'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BACKGROUND_PATH = path.resolve(
  __dirname,
  '../../extension/background.js'
);
const BACKGROUND_SOURCE = fs.readFileSync(
  BACKGROUND_PATH,
  'utf8'
);
const CONTENT_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../extension/content.js'),
  'utf8'
);

function clone(value) {
  return value === undefined
    ? undefined
    : structuredClone(value);
}

function readStorage(state, keys) {
  if (typeof keys === 'string') {
    return Object.prototype.hasOwnProperty.call(state, keys)
      ? { [keys]: clone(state[keys]) }
      : {};
  }

  if (Array.isArray(keys)) {
    return keys.reduce((result, key) => {
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        result[key] = clone(state[key]);
      }
      return result;
    }, {});
  }

  return clone(state);
}

function createEventTarget() {
  let listener = null;

  return {
    addListener(callback) {
      listener = callback;
    },
    dispatch(...args) {
      return listener?.(...args);
    }
  };
}

function createApiResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return clone(body);
    }
  };
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

async function runContentRiskAttempt(fetchImplementation) {
  const riskRequests = [];
  const messages = [];
  const context = {
    AbortController,
    clearTimeout,
    console: {
      log() {},
      warn() {}
    },
    crypto: webcrypto,
    extensionAPI: {
      runtime: {
        sendMessage(message, callback) {
          messages.push(clone(message));
          callback?.({ success: true });
        }
      }
    },
    fetch: async (url, options) => {
      riskRequests.push({ url, options });
      return fetchImplementation(url, options);
    },
    getApiUrl: async apiPath => `http://127.0.0.1:5000${apiPath}`,
    isAIServiceOnline: async () => true,
    localAIDetect: () => ({
      risk: 'high',
      score: 0.95,
      reason: '本地降级检测结果'
    }),
    setTimeout,
    shouldSkipProtectionNow: async () => false,
    window: {
      location: {
        href: 'https://example.com/content-risk'
      }
    }
  };
  const logFunctions = sourceBetween(
    CONTENT_SOURCE,
    'async function logSecurityEvent(eventData)',
    '// 便捷方法 - URL检测'
  );
  const checkFunction = sourceBetween(
    CONTENT_SOURCE,
    'async function checkTextWithAI(text)',
    'function getPageText()'
  );

  vm.createContext(context);
  vm.runInContext(`
    const AI_DEBUG = false;
    const AI_REQUEST_TIMEOUT = 5000;
    const MAX_TEXT_LENGTH = 3000;
    const COMPAT_SCORE_FIELD = ['risk', 'score'].join('_');
    function generateSecurityEventUuid() {
      return globalThis.crypto.randomUUID();
    }
    function isValidSecurityEventUuid(value) {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(value || ''));
    }
    function normalizeSecurityEventScore(value, riskLevel) {
      const score = Number(value);
      return Number.isFinite(score) ? score : ({ high: 0.95 }[riskLevel] || 0.5);
    }
    function createTimeoutController() {
      return { controller: new AbortController(), timeoutId: null };
    }
    ${logFunctions}
    ${checkFunction}
  `, context);

  const result = await context.checkTextWithAI('诈骗风险内容');
  if (result && !result.persisted_by_backend) {
    await context.logAICheck(
      result.risk,
      context.window.location.href,
      result.reason,
      result.score,
      result.event_uuid
    );
  }

  return { messages, result, riskRequests };
}

