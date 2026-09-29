'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const extensionDir = path.resolve(__dirname, '..');
const Contract = require(path.join(extensionDir, 'event-contract.js'));

function createBackgroundHarness({ paused = false, responseCode = 0, responseStatus = 201 } = {}) {
  const state = {
    protectionPaused: paused,
    paused,
    netguardSettings: { protectionPaused: paused, paused },
    netguardRiskEventQueue: [],
    netguardAdEventQueue: []
  };
  const requests = [];
  const tabUpdates = [];
  const listeners = {};
  const event = name => ({ addListener(handler) { listeners[name] = handler; } });
  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const values = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.hasOwn(state, key)) values[key] = state[key];
          }
          callback(values);
        },
        set(items, callback) {
          Object.assign(state, items);
          if (Object.hasOwn(items, 'pendingSecurityEvents')) {
            state.netguardRiskEventQueue = items.pendingSecurityEvents;
          }
          if (Object.hasOwn(items, 'pendingAdApiEvents')) {
            state.netguardAdEventQueue = items.pendingAdApiEvents;
          }
          callback?.();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
          callback?.();
        }
      },
      onChanged: event('storageChanged')
    },
    runtime: {
      getURL: file => `chrome-extension://test/${file}`,
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup')
    },
    tabs: {
      onUpdated: event('updated'), onActivated: event('activated'),
      async get() { return null; }, async query() { return []; },
      async update(tabId, change) { tabUpdates.push({ tabId, change }); }
    },
    webNavigation: { onCommitted: event('committed') },
    alarms: { onAlarm: event('alarm'), create() {} },
    declarativeNetRequest: { async updateDynamicRules() {} }
  };
  const context = {
    chrome, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    console: { log() {}, warn() {}, error() {} },
    importScripts(file) { context.NetGuardContract = require(path.join(extensionDir, file)); },
    fetch: async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/api/risk/check')) {
        return { status: 200, ok: true, async json() {
          return { code: 0, data: { risk_level: 'high', score: 0.9, reason: 'test' } };
        } };
      }
      return { status: responseStatus, ok: true, async json() {
        return { code: responseCode, message: responseCode === 1 ? 'duplicate' : 'success', data: {} };
      } };
    }
  };
  context.globalThis = context;
  const testBridge = `
    const __testEnqueueAdEvent = enqueueAdEvent;
    globalThis.NetGuardBackgroundTest = {
      ready: new Promise(resolve => setTimeout(resolve, 0)),
      async enqueueRiskEvent(event) {
        if (isProtectionPaused(await getSettings())) return false;
        await enqueueSecurityEvent(event);
        await flushSecurityEvents();
        return true;
      },
      async enqueueAdEvent(event) {
        const result = await __testEnqueueAdEvent(event);
        return Boolean(result?.accepted);
      },
      performUrlCheck,
      async flushEventQueues() {
        await flushSecurityEvents();
        await flushAdEventQueue();
        await flushAdStatistics();
      }
    };
  `;
  vm.runInNewContext(
    `${fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8')}\n${testBridge}`,
    context
  );
  return { api: context.NetGuardBackgroundTest, state, requests, tabUpdates };
}

test('risk payload contains only backend_api fields and score is clamped', () => {
  const event = Contract.createRiskEvent({
    event_uuid: 'uuid-risk', url: 'https://example.test', risk_level: 'high',
    score: 1.4, reason: 'local detection', details: { ignored: true }
  }, () => 'generated');
  assert.deepEqual(Object.keys(event).sort(),
    ['event_uuid', 'reason', 'risk_level', 'score', 'source', 'url'].sort());
  assert.equal(event.score, 1);
  assert.equal(Contract.validateRiskEvent(event), true);
});

test('HTTP 200 code=1 is terminal success and removes queued event', async () => {
  const harness = createBackgroundHarness({ responseCode: 1, responseStatus: 200 });
  await harness.api.ready;
  await harness.api.enqueueRiskEvent({ url: 'https://example.test', risk_level: 'high', score: 0.8 });
  assert.equal(harness.state.netguardRiskEventQueue.length, 0);
  assert.equal(harness.requests.filter(item => item.url.endsWith('/api/events/risk')).length, 1);
});

test('blocked_count remains the exact page batch count in all four modes', async () => {
  for (const mode of ['normal', 'strict', 'elder', 'child']) {
    const harness = createBackgroundHarness();
    await harness.api.ready;
    await harness.api.enqueueAdEvent({
      page_url: `https://${mode}.example.test`, resource_type: 'iframe', blocked_count: 7, mode
    });
    const request = harness.requests.find(item => item.url.endsWith('/api/events/ad'));
    assert.deepEqual(Object.keys(request.body).sort(),
      ['blocked_count', 'event_uuid', 'mode', 'page_url', 'resource_type'].sort());
    assert.equal(request.body.blocked_count, 7);
    assert.equal(request.body.mode, mode);
    assert.equal(harness.state.netguardAdEventQueue.length, 0);
  }
});

test('pause is highest priority for risk check and both event types', async () => {
  const harness = createBackgroundHarness({ paused: true });
  await harness.api.ready;
  assert.equal(await harness.api.enqueueRiskEvent({
    url: 'https://example.test', risk_level: 'high', score: 0.9
  }), false);
  assert.equal(await harness.api.enqueueAdEvent({
    page_url: 'https://example.test', resource_type: 'image', blocked_count: 3, mode: 'normal'
  }), false);
  await harness.api.performUrlCheck('https://gambling.example.test', 1);
  await harness.api.flushEventQueues();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.tabUpdates.length, 0);
});

test('mode resolution covers normal, strict, elder, and child', () => {
  assert.equal(Contract.resolveMode({ adBlockMode: 'normal' }), 'normal');
  assert.equal(Contract.resolveMode({ adBlockMode: 'strict' }), 'strict');
  assert.equal(Contract.resolveMode({ adBlockMode: 'strict', elderSettings: { enabled: true } }), 'elder');
  assert.equal(Contract.resolveMode({ elderSettings: { enabled: true }, childSettings: { childModeEnabled: true } }), 'child');
});

test('settings payload contains only backend fields for all four modes', () => {
  const cases = [
    [{ adBlockMode: 'normal' }, 'normal', false, false],
    [{ adBlockMode: 'strict' }, 'strict', false, false],
    [{ elderSettings: { enabled: true } }, 'elder', true, false],
    [{ childSettings: { childModeEnabled: true } }, 'child', false, true]
  ];
  for (const [settings, mode, elderMode, childMode] of cases) {
    const payload = Contract.createSettingsPayload(settings);
    assert.deepEqual(Object.keys(payload).sort(), ['child_mode', 'elder_mode', 'mode', 'paused']);
    assert.deepEqual({ ...payload }, {
      mode, elder_mode: elderMode, child_mode: childMode, paused: false
    });
  }
});
