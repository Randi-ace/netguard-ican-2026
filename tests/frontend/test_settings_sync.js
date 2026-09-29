'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UI_ROOT = path.join(REPO_ROOT, 'UI');
const INDEX_PATH = path.join(UI_ROOT, 'index.html');
const SCRIPT_PATH = path.join(UI_ROOT, 'script.js');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const SETTINGS_CORE_SOURCE = sourceBetween(
  SCRIPT_SOURCE,
  'function normalizeSharedSettings(raw = {})',
  'function setSettingsRequestState(state, message)'
);

const SETTINGS_UI_SOURCE = sourceBetween(
  SCRIPT_SOURCE,
  'function normalizeSharedSettings(raw = {})',
  'function bindElderFontToggle()'
);

function createSettingsCore() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(SETTINGS_CORE_SOURCE, context, { filename: SCRIPT_PATH });
  return context;
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class Element {
  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    const event = {
      target: this,
      preventDefault() {},
    };
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
    }
  }
}

class HTMLInputElement extends Element {
  constructor(attributes = {}) {
    super(attributes);
    this.checked = false;
  }
}

class HTMLButtonElement extends Element {}
class HTMLFormElement extends Element {}

function createSettingsUiHarness() {
  const elements = new Map();
  const normalCard = new HTMLButtonElement({ 'data-mode': 'normal' });
  const strictCard = new HTMLButtonElement({ 'data-mode': 'strict' });
  const elderToggle = new HTMLInputElement();
  const childToggle = new HTMLInputElement();
  const pausedToggle = new HTMLInputElement();
  const form = new HTMLFormElement();
  const saveButton = new HTMLButtonElement();
  const retryButton = new HTMLButtonElement();
  const status = new Element();
  const statusText = new Element();
  const modeDetail = new Element();
  const elderPreview = new Element();
  const childPreview = new Element();

  [
    ['settings-elder-mode', elderToggle],
    ['settings-child-mode', childToggle],
    ['settings-paused', pausedToggle],
    ['security-settings-form', form],
    ['settings-api-save', saveButton],
    ['settings-api-retry', retryButton],
    ['settings-api-state', status],
    ['settings-api-state-text', statusText],
    ['mode-detail-text', modeDetail],
    ['mode-preview-elder', elderPreview],
    ['mode-preview-child', childPreview],
  ].forEach(([id, element]) => elements.set(id, element));

  const getRequests = [];
  const postRequests = [];
  const toastMessages = [];
  let visiblePage = 'dash-modes';
  let getHandler = async () => ({
    code: 0,
    data: {
      mode: 'normal',
      elder_mode: false,
      child_mode: false,
      paused: false,
    },
  });
  let postHandler = async (_path, payload) => ({
    code: 0,
    data: payload,
  });

  const context = {
    Element,
    HTMLButtonElement,
    HTMLFormElement,
    HTMLInputElement,
    console: { error() {} },
    document: { addEventListener() {} },
    api: {
      get(apiPath) {
        getRequests.push(apiPath);
        return getHandler(apiPath);
      },
      post(apiPath, payload) {
        postRequests.push({ path: apiPath, payload: plain(payload) });
        return postHandler(apiPath, plain(payload));
      },
    },
    $(selector) {
      return selector.startsWith('#')
        ? elements.get(selector.slice(1)) || null
        : null;
    },
    $all(selector) {
      return selector === '.mode-card'
        ? [normalCard, strictCard]
        : [];
    },
    applyElderGlobal() {},
    getVisibleDashPage() {
      return visiblePage;
    },
    toast(message) {
      toastMessages.push(message);
    },
  };

  vm.createContext(context);
  vm.runInContext(`
    const MODE_COPY = {
      normal: 'normal', strict: 'strict', elder: 'elder', child: 'child'
    };
    let currentMode = null;
    let currentSettings = null;
    let settingsLoading = false;
    let settingsSaving = false;
    let settingsRefreshPromise = null;
    let settingsRequestGeneration = 0;
    ${SETTINGS_UI_SOURCE}
    globalThis.settingsTestApi = {
      bindModes,
      getModeFromBackend,
      refreshVisibleSettings,
      snapshot() {
        return {
          currentMode,
          currentSettings: currentSettings ? { ...currentSettings } : null,
          settingsLoading,
          settingsSaving,
          settingsRequestGeneration,
        };
      }
    };
  `, context, { filename: SCRIPT_PATH });
  context.settingsTestApi.bindModes();

  return {
    api: context.settingsTestApi,
    elements,
    normalCard,
    strictCard,
    elderToggle,
    childToggle,
    pausedToggle,
    form,
    saveButton,
    statusText,
    getRequests,
    postRequests,
    toastMessages,
    setVisiblePage(page) {
      visiblePage = page;
    },
    setGetHandler(handler) {
      getHandler = handler;
    },
    setPostHandler(handler) {
      postHandler = handler;
    },
  };
}