async function drainBackgroundInitialization() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function createHarness() {
  const state = {};
  const sessionState = {};
  const requests = [];
  const tabUpdates = [];
  let fetchImplementation = async () =>
    createApiResponse(201, {
      code: 0,
      message: 'success',
      data: {}
    });

  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          callback(readStorage(state, keys));
        },
        set(items, callback) {
          Object.assign(state, clone(items));
          callback?.();
        },
        remove(keys, callback) {
          const keyList = Array.isArray(keys)
            ? keys
            : [keys];
          keyList.forEach(key => delete state[key]);
          callback?.();
        }
      },
      session: {
        get(keys, callback) {
          callback(readStorage(sessionState, keys));
        },
        set(items, callback) {
          Object.assign(sessionState, clone(items));
          callback?.();
        },
        remove(keys, callback) {
          const keyList = Array.isArray(keys)
            ? keys
            : [keys];
          keyList.forEach(key => delete sessionState[key]);
          callback?.();
        }
      },
      onChanged: createEventTarget()
    },
    runtime: {
      getURL(resourcePath = '') {
        return `chrome-extension://test/${resourcePath}`;
      },
      onMessage: createEventTarget(),
      onInstalled: createEventTarget(),
      onStartup: createEventTarget()
    },
    tabs: {
      onUpdated: createEventTarget(),
      onActivated: createEventTarget(),
      onRemoved: createEventTarget(),
      async query() {
        return [];
      },
      async get() {
        return { id: 1, url: 'https://example.com' };
      },
      async update(tabId, updateProperties) {
        tabUpdates.push({ tabId, updateProperties: clone(updateProperties) });
      }
    },
    webNavigation: {
      onCommitted: createEventTarget()
    },
    alarms: {
      create() {},
      onAlarm: createEventTarget()
    },
    declarativeNetRequest: {
      async updateDynamicRules() {}
    }
  };

  const context = {
    AbortController,
    URL,
    URLSearchParams,
    chrome,
    clearTimeout,
    console: {
      log() {},
      warn() {},
      error() {}
    },
    crypto: webcrypto,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchImplementation(url, options);
    },
    setTimeout
  };

  vm.createContext(context);
  vm.runInContext(
    BACKGROUND_SOURCE,
    context,
    { filename: BACKGROUND_PATH }
  );
  await drainBackgroundInitialization();
  requests.length = 0;

  return {
    context,
    dispatchRuntimeMessage(message, sender = {}) {
      return new Promise(resolve => {
        const handled = chrome.runtime.onMessage.dispatch(
          message,
          sender,
          resolve
        );
        if (!handled) resolve(undefined);
      });
    },
    requests,
    sessionState,
    setFetchImplementation(implementation) {
      fetchImplementation = implementation;
    },
    state,
    tabUpdates
  };
}

test('content forwards its internal detection type without legacy score output', () => {
  assert.match(
    CONTENT_SOURCE,
    /score:\s*normalizeSecurityEventScore\(/
  );
  assert.match(
    CONTENT_SOURCE,
    /type:\s*'ai_check'[\s\S]*?score:\s*riskScore/
  );
  assert.match(
    CONTENT_SOURCE,
    /event:\s*{[\s\S]*?type:\s*eventData\.type/
  );
  assert.doesNotMatch(
    CONTENT_SOURCE,
    /^\s*risk_score\s*:/m
  );
});

test('content risk/check success carries UUID and skips events/risk', async () => {
  const attempt = await runContentRiskAttempt(async () =>
    createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        risk_level: 'high',
        score: 0.96,
        reason: '后端检测结果'
      }
    })
  );
  const riskPayload = JSON.parse(
    attempt.riskRequests[0].options.body
  );

  assert.match(
    riskPayload.event_uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.equal(attempt.result.persisted_by_backend, true);
  assert.equal(attempt.messages.length, 0);
});

test('content network loss reuses risk/check UUID for events/risk', async () => {
  const attempt = await runContentRiskAttempt(async () => {
    throw new Error('simulated response loss after commit');
  });
  const riskPayload = JSON.parse(
    attempt.riskRequests[0].options.body
  );
  const queuedEvent = attempt.messages[0].event;

  assert.equal(queuedEvent.event_uuid, riskPayload.event_uuid);

  const background = await createHarness();
  await background.dispatchRuntimeMessage(attempt.messages[0]);
  await background.context.flushSecurityEvents();
  const eventPayload = JSON.parse(
    background.requests[0].options.body
  );

  assert.equal(eventPayload.event_uuid, riskPayload.event_uuid);
  assert.equal(
    background.requests[0].url,
    'http://127.0.0.1:5000/api/events/risk'
  );
});

test('content HTTP 500 and 503 fallbacks reuse risk/check UUID', async () => {
  for (const status of [500, 503]) {
    const attempt = await runContentRiskAttempt(async () =>
      createApiResponse(status, {
        code: status,
        message: 'temporary failure'
      })
    );
    const riskPayload = JSON.parse(
      attempt.riskRequests[0].options.body
    );

    assert.equal(
      attempt.messages[0].event.event_uuid,
      riskPayload.event_uuid
    );
  }
});

test('background risk/check request carries a valid event UUID', async () => {
  const harness = await createHarness();
  harness.setFetchImplementation(async () =>
    createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        risk_level: 'safe',
        score: 0.05,
        reason: '测试结果'
      }
    })
  );

  await harness.context.performUrlCheck(
    'https://gambling.example.com',
    9
  );

  const payload = JSON.parse(harness.requests[0].options.body);
  assert.match(
    payload.event_uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test('warning continue bypasses exactly one same-tab URL navigation', async () => {
  const harness = await createHarness();
  const targetUrl = 'https://example.com/?phishing=1';
  harness.setFetchImplementation(async () =>
    createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        risk_level: 'high',
        score: 0.99,
        reason: '检测到钓鱼网站特征'
      }
    })
  );

  // A. 首次访问仍检测一次并进入 warning。
  await harness.context.performUrlCheck(
    targetUrl,
    9,
    { source: 'tabs-loading' }
  );
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.tabUpdates.length, 1);
  assert.equal(harness.state.netguardStats.urlDetectCount, 1);
  assert.equal(harness.state.netguardStats.highRisk, 1);
  assert.equal(harness.state.netguardRiskLogs.length, 1);
  const warningUrl = harness.tabUpdates[0].updateProperties.url;

  const grant = await harness.dispatchRuntimeMessage(
    {
      type: 'NETGUARD_CONTINUE_ONCE',
      targetUrl
    },
    {
      url: warningUrl,
      tab: { id: 9, url: warningUrl }
    }
  );
  assert.equal(grant.success, true);
  assert.equal(
    harness.sessionState.netguardOneTimeContinueBypasses['9'].targetUrl,
    targetUrl
  );

  // B. 凭证在目标 loading 时消费，后台与内容检测均不再请求后端。
  await harness.context.performUrlCheck(
    targetUrl,
    9,
    { source: 'tabs-loading' }
  );
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.tabUpdates.length, 1);
  assert.equal(
    harness.sessionState.netguardOneTimeContinueBypasses['9'],
    undefined
  );

  const contentDecision = await harness.dispatchRuntimeMessage(
    {
      type: 'NETGUARD_QUERY_CONTINUE_BYPASS',
      url: targetUrl
    },
    {
      url: targetUrl,
      frameId: 0,
      documentId: 'continued-document',
      tab: { id: 9, url: targetUrl }
    }
  );
  assert.equal(contentDecision.bypass, true);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.state.netguardStats.urlDetectCount, 1);
  assert.equal(harness.state.netguardStats.highRisk, 1);
  assert.equal(harness.state.netguardRiskLogs.length, 1);

  // B/C. 超过 pending TTL 后，同一 document 的多个入口仍保持抑制。
  const originalNow = vm.runInContext('Date.now()', harness.context);
  vm.runInContext(
    `Date.now = () => ${originalNow + 120000}`,
    harness.context
  );
  await harness.context.performUrlCheck(
    targetUrl,
    9,
    {
      source: 'web-navigation',
      documentId: 'continued-document'
    }
  );
  await harness.context.performUrlCheck(
    targetUrl,
    9,
    { source: 'tab-activated' }
  );
  const delayedContentDecision = await harness.dispatchRuntimeMessage(
    {
      type: 'NETGUARD_QUERY_CONTINUE_BYPASS',
      url: targetUrl
    },
    {
      url: targetUrl,
      frameId: 0,
      documentId: 'continued-document',
      tab: { id: 9, url: targetUrl }
    }
  );
  assert.equal(delayedContentDecision.bypass, true);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.state.netguardStats.urlDetectCount, 1);
  assert.equal(harness.state.netguardStats.highRisk, 1);
  assert.equal(harness.state.netguardRiskLogs.length, 1);

  // D. 下一次 loading（F5/新 document）清除标记并恢复正常检测。
  await harness.context.performUrlCheck(
    targetUrl,
    9,
    { source: 'tabs-loading' }
  );
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.tabUpdates.length, 2);
  assert.equal(harness.state.netguardStats.urlDetectCount, 2);
  assert.equal(harness.state.netguardStats.highRisk, 2);
  assert.equal(harness.state.netguardRiskLogs.length, 2);
});