test('official UI marker is static on the root html element only', () => {
  assert.match(
    INDEX_SOURCE,
    /<html\s+lang="zh-CN"\s+data-netguard-page="official-ui">/
  );
  assert.doesNotMatch(
    SCRIPT_SOURCE,
    /setAttribute\(\s*["']data-netguard-page["']/
  );
});

test('settings copy describes shared synchronization without extension-only ownership', () => {
  assert.match(
    INDEX_SOURCE,
    /当前保护设置会与浏览器扩展同步；扩展离线时使用最近一次本地设置，网络恢复后会自动同步。/
  );
  assert.doesNotMatch(INDEX_SOURCE, /平台侧配置原型/);
  assert.doesNotMatch(INDEX_SOURCE, /实时防护状态以扩展端为准/);
  assert.doesNotMatch(SCRIPT_SOURCE, /扩展实时保护以扩展端设置为准/);
});

test('normal strict elder and child normalize to one canonical shape', () => {
  const core = createSettingsCore();
  const cases = [
    ['normal', false, false],
    ['strict', false, false],
    ['elder', true, false],
    ['child', false, true],
  ];

  for (const [mode, elderMode, childMode] of cases) {
    const normalized = plain(core.normalizeSharedSettings({
      mode,
      elder_mode: elderMode,
      child_mode: childMode,
      paused: false,
    }));
    assert.deepEqual(normalized, {
      mode,
      elder_mode: elderMode,
      child_mode: childMode,
      paused: false,
    });
  }
});

test('conflicts use child then elder priority while paused stays independent', () => {
  const core = createSettingsCore();
  assert.deepEqual(
    plain(core.normalizeSharedSettings({
      mode: 'strict',
      elder_mode: true,
      child_mode: false,
      paused: true,
    })),
    {
      mode: 'elder',
      elder_mode: true,
      child_mode: false,
      paused: true,
    }
  );
  assert.deepEqual(
    plain(core.normalizeSharedSettings({
      mode: 'elder',
      elder_mode: true,
      child_mode: true,
      paused: false,
    })),
    {
      mode: 'child',
      elder_mode: false,
      child_mode: true,
      paused: false,
    }
  );
});

test('mode transitions are mutually exclusive and disabling family modes falls back to normal', () => {
  const core = createSettingsCore();
  const normal = {
    mode: 'normal', elder_mode: false, child_mode: false, paused: true,
  };
  const elder = plain(core.transitionSharedSettings(normal, 'elder', true));
  const child = plain(core.transitionSharedSettings(elder, 'child', true));
  const childDisabled = plain(core.transitionSharedSettings(child, 'child', false));
  const elderAgain = plain(core.transitionSharedSettings(child, 'elder', true));
  const disabled = plain(core.transitionSharedSettings(elderAgain, 'elder', false));

  assert.deepEqual(elder, {
    mode: 'elder', elder_mode: true, child_mode: false, paused: true,
  });
  assert.deepEqual(child, {
    mode: 'child', elder_mode: false, child_mode: true, paused: true,
  });
  assert.deepEqual(childDisabled, {
    mode: 'normal', elder_mode: false, child_mode: false, paused: true,
  });
  assert.deepEqual(elderAgain, {
    mode: 'elder', elder_mode: true, child_mode: false, paused: true,
  });
  assert.deepEqual(disabled, {
    mode: 'normal', elder_mode: false, child_mode: false, paused: true,
  });
});

test('Backend envelopes use response.data and POST payloads contain only four fields', () => {
  const core = createSettingsCore();
  const normalized = plain(core.normalizeSettingsResponse({
    code: 0,
    message: 'ok',
    data: {
      mode: 'strict',
      elder_mode: true,
      child_mode: false,
      paused: false,
    },
  }));
  assert.equal(normalized.mode, 'elder');

  const payload = plain(core.createSettingsPayload({
    mode: 'child',
    elder_mode: true,
    child_mode: true,
    paused: true,
    ignored: 'value',
  }));
  assert.deepEqual(Object.keys(payload), [
    'mode', 'elder_mode', 'child_mode', 'paused',
  ]);
  assert.deepEqual(payload, {
    mode: 'child', elder_mode: false, child_mode: true, paused: true,
  });
});

test('settings page GET normalizes Backend state and UI transitions stay canonical', async () => {
  const harness = createSettingsUiHarness();
  harness.setGetHandler(async () => ({
    code: 0,
    data: {
      mode: 'strict',
      elder_mode: true,
      child_mode: false,
      paused: false,
    },
  }));
  await harness.api.getModeFromBackend();
  assert.equal(harness.api.snapshot().currentMode, 'elder');
  assert.equal(harness.elderToggle.checked, true);
  assert.equal(harness.childToggle.checked, false);

  harness.childToggle.checked = true;
  await harness.childToggle.dispatch('change');
  assert.equal(harness.api.snapshot().currentMode, 'child');
  assert.equal(harness.elderToggle.checked, false);

  harness.elderToggle.checked = true;
  await harness.elderToggle.dispatch('change');
  assert.equal(harness.api.snapshot().currentMode, 'elder');
  assert.equal(harness.childToggle.checked, false);

  harness.elderToggle.checked = false;
  await harness.elderToggle.dispatch('change');
  assert.equal(harness.api.snapshot().currentMode, 'normal');
});

test('paused UI changes preserve the active mode', async () => {
  const harness = createSettingsUiHarness();
  await harness.api.getModeFromBackend();
  await harness.strictCard.dispatch('click');
  harness.pausedToggle.checked = true;
  await harness.pausedToggle.dispatch('change');

  assert.equal(harness.api.snapshot().currentMode, 'strict');
  assert.equal(harness.pausedToggle.checked, true);
});

test('mode page entry and the existing 30 second scheduler wire settings GET without another interval', () => {
  assert.match(
    SCRIPT_SOURCE,
    /if \(id === "dash-modes"\) \{\s*getModeFromBackend\(\);\s*\}/
  );
  assert.match(
    SCRIPT_SOURCE,
    /await fetchRiskLogs\(riskLogPage\);\s*await refreshVisibleSettings\(\);/
  );
  assert.equal(
    (SCRIPT_SOURCE.match(/setInterval\(loadDataAndUpdateUI, 30000\)/g) || []).length,
    1
  );
});

test('periodic settings GET runs only on the visible mode page and skips active saves', async () => {
  const harness = createSettingsUiHarness();
  await harness.api.getModeFromBackend();
  harness.getRequests.length = 0;

  harness.setVisiblePage('dash-home');
  await harness.api.refreshVisibleSettings();
  assert.equal(harness.getRequests.length, 0);

  harness.setVisiblePage('dash-modes');
  await harness.api.refreshVisibleSettings();
  assert.deepEqual(harness.getRequests, ['/api/settings']);

  let resolvePost;
  harness.setPostHandler(() => new Promise(resolve => {
    resolvePost = resolve;
  }));
  await harness.strictCard.dispatch('click');
  const save = harness.form.dispatch('submit');
  while (!resolvePost) await new Promise(resolve => setImmediate(resolve));
  await harness.form.dispatch('submit');
  assert.equal(harness.postRequests.length, 1);
  const beforeRefresh = harness.getRequests.length;
  await harness.api.refreshVisibleSettings();
  assert.equal(harness.getRequests.length, beforeRefresh);
  resolvePost({
    code: 0,
    data: {
      mode: 'strict', elder_mode: false, child_mode: false, paused: false,
    },
  });
  await save;
});

test('periodic GET failures retain the current known settings and show sync failure', async () => {
  const harness = createSettingsUiHarness();
  await harness.api.getModeFromBackend();
  harness.setGetHandler(async () => {
    throw new Error('offline');
  });

  await harness.api.refreshVisibleSettings();

  assert.equal(harness.api.snapshot().currentMode, 'normal');
  assert.deepEqual(plain(harness.api.snapshot().currentSettings), {
    mode: 'normal', elder_mode: false, child_mode: false, paused: false,
  });
  assert.match(harness.statusText.textContent, /同步失败/);
});

test('foreground GET failures retain a known Strict state and its rendered UI', async () => {
  const harness = createSettingsUiHarness();
  harness.setGetHandler(async () => ({
    code: 0,
    data: {
      mode: 'strict', elder_mode: false, child_mode: false, paused: false,
    },
  }));
  await harness.api.getModeFromBackend();
  harness.setGetHandler(async () => {
    throw new Error('offline');
  });

  await harness.api.getModeFromBackend();

  assert.deepEqual(plain(harness.api.snapshot().currentSettings), {
    mode: 'strict', elder_mode: false, child_mode: false, paused: false,
  });
  assert.equal(harness.api.snapshot().currentMode, 'strict');
  assert.equal(harness.strictCard.classList.contains('is-active'), true);
  assert.match(harness.statusText.textContent, /最近一次已知状态/);
});

test('periodic GET failures retain a known paused Child state', async () => {
  const harness = createSettingsUiHarness();
  harness.setGetHandler(async () => ({
    code: 0,
    data: {
      mode: 'child', elder_mode: false, child_mode: true, paused: true,
    },
  }));
  await harness.api.getModeFromBackend();
  harness.setGetHandler(async () => {
    throw new Error('offline');
  });

  await harness.api.refreshVisibleSettings();

  assert.deepEqual(plain(harness.api.snapshot().currentSettings), {
    mode: 'child', elder_mode: false, child_mode: true, paused: true,
  });
  assert.equal(harness.api.snapshot().currentMode, 'child');
  assert.equal(harness.elderToggle.checked, false);
  assert.equal(harness.childToggle.checked, true);
  assert.equal(harness.pausedToggle.checked, true);
});

test('an initial GET failure does not invent a Normal state', async () => {
  const harness = createSettingsUiHarness();
  harness.setGetHandler(async () => {
    throw new Error('offline');
  });

  await harness.api.getModeFromBackend();

  assert.equal(harness.api.snapshot().currentSettings, null);
  assert.equal(harness.api.snapshot().currentMode, null);
  assert.equal(harness.normalCard.classList.contains('is-active'), false);
  assert.equal(harness.strictCard.classList.contains('is-active'), false);
  assert.match(harness.statusText.textContent, /设置加载失败/);
});

test('a successful GET after a retained failure updates the UI to Elder', async () => {
  const harness = createSettingsUiHarness();
  harness.setGetHandler(async () => ({
    code: 0,
    data: {
      mode: 'strict', elder_mode: false, child_mode: false, paused: true,
    },
  }));
  await harness.api.getModeFromBackend();
  harness.setGetHandler(async () => {
    throw new Error('offline');
  });
  await harness.api.getModeFromBackend();
  harness.setGetHandler(async () => ({
    code: 0,
    data: {
      mode: 'elder', elder_mode: true, child_mode: false, paused: false,
    },
  }));

  await harness.api.getModeFromBackend();

  assert.deepEqual(plain(harness.api.snapshot().currentSettings), {
    mode: 'elder', elder_mode: true, child_mode: false, paused: false,
  });
  assert.equal(harness.api.snapshot().currentMode, 'elder');
  assert.equal(harness.elderToggle.checked, true);
  assert.equal(harness.childToggle.checked, false);
  assert.equal(harness.pausedToggle.checked, false);
  assert.equal(harness.statusText.textContent, '');
});

test('a stale GET error cannot replace a newer successful POST state', async () => {
  const harness = createSettingsUiHarness();
  await harness.api.getModeFromBackend();
  let rejectGet;
  harness.setGetHandler(() => new Promise((_resolve, reject) => {
    rejectGet = reject;
  }));
  harness.setPostHandler(async () => ({
    code: 0,
    data: {
      mode: 'child', elder_mode: false, child_mode: true, paused: true,
    },
  }));

  const refresh = harness.api.refreshVisibleSettings();
  while (!rejectGet) await new Promise(resolve => setImmediate(resolve));
  await harness.strictCard.dispatch('click');
  await harness.form.dispatch('submit');
  rejectGet(new Error('stale offline response'));
  await refresh;

  assert.deepEqual(plain(harness.api.snapshot().currentSettings), {
    mode: 'child', elder_mode: false, child_mode: true, paused: true,
  });
  assert.equal(harness.api.snapshot().currentMode, 'child');
  assert.equal(harness.childToggle.checked, true);
  assert.equal(harness.statusText.textContent, '');
});

test('a stale periodic GET cannot overwrite a newer successful POST response', async () => {
  const harness = createSettingsUiHarness();
  await harness.api.getModeFromBackend();
  let resolveGet;
  harness.setGetHandler(() => new Promise(resolve => {
    resolveGet = resolve;
  }));
  harness.setPostHandler(async () => ({
    code: 0,
    data: {
      mode: 'child', elder_mode: false, child_mode: true, paused: true,
    },
  }));

  const refresh = harness.api.refreshVisibleSettings();
  while (!resolveGet) await new Promise(resolve => setImmediate(resolve));
  await harness.strictCard.dispatch('click');
  await harness.form.dispatch('submit');
  resolveGet({
    code: 0,
    data: {
      mode: 'normal', elder_mode: false, child_mode: false, paused: false,
    },
  });
  await refresh;

  assert.equal(harness.api.snapshot().currentMode, 'child');
  assert.equal(harness.childToggle.checked, true);
  assert.deepEqual(harness.postRequests[0].payload, {
    mode: 'strict', elder_mode: false, child_mode: false, paused: false,
  });
});

test('POST failures retain known state while successful responses control the redraw', async () => {
  const harness = createSettingsUiHarness();
  await harness.api.getModeFromBackend();
  await harness.strictCard.dispatch('click');
  harness.setPostHandler(async () => ({
    code: 0,
    data: {
      mode: 'elder', elder_mode: true, child_mode: false, paused: false,
    },
  }));
  await harness.form.dispatch('submit');
  assert.equal(harness.api.snapshot().currentMode, 'elder');

  harness.setPostHandler(async () => {
    throw new Error('offline');
  });
  harness.childToggle.checked = true;
  await harness.childToggle.dispatch('change');
  await harness.form.dispatch('submit');
  assert.equal(harness.api.snapshot().currentMode, 'elder');
  assert.match(harness.statusText.textContent, /保存失败/);
});

test('AI quick scan continues to POST the risk check endpoint', () => {
  assert.match(
    SCRIPT_SOURCE,
    /async function runAiRiskScan\(\)[\s\S]*?api\.post\("\/api\/risk\/check", \{/
  );
  assert.match(
    SCRIPT_SOURCE,
    /#ai-scan-form["']\)\?\.addEventListener\("submit"/
  );
});

test('child browsing status keeps a real-data slot without fabricated minutes', () => {
  const childPreviewStart = INDEX_SOURCE.indexOf(
    '<div id="mode-preview-child"'
  );
  const childPreviewEnd = INDEX_SOURCE.indexOf(
    '<!-- 订阅 -->',
    childPreviewStart
  );
  assert.notEqual(childPreviewStart, -1);
  assert.notEqual(childPreviewEnd, -1);
  const childPreview = INDEX_SOURCE.slice(childPreviewStart, childPreviewEnd);

  assert.doesNotMatch(INDEX_SOURCE, /45\s*分钟/);
  assert.doesNotMatch(childPreview, /剩余浏览[\s\S]{0,160}\d+\s*分钟/);
  assert.match(childPreview, /<span>今日剩余浏览<\/span>/);
  assert.match(
    childPreview,
    /<strong id="childRemainingTime">--<\/strong>/
  );
  assert.match(
    childPreview,
    /浏览状态等待扩展同步；当前浏览时长保护由浏览器扩展实时执行。/
  );
  assert.match(
    childPreview,
    /<div class="child-safe-anim" aria-hidden="true">/
  );
  assert.match(
    INDEX_SOURCE,
    /<html\s+lang="zh-CN"\s+data-netguard-page="official-ui">/
  );
  assert.match(INDEX_SOURCE, /<form class="settings-form" id="ai-scan-form">/);
});