test('continue bypass is isolated by tab and exact full URL', async () => {
  const harness = await createHarness();
  const targetUrl = 'https://example.com/?phishing=1';
  const warningUrl = harness.context.getWarningPageUrl(
    targetUrl,
    'high',
    '检测到钓鱼网站特征'
  );
  harness.setFetchImplementation(async () =>
    createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        risk_level: 'high',
        score: 0.99,
        reason: '检测到钓鱼网站特征'
      }
    })
  );

  const grant = await harness.dispatchRuntimeMessage(
    { type: 'NETGUARD_CONTINUE_ONCE', targetUrl },
    {
      url: warningUrl,
      tab: { id: 9, url: warningUrl }
    }
  );
  assert.equal(grant.success, true);

  // D. 另一个 tab 的同一 URL 不继承凭证。
  await harness.context.performUrlCheck(
    targetUrl,
    10,
    { source: 'tabs-loading' }
  );
  assert.equal(harness.requests.length, 1);

  // 同一 tab 的不同完整 URL 也不能命中。
  assert.equal(
    await harness.context.shouldBypassContinuedNavigation(
      9,
      'https://example.com/?phishing=1#different',
      { source: 'tabs-loading' }
    ),
    false
  );
});

test('expired or untrusted continue bypass cannot suppress detection', async () => {
  const harness = await createHarness();
  const targetUrl = 'https://example.com/?phishing=1';
  const warningUrl = harness.context.getWarningPageUrl(
    targetUrl,
    'high',
    '检测到钓鱼网站特征'
  );
  harness.setFetchImplementation(async () =>
    createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        risk_level: 'high',
        score: 0.99,
        reason: '检测到钓鱼网站特征'
      }
    })
  );

  const rejected = await harness.dispatchRuntimeMessage(
    { type: 'NETGUARD_CONTINUE_ONCE', targetUrl },
    {
      url: targetUrl,
      tab: { id: 9, url: targetUrl }
    }
  );
  assert.equal(rejected.success, false);

  await harness.dispatchRuntimeMessage(
    { type: 'NETGUARD_CONTINUE_ONCE', targetUrl },
    {
      url: warningUrl,
      tab: { id: 9, url: warningUrl }
    }
  );
  harness.sessionState.netguardOneTimeContinueBypasses['9'].expiresAt =
    Date.now() - 1;

  // E. 过期后恢复正常检测。
  await harness.context.performUrlCheck(
    targetUrl,
    9,
    { source: 'tabs-loading' }
  );
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.tabUpdates.length, 1);
});

test('content automatic detection consults the continued-navigation gate', () => {
  assert.match(
    CONTENT_SOURCE,
    /type:\s*'NETGUARD_QUERY_CONTINUE_BYPASS'[\s\S]*?if \(await shouldSkipContinuedNavigation\(\)\)/
  );
});

test('content notifies background after updating ad statistics', () => {
  assert.match(CONTENT_SOURCE, /\[AD_DETECTED\]/);
  assert.match(CONTENT_SOURCE, /\[AD_STAT_UPDATE\]/);
  assert.match(
    CONTENT_SOURCE,
    /type:\s*'NETGUARD_AD_STAT_UPDATED'/
  );
});

test('AI legacy input uploads check_type=ai without legacy fields', async () => {
  const harness = await createHarness();

  await harness.context.enqueueSecurityEvent({
    type: 'ai_check',
    check_type: 'text',
    risk_level: 'high',
    risk_score: 0.82,
    url: 'https://example.com/risk',
    reason: '本地 AI 降级检测命中风险内容'
  });

  const queuedEvent = harness.state.pendingSecurityEvents[0];
  assert.deepEqual(
    Object.keys(queuedEvent).sort(),
    [
      'check_type',
      'event_uuid',
      'reason',
      'risk_level',
      'score',
      'source',
      'url'
    ]
  );
  assert.equal(queuedEvent.score, 0.82);
  assert.equal('risk_score' in queuedEvent, false);
  assert.equal(queuedEvent.check_type, 'ai');

  await harness.context.flushSecurityEvents();

  assert.equal(harness.requests.length, 1);
  assert.equal(
    harness.requests[0].url,
    'http://127.0.0.1:5000/api/events/risk'
  );

  const payload = JSON.parse(
    harness.requests[0].options.body
  );

  assert.deepEqual(
    Object.keys(payload).sort(),
    [
      'check_type',
      'event_uuid',
      'reason',
      'risk_level',
      'score',
      'source',
      'url'
    ]
  );
  assert.equal(payload.score, 0.82);
  assert.equal(typeof payload.score, 'number');
  assert.equal(payload.source, 'extension');
  assert.equal(payload.check_type, 'ai');
  assert.equal('risk_score' in payload, false);
  assert.equal('type' in payload, false);
  assert.equal('event_type' in payload, false);
});

test('background derives URL and rule check types from internal event types', async () => {
  const harness = await createHarness();
  const baseEvent = {
    risk_level: 'medium',
    score: 0.6,
    url: 'https://example.com/source',
    reason: '验证检测来源映射'
  };

  const urlEvent = harness.context.createRiskEvent({
    ...baseEvent,
    type: 'url_check'
  });
  const ruleEvent = harness.context.createRiskEvent({
    ...baseEvent,
    type: 'dangerous_block'
  });
  const legacyAiEvent = harness.context.createRiskEvent({
    ...baseEvent,
    check_type: 'text'
  });

  assert.equal(urlEvent.check_type, 'url');
  assert.equal(ruleEvent.check_type, 'rule');
  assert.equal(legacyAiEvent.check_type, 'ai');
});

test('retry reuses UUID and code=1 clears the queue', async () => {
  const harness = await createHarness();
  let attempt = 0;

  harness.setFetchImplementation(async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('simulated connection loss');
    }

    return createApiResponse(200, {
      code: 1,
      message: 'duplicate',
      data: {}
    });
  });

  await harness.context.enqueueSecurityEvent({
    type: 'ai_check',
    risk_level: 'medium',
    score: 0.67,
    url: 'https://example.com/retry',
    reason: '验证幂等重试'
  });

  await harness.context.flushSecurityEvents();
  assert.equal(
    harness.state.pendingSecurityEvents.length,
    1
  );

  const firstPayload = JSON.parse(
    harness.requests[0].options.body
  );

  await harness.context.flushSecurityEvents();

  const secondPayload = JSON.parse(
    harness.requests[1].options.body
  );
  assert.equal(firstPayload.check_type, 'ai');
  assert.equal(secondPayload.check_type, 'ai');
  assert.equal(
    secondPayload.event_uuid,
    firstPayload.event_uuid
  );
  assert.match(
    secondPayload.event_uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.deepEqual(
    harness.state.pendingSecurityEvents,
    []
  );
});

test('legacy cumulative statistics do not create a second ad event', async () => {
  const harness = await createHarness();
  harness.state.netguardStats = {
    adBlockCount: 7
  };
  harness.state.lastUploadedAdBlockCount = 2;
  harness.state.lastAdBlockContext = {
    page_url: 'https://example.com/articles/1',
    mode: 'normal',
    occurred_at: '2026-08-09T01:00:00.000Z'
  };

  await harness.context.flushAdStatistics();

  assert.equal(harness.requests.length, 0);
  assert.equal(
    harness.state.lastUploadedAdBlockCount,
    7
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.state,
      'pendingAdApiEvent'
    ),
    false
  );
});

test('ad statistics message only synchronizes the legacy cursor', async () => {
  const harness = await createHarness();
  harness.state.netguardStats = {
    adBlockCount: 1
  };
  harness.state.lastUploadedAdBlockCount = 0;
  harness.state.lastAdBlockContext = {
    page_url: 'https://example.com/ad-demo',
    mode: 'normal',
    occurred_at: '2026-08-10T01:00:00.000Z'
  };

  const response = await harness.dispatchRuntimeMessage({
    type: 'NETGUARD_AD_STAT_UPDATED'
  });

  assert.equal(response.success, true);
  assert.equal(harness.requests.length, 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.state,
      'pendingAdApiEvent'
    ),
    false
  );
  assert.equal(
    harness.state.lastUploadedAdBlockCount,
    1
  );
});

test('legacy pending migrates to the primary queue and reuses UUID', async () => {
  const harness = await createHarness();
  const eventUuid = webcrypto.randomUUID();
  let attempt = 0;
  harness.state.netguardStats = {
    adBlockCount: 4
  };
  harness.state.lastUploadedAdBlockCount = 0;
  harness.state.lastAdBlockContext = {
    page_url: 'https://example.com/retry-ad',
    mode: 'strict',
    occurred_at: '2026-08-09T01:00:00.000Z'
  };
  harness.state.netguardSettings = {
    adMode: 'strict',
    elderMode: false,
    childMode: false,
    paused: false,
    whitelist: []
  };
  harness.state.pendingAdApiEvent = {
    event_uuid: eventUuid,
    page_url: 'https://example.com/retry-ad',
    blocked_count: 4,
    mode: 'strict',
    resource_type: 'mixed',
    total_snapshot: 4
  };

  harness.setFetchImplementation(async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('simulated connection loss');
    }

    return createApiResponse(200, {
      code: 1,
      message: 'duplicate',
      data: {}
    });
  });

  await harness.context.flushAdStatistics();
  const firstPayload = JSON.parse(
    harness.requests[0].options.body
  );

  assert.equal(firstPayload.event_uuid, eventUuid);
  assert.equal(
    harness.state.pendingAdApiEvents[0].event_uuid,
    eventUuid
  );
  assert.equal(harness.state.pendingAdApiEvent, undefined);

  await harness.context.flushAdEventQueue();

  const secondPayload = JSON.parse(
    harness.requests[1].options.body
  );
  assert.equal(secondPayload.event_uuid, eventUuid);
  assert.equal(
    harness.state.lastUploadedAdBlockCount,
    4
  );
  assert.deepEqual(harness.state.pendingAdApiEvents, []);
});

test('ad upload skips fabricated extension page URLs', async () => {
  const harness = await createHarness();
  harness.state.netguardStats = {
    adBlockCount: 3
  };
  harness.state.lastUploadedAdBlockCount = 0;
  harness.state.lastAdBlockContext = {
    page_url: 'extension://netguard/ad-statistics',
    mode: 'normal'
  };

  await harness.context.flushAdStatistics();

  assert.equal(harness.requests.length, 0);
  assert.equal(
    harness.state.lastUploadedAdBlockCount,
    3
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      harness.state,
      'pendingAdApiEvent'
    ),
    false
  );
});

test('ad upload keeps pending when blocked_count is invalid', async () => {
  const harness = await createHarness();
  const eventUuid = webcrypto.randomUUID();
  harness.state.netguardStats = {
    adBlockCount: 3
  };
  harness.state.lastUploadedAdBlockCount = 0;
  harness.state.lastAdBlockContext = {
    page_url: 'https://example.com/invalid-count',
    mode: 'normal'
  };
  harness.state.pendingAdApiEvent = {
    event_uuid: eventUuid,
    page_url: 'https://example.com/invalid-count',
    blocked_count: -1,
    mode: 'normal',
    resource_type: 'mixed',
    total_snapshot: 3
  };

  await harness.context.flushAdStatistics();

  assert.equal(harness.requests.length, 0);
  assert.equal(
    harness.state.pendingAdApiEvent.event_uuid,
    eventUuid
  );
  assert.equal(
    harness.state.lastUploadedAdBlockCount,
    0
  );
});
