'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const BACKGROUND_PATH = path.join(EXTENSION_ROOT, 'background.js');
const CONTENT_PATH = path.join(EXTENSION_ROOT, 'content.js');
const POPUP_PATH = path.join(EXTENSION_ROOT, 'popup.js');
const API_CONFIG_PATH = path.join(EXTENSION_ROOT, 'api-config.js');
const AD_DETECTOR_PATH = path.join(EXTENSION_ROOT, 'ad-detector.js');
const AD_HIDE_PATH = path.join(EXTENSION_ROOT, 'ad-hide.css');
const ELDER_MODE_CSS_PATH = path.join(EXTENSION_ROOT, 'elder-mode.css');
const EXTENSION_API_PATH = path.join(EXTENSION_ROOT, 'extension-api.js');
const WARNING_PATH = path.join(EXTENSION_ROOT, 'warning.js');
const MANIFEST_PATH = path.join(EXTENSION_ROOT, 'manifest.json');

const BACKGROUND_SOURCE = fs.readFileSync(BACKGROUND_PATH, 'utf8');
const CONTENT_SOURCE = fs.readFileSync(CONTENT_PATH, 'utf8');
const POPUP_SOURCE = fs.readFileSync(POPUP_PATH, 'utf8');
const API_CONFIG_SOURCE = fs.readFileSync(API_CONFIG_PATH, 'utf8');
const AD_DETECTOR_SOURCE = fs.readFileSync(AD_DETECTOR_PATH, 'utf8');
const AD_HIDE_SOURCE = fs.readFileSync(AD_HIDE_PATH, 'utf8');
const ELDER_MODE_CSS_SOURCE = fs.readFileSync(ELDER_MODE_CSS_PATH, 'utf8');
const EXTENSION_API_SOURCE = fs.readFileSync(EXTENSION_API_PATH, 'utf8');
const WARNING_SOURCE = fs.readFileSync(WARNING_PATH, 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

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

function evaluateOfficialTrustedUiPage(url, marker = null) {
  const trustedUiSource = sourceBetween(
    CONTENT_SOURCE,
    'function isOfficialTrustedUiPage()',
    '// 本地文件协议（file://）允许检测'
  );
  const parsed = new URL(url);
  const context = {
    URL,
    decodeURIComponent,
    window: {
      location: {
        href: parsed.href,
        protocol: parsed.protocol,
        pathname: parsed.pathname
      }
    },
    document: {
      documentElement: {
        getAttribute(name) {
          return name === 'data-netguard-page'
            ? marker
            : null;
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(
    `${trustedUiSource}\nthis.result = isOfficialTrustedUiPage();`,
    context
  );
  return context.result;
}

function createPopupSettingsHarness(
  initialState = {},
  runtimeResponder = async () => ({
    success: false,
    error: 'offline'
  })
) {
  const state = clone(initialState);
  const runtimeMessages = [];
  let domReady = null;
  let fetchCalls = 0;
  const context = {
    AbortController,
    URL,
    clearTimeout,
    setTimeout,
    console: { log() {}, warn() {} },
    document: {
      getElementById() {
        return null;
      },
      addEventListener(name, callback) {
        if (name === 'DOMContentLoaded') {
          domReady = callback;
        }
      }
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            return readStorage(state, keys);
          },
          async set(items) {
            Object.assign(state, clone(items));
          },
          async remove(keys) {
            const keyList = Array.isArray(keys) ? keys : [keys];
            keyList.forEach(key => delete state[key]);
          }
        }
      },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          runtimeMessages.push(clone(message));
          Promise.resolve(runtimeResponder(message))
            .then(response => callback(response));
        }
      }
    },
    async fetch() {
      fetchCalls += 1;
      throw new Error('Popup must not call Backend directly');
    }
  };

  vm.createContext(context);
  vm.runInContext(POPUP_SOURCE, context, { filename: POPUP_PATH });

  return {
    context,
    state,
    runtimeMessages,
    get fetchCalls() {
      return fetchCalls;
    },
    async dispatchDomReady() {
      assert.ok(domReady);
      await domReady();
    }
  };
}

function createChildPolicyHarness() {
  const childSettingSource = sourceBetween(
    CONTENT_SOURCE,
    'function isChildPolicyEnabled(settingName)',
    'function clearProtectionWarnings()'
  );
  const childPolicySource = sourceBetween(
    CONTENT_SOURCE,
    'function resolveChildPolicyType(siteInfo)',
    '// 检查当前网站并应用儿童模式规则'
  );
  const elements = new Map();
  const calls = [];
  const addElement = id => {
    elements.set(id, {
      id,
      remove() {
        elements.delete(id);
      }
    });
  };
  const context = {
    calls,
    console: { log() {} },
    document: {
      getElementById(id) {
        return elements.get(id) || null;
      }
    },
    addElement
  };

  vm.createContext(context);
  vm.runInContext(`
    const IS_TOP_FRAME = true;
    const AI_DEBUG = false;
    const CHILD_POLICY_DEFAULTS = Object.freeze({
      dangerousFilter: true,
      entertainmentLimit: true,
      learningMode: false
    });
    let childModeSettings = {};
    let childModeEnabled = true;
    let isChildMode = true;
    let skipProtection = false;
    let activeChildPolicyKey = null;

    function shouldSkipProtection() {
      return skipProtection;
    }
    function shouldSkipChildProtection() {
      return skipProtection;
    }
    function applyChildBrowsingLimitState() {
      return false;
    }
    function removeChildBrowsingReminder() {}
    function showChildModeBanner(type) {
      calls.push(['banner', type]);
      addElement('netguard-child-banner');
    }
    function showEntertainmentBlocker(site) {
      calls.push(['entertainment-ui', site]);
      addElement('netguard-child-overlay');
      addElement('netguard-child-popup');
    }
    function showGameBlocker(site) {
      calls.push(['game-ui', site]);
      addElement('netguard-child-overlay');
      addElement('netguard-child-popup');
    }
    function showDangerousBlocker(keyword) {
      calls.push(['dangerous-ui', keyword]);
      addElement('netguard-child-overlay');
      addElement('netguard-child-popup');
    }
    async function logEntertainmentBlock() {
      calls.push(['entertainment-log']);
    }
    async function logGameBlock() {
      calls.push(['game-log']);
    }
    async function logDangerousBlock() {
      calls.push(['dangerous-log']);
    }

    ${childSettingSource}
    ${childPolicySource}

    globalThis.setChildPolicyState = state => {
      childModeSettings = { ...(state.settings || {}) };
      childModeEnabled = state.childModeEnabled ?? true;
      isChildMode = state.isChildMode ?? childModeEnabled;
      skipProtection = Boolean(state.skipProtection);
    };
    globalThis.hasChildElement = id => Boolean(document.getElementById(id));
  `, context);

  return {
    apply(siteInfo, url = 'file:///project/demos/child/test.html') {
      return context.applyChildModePolicy(siteInfo, url);
    },
    calls,
    hasElement(id) {
      return context.hasChildElement(id);
    },
    setState(state) {
      context.setChildPolicyState(state);
    }
  };
}

function createElderModeHarness({
  url = 'https://example.test/',
  elements: initialElements = [],
  headAvailable = true
} = {}) {
  const elderSource = sourceBetween(
    CONTENT_SOURCE,
    '// ==================== 老人模式：风险关键词 ====================',
    '// ==================== 主控函数 ===================='
  );
  const domElements = new Map();
  const pageElements = [...initialElements];
  const eventLogs = [];
  const timers = new Map();
  let nextTimerId = 1;
  let lastObserver = null;

  const createClassList = (initial = []) => {
    const values = new Set(initial);
    return {
      add(...names) { names.forEach(name => values.add(name)); },
      remove(...names) { names.forEach(name => values.delete(name)); },
      contains(name) { return values.has(name); },
      values
    };
  };

  const createElement = (tagName = 'div', options = {}) => {
    const attributes = new Map(Object.entries(options.attributes || {}));
    const element = {
      id: options.id || '',
      tagName: String(tagName).toUpperCase(),
      innerText: options.text || '',
      textContent: options.text || '',
      classList: createClassList(options.classes),
      isConnected: true,
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      hasAttribute(name) {
        return attributes.has(name);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      querySelectorAll() {
        return [];
      },
      remove() {
        this.isConnected = false;
        if (this.id) domElements.delete(this.id);
      }
    };
    return element;
  };

  const documentElement = createElement('html');
  const body = createElement('body');
  const head = createElement('head');
  const appendStyleElement = element => {
    element.isConnected = true;
    if (element.id) domElements.set(element.id, element);
    return element;
  };
  head.appendChild = appendStyleElement;
  documentElement.appendChild = appendStyleElement;
  const riskModal = createElement('div', { id: 'elderRiskModal' });
  domElements.set(riskModal.id, riskModal);

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      lastObserver = this;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    trigger(records = []) {
      if (!this.disconnected) return this.callback(records);
      return undefined;
    }
  }

  const windowObject = { location: { href: url } };
  windowObject.top = windowObject;
  const context = {
    URL,
    console: { log() {}, warn() {} },
    window: windowObject,
    document: {
      body,
      head: headAvailable ? head : null,
      documentElement,
      createElement,
      getElementById(id) {
        return domElements.get(id) || null;
      },
      querySelectorAll(selector) {
        if (selector === 'video, .video-container, .player-container, [data-video]') {
          return [];
        }
        if (selector === 'a, button, [role="button"], [onclick]') {
          return pageElements;
        }
        return [];
      }
    },
    MutationObserver: FakeMutationObserver,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    extensionAPI: {
      runtime: {
        getURL(file) {
          return `chrome-extension://test/${file}`;
        }
      }
    },
    eventLogs
  };

  vm.createContext(context);
  vm.runInContext(`
    const IS_TOP_FRAME = true;
    const AI_DEBUG = false;
    let elderModeEnabled = true;
    let childModeEnabled = false;
    let protectionSkipped = false;
    let riskObserver = null;
    let riskHighlightTimer = null;
    let elderDemoTimer = null;
    let currentElderSettings = {};
    const elderRiskOriginalTitles = new Map();
    const elderRiskLoggedElements = new WeakSet();

    function shouldSkipProtection() {
      return protectionSkipped;
    }
    async function shouldSkipProtectionNow() {
      return protectionSkipped;
    }
    async function refreshRuntimeSettings() {
      return { elderSettings: currentElderSettings };
    }
    function updateRuntimeSettings() {}
    async function logElderMode(urlValue, reason) {
      eventLogs.push({ url: urlValue, reason });
    }

    globalThis.setElderHarnessState = state => {
      elderModeEnabled = state.elderModeEnabled ?? elderModeEnabled;
      childModeEnabled = state.childModeEnabled ?? childModeEnabled;
      protectionSkipped = state.protectionSkipped ?? protectionSkipped;
      currentElderSettings = { ...(state.settings || currentElderSettings) };
      if (state.url) window.location.href = state.url;
    };
  `, context);
  vm.runInContext(elderSource, context);

  return {
    context,
    createElement,
    addElement(element) {
      pageElements.push(element);
    },
    async apply(settings = {}) {
      context.setElderHarnessState({ settings });
      return context.applyCurrentElderMode({ elderSettings: settings });
    },
    setState(state) {
      context.setElderHarnessState(state);
    },
    getElement(id) {
      return domElements.get(id) || null;
    },
    hasRootClass(name) {
      return documentElement.classList.contains(name);
    },
    getRootAttribute(name) {
      return documentElement.getAttribute(name);
    },
    eventLogs,
    pendingTimers() {
      return timers.size;
    },
    async runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) {
        await timer.callback();
      }
    },
    triggerMutation() {
      lastObserver?.trigger([]);
    }
  };
}

function createElderStorageRoutingHarness() {
  const helperSource = sourceBetween(
    CONTENT_SOURCE,
    'function unifiedSettingChanged(changes, key)',
    'function normalizeHost(value)'
  );
  const listenerSource = sourceBetween(
    CONTENT_SOURCE,
    '// 按配置字段路由变化，避免老人设置重启广告或儿童策略。',
    '// 后续任何保护逻辑都必须等待暂停状态完成首次读取。'
  );
  const calls = { full: 0, elder: 0, child: 0 };
  let listener = null;
  const context = {
    calls,
    Promise,
    console: { log() {} },
    extensionAPI: {
      storage: {
        onChanged: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(`
    const RUNTIME_SETTINGS_KEYS = [
      'netguardSettings', 'modeSettings', 'adMode', 'adBlockMode',
      'elderMode', 'childMode', 'elderSettings', 'childSettings',
      'protectionPaused', 'paused', 'whitelist', 'siteWhitelist',
      'blockType'
    ];
    const runtimeSettingsReady = Promise.resolve();
    async function refreshRuntimeSettings() { return {}; }
    async function applyAllSettings() { calls.full += 1; }
    async function applyCurrentElderMode() { calls.elder += 1; }
    async function checkChildModeSite() { calls.child += 1; }
    ${helperSource}
    ${listenerSource}
  `, context);

  return {
    calls,
    async dispatch(changes) {
      listener(changes, 'local');
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

function createChildBrowsingReminderUiHarness({ topFrame = true } = {}) {
  const reminderSource = sourceBetween(
    CONTENT_SOURCE,
    "const CHILD_BROWSING_REMINDER_ID = 'netguard-child-browsing-reminder';",
    '// 显示娱乐网站限制弹窗'
  );
  const elements = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let messageListener = null;
  const bodyStyle = { paddingTop: '', marginTop: '' };

  const createElement = tagName => {
    let clickListener = null;
    const element = {
      id: '',
      tagName: String(tagName).toUpperCase(),
      dataset: {},
      style: {},
      attributes: new Map(),
      parentNode: null,
      children: [],
      innerHTML: '',
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      addEventListener(type, callback) {
        if (type === 'click') clickListener = callback;
      },
      querySelector(selector) {
        if (selector !== 'button') return null;
        return {
          addEventListener(type, callback) {
            if (type === 'click') clickListener = callback;
          },
          click() {
            clickListener?.();
          }
        };
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
        return child;
      },
      remove() {
        if (this.id) elements.delete(this.id);
        this.parentNode = null;
      },
      clickClose() {
        clickListener?.();
      }
    };
    return element;
  };

  const appendElement = element => {
    element.parentNode = body;
    if (element.id) elements.set(element.id, element);
    return element;
  };
  const body = {
    style: bodyStyle,
    appendChild: appendElement
  };
  const head = { appendChild: appendElement };
  const documentElement = { appendChild: appendElement };
  const document = {
    body,
    head,
    documentElement,
    createElement,
    getElementById(id) {
      return elements.get(id) || null;
    }
  };
  const topWindow = {};
  const windowObject = topFrame ? topWindow : { top: topWindow };
  if (topFrame) windowObject.top = windowObject;
  const context = {
    document,
    window: windowObject,
    console: { warn() {} },
    extensionAPI: {
      runtime: {
        onMessage: {
          addListener(callback) {
            messageListener = callback;
          }
        }
      }
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    const IS_TOP_FRAME = window.top === window;
    let childBrowsingReminderTimer = null;
    let childBrowsingLimitState = null;
    let childModeEnabled = true;
    let isChildMode = true;
    let skipChildProtection = false;
    let activeChildPolicyKey = null;
    function shouldSkipChildProtection() {
      return skipChildProtection;
    }
    function clearChildModeUi() {
      [
        'netguard-child-overlay',
        'netguard-child-popup',
        'netguard-child-banner'
      ].forEach(id => document.getElementById(id)?.remove());
      removeChildBrowsingReminder(true);
      activeChildPolicyKey = null;
    }
    ${reminderSource}
    globalThis.setChildLimitHarnessState = state => {
      childModeEnabled = state.childModeEnabled ?? childModeEnabled;
      isChildMode = state.isChildMode ?? isChildMode;
      skipChildProtection = state.skipChildProtection ?? skipChildProtection;
      if (state.limitState !== undefined) {
        childBrowsingLimitState = state.limitState;
      }
      if (!childModeEnabled || !isChildMode || skipChildProtection) {
        clearChildModeUi();
      }
    };
  `, context);

  return {
    dispatch(message) {
      let response;
      messageListener?.(message, {}, value => {
        response = value;
      });
      return response;
    },
    getReminder() {
      return elements.get('netguard-child-browsing-reminder') || null;
    },
    getStyle() {
      return elements.get('netguard-child-browsing-reminder-style') || null;
    },
    getLimitOverlay() {
      return elements.get('netguard-child-overlay') || null;
    },
    getLimitPopup() {
      return elements.get('netguard-child-popup') || null;
    },
    setState(state) {
      context.setChildLimitHarnessState(state);
      return context.applyChildBrowsingLimitState();
    },
    bodyStyle,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
      const followups = [...timers.values()];
      timers.clear();
      followups.forEach(callback => callback());
    }
  };
}

function createGameBlockerHarness(currentUrl) {
  const demoMappingSource = sourceBetween(
    CONTENT_SOURCE,
    'const CHILD_DEMO_SITE_TYPE_MAP =',
    '// 检查当前页面是否为演示页面'
  );
  const gameExitSource = sourceBetween(
    CONTENT_SOURCE,
    'function getGameBlockerExitAction(url)',
    '// 显示游戏网站拦截页面'
  );
  const blockerStyleSource = sourceBetween(
    CONTENT_SOURCE,
    'function ensureChildModeBlockerStyles()',
    '// 显示娱乐网站限制弹窗'
  );
  const gameBlockerSource = sourceBetween(
    CONTENT_SOURCE,
    'function showGameBlocker(site)',
    '// 显示危险网站拦截页面'
  );
  const elements = new Map();
  const backButton = {
    addEventListener(eventName, callback) {
      this[eventName] = callback;
    }
  };
  const registerTree = element => {
    if (element.id) elements.set(element.id, element);
    element.children.forEach(registerTree);
  };
  const createElement = tagName => ({
    tagName,
    id: '',
    className: '',
    children: [],
    style: {},
    textContent: '',
    innerHTML: '',
    appendChild(child) {
      this.children.push(child);
      registerTree(child);
      return child;
    }
  });
  const head = createElement('head');
  const body = createElement('body');
  let replacedTo = null;
  let historyBackCount = 0;
  const context = {
    URL,
    console: { log() {} },
    document: {
      body,
      head,
      createElement,
      getElementById(id) {
        if (id === 'netguard-child-back-btn') return backButton;
        return elements.get(id) || null;
      }
    },
    window: {
      location: {
        href: currentUrl,
        replace(target) {
          replacedTo = target;
        }
      },
      history: {
        back() {
          historyBackCount += 1;
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(`
    const AI_DEBUG = false;
    function removeChildModeOverlay() {}
    ${demoMappingSource}
    ${gameExitSource}
    ${blockerStyleSource}
    ${gameBlockerSource}
  `, context);
  context.showGameBlocker('儿童模式游戏网站');

  const overlay = body.children[0];
  return {
    backButton,
    elements,
    overlay,
    popup: overlay.children[0],
    clickBack() {
      backButton.click();
    },
    get historyBackCount() {
      return historyBackCount;
    },
    get replacedTo() {
      return replacedTo;
    }
  };
}

async function drainInitialization() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function createBackgroundHarness(
  initialState = {},
  options = {}
) {
  const state = options.sharedState || clone(initialState);
  const requests = [];
  const tabUpdates = [];
  const dynamicRuleUpdates = [];
  const sentTabMessages = [];
  const createdAlarms = [];
  const clearedAlarms = [];
  const alarms = options.sharedAlarms || new Map();
  let activeTabs = clone(options.activeTabs || []);
  let focusedWindow = clone(options.focusedWindow || {
    id: 1,
    focused: true
  });
  let idleState = options.idleState || 'active';
  let sendMessageError = options.sendMessageError || null;
  let fetchImplementation = options.fetchImplementation || (
    async () => createApiResponse(201, {
      code: 0,
      message: 'success',
      data: {}
    })
  );

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
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach(key => delete state[key]);
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
        return clone(activeTabs);
      },
      async get() {
        return { id: 1, url: 'https://example.com' };
      },
      async update(tabId, updateProperties) {
        tabUpdates.push({ tabId, updateProperties: clone(updateProperties) });
      },
      async sendMessage(tabId, message, sendOptions) {
        sentTabMessages.push({
          tabId,
          message: clone(message),
          options: clone(sendOptions)
        });
        if (sendMessageError) throw sendMessageError;
        return { shown: true };
      }
    },
    windows: {
      async getLastFocused() {
        return clone(focusedWindow);
      }
    },
    idle: {
      async queryState() {
        return idleState;
      }
    },
    webNavigation: {
      onCommitted: createEventTarget()
    },
    alarms: {
      create(name, alarmInfo) {
        createdAlarms.push({ name, alarmInfo: clone(alarmInfo) });
        alarms.set(name, { name, ...clone(alarmInfo) });
      },
      async get(name) {
        return clone(alarms.get(name) || null);
      },
      async clear(name) {
        clearedAlarms.push(name);
        return alarms.delete(name);
      },
      onAlarm: createEventTarget()
    },
    declarativeNetRequest: {
      async updateDynamicRules(update) {
        dynamicRuleUpdates.push(clone(update));
      }
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
    API_CONFIG_SOURCE,
    context,
    { filename: API_CONFIG_PATH }
  );
  vm.runInContext(
    BACKGROUND_SOURCE,
    context,
    { filename: BACKGROUND_PATH }
  );
  await drainInitialization();
  if (!options.keepInitializationRequests) {
    requests.length = 0;
  }

  return {
    context,
    dispatch(
      message,
      sender = {
        tab: {
          id: 1,
          url: message?.event?.page_url || 'https://example.com'
        }
      }
    ) {
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
    tabUpdates,
    dynamicRuleUpdates,
    sentTabMessages,
    createdAlarms,
    clearedAlarms,
    alarms,
    dispatchAlarm(alarm) {
      return chrome.alarms.onAlarm.dispatch(alarm);
    },
    dispatchStartup() {
      return chrome.runtime.onStartup.dispatch();
    },
    dispatchStorageChange(changes) {
      return chrome.storage.onChanged.dispatch(changes, 'local');
    },
    setActiveTabs(tabs) {
      activeTabs = clone(tabs || []);
    },
    setFocusedWindow(value) {
      focusedWindow = clone(value);
    },
    setIdleState(value) {
      idleState = value;
    },
    setSendMessageError(error) {
      sendMessageError = error;
    },
    setFetchImplementation(implementation) {
      fetchImplementation = implementation;
    },
    state
  };
}

function parseRequest(request) {
  return JSON.parse(request.options.body);
}

function createAdPipelineHarness({ pageUrl = 'https://shop.example.test/' } = {}) {
  const pipelineSource = sourceBetween(
    CONTENT_SOURCE,
    'const AD_TOKENS = new Set([',
    '// ==================== 老人模式：风险关键词'
  );
  const reconcileSource = sourceBetween(
    CONTENT_SOURCE,
    'async function reconcileAdElements(mode)',
    '// ==================== 主控函数 ===================='
  );
  const stats = [];
  const observers = [];
  const timers = new Map();
  let nextTimerId = 1;
  let detector = null;
  let candidateDocumentScans = 0;
  let candidateSubtreeScans = 0;
  let document = null;

  const descendantElements = element => {
    const result = [];
    for (const child of element.children) {
      result.push(child, ...descendantElements(child));
    }
    return result;
  };
  const isInteractive = element => [
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'VIDEO', 'AUDIO'
  ].includes(element.tagName) || element.hasAttribute('contenteditable');
  const isCoreContent = element => [
    'HEADER', 'NAV', 'MAIN', 'ARTICLE', 'SECTION', 'FORM'
  ].includes(element.tagName) || element.getAttribute('role') === 'main';
  const hasPromotionMarker = element => detector.hasPromotionMarker(element.className) ||
    detector.hasPromotionMarker(element.id) || element.hasAttribute('data-promo');
  const isCandidate = (element, selector) => {
    if (!selector) return false;
    if (['data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-client', 'data-ad-demo', 'data-sponsor']
      .some(name => element.hasAttribute(name))) return true;
    if (element.tagName === 'INS' && element.classList.contains('adsbygoogle')) return true;
    if (element.tagName === 'IFRAME' && element.hasAttribute('src')) return true;
    if (element.tagName === 'IMG' && element.hasAttribute('src')) return true;
    if ((element.getAttribute('style') || '').includes('background-image')) return true;
    if (detector.hasAdMarker(element.className) || detector.hasAdMarker(element.id)) return true;
    return selector.includes('[data-promo]') && hasPromotionMarker(element);
  };

  class FakeElement {
    constructor(tagName = 'DIV', attributes = {}, options = {}) {
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this.id = options.id || attributes.id || '';
      this.className = options.className || attributes.class || '';
      this.textContent = options.textContent || '';
      this.children = [];
      this.parentElement = null;
      this.ownerDocument = null;
      this._attributes = new Map(Object.entries(attributes).filter(([name]) => !['id', 'class'].includes(name)));
      this.src = attributes.src || '';
      this.href = attributes.href || '';
      this._classes = new Set(this.className.split(/\s+/).filter(Boolean));
      this._styleValues = new Map();
      this._stylePriorities = new Map();
      this.classList = {
        add: (...names) => {
          names.forEach(name => this._classes.add(name));
          this.className = [...this._classes].join(' ');
        },
        remove: (...names) => {
          names.forEach(name => this._classes.delete(name));
          this.className = [...this._classes].join(' ');
        },
        contains: name => this._classes.has(name)
      };
      this.style = {
        setProperty: (name, value, priority = '') => {
          this._styleValues.set(name, String(value));
          this._stylePriorities.set(name, priority);
          this._attributes.set('style', [...this._styleValues].map(([property, propertyValue]) =>
            `${property}:${propertyValue}${this._stylePriorities.get(property) ? ` !${this._stylePriorities.get(property)}` : ''}`
          ).join(';'));
        },
        getPropertyValue: name => this._styleValues.get(name) || '',
        getPropertyPriority: name => this._stylePriorities.get(name) || ''
      };
      this.rect = options.rect || { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }

    append(...elements) {
      for (const element of elements) {
        element.parentElement = this;
        element.ownerDocument = this.ownerDocument;
        this.children.push(element);
        for (const descendant of descendantElements(element)) descendant.ownerDocument = this.ownerDocument;
      }
    }

    contains(element) {
      return element === this || descendantElements(this).includes(element);
    }

    getAttribute(name) {
      if (name === 'id') return this.id || null;
      if (name === 'class') return this.className || null;
      return this._attributes.has(name) ? this._attributes.get(name) : null;
    }

    hasAttribute(name) {
      if (name === 'id') return Boolean(this.id);
      if (name === 'class') return Boolean(this.className);
      return this._attributes.has(name);
    }

    setAttribute(name, value) {
      if (name === 'id') this.id = String(value);
      else if (name === 'class') {
        this.className = String(value);
        this._classes = new Set(this.className.split(/\s+/).filter(Boolean));
      } else {
        this._attributes.set(name, String(value));
        if (name === 'src') this.src = String(value);
        if (name === 'href') this.href = String(value);
        if (name === 'style') {
          this._styleValues.clear();
          this._stylePriorities.clear();
          for (const declaration of String(value).split(';')) {
            const [property, ...rawValue] = declaration.split(':');
            if (!property || rawValue.length === 0) continue;
            const parsedValue = rawValue.join(':').trim();
            const important = /\s*!important$/i.test(parsedValue);
            this._styleValues.set(property.trim(), parsedValue.replace(/\s*!important$/i, '').trim());
            this._stylePriorities.set(property.trim(), important ? 'important' : '');
          }
        }
      }
    }

    removeAttribute(name) {
      if (name === 'id') this.id = '';
      else if (name === 'class') {
        this.className = '';
        this._classes.clear();
      } else {
        this._attributes.delete(name);
        if (name === 'style') {
          this._styleValues.clear();
          this._stylePriorities.clear();
        }
      }
    }

    getBoundingClientRect() {
      return this.rect;
    }

    matches(selector) {
      return isCandidate(this, selector);
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (selector.includes('.ad-hidden-normal') &&
            (current.classList.contains('ad-hidden-normal') || current.classList.contains('ad-hidden-strict'))) {
          return current;
        }
        if (selector.includes('header,nav,main,article,section,form') && isCoreContent(current)) return current;
        if (selector.includes('[data-upload-policy-url]') && (
          isCoreContent(current) || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO', 'AUDIO'].includes(current.tagName)
        )) return current;
        current = current.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const descendants = descendantElements(this);
      if (selector === '*') return descendants;
      if (selector.startsWith('input,textarea,select,button,a,')) {
        return descendants.filter(isInteractive);
      }
      if (selector.includes('.ad-hidden-normal')) {
        return descendants.filter(element =>
          element.classList.contains('ad-hidden-normal') || element.classList.contains('ad-hidden-strict'));
      }
      if (selector.includes('[data-ad]')) {
        candidateSubtreeScans++;
        return descendants.filter(element => isCandidate(element, selector));
      }
      return [];
    }

    querySelector(selector) {
      if (selector.includes('header,nav,main,article,section,form')) {
        return descendantElements(this).find(isCoreContent) || null;
      }
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const html = new FakeElement('HTML');
  const body = new FakeElement('BODY');
  document = {
    location: { href: pageUrl },
    documentElement: html,
    body,
    querySelectorAll(selector) {
      if (selector.includes('[data-ad]')) candidateDocumentScans++;
      return descendantElements(body).filter(element => {
        if (selector.includes('.ad-hidden-normal')) {
          return element.classList.contains('ad-hidden-normal') || element.classList.contains('ad-hidden-strict');
        }
        return isCandidate(element, selector);
      });
    },
    createTreeWalker() {
      return { nextNode() { return null; } };
    },
    getElementById() { return null; }
  };
  html.ownerDocument = document;
  body.ownerDocument = document;
  html.append(body);

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = false;
      observers.push(this);
    }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    trigger(mutations) { this.callback(mutations); }
  }

  const context = {
    URL,
    Node: { ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: FakeMutationObserver,
    document,
    location: document.location,
    console: { log() {}, warn() {}, error() {} },
    currentMode: 'normal',
    adBlockMode: 'normal',
    DEBUG: false,
    AI_DEBUG: false,
    shouldSkipProtection() { return false; },
    checkIfDemoPage() { return false; },
    getAdEventPageUrl() { return pageUrl; },
    getAdResourceType(element) { return element.tagName.toLowerCase(); },
    async updateStorageStats(type, increment, metadata) {
      stats.push({ type, increment, metadata });
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(AD_DETECTOR_SOURCE, context, { filename: AD_DETECTOR_PATH });
  detector = context.NetGuardAdDetector;
  vm.runInContext(
    `${pipelineSource}\n${reconcileSource}\n` +
    'globalThis.__adPipeline = { handleAdElement, purgeAllAds, startObserver, reconcileAdElements, ' +
    'isAdElement, findStrictAdShellFromLabel };',
    context,
    { filename: CONTENT_PATH }
  );

  const mount = (...elements) => body.append(...elements);
  const flushTimers = async () => {
    while (timers.size) {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) await callback();
    }
  };
  const activeObserverCount = () => observers.filter(observer => observer.active).length;
  const scheduleMutations = mutations => {
    const observer = [...observers].reverse().find(item => item.active);
    assert.ok(observer, 'expected one active MutationObserver');
    observer.trigger(mutations);
  };
  const scheduleAdded = element => {
    scheduleMutations([{ type: 'childList', addedNodes: [element] }]);
  };
  const triggerAdded = async element => {
    scheduleAdded(element);
    await flushTimers();
  };
  const triggerMutations = async mutations => {
    scheduleMutations(mutations);
    await flushTimers();
  };
  const takeScheduledCallbacks = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    return callbacks;
  };

  return {
    api: context.__adPipeline,
    createElement: (tagName, attributes, options) => new FakeElement(tagName, attributes, options),
    mount,
    stats,
    observers,
    activeObserverCount,
    scheduleAdded,
    triggerAdded,
    triggerMutations,
    takeScheduledCallbacks,
    get candidateDocumentScans() { return candidateDocumentScans; },
    get candidateSubtreeScans() { return candidateSubtreeScans; }
  };
}

const CHILD_REMINDER_ALARM = 'netguardChildBrowsingReminderTick';
const CHILD_REMINDER_STATE_KEY = 'childBrowsingReminderState';

function createChildReminderStorage({
  enabled = true,
  paused = false,
  minutes = 5,
  limitMinutes = minutes,
  globalWhitelist = [],
  childWhitelist = []
} = {}) {
  return {
    netguardUnifiedSettingsMigrated: true,
    netguardSettings: {
      adMode: 'normal',
      elderMode: false,
      childMode: enabled,
      protectionPaused: paused,
      paused,
      whitelist: globalWhitelist
    },
    childSettings: {
      dailyReminderMinutes: minutes,
      dailyLimitMinutes: limitMinutes,
      childWhitelist,
      learningWhitelist: childWhitelist
    }
  };
}

async function dispatchChildReminderTicks(harness, count) {
  for (let index = 0; index < count; index += 1) {
    await harness.dispatchAlarm({ name: CHILD_REMINDER_ALARM });
  }
}

test('first install persists the exact four-field mode structure with child off', async () => {
  const harness = await createBackgroundHarness();

  assert.deepEqual(
    harness.state.netguardSettings,
    {
      adMode: 'normal',
      elderMode: false,
      childMode: false,
      paused: false
    }
  );
  assert.equal(harness.state.netguardUnifiedSettingsMigrated, true);
  for (const legacyKey of [
    'adMode',
    'adBlockMode',
    'elderMode',
    'childMode',
    'protectionPaused',
    'paused'
  ]) {
    assert.equal(harness.state[legacyKey], undefined);
  }
});

test('risk event uses only the v1.0.1 score contract', async () => {
  const retiredField = ['risk', 'score'].join('_');
  assert.equal(BACKGROUND_SOURCE.includes(retiredField), false);
  assert.equal(CONTENT_SOURCE.includes(retiredField), false);

  const harness = await createBackgroundHarness();
  await harness.context.enqueueSecurityEvent({
    type: 'ai_check',
    risk_level: 'high',
    score: 0.82,
    url: 'https://example.com/risk',
    reason: '本地检测命中风险内容'
  });
  await harness.context.flushSecurityEvents();

  const payload = parseRequest(harness.requests[0]);
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
});

test('risk event retry policy drops 400 and bounds HTTP 500 attempts', async () => {
  const invalidHarness = await createBackgroundHarness();
  invalidHarness.setFetchImplementation(async () =>
    createApiResponse(400, {
      code: 400,
      message: 'invalid risk event'
    })
  );
  await invalidHarness.context.enqueueSecurityEvent({
    type: 'dangerous_block',
    risk_level: 'high',
    score: 0.95,
    url: 'https://example.com/invalid-risk',
    reason: 'validation test'
  });
  await invalidHarness.context.flushSecurityEvents();
  await invalidHarness.context.flushSecurityEvents();

  assert.equal(invalidHarness.requests.length, 1);
  assert.deepEqual(invalidHarness.state.pendingSecurityEvents, []);
  assert.equal(
    invalidHarness.state.failedSecurityEvents[0].failure_reason,
    'validation'
  );

  const serverHarness = await createBackgroundHarness();
  serverHarness.setFetchImplementation(async () =>
    createApiResponse(500, {
      code: 500,
      message: 'server failure'
    })
  );
  await serverHarness.context.enqueueSecurityEvent({
    type: 'dangerous_block',
    risk_level: 'high',
    score: 0.95,
    url: 'https://example.com/server-risk',
    reason: 'server retry test'
  });
  await serverHarness.context.flushSecurityEvents();
  await serverHarness.context.flushSecurityEvents();
  await serverHarness.context.flushSecurityEvents();

  assert.equal(serverHarness.requests.length, 3);
  assert.equal(new Set(serverHarness.requests.map(request =>
    parseRequest(request).event_uuid
  )).size, 1);
  assert.deepEqual(serverHarness.state.pendingSecurityEvents, []);
  assert.equal(
    serverHarness.state.failedSecurityEvents[0].failure_reason,
    'server_retry_exhausted'
  );
});

test('ad blocks are aggregated once per page with an exact blocked_count', async () => {
  const harness = await createBackgroundHarness();

  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/page-a',
      increment: 1,
      mode: 'normal',
      resource_type: 'iframe'
    }
  });
  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/page-a',
      increment: 2,
      mode: 'normal',
      resource_type: 'image'
    }
  });
  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/page-a',
      increment: 3,
      mode: 'normal',
      resource_type: 'script'
    }
  });

  assert.equal(harness.requests.length, 0);
  assert.equal(
    Object.values(harness.state.pendingAdPageAggregates)[0].blocked_count,
    6
  );

  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: {
      page_url: 'https://example.com/page-a'
    }
  });

  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/page-b',
      increment: 2,
      mode: 'strict',
      resource_type: 'script'
    }
  });
  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: {
      page_url: 'https://example.com/page-b'
    }
  });

  assert.equal(harness.requests.length, 2);
  const payloads = harness.requests.map(parseRequest);
  assert.deepEqual(
    payloads.map(item => item.blocked_count),
    [6, 2]
  );
  assert.deepEqual(
    payloads.map(item => item.page_url),
    [
      'https://example.com/page-a',
      'https://example.com/page-b'
    ]
  );
  payloads.forEach(payload => {
    assert.deepEqual(
      Object.keys(payload),
      [
        'event_uuid',
        'page_url',
        'blocked_count',
        'mode',
        'resource_type'
      ]
    );
  });
  assert.equal(
    payloads.reduce((total, item) => total + item.blocked_count, 0),
    8
  );
  assert.equal(payloads[0].resource_type, 'mixed');
});

test('page aggregation stays the only upload source across flush triggers and restart', async () => {
  const pageUrl = 'https://example.com/single-source';
  const harness = await createBackgroundHarness({
    netguardStats: { adBlockCount: 0 },
    lastUploadedAdBlockCount: 0,
    pendingAdApiEvents: [],
    pendingAdPageAggregates: {}
  });

  for (const increment of [1, 2, 3]) {
    harness.state.netguardStats.adBlockCount += increment;
    await harness.dispatch({
      type: 'NETGUARD_AD_BLOCKED',
      event: {
        page_url: pageUrl,
        increment,
        mode: 'normal',
        resource_type: 'element'
      }
    });
  }

  assert.equal(harness.requests.length, 0);
  assert.equal(
    Object.values(
      harness.state.pendingAdPageAggregates
    )[0].blocked_count,
    6
  );

  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: { page_url: pageUrl }
  });

  const adRequests = () => harness.requests.filter(
    request => request.url.endsWith('/api/events/ad')
  );
  assert.equal(adRequests().length, 1);
  assert.equal(parseRequest(adRequests()[0]).blocked_count, 6);
  assert.equal(
    harness.state.lastUploadedAdBlockCount,
    6
  );

  await harness.dispatchAlarm({
    name: 'netguardBatchUpload'
  });
  await harness.dispatch({
    type: 'NETGUARD_FLUSH_EVENTS'
  });
  assert.equal(adRequests().length, 1);

  const restarted = await createBackgroundHarness(
    harness.state,
    { keepInitializationRequests: true }
  );
  await restarted.dispatchStartup();
  assert.equal(
    restarted.requests.filter(request =>
      request.url.endsWith('/api/events/ad')
    ).length,
    0
  );
});

test('normal strict elder and child modes reach the ad endpoint', async () => {
  const harness = await createBackgroundHarness();
  const modes = ['normal', 'strict', 'elder', 'child'];

  for (const [index, mode] of modes.entries()) {
    const response = await harness.dispatch({
      type: 'NETGUARD_AD_BLOCKED',
      event: {
        page_url: `https://example.com/${mode}`,
        increment: index + 1,
        mode,
        resource_type: 'mixed'
      }
    });
    assert.equal(response.success, true);
    assert.equal(response.accepted, true);
    await harness.dispatch({
      type: 'NETGUARD_AD_PAGE_COMPLETE',
      force: true,
      event: {
        page_url: `https://example.com/${mode}`
      }
    });
  }

  assert.deepEqual(
    harness.requests.map(request => parseRequest(request).mode),
    modes
  );
  assert.ok(harness.requests.every(
    request => request.url === 'http://127.0.0.1:5000/api/events/ad'
  ));
});

test('paused mode suppresses risk and ad uploads', async () => {
  const harness = await createBackgroundHarness({
    netguardSettings: {
      adMode: 'normal',
      elderMode: false,
      childMode: false,
      paused: true,
      whitelist: []
    }
  });

  await harness.context.enqueueSecurityEvent({
    type: 'dangerous_block',
    risk_level: 'high',
    score: 0.95,
    url: 'https://example.com/paused-risk',
    reason: '暂停状态不应上报'
  });
  const response = await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/paused-ad',
      increment: 4,
      mode: 'normal',
      resource_type: 'image'
    }
  });

  assert.equal(response.success, true);
  assert.equal(response.accepted, false);
  assert.equal(response.skipped, true);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.state.pendingSecurityEvents, undefined);
  assert.equal(harness.state.pendingAdApiEvents, undefined);
  assert.equal(harness.state.pendingAdPageAggregates, undefined);
});

test('whitelist disables risk checks, risk events, ad events and static rules', async () => {
  const harness = await createBackgroundHarness({
    netguardUnifiedSettingsMigrated: true,
    netguardSettings: {
      adMode: 'strict',
      elderMode: false,
      childMode: false,
      paused: false
    },
    whitelist: ['allowed.example'],
    siteWhitelist: ['allowed.example']
  });

  await harness.context.enqueueSecurityEvent({
    type: 'dangerous_block',
    risk_level: 'high',
    score: 0.95,
    url: 'https://sub.allowed.example/local-risk',
    reason: 'whitelist test'
  });
  await harness.context.performUrlCheck(
    'https://allowed.example/gambling-demo.html',
    4
  );
  const adResponse = await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://allowed.example/article',
      increment: 3,
      mode: 'strict',
      resource_type: 'iframe'
    }
  });
  await harness.context.syncWhitelistRules();

  assert.equal(adResponse.skipped, true);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.tabUpdates.length, 0);
  assert.equal(harness.state.pendingSecurityEvents, undefined);
  assert.equal(harness.state.pendingAdPageAggregates, undefined);

  const latestRules = harness.dynamicRuleUpdates.at(-1);
  const allowRule = latestRules.addRules.find(rule => rule.id === 900001);
  assert.equal(allowRule.action.type, 'allow');
  assert.deepEqual(allowRule.condition.initiatorDomains, ['allowed.example']);
  assert.ok(allowRule.priority > 1);
});

test('child whitelist does not bypass global ad or risk protection', async () => {
  const childOnlyUrl = 'https://allowed-child.example/gambling-demo.html';
  const harness = await createBackgroundHarness(
    createChildReminderStorage({
      childWhitelist: ['allowed-child.example']
    })
  );
  harness.setFetchImplementation(async () => createApiResponse(200, {
    code: 0,
    message: 'success',
    data: {
      risk_level: 'high',
      score: 0.98,
      reason: 'child whitelist must retain risk protection'
    }
  }));

  await harness.context.enqueueSecurityEvent({
    type: 'dangerous_block',
    risk_level: 'high',
    score: 0.98,
    url: childOnlyUrl,
    reason: 'child whitelist risk event'
  });
  await harness.context.performUrlCheck(childOnlyUrl, 23);
  const adResponse = await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: childOnlyUrl,
      increment: 2,
      mode: 'normal',
      resource_type: 'iframe'
    }
  });
  await harness.context.syncWhitelistRules();

  assert.equal(adResponse.accepted, true);
  assert.equal(adResponse.aggregated, true);
  assert.equal(harness.state.pendingSecurityEvents.length, 1);
  assert.ok(harness.state.pendingAdPageAggregates);
  assert.equal(
    harness.requests.filter(request => request.url.endsWith('/api/risk/check')).length,
    1
  );
  assert.equal(harness.tabUpdates.length, 1);

  const latestRules = harness.dynamicRuleUpdates.at(-1);
  assert.equal(
    (latestRules.addRules || []).some(rule => rule.id === 900001),
    false
  );
});

test('protectionPaused blocks gambling URL checks before the API and warning page', async () => {
  const harness = await createBackgroundHarness({
    protectionPaused: true,
    paused: true,
    netguardSettings: {
      adMode: 'normal',
      elderMode: false,
      childMode: false,
      protectionPaused: false,
      paused: false,
      whitelist: []
    }
  });

  await harness.context.performUrlCheck(
    'file:///project/demos/url/gambling-demo.html',
    7
  );

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.tabUpdates.length, 0);
  assert.equal(harness.state.netguardStats, undefined);
});

test('pausing during a risk request discards the response before warning navigation', async () => {
  const harness = await createBackgroundHarness();

  harness.setFetchImplementation(async () => {
    harness.state.netguardSettings = {
      ...harness.state.netguardSettings,
      protectionPaused: true,
      paused: true
    };
    harness.state.protectionPaused = true;
    harness.state.paused = true;

    return createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        risk_level: 'high',
        score: 0.99,
        reason: '赌博风险演示'
      }
    });
  });

  await harness.context.performUrlCheck(
    'file:///project/demos/url/gambling-demo.html',
    8
  );

  assert.equal(harness.requests.length, 1);
  assert.equal(
    harness.requests[0].url,
    'http://127.0.0.1:5000/api/risk/check'
  );
  assert.equal(harness.tabUpdates.length, 0);
});

test('ad retry reuses UUID and code 1 clears the exact queue', async () => {
  const harness = await createBackgroundHarness();
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

  const response = await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/retry',
      increment: 6,
      mode: 'elder',
      resource_type: 'iframe'
    }
  });

  assert.equal(response.success, true);
  assert.equal(response.accepted, true);
  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: {
      page_url: 'https://example.com/retry'
    }
  });
  assert.equal(harness.state.pendingAdApiEvents.length, 1);
  const firstPayload = parseRequest(harness.requests[0]);

  await harness.context.flushAdEventQueue();
  const secondPayload = parseRequest(harness.requests[1]);

  assert.equal(secondPayload.event_uuid, firstPayload.event_uuid);
  assert.equal(secondPayload.blocked_count, firstPayload.blocked_count);
  assert.deepEqual(harness.state.pendingAdApiEvents, []);
});

test('HTTP 400 ad events are quarantined without another retry', async () => {
  const harness = await createBackgroundHarness();
  harness.setFetchImplementation(async () =>
    createApiResponse(400, {
      code: 400,
      message: 'blocked_count invalid'
    })
  );

  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/invalid-ad',
      increment: 2,
      mode: 'normal',
      resource_type: 'image'
    }
  });
  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: { page_url: 'https://example.com/invalid-ad' }
  });

  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.state.pendingAdApiEvents, []);
  assert.equal(harness.state.failedAdEvents.length, 1);
  assert.equal(harness.state.failedAdEvents[0].failure_reason, 'validation');

  await harness.context.flushAdEventQueue();
  assert.equal(harness.requests.length, 1);
});

test('HTTP 500 ad events stop after three attempts with the same UUID', async () => {
  const harness = await createBackgroundHarness();
  harness.setFetchImplementation(async () =>
    createApiResponse(500, {
      code: 500,
      message: 'temporary server failure'
    })
  );

  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/server-error',
      increment: 4,
      mode: 'strict',
      resource_type: 'script'
    }
  });
  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: { page_url: 'https://example.com/server-error' }
  });
  await harness.context.flushAdEventQueue();
  await harness.context.flushAdEventQueue();

  assert.equal(harness.requests.length, 3);
  const uuids = harness.requests.map(request =>
    parseRequest(request).event_uuid
  );
  assert.equal(new Set(uuids).size, 1);
  assert.deepEqual(harness.state.pendingAdApiEvents, []);
  assert.equal(
    harness.state.failedAdEvents[0].failure_reason,
    'server_retry_exhausted'
  );
  assert.equal(harness.state.failedAdEvents[0].attempts, 3);

  await harness.context.flushAdEventQueue();
  assert.equal(harness.requests.length, 3);
});

test('HTTP 503 retains the UUID until a terminal code 1 response', async () => {
  const harness = await createBackgroundHarness();
  let attempt = 0;
  harness.setFetchImplementation(async () => {
    attempt += 1;
    if (attempt < 3) {
      return createApiResponse(503, {
        code: 503,
        message: 'service unavailable'
      });
    }
    return createApiResponse(200, {
      code: 1,
      message: 'already accepted'
    });
  });

  await harness.dispatch({
    type: 'NETGUARD_AD_BLOCKED',
    event: {
      page_url: 'https://example.com/unavailable',
      increment: 5,
      mode: 'elder',
      resource_type: 'iframe'
    }
  });
  await harness.dispatch({
    type: 'NETGUARD_AD_PAGE_COMPLETE',
    force: true,
    event: { page_url: 'https://example.com/unavailable' }
  });
  await harness.context.flushAdEventQueue();
  await harness.context.flushAdEventQueue();

  assert.equal(harness.requests.length, 3);
  assert.equal(new Set(harness.requests.map(request =>
    parseRequest(request).event_uuid
  )).size, 1);
  assert.deepEqual(harness.state.pendingAdApiEvents, []);
  assert.deepEqual(harness.state.failedAdEvents, []);
});

test('API base URL is centralized and can be overridden from storage', async () => {
  const productionSources = new Map([
    ['api-config.js', API_CONFIG_SOURCE],
    ['background.js', BACKGROUND_SOURCE],
    ['content.js', CONTENT_SOURCE],
    ['popup.js', POPUP_SOURCE]
  ]);
  const sourcesWithDefault = [...productionSources]
    .filter(([, source]) => source.includes('http://127.0.0.1:5000'))
    .map(([name]) => name);
  assert.deepEqual(sourcesWithDefault, ['api-config.js']);

  const harness = await createBackgroundHarness({
    netguardApiBaseUrl: 'https://api.example.test/v1/'
  });
  await harness.context.enqueueSecurityEvent({
    type: 'dangerous_block',
    risk_level: 'high',
    score: 0.9,
    url: 'https://example.com/configured-api',
    reason: 'configuration test'
  });
  await harness.context.flushSecurityEvents();

  assert.equal(
    harness.requests[0].url,
    'https://api.example.test/v1/api/events/risk'
  );
});

test('background coordinator syncs paused and all four modes with the settings contract', async () => {
  const cases = [
    [{ adMode: 'normal', elderMode: false, childMode: false, paused: false }, 'normal'],
    [{ adMode: 'strict', elderMode: false, childMode: false, paused: true }, 'strict'],
    [{ adMode: 'normal', elderMode: true, childMode: false, paused: false }, 'elder'],
    [{ adMode: 'normal', elderMode: false, childMode: true, paused: false }, 'child']
  ];

  for (const [settings, expectedMode] of cases) {
    const harness = await createBackgroundHarness({
      netguardSettings: settings,
      settingsSyncPending: true
    });
    harness.setFetchImplementation(async () => createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {
        mode: expectedMode,
        elder_mode: expectedMode === 'elder',
        child_mode: expectedMode === 'child',
        paused: settings.paused
      }
    }));

    const result = await harness.context
      .synchronizeSettingsWithBackend('test-four-modes');
    const request = harness.requests.at(-1);
    const payload = parseRequest(request);

    assert.equal(result.success, true);
    assert.equal(result.direction, 'push');
    assert.equal(request.url, 'http://127.0.0.1:5000/api/settings');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(
      Object.keys(payload),
      ['mode', 'elder_mode', 'child_mode', 'paused']
    );
    assert.equal(payload.mode, expectedMode);
    assert.equal(payload.elder_mode, expectedMode === 'elder');
    assert.equal(payload.child_mode, expectedMode === 'child');
    assert.equal(payload.paused, settings.paused);
    assert.equal(harness.state.settingsSyncPending, false);
  }
});

test('shared settings normalizer applies child elder strict normal priority and keeps pause independent', async () => {
  const harness = await createBackgroundHarness();
  const normalize = value => harness.context.normalizeSharedSettings(value);

  const normal = normalize({ mode: 'normal', paused: false });
  assert.equal(normal.mode, 'normal');
  assert.equal(normal.elder_mode, false);
  assert.equal(normal.child_mode, false);

  const strict = normalize({ mode: 'strict', paused: true });
  assert.equal(strict.mode, 'strict');
  assert.equal(strict.paused, true);

  const elderConflict = normalize({
    mode: 'strict',
    elder_mode: true,
    child_mode: false,
    paused: true
  });
  assert.equal(elderConflict.mode, 'elder');
  assert.equal(elderConflict.elder_mode, true);
  assert.equal(elderConflict.child_mode, false);
  assert.equal(elderConflict.paused, true);

  const childConflict = normalize({
    mode: 'elder',
    elder_mode: true,
    child_mode: true,
    paused: false
  });
  assert.equal(childConflict.mode, 'child');
  assert.equal(childConflict.elder_mode, false);
  assert.equal(childConflict.child_mode, true);
});

test('background initialization and browser startup hydrate local settings from Backend', async () => {
  let serverSettings = {
    mode: 'strict',
    elder_mode: false,
    child_mode: false,
    paused: true
  };
  const harness = await createBackgroundHarness(
    {
      netguardSettings: {
        adMode: 'normal',
        elderMode: false,
        childMode: false,
        paused: false
      }
    },
    {
      keepInitializationRequests: true,
      fetchImplementation: async () => createApiResponse(200, {
        code: 0,
        message: 'success',
        data: serverSettings
      })
    }
  );

  assert.equal(harness.requests.length, 0);
  await harness.dispatchStartup();

  assert.equal(harness.requests[0].options.method, 'GET');
  assert.equal(harness.state.netguardSettings.adMode, 'strict');
  assert.equal(harness.state.netguardSettings.paused, true);

  serverSettings = {
    mode: 'elder',
    elder_mode: true,
    child_mode: false,
    paused: false
  };
  harness.requests.length = 0;
  await harness.dispatchStartup();

  assert.equal(harness.requests[0].options.method, 'GET');
  assert.equal(harness.state.netguardSettings.elderMode, true);
  assert.equal(harness.state.netguardSettings.childMode, false);
  assert.equal(harness.state.netguardSettings.paused, false);
});

test('popup open asks Background to synchronize and never calls Backend directly', async () => {
  const popup = createPopupSettingsHarness();
  await popup.dispatchDomReady();

  assert.deepEqual(popup.runtimeMessages, [{
    type: 'NETGUARD_SYNC_SETTINGS',
    reason: 'popup-open'
  }]);
  assert.equal(popup.fetchCalls, 0);
});

test('popup changes local settings immediately, marks pending and delegates synchronization', async () => {
  const popup = createPopupSettingsHarness();
  await vm.runInContext(
    "updateSettings({ adMode: 'strict', protectionPaused: true, paused: true })",
    popup.context
  );

  assert.equal(popup.state.netguardSettings.adMode, 'strict');
  assert.equal(popup.state.netguardSettings.paused, true);
  assert.equal(popup.state.settingsSyncPending, true);

  await vm.runInContext(
    "syncSettingsToBackend('popup-test-change')",
    popup.context
  );
  assert.deepEqual(popup.runtimeMessages, [{
    type: 'NETGUARD_SYNC_SETTINGS',
    reason: 'popup-test-change'
  }]);
  assert.equal(popup.fetchCalls, 0);
});

test('pending reconnect is push-first and clears pending only after a successful POST', async () => {
  const harness = await createBackgroundHarness({
    netguardSettings: {
      adMode: 'strict',
      elderMode: false,
      childMode: false,
      paused: true
    },
    settingsSyncPending: true
  });
  harness.setFetchImplementation(async () => createApiResponse(200, {
    code: 0,
    message: 'success',
    data: {
      mode: 'strict',
      elder_mode: false,
      child_mode: false,
      paused: true
    }
  }));

  const result = await harness.context
    .synchronizeSettingsWithBackend('reconnect');
  const request = harness.requests[0];

  assert.equal(result.success, true);
  assert.equal(result.direction, 'push');
  assert.equal(request.options.method, 'POST');
  assert.equal(parseRequest(request).mode, 'strict');
  assert.equal(harness.state.settingsSyncPending, false);
});

test('failed settings POST preserves the local protection state and pending flag', async () => {
  const harness = await createBackgroundHarness({
    netguardSettings: {
      adMode: 'strict',
      elderMode: false,
      childMode: false,
      paused: true
    },
    settingsSyncPending: true
  });
  harness.setFetchImplementation(async () => createApiResponse(503, {
    code: 50301,
    message: 'offline',
    data: null
  }));

  const result = await harness.context
    .synchronizeSettingsWithBackend('offline-retry');

  assert.equal(result.success, false);
  assert.equal(result.direction, 'push');
  assert.equal(harness.requests[0].options.method, 'POST');
  assert.equal(harness.state.netguardSettings.adMode, 'strict');
  assert.equal(harness.state.netguardSettings.paused, true);
  assert.equal(harness.state.settingsSyncPending, true);
});

test('an in-flight Backend pull cannot overwrite a newly pending local change', async () => {
  const harness = await createBackgroundHarness({
    netguardSettings: {
      adMode: 'normal',
      elderMode: false,
      childMode: false,
      paused: false
    }
  });
  let resolveBackend;
  harness.setFetchImplementation(() => new Promise(resolve => {
    resolveBackend = resolve;
  }));

  const synchronization = harness.context
    .synchronizeSettingsWithBackend('concurrent-local-change');
  while (!resolveBackend) {
    await new Promise(resolve => setImmediate(resolve));
  }

  harness.state.netguardSettings = {
    adMode: 'strict',
    elderMode: false,
    childMode: false,
    paused: true
  };
  harness.state.settingsSyncPending = true;
  resolveBackend(createApiResponse(200, {
    code: 0,
    message: 'success',
    data: {
      mode: 'normal',
      elder_mode: false,
      child_mode: false,
      paused: false
    }
  }));

  const result = await synchronization;
  assert.equal(result.success, true);
  assert.equal(result.superseded, true);
  assert.equal(harness.state.netguardSettings.adMode, 'strict');
  assert.equal(harness.state.netguardSettings.paused, true);
  assert.equal(harness.state.settingsSyncPending, true);
});

test('without pending changes a runtime sync pulls and normalizes Backend settings', async () => {
  const harness = await createBackgroundHarness({
    netguardSettings: {
      adMode: 'normal',
      elderMode: false,
      childMode: false,
      paused: false
    }
  });
  harness.setFetchImplementation(async () => createApiResponse(200, {
    code: 0,
    message: 'success',
    data: {
      mode: 'strict',
      elder_mode: true,
      child_mode: false,
      paused: true
    }
  }));

  const result = await harness.dispatch({
    type: 'NETGUARD_SYNC_SETTINGS',
    reason: 'popup-open'
  });

  assert.equal(result.success, true);
  assert.equal(result.direction, 'pull');
  assert.equal(harness.requests[0].options.method, 'GET');
  assert.equal(harness.state.netguardSettings.elderMode, true);
  assert.equal(harness.state.netguardSettings.childMode, false);
  assert.equal(harness.state.netguardSettings.paused, true);
});

test('periodic settings recovery reuses the global alarm without conflicting with Child alarm', async () => {
  const harness = await createBackgroundHarness(
    createChildReminderStorage()
  );
  const alarmNames = [...harness.alarms.keys()].sort();

  assert.deepEqual(
    alarmNames,
    ['netguardBatchUpload', CHILD_REMINDER_ALARM].sort()
  );
  assert.equal(
    harness.createdAlarms.filter(
      alarm => alarm.name === 'netguardBatchUpload'
    ).length,
    1
  );
  assert.equal(
    harness.createdAlarms.some(
      alarm => alarm.name === 'netguardSettingsSync'
    ),
    false
  );

  harness.setFetchImplementation(async () => createApiResponse(200, {
    code: 0,
    message: 'success',
    data: {
      mode: 'child',
      elder_mode: false,
      child_mode: true,
      paused: false
    }
  }));
  await harness.dispatchAlarm({ name: CHILD_REMINDER_ALARM });
  assert.equal(
    harness.requests.some(request => request.url.endsWith('/api/settings')),
    false
  );

  await harness.dispatchAlarm({ name: 'netguardBatchUpload' });
  assert.equal(
    harness.requests.filter(request => request.url.endsWith('/api/settings')).length,
    1
  );
  assert.equal(harness.alarms.size, 2);
});

test('popup persists pause in the unified settings structure', async () => {
  const state = {};
  const context = {
    AbortController,
    URL,
    clearTimeout,
    setTimeout,
    console: { log() {}, warn() {} },
    document: {
      getElementById() {
        return null;
      },
      addEventListener() {}
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            return readStorage(state, keys);
          },
          async set(items) {
            Object.assign(state, clone(items));
          }
        }
      }
    },
    fetch: async () => createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {}
    })
  };

  vm.createContext(context);
  vm.runInContext(API_CONFIG_SOURCE, context, { filename: API_CONFIG_PATH });
  vm.runInContext(POPUP_SOURCE, context, { filename: POPUP_PATH });
  await vm.runInContext('savePauseState(true)', context);

  assert.equal(state.protectionPaused, undefined);
  assert.equal(state.paused, undefined);
  assert.equal(state.netguardSettings.paused, true);
  assert.deepEqual(
    Object.keys(state.netguardSettings),
    ['adMode', 'elderMode', 'childMode', 'paused']
  );

});

test('legacy child settings cannot enable child mode on first migration', async () => {
  const state = {
    childMode: true,
    childSettings: {
      childModeEnabled: true,
      learningWhitelist: ['legacy-learning.example']
    },
    elderMode: true,
    elderSettings: { enabled: true }
  };
  const context = {
    AbortController,
    URL,
    clearTimeout,
    setTimeout,
    console: { log() {}, warn() {} },
    document: {
      getElementById() { return null; },
      addEventListener() {}
    },
    chrome: {
      storage: {
        local: {
          async get(keys) { return readStorage(state, keys); },
          async set(items) { Object.assign(state, clone(items)); }
        }
      }
    },
    fetch: async () => createApiResponse(200, {
      code: 0,
      message: 'success',
      data: {}
    })
  };

  vm.createContext(context);
  vm.runInContext(API_CONFIG_SOURCE, context, { filename: API_CONFIG_PATH });
  vm.runInContext(POPUP_SOURCE, context, { filename: POPUP_PATH });
  const migrated = await vm.runInContext('getStoredState()', context);

  assert.equal(migrated.settings.childMode, false);
  assert.equal(migrated.settings.elderMode, false);
  assert.deepEqual(Array.from(migrated.settings.whitelist), []);
  assert.equal(migrated.childSettings.dailyReminderMinutes, 15);
  assert.equal(migrated.childSettings.dailyLimitMinutes, 60);

  await vm.runInContext(
    'persistState(__state.settings, __state.elderSettings, __state.childSettings)',
    Object.assign(context, { __state: migrated })
  );
  assert.deepEqual(
    Object.keys(state.netguardSettings),
    ['adMode', 'elderMode', 'childMode', 'paused']
  );
  assert.equal(state.netguardSettings.childMode, false);
  assert.equal(state.childSettings.childModeEnabled, false);
});

test('unified modes and child P1 settings survive a popup script restart', async () => {
  const state = {};
  const createPopupContext = () => {
    const context = {
      AbortController,
      URL,
      clearTimeout,
      setTimeout,
      console: { log() {}, warn() {} },
      document: {
        getElementById() { return null; },
        addEventListener() {}
      },
      chrome: {
        storage: {
          local: {
            async get(keys) { return readStorage(state, keys); },
            async set(items) { Object.assign(state, clone(items)); }
          }
        }
      },
      fetch: async () => createApiResponse(200, {
        code: 0,
        message: 'success',
        data: {}
      })
    };
    vm.createContext(context);
    vm.runInContext(API_CONFIG_SOURCE, context, { filename: API_CONFIG_PATH });
    vm.runInContext(POPUP_SOURCE, context, { filename: POPUP_PATH });
    return context;
  };

  let context = createPopupContext();
  await vm.runInContext(`persistState(
    {
      adMode: 'strict',
      elderMode: true,
      childMode: true,
      protectionPaused: true,
      paused: true,
      whitelist: ['global.example']
    },
    { enabled: false },
    {
      childModeEnabled: true,
      dailyReminderMinutes: 45,
      dailyLimitMinutes: 30,
      dangerousSites: ['custom-danger', '危险入口'],
      entertainmentSites: ['media.example'],
      childWhitelist: ['safe.example'],
      learningWhitelist: ['safe.example']
    }
  )`, context);

  context = createPopupContext();
  const restored = await vm.runInContext('getStoredState()', context);
  assert.equal(restored.settings.adMode, 'strict');
  assert.equal(restored.settings.childMode, true);
  assert.equal(restored.settings.elderMode, false);
  assert.equal(restored.settings.paused, true);
  assert.deepEqual(Array.from(restored.settings.whitelist), ['global.example']);
  assert.equal(restored.childSettings.dailyReminderMinutes, 45);
  assert.equal(restored.childSettings.dailyLimitMinutes, 45);
  assert.deepEqual(
    Array.from(restored.childSettings.dangerousSites),
    ['custom-danger', '危险入口']
  );
  assert.deepEqual(
    Array.from(restored.childSettings.entertainmentSites),
    ['media.example']
  );
  assert.deepEqual(
    Array.from(restored.childSettings.childWhitelist),
    ['safe.example']
  );
  assert.deepEqual(
    Array.from(restored.childSettings.learningWhitelist),
    ['safe.example']
  );
  assert.deepEqual(
    Object.keys(state.netguardSettings),
    ['adMode', 'elderMode', 'childMode', 'paused']
  );

  state.childSettings.dangerousSites = 'broken-storage-value';
  state.childSettings.entertainmentSites = { invalid: true };
  state.childSettings.learningWhitelist = ['stale.example'];
  state.childSettings.childWhitelist = ['child.example'];
  context = createPopupContext();
  const repaired = await vm.runInContext('getStoredState()', context);
  assert.equal(Array.isArray(repaired.childSettings.dangerousSites), true);
  assert.equal(repaired.childSettings.dangerousSites.includes('porn'), true);
  assert.equal(Array.isArray(repaired.childSettings.entertainmentSites), true);
  assert.equal(
    repaired.childSettings.entertainmentSites.includes('youtube.com'),
    true
  );
  assert.deepEqual(
    Array.from(repaired.childSettings.childWhitelist),
    ['child.example']
  );
  assert.deepEqual(
    Array.from(repaired.childSettings.learningWhitelist),
    ['child.example']
  );
  assert.deepEqual(Array.from(repaired.settings.whitelist), ['global.example']);
});

test('ad rules protect normal iframe use cases and broad CSS false positives', () => {
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(
    AD_DETECTOR_SOURCE,
    context,
    { filename: AD_DETECTOR_PATH }
  );

  const makeElement = (tagName, attributes = {}, extras = {}) => ({
    nodeType: 1,
    tagName,
    className: extras.className || '',
    id: extras.id || '',
    textContent: extras.textContent || '',
    src: attributes.src || '',
    href: attributes.href || '',
    parentElement: extras.parentElement || null,
    ownerDocument: extras.pageUrl ? { location: { href: extras.pageUrl } } : undefined,
    getAttribute(name) { return attributes[name] || ''; },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
    closest() { return extras.insideCoreContent ? {} : null; },
    querySelector() { return extras.containsCoreContent ? {} : null; },
    querySelectorAll(selector) {
      if (selector === '*') return { length: extras.descendantCount || 0 };
      return { length: extras.interactiveCount || 0 };
    },
    getBoundingClientRect() {
      return {
        width: extras.width || 0,
        height: extras.height || 0
      };
    }
  });
  const detector = context.NetGuardAdDetector;

  for (const iframe of [
    makeElement('IFRAME', {
      src: 'https://www.youtube.com/embed/demo',
      title: 'video player'
    }),
    makeElement('IFRAME', {
      src: 'https://accounts.example.com/login',
      title: 'login'
    }),
    makeElement('IFRAME', {
      src: 'https://captcha.example.com/challenge',
      title: 'captcha verification'
    }),
    makeElement('IFRAME', {
      src: 'https://maps.google.com/maps/embed',
      title: 'map'
    })
  ]) {
    assert.equal(detector.isAdElement(iframe), false);
  }

  assert.equal(detector.isAdElement(
    makeElement('IFRAME', {
      src: 'https://pagead2.googlesyndication.com/pagead/ads',
      title: 'Advertisement video player'
    })
  ), true);
  assert.equal(detector.isAdElement(
    makeElement('DIV', {}, { className: 'ad-banner' })
  ), true);
  for (const marker of ['header', 'adapter', 'download']) {
    assert.equal(detector.isAdElement(
      makeElement('DIV', {}, { className: marker })
    ), false);
  }

  const ecommercePromotion = makeElement('DIV', {}, {
    className: 'recommend promotion'
  });
  assert.equal(detector.isAdElement(ecommercePromotion, 'normal'), false);
  assert.equal(detector.isAdElement(ecommercePromotion, 'strict'), true);
  assert.equal(
    detector.inspectAdElement(ecommercePromotion, 'strict').reason,
    'bounded-promotion-container'
  );
  const dataPromotion = makeElement('ASIDE', { 'data-promo': 'seasonal' });
  assert.equal(detector.isAdElement(dataPromotion, 'normal'), false);
  assert.equal(detector.isAdElement(dataPromotion, 'strict'), true);
  const exactPromoClass = makeElement('DIV', {}, { className: 'promo' });
  assert.equal(detector.isAdElement(exactPromoClass, 'normal'), false);
  assert.equal(detector.isAdElement(exactPromoClass, 'strict'), true);

  for (const firstPartyOrdinaryAsset of [
    makeElement('A', { href: 'https://www.taobao.com/item/123' }, {
      pageUrl: 'https://www.taobao.com/'
    }),
    makeElement('IMG', { src: '/ads/home-carousel.webp' }, {
      pageUrl: 'https://www.taobao.com/'
    }),
    makeElement('IMG', { src: 'https://img.alicdn.com/item/product.webp' }, {
      pageUrl: 'https://www.taobao.com/'
    }),
    makeElement('IMG', { src: '/item/hero.webp' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ad'
    }),
    makeElement('A', { href: '/item/123' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ads'
    })
  ]) {
    assert.equal(detector.isAdElement(firstPartyOrdinaryAsset, 'normal'), false);
    assert.equal(detector.isAdElement(firstPartyOrdinaryAsset, 'strict'), false);
  }

  for (const explicitSameSiteAd of [
    makeElement('A', { href: '/ads/campaign' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ad-banner'
    }),
    makeElement('IMG', { src: '/ads/banner.jpg' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ad-banner'
    }),
    makeElement('PICTURE', { src: '/ads/banner.avif' }, {
      pageUrl: 'https://www.taobao.com/', className: 'adsbygoogle'
    }),
    makeElement('VIDEO', { src: '/media/campaign.mp4' }, {
      pageUrl: 'https://www.taobao.com/', className: 'video-ad'
    }),
    makeElement('SOURCE', { src: '/media/campaign.webm' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ad-banner'
    }),
    makeElement('DIV', { 'data-ad-slot': 'home-feed-ad' }, {
      pageUrl: 'https://www.taobao.com/'
    }),
    makeElement('IFRAME', { src: '/campaign/frame', title: 'Advertisement' }, {
      pageUrl: 'https://www.taobao.com/'
    })
  ]) {
    assert.equal(detector.isAdElement(explicitSameSiteAd, 'normal'), true);
    assert.equal(detector.isAdElement(explicitSameSiteAd, 'strict'), true);
  }

  assert.doesNotMatch(AD_DETECTOR_SOURCE, /FIRST_PARTY_DOMAIN_GROUPS|isFirstPartyBusinessPage/);
  assert.equal(detector.isAdElement(
    makeElement('IMG', { src: 'https://cdn.example.net/ads/banner.webp' }, {
      pageUrl: 'https://www.taobao.com/'
    })
  ), true);
  assert.equal(detector.isAdElement(
    makeElement('IMG', {
      src: 'https://www.taobao.com/image.jpg?redirect=https://doubleclick.net'
    }, { pageUrl: 'https://www.taobao.com/' })
  ), false);
  assert.equal(detector.isAdElement(
    makeElement('IMG', {
      src: 'https://cdn.example.net/image.jpg?category=ads'
    }, { pageUrl: 'https://www.taobao.com/' })
  ), false);
  assert.equal(detector.isAdElement(
    makeElement('IMG', { src: 'https://ads.example.net/banner.jpg' }, {
      pageUrl: 'https://www.taobao.com/'
    })
  ), true);

  for (const protectedPromotion of [
    makeElement('BODY', {}, { className: 'ad-banner' }),
    makeElement('MAIN', {}, { className: 'promotion' }),
    makeElement('SECTION', {}, { className: 'promotion' }),
    makeElement('DIV', {}, { className: 'promotion', insideCoreContent: true }),
    makeElement('DIV', {}, { className: 'promotion', containsCoreContent: true }),
    makeElement('DIV', {}, { className: 'promotion', interactiveCount: 5 }),
    makeElement('DIV', {}, { className: 'promotion', descendantCount: 81 }),
    makeElement('DIV', {}, { className: 'promotion', width: 900, height: 320 }),
    makeElement('DIV', {}, { className: 'promotion', width: 1200, height: 600 }),
    makeElement('IMG', {}, { className: 'promotion' })
  ]) {
    assert.equal(detector.isAdElement(protectedPromotion, 'normal'), false);
    assert.equal(detector.isAdElement(protectedPromotion, 'strict'), false);
  }

  for (const largeAdContainer of [
    makeElement('DIV', {}, { className: 'ad-container', descendantCount: 121 }),
    makeElement('DIV', {}, { className: 'ad-container', interactiveCount: 13 }),
    makeElement('DIV', {}, { className: 'ad-container', textContent: '正文'.repeat(2501) }),
    makeElement('DIV', {}, { className: 'ad-container', width: 1000, height: 500 }),
    makeElement('DIV', {}, { className: 'ad-container', width: 1400, height: 800 })
  ]) {
    assert.equal(detector.isAdElement(largeAdContainer, 'normal'), false);
    assert.equal(detector.isAdElement(largeAdContainer, 'strict'), false);
  }

  for (const largeClassOnlyBusinessResource of [
    makeElement('A', { href: '/ads/banner' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ad-banner', width: 1000, height: 500
    }),
    makeElement('IMG', { src: '/ads/banner.jpg' }, {
      pageUrl: 'https://www.taobao.com/', className: 'ad-banner', width: 1000, height: 500
    }),
    makeElement('PICTURE', { src: '/ads/banner.avif' }, {
      pageUrl: 'https://www.taobao.com/', className: 'adsbygoogle', width: 1000, height: 500
    })
  ]) {
    assert.equal(detector.isAdElement(largeClassOnlyBusinessResource, 'normal'), false);
    assert.equal(detector.isAdElement(largeClassOnlyBusinessResource, 'strict'), false);
  }
  const largeAttributedAd = makeElement('IMG', {
    src: '/ads/banner.jpg', 'data-ad-slot': 'confirmed-hero-ad'
  }, {
    pageUrl: 'https://www.taobao.com/', className: 'ad-banner', width: 1000, height: 500
  });
  assert.equal(detector.isAdElement(largeAttributedAd, 'normal'), true);
  assert.equal(detector.isAdElement(largeAttributedAd, 'strict'), true);

  const largeCommerceAncestor = makeElement('DIV', {}, { width: 1000, height: 500 });
  const nestedClassOnlyAsset = makeElement('IMG', { src: '/item/hero.webp' }, {
    pageUrl: 'https://www.taobao.com/', className: 'ad-banner',
    parentElement: largeCommerceAncestor
  });
  const nestedAttributedAd = makeElement('IMG', {
    src: '/ads/confirmed.jpg', 'data-ad-slot': 'nested-confirmed-ad'
  }, {
    pageUrl: 'https://www.taobao.com/', className: 'ad-banner',
    parentElement: largeCommerceAncestor
  });
  assert.equal(detector.isAdElement(nestedClassOnlyAsset, 'normal'), false);
  assert.equal(detector.isAdElement(nestedClassOnlyAsset, 'strict'), false);
  assert.equal(detector.isAdElement(nestedAttributedAd, 'normal'), true);
  assert.equal(detector.isAdElement(nestedAttributedAd, 'strict'), true);

  const insertedAdScript = makeElement('SCRIPT', {
    src: 'https://pagead2.googlesyndication.com/pagead/ads'
  });
  assert.equal(detector.isAdElement(insertedAdScript, 'normal'), false);
  assert.equal(detector.isAdElement(insertedAdScript, 'strict'), false);

  assert.doesNotMatch(AD_HIDE_SOURCE, /\[src\*=["']\/static\//);
  assert.doesNotMatch(AD_HIDE_SOURCE, /bugsnag/);
  assert.match(AD_HIDE_SOURCE, /\.ad-hidden-strict/);
  assert.match(AD_HIDE_SOURCE, /\.ad-hidden-normal/);
});

test('ad pipeline counts one parent region and skips matching child ads', async () => {
  const harness = createAdPipelineHarness();
  const parentAd = harness.createElement('DIV', { 'data-ad-slot': 'hero-slot' });
  const childAdOne = harness.createElement('IMG', {
    src: 'https://cdn.example.net/ads/one.jpg'
  }, { className: 'ad-banner' });
  const childAdTwo = harness.createElement('DIV', {}, { className: 'adsbygoogle' });
  parentAd.append(childAdOne, childAdTwo);
  harness.mount(parentAd);

  await harness.api.purgeAllAds('normal');
  await harness.api.purgeAllAds('normal');

  assert.equal(parentAd.__adBlocked, true);
  assert.equal(childAdOne.__adBlocked, undefined);
  assert.equal(childAdTwo.__adBlocked, undefined);
  assert.equal(harness.stats.length, 1);
  assert.equal(harness.stats[0].increment, 1);
  assert.equal(harness.stats[0].metadata.rule_reason, 'explicit-ad-attribute');
});

test('large commerce resources need authoritative evidence before DOM hiding', async () => {
  const harness = createAdPipelineHarness();
  const classOnlyCommerceHero = harness.createElement('IMG', { src: '/ads/banner.jpg' }, {
    className: 'ad-banner',
    rect: { width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }
  });
  const explicitLargeAd = harness.createElement('IMG', {
    src: '/ads/confirmed.jpg', 'data-ad-slot': 'confirmed-hero-ad'
  }, {
    className: 'ad-banner',
    rect: { width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }
  });
  const ordinaryLargeImage = harness.createElement('IMG', { src: '/products/hero.jpg' }, {
    rect: { width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }
  });
  harness.mount(classOnlyCommerceHero, explicitLargeAd, ordinaryLargeImage);

  await harness.api.purgeAllAds('normal');

  assert.equal(classOnlyCommerceHero.__adBlocked, undefined);
  assert.equal(explicitLargeAd.__adBlocked, true);
  assert.equal(ordinaryLargeImage.__adBlocked, undefined);
  assert.equal(harness.stats.length, 1);
  assert.equal(harness.stats[0].metadata.rule_reason, 'explicit-ad-attribute');
});

test('ad-like descendants inside large commerce regions stay visible without authoritative evidence', async () => {
  const harness = createAdPipelineHarness();
  const commerceHero = harness.createElement('DIV', {}, {
    rect: { width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }
  });
  const classOnlySlide = harness.createElement('IMG', { src: '/products/hero.jpg' }, {
    className: 'ad-banner'
  });
  commerceHero.append(classOnlySlide);

  const confirmedAdRegion = harness.createElement('DIV', {}, {
    rect: { width: 1000, height: 500, top: 0, left: 0, right: 1000, bottom: 500 }
  });
  const confirmedAd = harness.createElement('IMG', {
    src: '/ads/confirmed.jpg', 'data-ad-slot': 'confirmed-child-ad'
  }, { className: 'ad-banner' });
  confirmedAdRegion.append(confirmedAd);
  harness.mount(commerceHero, confirmedAdRegion);

  await harness.api.purgeAllAds('strict');

  assert.equal(classOnlySlide.__adBlocked, undefined);
  assert.equal(confirmedAd.__adBlocked, true);
  assert.equal(harness.stats.length, 1);
  assert.equal(harness.stats[0].metadata.rule_reason, 'explicit-ad-attribute');
});

test('strict mode collapses a bounded empty ad shell while normal leaves the shell layout intact', async () => {
  const strictHarness = createAdPipelineHarness({ pageUrl: 'https://www.csdn.net/' });
  const strictShell = strictHarness.createElement('DIV', {}, {
    textContent: '广告×',
    rect: { width: 400, height: 475, top: 0, left: 0, right: 400, bottom: 475 }
  });
  const strictFrame = strictHarness.createElement('IFRAME', {
    src: 'https://pagead2.googlesyndication.com/pagead/ads', title: 'Advertisement'
  });
  strictShell.append(strictFrame);
  strictHarness.mount(strictShell);

  await strictHarness.api.purgeAllAds('strict');

  assert.equal(strictShell.__adBlocked, true);
  assert.equal(strictShell.classList.contains('ad-hidden-strict'), true);
  assert.equal(strictFrame.__adBlocked, undefined);
  assert.equal(strictHarness.stats.length, 1);

  const normalHarness = createAdPipelineHarness({ pageUrl: 'https://www.csdn.net/' });
  const normalShell = normalHarness.createElement('DIV', {}, {
    textContent: '广告×',
    rect: { width: 400, height: 475, top: 0, left: 0, right: 400, bottom: 475 }
  });
  const normalFrame = normalHarness.createElement('IFRAME', {
    src: 'https://pagead2.googlesyndication.com/pagead/ads', title: 'Advertisement'
  });
  normalShell.append(normalFrame);
  normalHarness.mount(normalShell);

  await normalHarness.api.purgeAllAds('normal');

  assert.equal(normalShell.__adBlocked, undefined);
  assert.equal(normalFrame.__adBlocked, true);
  assert.equal(normalHarness.stats.length, 1);
});

test('an explicit ad label shell can collapse inside a large sidebar without weakening commerce protection', () => {
  const harness = createAdPipelineHarness({ pageUrl: 'https://www.csdn.net/' });
  const sidebar = harness.createElement('DIV', {}, {
    rect: { width: 450, height: 1100, top: 0, left: 0, right: 450, bottom: 1100 }
  });
  const shell = harness.createElement('DIV', {}, {
    textContent: '广告×',
    rect: { width: 400, height: 475, top: 0, left: 0, right: 400, bottom: 475 }
  });
  const label = harness.createElement('SPAN', {}, {
    textContent: '广告×',
    rect: { width: 55, height: 22, top: 5, left: 340, right: 395, bottom: 27 }
  });
  shell.append(label);
  sidebar.append(shell);
  harness.mount(sidebar);

  assert.equal(harness.api.findStrictAdShellFromLabel(label, '广告×'), shell);
});

test('normal and strict shell transitions keep one count for the same underlying ad', async () => {
  const createShellHarness = () => {
    const harness = createAdPipelineHarness({ pageUrl: 'https://www.csdn.net/' });
    const shell = harness.createElement('DIV', {}, {
      textContent: '广告×',
      rect: { width: 400, height: 475, top: 0, left: 0, right: 400, bottom: 475 }
    });
    const frame = harness.createElement('IFRAME', {
      src: 'https://pagead2.googlesyndication.com/pagead/ads', title: 'Advertisement'
    });
    shell.append(frame);
    harness.mount(shell);
    return { harness, shell, frame };
  };

  const normalFirst = createShellHarness();
  await normalFirst.harness.api.reconcileAdElements('normal');
  await normalFirst.harness.api.reconcileAdElements('strict');
  await normalFirst.harness.api.reconcileAdElements('normal');
  assert.equal(normalFirst.harness.stats.length, 1);
  assert.equal(normalFirst.frame.__adBlocked, true);
  assert.equal(normalFirst.shell.__adBlocked, undefined);
  assert.equal(normalFirst.harness.activeObserverCount(), 1);

  const strictFirst = createShellHarness();
  await strictFirst.harness.api.reconcileAdElements('strict');
  await strictFirst.harness.api.reconcileAdElements('normal');
  assert.equal(strictFirst.harness.stats.length, 1);
  assert.equal(strictFirst.frame.__adBlocked, true);
  assert.equal(strictFirst.shell.__adBlocked, undefined);
  assert.equal(strictFirst.harness.activeObserverCount(), 1);

  const labelFirst = createShellHarness();
  await labelFirst.harness.api.handleAdElement('strict', labelFirst.shell, {
    isAd: true, confidence: 'high', reason: 'explicit-ad-label-shell'
  });
  await labelFirst.harness.api.reconcileAdElements('normal');
  assert.equal(labelFirst.harness.stats.length, 1);
  assert.equal(labelFirst.frame.__adBlocked, true);
  assert.equal(labelFirst.shell.__adBlocked, undefined);
  assert.equal(labelFirst.harness.activeObserverCount(), 1);
});

test('explicit media ad markers win over media and safe-token protection', async () => {
  const harness = createAdPipelineHarness();
  const explicitVideoAd = harness.createElement('VIDEO', { src: '/media/spot.mp4' }, {
    className: 'ad-banner player'
  });
  const explicitSourceAd = harness.createElement('SOURCE', { src: '/media/spot.webm' }, {
    className: 'sponsored'
  });
  const sponsoredPicture = harness.createElement('PICTURE', { 'data-sponsor': 'home-slot' }, {
    className: 'player'
  });
  const ordinaryVideo = harness.createElement('VIDEO', { src: '/media/product.mp4' }, {
    className: 'player'
  });
  const ambiguousCommerceVideo = harness.createElement('VIDEO', { src: '/media/product-hero.mp4' }, {
    className: 'ad player'
  });
  harness.mount(
    explicitVideoAd, explicitSourceAd, sponsoredPicture, ordinaryVideo, ambiguousCommerceVideo
  );

  await harness.api.purgeAllAds('normal');

  assert.equal(explicitVideoAd.__adBlocked, true);
  assert.equal(explicitSourceAd.__adBlocked, true);
  assert.equal(sponsoredPicture.__adBlocked, true);
  assert.equal(ordinaryVideo.__adBlocked, undefined);
  assert.equal(ambiguousCommerceVideo.__adBlocked, undefined);
  assert.equal(harness.stats.length, 3);
  assert.deepEqual(
    harness.stats.map(entry => entry.metadata.rule_reason),
    ['ad-marker', 'ad-marker', 'explicit-ad-attribute']
  );
});

test('authentication QR and captcha controls survive normal and strict ad pipelines', async () => {
  for (const mode of ['normal', 'strict']) {
    const qrHarness = createAdPipelineHarness();
    const loginModal = qrHarness.createElement('DIV', {
      role: 'dialog', 'aria-modal': 'true'
    }, { className: 'account-sign-in-modal' });
    const qrCode = qrHarness.createElement('IMG', {
      src: '/account/qrcode.png', 'aria-label': '登录二维码'
    }, { className: 'ad-banner qr-code' });
    loginModal.append(qrCode);
    qrHarness.mount(loginModal);

    await qrHarness.api.purgeAllAds(mode);

    assert.equal(loginModal.__adBlocked, undefined);
    assert.equal(qrCode.__adBlocked, undefined);
    assert.equal(qrHarness.stats.length, 0);

    const captchaHarness = createAdPipelineHarness();
    const loginForm = captchaHarness.createElement('FORM', {
      action: '/authentication/sign-in'
    }, { className: 'authentication-form' });
    const captcha = captchaHarness.createElement('IMG', {
      src: '/verification/captcha.png', 'aria-label': '验证码'
    }, { className: 'ad-banner captcha-image' });
    loginForm.append(captcha);
    captchaHarness.mount(loginForm);

    await captchaHarness.api.purgeAllAds(mode);

    assert.equal(loginForm.__adBlocked, undefined);
    assert.equal(captcha.__adBlocked, undefined);
    assert.equal(captchaHarness.stats.length, 0);
  }
});

test('authentication protection stays local and does not release nearby strict promotion', async () => {
  const harness = createAdPipelineHarness();
  const loginModal = harness.createElement('DIV', {
    role: 'dialog', 'aria-modal': 'true'
  }, { className: 'oauth-login-modal' });
  const qrCode = harness.createElement('IMG', {
    src: '/oauth/qr-code.png'
  }, { className: 'qr-code' });
  loginModal.append(qrCode);

  const nearbyPromotion = harness.createElement('DIV', {}, {
    className: 'promotion'
  });
  harness.mount(loginModal, nearbyPromotion);

  await harness.api.purgeAllAds('strict');

  assert.equal(loginModal.__adBlocked, undefined);
  assert.equal(qrCode.__adBlocked, undefined);
  assert.equal(nearbyPromotion.__adBlocked, true);
  assert.equal(harness.stats.length, 1);
  assert.equal(harness.stats[0].metadata.rule_reason, 'bounded-promotion-container');
});

test('authoritative ad evidence inside authentication UI blocks only the ad region', async () => {
  for (const mode of ['normal', 'strict']) {
    const harness = createAdPipelineHarness();
    const loginModal = harness.createElement('DIV', {
      role: 'dialog', 'aria-modal': 'true'
    }, { className: 'authentication-modal' });
    const qrCode = harness.createElement('IMG', {
      src: '/authentication/qrcode.png'
    }, { className: 'qr-code' });
    const confirmedAd = harness.createElement('DIV', {
      'data-ad-slot': 'login-ad-slot'
    });
    loginModal.append(qrCode, confirmedAd);
    harness.mount(loginModal);

    await harness.api.purgeAllAds(mode);

    assert.equal(loginModal.__adBlocked, undefined);
    assert.equal(qrCode.__adBlocked, undefined);
    assert.equal(confirmedAd.__adBlocked, true);
    assert.equal(harness.stats.length, 1);
    assert.equal(harness.stats[0].metadata.rule_reason, 'explicit-ad-attribute');
  }

  const networkHarness = createAdPipelineHarness();
  const authenticationForm = networkHarness.createElement('FORM', {}, {
    className: 'oauth-sign-in-form'
  });
  const networkAd = networkHarness.createElement('IFRAME', {
    src: 'https://pagead2.googlesyndication.com/pagead/ads'
  });
  authenticationForm.append(networkAd);
  networkHarness.mount(authenticationForm);

  await networkHarness.api.purgeAllAds('strict');

  assert.equal(authenticationForm.__adBlocked, undefined);
  assert.equal(networkAd.__adBlocked, true);
  assert.equal(networkHarness.stats.length, 1);
  assert.equal(networkHarness.stats[0].metadata.rule_reason, 'known-ad-resource');
});

test('dynamic authentication data images stay visible in normal and strict modes', async () => {
  const qrDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ/ad/banner/promo';

  for (const mode of ['normal', 'strict']) {
    const harness = createAdPipelineHarness({ pageUrl: 'https://passport.example.test/' });
    harness.api.startObserver(mode);
    const loginModal = harness.createElement('DIV', {
      role: 'dialog', 'aria-modal': 'true'
    }, { className: 'account-sign-in-modal' });
    const qrCode = harness.createElement('IMG', {
      src: qrDataUrl, 'aria-label': '登录二维码'
    }, { className: 'ad-banner qr-code' });
    loginModal.append(qrCode);
    harness.mount(loginModal);

    await harness.triggerAdded(loginModal);

    assert.equal(qrCode.__adBlocked, undefined);
    assert.equal(qrCode.classList.contains(`ad-hidden-${mode}`), false);
    assert.equal(harness.stats.length, 0);
  }
});

test('placeholder QR source updates and previously blocked resources are reclassified', async () => {
  const qrDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ/ad/banner/promo';

  for (const mode of ['normal', 'strict']) {
    const harness = createAdPipelineHarness({ pageUrl: 'https://passport.example.test/' });
    harness.api.startObserver(mode);
    const loginModal = harness.createElement('DIV', {}, { className: 'oauth-login-modal' });
    const qrCode = harness.createElement('IMG', {
      src: '/images/loading-placeholder.jpg'
    }, { className: 'ad-banner qr-code' });
    loginModal.append(qrCode);
    harness.mount(loginModal);
    await harness.triggerAdded(loginModal);

    qrCode.setAttribute('src', qrDataUrl);
    await harness.triggerMutations([
      { type: 'attributes', attributeName: 'src', target: qrCode }
    ]);

    assert.equal(qrCode.__adBlocked, undefined);
    assert.equal(qrCode.classList.contains(`ad-hidden-${mode}`), false);
    assert.equal(harness.stats.length, 0);
  }

  const historicalHarness = createAdPipelineHarness();
  historicalHarness.api.startObserver('normal');
  const rotatingResource = historicalHarness.createElement('IMG', {
    src: 'https://pagead2.googlesyndication.com/pagead/ads'
  });
  historicalHarness.mount(rotatingResource);
  await historicalHarness.triggerAdded(rotatingResource);
  assert.equal(rotatingResource.__adBlocked, true);

  rotatingResource.setAttribute('src', qrDataUrl);
  await historicalHarness.triggerMutations([
    { type: 'attributes', attributeName: 'src', target: rotatingResource }
  ]);

  assert.equal(rotatingResource.__adBlocked, undefined);
  assert.equal(rotatingResource.classList.contains('ad-hidden-normal'), false);
  assert.equal(rotatingResource.style.getPropertyValue('visibility'), '');
  assert.equal(historicalHarness.stats.length, 1);
});

test('non-network image schemes stay safe without weakening DOM and HTTP ad evidence', async () => {
  for (const mode of ['normal', 'strict']) {
    const harness = createAdPipelineHarness();
    const ordinaryDataImage = harness.createElement('IMG', {
      src: 'data:image/jpeg;base64,/9j/4AAQ/ad/banner/promo'
    });
    const ordinaryBlobImage = harness.createElement('IMG', {
      src: 'blob:https://shop.example.test/550e8400-e29b-41d4-a716-ad-banner'
    });
    const explicitDataAd = harness.createElement('IMG', {
      src: 'data:image/png;base64,/ad/banner',
      'data-ad-slot': 'memory-backed-ad'
    });
    const explicitClassDataAd = harness.createElement('IMG', {
      src: 'data:image/png;base64,/safe/image'
    }, { className: 'ad-banner' });
    const networkAd = harness.createElement('IMG', {
      src: 'https://pagead2.googlesyndication.com/pagead/ads'
    });
    harness.mount(
      ordinaryDataImage,
      ordinaryBlobImage,
      explicitDataAd,
      explicitClassDataAd,
      networkAd
    );

    await harness.api.purgeAllAds(mode);

    assert.equal(ordinaryDataImage.__adBlocked, undefined);
    assert.equal(ordinaryBlobImage.__adBlocked, undefined);
    assert.equal(explicitDataAd.__adBlocked, true);
    assert.equal(explicitClassDataAd.__adBlocked, true);
    assert.equal(networkAd.__adBlocked, true);
    assert.equal(harness.stats.length, 3);
    assert.deepEqual(
      harness.stats.map(entry => entry.metadata.rule_reason),
      ['explicit-ad-attribute', 'ad-marker', 'known-ad-resource']
    );
  }
});

test('normal and strict transitions never reclassify a data QR image as advertising', async () => {
  const harness = createAdPipelineHarness({ pageUrl: 'https://passport.example.test/' });
  const loginModal = harness.createElement('DIV', {
    role: 'dialog', 'aria-modal': 'true'
  }, { className: 'authentication-modal' });
  const qrCode = harness.createElement('IMG', {
    src: 'data:image/jpeg;base64,/9j/4AAQ/ad/banner/promo'
  }, { className: 'ad-banner qr-code' });
  loginModal.append(qrCode);
  harness.mount(loginModal);

  await harness.api.reconcileAdElements('normal');
  await harness.api.reconcileAdElements('strict');
  await harness.api.reconcileAdElements('normal');

  assert.equal(qrCode.__adBlocked, undefined);
  assert.equal(qrCode.classList.contains('ad-hidden-normal'), false);
  assert.equal(qrCode.classList.contains('ad-hidden-strict'), false);
  assert.equal(harness.stats.length, 0);
  assert.equal(harness.activeObserverCount(), 1);
});

test('bounded MutationObserver handles dynamic ads once without a full-page rescan', async () => {
  const normalHarness = createAdPipelineHarness();
  normalHarness.api.startObserver('normal');
  assert.equal(normalHarness.activeObserverCount(), 1);

  const dynamicAd = normalHarness.createElement('DIV', {}, { className: 'ad-banner' });
  normalHarness.mount(dynamicAd);
  await normalHarness.triggerAdded(dynamicAd);
  await normalHarness.triggerAdded(dynamicAd);
  assert.equal(dynamicAd.__adBlocked, true);
  assert.equal(normalHarness.stats.length, 1);

  dynamicAd.classList.remove('ad-hidden-normal');
  dynamicAd.style.setProperty('visibility', 'visible', 'important');
  await normalHarness.triggerMutations([{ type: 'attributes', target: dynamicAd }]);
  assert.equal(dynamicAd.classList.contains('ad-hidden-normal'), true);
  assert.equal(dynamicAd.style.getPropertyValue('visibility'), 'hidden');
  assert.equal(normalHarness.stats.length, 1);

  const normalPromotion = normalHarness.createElement('DIV', {}, { className: 'promotion' });
  normalHarness.mount(normalPromotion);
  await normalHarness.triggerAdded(normalPromotion);
  assert.equal(normalPromotion.__adBlocked, undefined);
  assert.equal(normalHarness.stats.length, 1);
  assert.equal(normalHarness.candidateDocumentScans, 0);

  const nestedRoot = normalHarness.createElement('DIV');
  const nestedAd = normalHarness.createElement('DIV', {}, { className: 'ad-banner' });
  nestedRoot.append(nestedAd);
  normalHarness.mount(nestedRoot);
  const subtreeScansBefore = normalHarness.candidateSubtreeScans;
  await normalHarness.triggerMutations([
    { type: 'childList', addedNodes: [nestedAd] },
    { type: 'childList', addedNodes: [nestedRoot] }
  ]);
  assert.equal(nestedAd.__adBlocked, true);
  assert.equal(normalHarness.candidateSubtreeScans - subtreeScansBefore, 1);
  assert.equal(normalHarness.stats.length, 2);

  const strictHarness = createAdPipelineHarness();
  strictHarness.api.startObserver('strict');
  const safePromotion = strictHarness.createElement('DIV', {}, { className: 'promotion' });
  const unsafePromotion = strictHarness.createElement('DIV', {}, { className: 'promotion' });
  unsafePromotion.append(
    ...Array.from({ length: 5 }, (_, index) =>
      strictHarness.createElement('A', { href: `/item/${index}` }))
  );
  strictHarness.mount(safePromotion, unsafePromotion);

  await strictHarness.triggerAdded(safePromotion);
  await strictHarness.triggerAdded(safePromotion);
  await strictHarness.triggerAdded(unsafePromotion);
  assert.equal(safePromotion.__adBlocked, true);
  assert.equal(unsafePromotion.__adBlocked, undefined);
  assert.equal(strictHarness.stats.length, 1);
  assert.equal(strictHarness.stats[0].metadata.rule_reason, 'bounded-promotion-container');
  assert.equal(strictHarness.candidateDocumentScans, 0);
  assert.equal(strictHarness.activeObserverCount(), 1);
});

test('normal and strict transitions reuse one observer and never recount an ad region', async () => {
  const harness = createAdPipelineHarness();
  const highConfidenceAd = harness.createElement('DIV', {}, {
    id: 'stable-ad', className: 'ad-banner'
  });
  const strictOnlyPromotion = harness.createElement('DIV', {}, {
    id: 'strict-promotion', className: 'promotion'
  });
  harness.mount(highConfidenceAd, strictOnlyPromotion);

  await harness.api.reconcileAdElements('normal');
  assert.equal(harness.stats.length, 1);
  assert.equal(harness.activeObserverCount(), 1);

  await harness.api.reconcileAdElements('strict');
  assert.equal(harness.stats.length, 2);
  assert.equal(harness.activeObserverCount(), 1);
  assert.equal(strictOnlyPromotion.__adBlocked, true);

  await harness.api.reconcileAdElements('normal');
  assert.equal(harness.stats.length, 2);
  assert.equal(harness.activeObserverCount(), 1);
  assert.equal(strictOnlyPromotion.__adBlocked, undefined);
  assert.deepEqual(harness.stats.map(entry => entry.metadata.mode), ['normal', 'strict']);
  assert.equal(harness.observers.length, 3);
  assert.equal(harness.observers.filter(observer => !observer.active).length, 2);
});

test('an obsolete strict observer batch cannot run after switching to normal', async () => {
  const harness = createAdPipelineHarness();
  const promotion = harness.createElement('DIV', {}, { className: 'promotion' });
  harness.mount(promotion);

  harness.api.startObserver('strict');
  harness.scheduleAdded(promotion);
  const staleStrictCallbacks = harness.takeScheduledCallbacks();
  assert.equal(staleStrictCallbacks.length, 1);

  harness.api.startObserver('normal');
  for (const callback of staleStrictCallbacks) await callback();

  assert.equal(promotion.__adBlocked, undefined);
  assert.equal(harness.stats.length, 0);
  assert.equal(harness.activeObserverCount(), 1);
});

test('back-to-back reconcile requests apply only the latest requested mode', async () => {
  const harness = createAdPipelineHarness();
  const promotion = harness.createElement('DIV', {}, { className: 'promotion' });
  harness.mount(promotion);

  const strictRequest = harness.api.reconcileAdElements('strict');
  const normalRequest = harness.api.reconcileAdElements('normal');
  await Promise.all([strictRequest, normalRequest]);

  assert.equal(promotion.__adBlocked, undefined);
  assert.equal(harness.stats.length, 0);
  assert.equal(harness.activeObserverCount(), 1);
  const dynamicPromotion = harness.createElement('DIV', {}, { className: 'promotion' });
  harness.mount(dynamicPromotion);
  await harness.triggerAdded(dynamicPromotion);
  assert.equal(dynamicPromotion.__adBlocked, undefined);
});

test('elder mode applies, cleans, reapplies and clamps font scale without stacking', async () => {
  const harness = createElderModeHarness();
  const settings = {
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: true
  };

  await harness.apply(settings);
  assert.equal(harness.hasRootClass('elder-mode'), true);
  assert.equal(harness.hasRootClass('simplify'), true);
  const firstStyle = harness.getElement('elder-mode-dynamic-css');
  assert.ok(firstStyle);
  assert.match(firstStyle.textContent, /zoom: 1\.35 !important/);

  await harness.apply(settings);
  assert.equal(harness.getElement('elder-mode-dynamic-css'), firstStyle);
  assert.equal(
    firstStyle.textContent,
    ':root { --elder-zoom: 1.35; } .elder-mode body { zoom: 1.35 !important; }'
  );

  harness.setState({ elderModeEnabled: false });
  await harness.apply(settings);
  assert.equal(harness.hasRootClass('elder-mode'), false);
  assert.equal(harness.hasRootClass('simplify'), false);
  assert.equal(harness.getElement('elder-mode-style-link'), null);
  assert.equal(harness.getElement('elder-mode-dynamic-css'), null);

  harness.setState({ elderModeEnabled: true });
  await harness.apply({ ...settings, pageSimplify: false });
  assert.equal(harness.hasRootClass('elder-mode'), true);
  assert.equal(harness.hasRootClass('simplify'), false);

  await harness.apply({ ...settings, fontScale: Number.NaN });
  assert.match(
    harness.getElement('elder-mode-dynamic-css').textContent,
    /zoom: 1\.35 !important/
  );
  await harness.apply({ ...settings, fontScale: 0.25 });
  assert.match(
    harness.getElement('elder-mode-dynamic-css').textContent,
    /zoom: 1 !important/
  );
  await harness.apply({ ...settings, fontScale: 8 });
  assert.match(
    harness.getElement('elder-mode-dynamic-css').textContent,
    /zoom: 2 !important/
  );
});

test('elder font scaling initializes at document_start before head exists', async () => {
  const harness = createElderModeHarness({ headAvailable: false });

  await harness.apply({
    fontScale: 1.5,
    riskHighlight: false,
    pageSimplify: false
  });

  assert.equal(harness.hasRootClass('elder-mode'), true);
  assert.ok(harness.getElement('elder-mode-style-link'));
  const dynamicStyle = harness.getElement('elder-mode-dynamic-css');
  assert.ok(dynamicStyle);
  assert.match(dynamicStyle.textContent, /zoom: 1\.5 !important/);
});

test('elder risk highlighting preserves safe titles and restores managed titles exactly', async () => {
  const harness = createElderModeHarness();
  const safeLink = harness.createElement('a', {
    text: '查看产品说明',
    attributes: { title: '站点原始说明' }
  });
  const titledRisk = harness.createElement('a', {
    text: '立即转账领取优惠',
    classes: ['site-link'],
    attributes: {
      title: '原始风险链接说明',
      style: 'color: purple'
    }
  });
  const untitledRisk = harness.createElement('button', {
    text: '点击领取免费红包'
  });
  const keywordText = harness.createElement('span', {
    text: '银行卡',
    classes: ['risk-word', 'site-original-class'],
    attributes: { style: 'letter-spacing: 1px' }
  });
  harness.addElement(safeLink);
  harness.addElement(titledRisk);
  harness.addElement(untitledRisk);
  harness.addElement(keywordText);

  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: false
  });
  assert.equal(safeLink.getAttribute('title'), '站点原始说明');
  assert.match(titledRisk.getAttribute('title'), /风险提示/);
  assert.equal(titledRisk.classList.contains('site-link'), true);
  assert.equal(titledRisk.getAttribute('style'), 'color: purple');
  assert.match(untitledRisk.getAttribute('title'), /风险提示/);
  assert.equal(titledRisk.classList.contains('risk-highlight'), true);
  assert.equal(harness.hasRootClass('elder-risk-highlight-enabled'), true);
  assert.equal(keywordText.classList.contains('risk-word'), true);
  assert.equal(keywordText.classList.contains('site-original-class'), true);
  assert.equal(keywordText.getAttribute('style'), 'letter-spacing: 1px');
  assert.equal(keywordText.classList.contains('risk-highlight'), false);
  assert.equal(harness.eventLogs.length, 1);

  await harness.context.highlightRisks();
  assert.equal(harness.eventLogs.length, 1);

  await harness.apply({
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: false
  });
  assert.equal(safeLink.getAttribute('title'), '站点原始说明');
  assert.equal(titledRisk.getAttribute('title'), '原始风险链接说明');
  assert.equal(titledRisk.classList.contains('site-link'), true);
  assert.equal(titledRisk.getAttribute('style'), 'color: purple');
  assert.equal(untitledRisk.hasAttribute('title'), false);
  assert.equal(titledRisk.hasAttribute('data-risk-warning'), false);
  assert.equal(titledRisk.classList.contains('risk-highlight'), false);
  assert.equal(harness.hasRootClass('elder-risk-highlight-enabled'), false);
  assert.equal(keywordText.classList.contains('risk-word'), true);
  assert.equal(keywordText.classList.contains('site-original-class'), true);
  assert.equal(keywordText.getAttribute('style'), 'letter-spacing: 1px');

  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: false
  });
  await harness.apply({
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: false
  });
  assert.equal(titledRisk.getAttribute('title'), '原始风险链接说明');
  assert.equal(untitledRisk.hasAttribute('title'), false);
  assert.equal(harness.eventLogs.length, 1);
  assert.match(
    ELDER_MODE_CSS_SOURCE,
    /\.elder-mode\.elder-risk-highlight-enabled \.risk-word/
  );
});

test('elder risk observer handles dynamic links once and full gates clean all elder state', async () => {
  const harness = createElderModeHarness();
  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: true
  });
  assert.equal(harness.eventLogs.length, 0);

  const dynamicRisk = harness.createElement('a', {
    text: '账户异常，立即进行安全验证',
    attributes: { title: '动态链接原始说明' }
  });
  harness.addElement(dynamicRisk);
  harness.triggerMutation();
  await harness.runTimers();
  assert.equal(dynamicRisk.classList.contains('risk-highlight'), true);
  assert.equal(harness.eventLogs.length, 1);

  harness.triggerMutation();
  await harness.runTimers();
  assert.equal(harness.eventLogs.length, 1);

  await harness.apply({
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: true
  });
  const disabledDynamicRisk = harness.createElement('button', {
    text: '立即转账并提供验证码'
  });
  harness.addElement(disabledDynamicRisk);
  harness.triggerMutation();
  await harness.runTimers();
  assert.equal(disabledDynamicRisk.classList.contains('risk-highlight'), false);
  assert.equal(disabledDynamicRisk.hasAttribute('data-risk-warning'), false);
  assert.equal(harness.eventLogs.length, 1);

  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: true
  });
  assert.equal(disabledDynamicRisk.classList.contains('risk-highlight'), true);
  assert.equal(harness.eventLogs.length, 2);
  await harness.context.highlightRisks();
  assert.equal(harness.eventLogs.length, 2);

  harness.setState({ protectionSkipped: true });
  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: true
  });
  assert.equal(harness.hasRootClass('elder-mode'), false);
  assert.equal(dynamicRisk.getAttribute('title'), '动态链接原始说明');
  assert.equal(dynamicRisk.hasAttribute('data-risk-warning'), false);

  harness.setState({ protectionSkipped: false, elderModeEnabled: true });
  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: true
  });
  harness.setState({ protectionSkipped: true });
  await harness.apply({
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: true
  });
  assert.equal(harness.hasRootClass('elder-mode'), false);

  harness.setState({
    protectionSkipped: false,
    elderModeEnabled: true,
    childModeEnabled: true
  });
  await harness.apply({
    enabled: true,
    fontScale: 1.35,
    riskHighlight: true,
    pageSimplify: true
  });
  assert.equal(harness.hasRootClass('elder-mode'), false);
  assert.equal(harness.getElement('elder-mode-style-link'), null);
  assert.equal(dynamicRisk.getAttribute('title'), '动态链接原始说明');
});

test('elder storage changes use the elder-only path while ad and pause changes keep full routing', async () => {
  const harness = createElderStorageRoutingHarness();

  await harness.dispatch({
    elderSettings: {
      oldValue: { fontScale: 1.35 },
      newValue: { fontScale: 1.5 }
    },
    whitelist: { oldValue: ['safe.test'], newValue: ['safe.test'] },
    siteWhitelist: { oldValue: ['safe.test'], newValue: ['safe.test'] },
    childSettings: {
      oldValue: { learningMode: false },
      newValue: { learningMode: false }
    }
  });
  assert.deepEqual(harness.calls, { full: 0, elder: 1, child: 0 });

  await harness.dispatch({
    netguardSettings: {
      oldValue: {
        adMode: 'normal', elderMode: false, childMode: false, paused: false
      },
      newValue: {
        adMode: 'normal', elderMode: true, childMode: false, paused: false
      }
    }
  });
  assert.deepEqual(harness.calls, { full: 0, elder: 2, child: 0 });

  await harness.dispatch({
    childSettings: { oldValue: {}, newValue: { learningMode: true } }
  });
  assert.deepEqual(harness.calls, { full: 0, elder: 3, child: 0 });

  await harness.dispatch({
    netguardSettings: {
      oldValue: {
        adMode: 'normal', elderMode: true, childMode: false, paused: false
      },
      newValue: {
        adMode: 'strict', elderMode: true, childMode: false, paused: false
      }
    }
  });
  assert.deepEqual(harness.calls, { full: 1, elder: 3, child: 0 });

  await harness.dispatch({
    netguardSettings: {
      oldValue: {
        adMode: 'strict', elderMode: true, childMode: false, paused: false
      },
      newValue: {
        adMode: 'strict', elderMode: true, childMode: false, paused: true
      }
    }
  });
  assert.deepEqual(harness.calls, { full: 2, elder: 3, child: 1 });

  await harness.dispatch({
    whitelist: { oldValue: [], newValue: ['safe.test'] }
  });
  assert.deepEqual(harness.calls, { full: 3, elder: 3, child: 2 });

  const elderRoute = sourceBetween(
    CONTENT_SOURCE,
    '// 按配置字段路由变化，避免老人设置重启广告或儿童策略。',
    '// 后续任何保护逻辑都必须等待暂停状态完成首次读取。'
  );
  assert.doesNotMatch(elderRoute, /restoreAdElement|purgeAllAds|updateStorageStats/);
  assert.doesNotMatch(CONTENT_SOURCE, /function setupStorageChangeListener\(\)/);
});

test('elder simplify stays reversible and avoids broad structural selectors', async () => {
  const harness = createElderModeHarness();
  await harness.apply({
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: true
  });
  assert.equal(harness.hasRootClass('simplify'), true);

  await harness.apply({
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: false
  });
  assert.equal(harness.hasRootClass('elder-mode'), true);
  assert.equal(harness.hasRootClass('simplify'), false);
  assert.doesNotMatch(ELDER_MODE_CSS_SOURCE, /\.elder-mode\.simplify\s+aside\s*,/);
  assert.doesNotMatch(ELDER_MODE_CSS_SOURCE, /\.elder-mode\.simplify\s+footer\s*,/);
  assert.doesNotMatch(ELDER_MODE_CSS_SOURCE, /\.elder-mode\.simplify\s+\.sidebar\s*,/);
  assert.match(ELDER_MODE_CSS_SOURCE, /\.elder-mode\.simplify\s+\.related-posts/);
  assert.match(ELDER_MODE_CSS_SOURCE, /\.elder-mode\.simplify\s+\.advertisement/);
});

test('elder demo matching and timer are exact, cancellable and single-instance', async () => {
  const demoUrl = 'file:///D:/project/demos/elder/elder_demo.html';
  const harness = createElderModeHarness({ url: demoUrl });
  const settings = {
    fontScale: 1.35,
    riskHighlight: false,
    pageSimplify: false
  };

  assert.equal(harness.context.isLocalElderDemoPage(demoUrl), true);
  assert.equal(
    harness.context.isLocalElderDemoPage('file:///tmp/elder_demo.html'),
    false
  );
  assert.equal(
    harness.context.isLocalElderDemoPage('file:///D:/project/demos/other/elder_demo.html'),
    false
  );
  assert.equal(
    harness.context.isLocalElderDemoPage('https://example.test/demos/elder/elder_demo.html'),
    false
  );

  await harness.apply(settings);
  assert.equal(harness.pendingTimers(), 1);
  assert.equal(harness.hasRootClass('elder-risk-highlight-enabled'), false);
  assert.equal(harness.getRootAttribute('data-netguard-elder-demo'), 'true');
  await harness.apply(settings);
  assert.equal(harness.pendingTimers(), 1);

  harness.setState({ elderModeEnabled: false });
  await harness.runTimers();
  assert.equal(harness.getElement('elderRiskModal').classList.contains('active'), false);

  harness.setState({ elderModeEnabled: true });
  await harness.apply(settings);
  harness.setState({ elderModeEnabled: false });
  await harness.apply(settings);
  assert.equal(harness.pendingTimers(), 0);
  assert.equal(harness.getElement('elderRiskModal').classList.contains('active'), false);
  assert.equal(harness.getRootAttribute('data-netguard-elder-demo'), null);

  harness.setState({ elderModeEnabled: true });
  await harness.apply(settings);
  await harness.runTimers();
  assert.equal(harness.getElement('elderRiskModal').classList.contains('active'), true);
  harness.setState({ elderModeEnabled: false });
  await harness.apply(settings);
  assert.equal(harness.getElement('elderRiskModal').classList.contains('active'), false);

  const webHarness = createElderModeHarness({
    url: 'https://example.test/demos/elder/elder_demo.html'
  });
  await webHarness.apply(settings);
  assert.equal(webHarness.pendingTimers(), 0);
  assert.equal(webHarness.getRootAttribute('data-netguard-elder-demo'), null);
  assert.match(
    ELDER_MODE_CSS_SOURCE,
    /\[data-netguard-elder-demo="true"\]:not\(\.elder-risk-highlight-enabled\) \.risk-word/
  );
});

test('child browsing reminder stays absent while child mode is disabled', async () => {
  const harness = await createBackgroundHarness(
    createChildReminderStorage({ enabled: false }),
    {
      activeTabs: [{ id: 6, url: 'https://learn.example.test/' }]
    }
  );
  await dispatchChildReminderTicks(harness, 6);
  assert.equal(CHILD_REMINDER_STATE_KEY in harness.state, false);
  assert.equal(harness.sentTabMessages.length, 0);
  assert.equal(
    harness.createdAlarms.some(alarm => alarm.name === CHILD_REMINDER_ALARM),
    false
  );
  assert.equal(harness.clearedAlarms.includes(CHILD_REMINDER_ALARM), true);

  const disabledSettings = clone(harness.state.netguardSettings);
  harness.state.netguardSettings.childMode = true;
  await harness.dispatchStorageChange({
    netguardSettings: {
      oldValue: disabledSettings,
      newValue: clone(harness.state.netguardSettings)
    }
  });
  assert.equal(harness.alarms.has(CHILD_REMINDER_ALARM), true);
  assert.equal(
    harness.createdAlarms.filter(alarm => alarm.name === CHILD_REMINDER_ALARM).length,
    1
  );
  assert.equal(
    harness.createdAlarms.find(alarm => alarm.name === CHILD_REMINDER_ALARM)
      .alarmInfo.periodInMinutes,
    1
  );

  await harness.dispatchStorageChange({
    childSettings: {
      oldValue: { dailyReminderMinutes: 30 },
      newValue: clone(harness.state.childSettings)
    }
  });
  assert.equal(
    harness.createdAlarms.filter(alarm => alarm.name === CHILD_REMINDER_ALARM).length,
    1
  );
});

test('child browsing reminder counts only an eligible focused active web tab', async () => {
  const storage = createChildReminderStorage();
  const harness = await createBackgroundHarness(storage, {
    activeTabs: [{ id: 7, url: 'https://learn.example.test/course' }]
  });

  await dispatchChildReminderTicks(harness, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 1);

  harness.setFocusedWindow({ id: 1, focused: false });
  await dispatchChildReminderTicks(harness, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 1);

  harness.setFocusedWindow({ id: 1, focused: true });
  harness.setIdleState('idle');
  await dispatchChildReminderTicks(harness, 1);
  harness.setIdleState('locked');
  await dispatchChildReminderTicks(harness, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 1);

  harness.setIdleState('active');
  harness.setActiveTabs([{ id: 7, url: 'edge://settings/' }]);
  await dispatchChildReminderTicks(harness, 1);
  harness.setActiveTabs([{ id: 7, url: 'chrome://extensions/' }]);
  await dispatchChildReminderTicks(harness, 1);
  harness.setActiveTabs([{ id: 7, url: 'file:///D:/project/demo.html' }]);
  await dispatchChildReminderTicks(harness, 1);
  harness.setActiveTabs([{
    id: 7,
    url: 'chrome-extension://test/popup.html'
  }]);
  await dispatchChildReminderTicks(harness, 1);
  harness.setActiveTabs([{
    id: 7,
    url: 'https://microsoftedge.microsoft.com/addons/detail/example'
  }]);
  await dispatchChildReminderTicks(harness, 1);
  harness.setActiveTabs([{
    id: 7,
    url: 'https://chromewebstore.google.com/detail/example'
  }]);
  await dispatchChildReminderTicks(harness, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 1);
  assert.equal(harness.sentTabMessages.length, 0);
});

test('child browsing time freezes for pause and child whitelist then resumes', async () => {
  const storage = createChildReminderStorage({ paused: true });
  const harness = await createBackgroundHarness(storage, {
    activeTabs: [{ id: 8, url: 'https://school.example.test/lesson' }]
  });

  await dispatchChildReminderTicks(harness, 2);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 0);

  const pausedSettings = clone(harness.state.netguardSettings);
  harness.state.netguardSettings.protectionPaused = false;
  harness.state.netguardSettings.paused = false;
  await harness.dispatchStorageChange({
    netguardSettings: {
      oldValue: pausedSettings,
      newValue: clone(harness.state.netguardSettings)
    }
  });
  await dispatchChildReminderTicks(harness, 2);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 2);

  const unlistedChildSettings = clone(harness.state.childSettings);
  const dynamicRuleUpdatesBeforeChildWhitelist = harness.dynamicRuleUpdates.length;
  harness.state.childSettings.childWhitelist = ['school.example.test'];
  harness.state.childSettings.learningWhitelist = ['school.example.test'];
  await harness.dispatchStorageChange({
    childSettings: {
      oldValue: unlistedChildSettings,
      newValue: clone(harness.state.childSettings)
    }
  });
  await dispatchChildReminderTicks(harness, 2);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 2);
  assert.equal(
    harness.dynamicRuleUpdates.length,
    dynamicRuleUpdatesBeforeChildWhitelist
  );

  const listedChildSettings = clone(harness.state.childSettings);
  harness.state.childSettings.childWhitelist = [];
  harness.state.childSettings.learningWhitelist = [];
  await harness.dispatchStorageChange({
    childSettings: {
      oldValue: listedChildSettings,
      newValue: clone(harness.state.childSettings)
    }
  });
  await dispatchChildReminderTicks(harness, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 3);
});

test('child reminder intervals repeat without limiting until the daily limit is reached', async () => {
  const harness = await createBackgroundHarness(
    createChildReminderStorage({ minutes: 5, limitMinutes: 12 }),
    {
      activeTabs: [
        { id: 11, url: 'https://one.example.test/' },
        { id: 12, url: 'https://two.example.test/' }
      ]
    }
  );

  await dispatchChildReminderTicks(harness, 5);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, false);
  assert.equal(harness.sentTabMessages.length, 1);
  assert.equal(
    harness.sentTabMessages[0].message.type,
    'NETGUARD_CHILD_BROWSING_REMINDER'
  );
  assert.equal(harness.sentTabMessages[0].message.cycleId, 1);

  await dispatchChildReminderTicks(harness, 5);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 10);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, false);
  assert.equal(harness.sentTabMessages.length, 2);
  assert.equal(
    harness.sentTabMessages[1].message.type,
    'NETGUARD_CHILD_BROWSING_REMINDER'
  );
  assert.equal(harness.sentTabMessages[1].message.cycleId, 2);

  await dispatchChildReminderTicks(harness, 2);
  assert.equal(harness.sentTabMessages.length, 3);
  assert.equal(harness.sentTabMessages[2].tabId, 11);
  assert.equal(
    harness.sentTabMessages[2].message.type,
    'NETGUARD_CHILD_BROWSING_LIMIT_REACHED'
  );
  assert.equal(harness.sentTabMessages[2].message.cycleId, 3);
  assert.equal(harness.sentTabMessages[2].options.frameId, 0);
  const limitedState = harness.state[CHILD_REMINDER_STATE_KEY];
  assert.equal(limitedState.elapsedMinutes, 12);
  assert.equal(limitedState.limitReached, true);
  assert.equal(limitedState.lastNotifiedCycleId, 3);
  assert.equal(harness.sentTabMessages[2].message.dateKey, limitedState.dateKey);

  await dispatchChildReminderTicks(harness, 10);
  assert.equal(harness.sentTabMessages.length, 3);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 12);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, true);
});

test('child reminder keeps one global cycle while the active tab changes', async () => {
  const harness = await createBackgroundHarness(
    createChildReminderStorage(),
    {
      activeTabs: [{ id: 18, url: 'https://first.example.test/' }]
    }
  );

  await dispatchChildReminderTicks(harness, 2);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 2);

  harness.setActiveTabs([{ id: 19, url: 'https://second.example.test/' }]);
  await dispatchChildReminderTicks(harness, 3);
  assert.equal(harness.sentTabMessages.length, 1);
  assert.equal(harness.sentTabMessages[0].tabId, 19);
  assert.equal(harness.sentTabMessages[0].message.cycleId, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, true);
});

test('overlapping child reminder alarm events serialize without duplicate cycle delivery', async () => {
  const harness = await createBackgroundHarness(
    createChildReminderStorage(),
    {
      activeTabs: [{ id: 17, url: 'https://serial.example.test/' }]
    }
  );
  await dispatchChildReminderTicks(harness, 4);

  await Promise.all([
    harness.dispatchAlarm({ name: CHILD_REMINDER_ALARM }),
    harness.dispatchAlarm({ name: CHILD_REMINDER_ALARM })
  ]);

  assert.equal(harness.sentTabMessages.length, 1);
  assert.equal(harness.sentTabMessages[0].message.cycleId, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, true);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].lastNotifiedCycleId, 1);
});

test('timer configuration changes preserve the day state while leaving Child preserves it for re-entry', async () => {
  const storage = createChildReminderStorage();
  const harness = await createBackgroundHarness(storage, {
    activeTabs: [{ id: 13, url: 'https://reading.example.test/' }]
  });

  await dispatchChildReminderTicks(harness, 3);
  const oldChildSettings = clone(harness.state.childSettings);
  const protectionRuleUpdatesBeforeThresholdChange =
    harness.dynamicRuleUpdates.length;
  harness.state.childSettings.dailyReminderMinutes = 10;
  harness.state.childSettings.dailyLimitMinutes = 12;
  await harness.dispatchStorageChange({
    childSettings: {
      oldValue: oldChildSettings,
      newValue: clone(harness.state.childSettings)
    }
  });
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].dailyReminderMinutes, 10);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].dailyLimitMinutes, 12);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 3);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, false);
  assert.equal(
    harness.dynamicRuleUpdates.length,
    protectionRuleUpdatesBeforeThresholdChange
  );

  await dispatchChildReminderTicks(harness, 2);
  const enabledSettings = clone(harness.state.netguardSettings);
  harness.state.netguardSettings.childMode = false;
  await harness.dispatchStorageChange({
    netguardSettings: {
      oldValue: enabledSettings,
      newValue: clone(harness.state.netguardSettings)
    }
  });
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].limitReached, false);
  assert.equal(harness.alarms.has(CHILD_REMINDER_ALARM), false);
  assert.equal(harness.clearedAlarms.includes(CHILD_REMINDER_ALARM), true);
  await dispatchChildReminderTicks(harness, 1);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(harness.sentTabMessages.length, 0);

  const disabledSettings = clone(harness.state.netguardSettings);
  harness.state.netguardSettings.childMode = true;
  await harness.dispatchStorageChange({
    netguardSettings: {
      oldValue: disabledSettings,
      newValue: clone(harness.state.netguardSettings)
    }
  });
  assert.equal(harness.alarms.has(CHILD_REMINDER_ALARM), true);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
});

test('child limit state survives worker rebuild and browser startup on the same day', async () => {
  const sharedState = createChildReminderStorage();
  const sharedAlarms = new Map();
  const first = await createBackgroundHarness({}, {
    sharedState,
    sharedAlarms,
    activeTabs: [{ id: 14, url: 'https://study.example.test/' }]
  });
  await dispatchChildReminderTicks(first, 2);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 2);

  const rebuilt = await createBackgroundHarness({}, {
    sharedState,
    sharedAlarms,
    activeTabs: [{ id: 14, url: 'https://study.example.test/' }]
  });
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 2);
  assert.equal(rebuilt.sentTabMessages.length, 0);
  assert.equal(
    rebuilt.createdAlarms.filter(alarm => alarm.name === CHILD_REMINDER_ALARM).length,
    0
  );

  sharedAlarms.delete(CHILD_REMINDER_ALARM);
  const rebuiltWithMissingAlarm = await createBackgroundHarness({}, {
    sharedState,
    sharedAlarms,
    activeTabs: [{ id: 14, url: 'https://study.example.test/' }]
  });
  assert.equal(
    rebuiltWithMissingAlarm.createdAlarms.filter(
      alarm => alarm.name === CHILD_REMINDER_ALARM
    ).length,
    1
  );
  await dispatchChildReminderTicks(rebuiltWithMissingAlarm, 1);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 3);

  await rebuiltWithMissingAlarm.dispatchStartup();
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 3);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].limitReached, false);
  assert.equal(sharedState.childSettings.dailyReminderMinutes, 5);
});

test('child browsing state resets automatically when its stored date is stale', async () => {
  const sharedState = createChildReminderStorage();
  const harness = await createBackgroundHarness({}, {
    sharedState,
    activeTabs: [{ id: 21, url: 'https://new-day.example.test/' }]
  });
  await dispatchChildReminderTicks(harness, 5);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].limitReached, true);

  sharedState[CHILD_REMINDER_STATE_KEY].dateKey = '2000-01-01';
  await harness.dispatchStartup();

  const resetState = sharedState[CHILD_REMINDER_STATE_KEY];
  assert.equal(resetState.dateKey, harness.context.getChildBrowsingDateKey());
  assert.equal(resetState.elapsedMinutes, 0);
  assert.equal(resetState.limitReached, false);
  assert.equal(resetState.pendingNotificationCycleId, null);
  assert.equal(resetState.pendingNotificationType, null);
});

test('page refresh restores the persisted child browsing limit without restarting time', async () => {
  const sharedState = createChildReminderStorage();
  const beforeRefresh = await createBackgroundHarness({}, {
    sharedState,
    activeTabs: [{ id: 16, url: 'https://refresh.example.test/' }]
  });
  await dispatchChildReminderTicks(beforeRefresh, 5);
  assert.equal(beforeRefresh.sentTabMessages.length, 1);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].lastNotifiedCycleId, 1);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].limitReached, true);

  // 页面刷新会替换 content script；新脚本从当天持久状态恢复限制界面。
  const refreshedPage = createChildBrowsingReminderUiHarness();
  assert.equal(refreshedPage.setState({
    limitState: sharedState[CHILD_REMINDER_STATE_KEY]
  }), true);
  assert.ok(refreshedPage.getLimitOverlay());
  assert.ok(refreshedPage.getLimitPopup());

  const afterRefresh = await createBackgroundHarness({}, {
    sharedState,
    activeTabs: [{ id: 16, url: 'https://refresh.example.test/' }]
  });
  assert.equal(afterRefresh.sentTabMessages.length, 0);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  await dispatchChildReminderTicks(afterRefresh, 3);
  assert.equal(afterRefresh.sentTabMessages.length, 0);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(sharedState[CHILD_REMINDER_STATE_KEY].limitReached, true);
});

test('child reminder normalizes invalid minutes and tolerates a missing content receiver', async () => {
  const harness = await createBackgroundHarness(
    createChildReminderStorage({ minutes: 'invalid' })
  );
  assert.equal(harness.context.normalizeChildReminderMinutes('invalid'), 15);
  assert.equal(harness.context.normalizeChildReminderMinutes(-1), 5);
  assert.equal(harness.context.normalizeChildReminderMinutes(999), 120);
  assert.equal(harness.context.normalizeChildReminderMinutes(9.8), 9);
  assert.equal(harness.context.normalizeChildDailyLimitMinutes(4, 15), 15);
  assert.equal(harness.context.normalizeChildDailyLimitMinutes('invalid', 15), 60);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].dailyReminderMinutes, 15);
  assert.equal(harness.state[CHILD_REMINDER_STATE_KEY].dailyLimitMinutes, 60);

  const receiverState = createChildReminderStorage();
  const receiverAlarms = new Map();
  const receiverHarness = await createBackgroundHarness(
    {},
    {
      sharedState: receiverState,
      sharedAlarms: receiverAlarms,
      activeTabs: [{ id: 15, url: 'https://safe.example.test/' }],
      sendMessageError: new Error('Receiving end does not exist')
    }
  );
  await dispatchChildReminderTicks(receiverHarness, 5);
  assert.equal(receiverHarness.sentTabMessages.length, 1);
  assert.equal(receiverHarness.state[CHILD_REMINDER_STATE_KEY].lastNotifiedCycleId, 0);
  assert.equal(receiverHarness.state[CHILD_REMINDER_STATE_KEY].pendingNotificationCycleId, 1);
  assert.equal(receiverHarness.state[CHILD_REMINDER_STATE_KEY].pendingNotificationType, 'limit');
  assert.equal(receiverHarness.state[CHILD_REMINDER_STATE_KEY].pendingNotificationStatus, 'retry');
  assert.equal(receiverHarness.state[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(receiverHarness.state[CHILD_REMINDER_STATE_KEY].limitReached, true);

  const recoveredReceiver = await createBackgroundHarness({}, {
    sharedState: receiverState,
    sharedAlarms: receiverAlarms,
    activeTabs: [{ id: 15, url: 'https://safe.example.test/' }]
  });
  await dispatchChildReminderTicks(recoveredReceiver, 1);
  assert.equal(recoveredReceiver.sentTabMessages.length, 1);
  assert.equal(
    recoveredReceiver.sentTabMessages[0].message.type,
    'NETGUARD_CHILD_BROWSING_LIMIT_REACHED'
  );
  assert.equal(recoveredReceiver.sentTabMessages[0].message.cycleId, 1);
  assert.equal(receiverState[CHILD_REMINDER_STATE_KEY].lastNotifiedCycleId, 1);
  assert.equal(receiverState[CHILD_REMINDER_STATE_KEY].pendingNotificationCycleId, null);
  assert.equal(receiverState[CHILD_REMINDER_STATE_KEY].pendingNotificationType, null);
  assert.equal(receiverState[CHILD_REMINDER_STATE_KEY].elapsedMinutes, 5);
  assert.equal(receiverState[CHILD_REMINDER_STATE_KEY].limitReached, true);
});

test('child reminder content UI is top-frame singleton, closable, fading and layout neutral', () => {
  const harness = createChildBrowsingReminderUiHarness();
  assert.equal(harness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_REMINDER',
    cycleId: 1
  }).shown, true);
  const reminder = harness.getReminder();
  assert.ok(reminder);
  assert.ok(harness.getStyle());
  assert.equal(harness.bodyStyle.paddingTop, '');
  assert.equal(harness.bodyStyle.marginTop, '');

  harness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_REMINDER',
    cycleId: 1
  });
  assert.equal(harness.getReminder(), reminder);
  reminder.clickClose();
  harness.runTimers();
  assert.equal(harness.getReminder(), null);
  assert.equal(harness.getStyle(), null);

  const autoHarness = createChildBrowsingReminderUiHarness();
  autoHarness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_REMINDER',
    cycleId: 2
  });
  autoHarness.runTimers();
  assert.equal(autoHarness.getReminder(), null);
  assert.equal(autoHarness.getStyle(), null);

  const subframeHarness = createChildBrowsingReminderUiHarness({ topFrame: false });
  assert.equal(subframeHarness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_REMINDER',
    cycleId: 1
  }).shown, false);
  assert.equal(subframeHarness.getReminder(), null);
});

test('child browsing limit UI is persistent, singleton and top-frame only', () => {
  const harness = createChildBrowsingReminderUiHarness();
  assert.equal(harness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_LIMIT_REACHED',
    cycleId: 1
  }).shown, true);

  const overlay = harness.getLimitOverlay();
  const popup = harness.getLimitPopup();
  assert.ok(overlay);
  assert.ok(popup);
  assert.match(popup.innerHTML, /今日浏览时间已达到上限/);

  harness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_LIMIT_REACHED',
    cycleId: 1
  });
  assert.equal(harness.getLimitOverlay(), overlay);
  assert.equal(harness.getLimitPopup(), popup);
  harness.runTimers();
  assert.equal(harness.getLimitOverlay(), overlay);
  assert.equal(harness.getLimitPopup(), popup);

  const subframeHarness = createChildBrowsingReminderUiHarness({ topFrame: false });
  assert.equal(subframeHarness.dispatch({
    type: 'NETGUARD_CHILD_BROWSING_LIMIT_REACHED',
    cycleId: 1
  }).shown, false);
  assert.equal(subframeHarness.getLimitOverlay(), null);
});

test('child browsing limit clears in Normal Strict and Elder without changing its persisted state', () => {
  for (const mode of ['Normal', 'Strict', 'Elder']) {
    const harness = createChildBrowsingReminderUiHarness();
    const limitState = {
      dateKey: new Date().toLocaleDateString('en-CA'),
      elapsedMinutes: 5,
      dailyReminderMinutes: 5,
      dailyLimitMinutes: 5,
      limitReached: true
    };
    assert.equal(harness.setState({ limitState }), true, mode);
    assert.ok(harness.getLimitOverlay(), mode);

    assert.equal(harness.setState({
      childModeEnabled: false,
      isChildMode: false
    }), false, mode);
    assert.equal(harness.getLimitOverlay(), null, mode);
    assert.equal(harness.getLimitPopup(), null, mode);
  }
});

test('child-only website blocking is gated by the unified child mode flag', () => {
  const fastGameSource = sourceBetween(
    CONTENT_SOURCE,
    '// 游戏网站快速入口',
    '// 本地文件页面正常执行检测'
  );
  assert.match(
    fastGameSource,
    /childModeEnabled\s*&&\s*resolveChildPolicyType\(\{ type: 'game' \}\) === 'game'/
  );
  assert.match(
    CONTENT_SOURCE,
    /shouldSkipChildProtection\(\) \|\|\s*!isChildMode \|\|\s*!childModeEnabled/
  );
  assert.match(
    CONTENT_SOURCE,
    /unified\.childMode \?\? result\.childMode \?\? false/
  );
});

test('local child demos use exact file path classification without changing web rules', () => {
  const configSource = sourceBetween(
    CONTENT_SOURCE,
    'const CHILD_MODE_CONFIG =',
    '// 加载儿童模式配置'
  );
  const demoMappingSource = sourceBetween(
    CONTENT_SOURCE,
    'const CHILD_DEMO_SITE_TYPE_MAP =',
    '// 检查当前页面是否为演示页面'
  );
  const demoModeSource = sourceBetween(
    CONTENT_SOURCE,
    'function isDemoModePage()',
    '// 检查当前页面是否为危险演示页面'
  );
  const siteTypeSource = sourceBetween(
    CONTENT_SOURCE,
    'function getDangerType()',
    '// 显示儿童模式顶部横幅'
  );
  const context = {
    URL,
    console: { log() {} },
    document: {
      querySelector(selector) {
        if (selector === 'meta[name="data-demo-mode"]') {
          return context.demoMode ? {} : null;
        }
        return null;
      }
    },
    demoMode: false
  };

  vm.createContext(context);
  vm.runInContext(`
    ${configSource}
    let childModeSettings = null;
    ${demoMappingSource}
    ${demoModeSource}
    ${siteTypeSource}
    globalThis.setChildModeRules = rules => {
      childModeSettings = rules;
    };
  `, context);

  const exactCases = {
    'child_learning_demo.html': 'learning',
    'child_entertainment_demo.html': 'entertainment',
    'child_game_demo.html': 'game',
    'child_danger_demo.html': 'dangerous',
    'fake_gambling.html': 'dangerous',
    'fake_violence.html': 'dangerous'
  };
  for (const [fileName, expectedType] of Object.entries(exactCases)) {
    const url = `file:///D:/project/demos/child/${fileName}`;
    assert.equal(context.getChildDemoSiteType(url), expectedType);
    const siteInfo = context.getSiteType(url);
    assert.equal(siteInfo.type, expectedType);
    assert.equal(siteInfo.isChildDemo, true);
  }

  for (const url of [
    'file:///tmp/child_game_demo.html',
    'file:///D:/project/demos/other/child_game_demo.html',
    'file:///D:/project/demos/child/archive/child_game_demo.html',
    'file:///D:/project/demos/child/game_notes.html',
    'file:///D:/project/demos/child/danger_notes.html',
    'file:///D:/project/demos/child/child_game_demo_backup.html'
  ]) {
    assert.equal(context.getChildDemoSiteType(url), null);
    const siteInfo = context.getSiteType(url);
    assert.equal(siteInfo.type, 'normal');
    assert.equal(siteInfo.isChildDemo, undefined);
  }

  const webCases = [
    ['https://www.coursera.org/learn/security', 'learning'],
    ['https://www.youtube.com/watch?v=demo', 'entertainment'],
    ['https://www.4399.com/flash/1.htm', 'game'],
    ['https://example.com/?phishing=1', 'dangerous'],
    ['https://example.com/demos/child/child_game_demo.html', 'normal']
  ];
  for (const [url, expectedType] of webCases) {
    const siteInfo = context.getSiteType(url);
    assert.equal(siteInfo.type, expectedType);
    assert.equal(siteInfo.isChildDemo, undefined);
  }

  assert.equal(
    context.getSiteType('https://example.com/?next=youtube.com').type,
    'normal'
  );
  assert.equal(
    context.getSiteType('https://notyoutube.com/watch').type,
    'normal'
  );

  context.setChildModeRules({
    dangerousSites: ['custom-danger', '危险入口'],
    entertainmentSites: ['media.example'],
    learningWhitelist: ['learn.example']
  });
  assert.equal(
    context.getSiteType('https://example.com/path/custom-danger').type,
    'dangerous'
  );
  assert.equal(
    context.getSiteType('https://example.com/%E5%8D%B1%E9%99%A9%E5%85%A5%E5%8F%A3').type,
    'dangerous'
  );
  assert.equal(
    context.getSiteType('https://phishing.example/path').type,
    'normal'
  );
  assert.equal(
    context.getSiteType('https://video.media.example/watch').type,
    'entertainment'
  );
  assert.equal(
    context.getSiteType('https://youtube.com/watch').type,
    'normal'
  );
  assert.equal(
    context.getSiteType('https://learn.example/course').type,
    'learning'
  );

  context.demoMode = true;
  const childGameInfo = context.getSiteType(
    'file:///D:/project/demos/child/child_game_demo.html'
  );
  const otherDemoInfo = context.getSiteType(
    'file:///D:/project/demos/elder/elder_demo.html'
  );
  assert.equal(context.isDemoModePage() && !childGameInfo.isChildDemo, false);
  assert.equal(context.isDemoModePage() && !otherDemoInfo.isChildDemo, true);
  assert.match(
    CONTENT_SOURCE,
    /if \(isDemoModePage\(\) && !siteInfo\.isChildDemo\)/
  );
});

test('child demo mapping keeps child mode pause and whitelist gates first', () => {
  assert.match(
    CONTENT_SOURCE,
    /function shouldSkipProtection\(\) \{\s*return protectionPaused \|\| isCurrentSiteWhitelisted\(\);/
  );
  assert.match(
    CONTENT_SOURCE,
    /function shouldSkipChildProtection\(\) \{\s*return shouldSkipProtection\(\) \|\| isCurrentSiteChildWhitelisted\(\);/
  );
  assert.match(
    CONTENT_SOURCE,
    /if \(!IS_TOP_FRAME \|\| shouldSkipChildProtection\(\) \|\| !isChildMode \|\| !childModeEnabled\) \{[\s\S]*?let siteInfo = getSiteType\(url\);/
  );
});

test('dangerousFilter gates only the child dangerous UI and event', async () => {
  const harness = createChildPolicyHarness();
  const siteInfo = { type: 'dangerous', keyword: '赌博内容' };
  const url = 'file:///project/demos/child/fake_gambling.html';

  harness.setState({
    childModeEnabled: true,
    settings: { dangerousFilter: true }
  });
  await harness.apply(siteInfo, url);
  assert.equal(harness.hasElement('netguard-child-overlay'), true);
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    ['dangerous-ui', 'dangerous-log']
  );

  harness.setState({
    childModeEnabled: true,
    settings: { dangerousFilter: false }
  });
  await harness.apply(siteInfo, url);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
  assert.equal(harness.hasElement('netguard-child-popup'), false);
  assert.equal(harness.calls.length, 2);
});

test('entertainmentLimit supports live disable enable and duplicate-save suppression', async () => {
  const harness = createChildPolicyHarness();
  const siteInfo = { type: 'entertainment', site: '本地儿童模式演示页' };
  const url = 'file:///project/demos/child/child_entertainment_demo.html';

  harness.setState({
    childModeEnabled: true,
    settings: { entertainmentLimit: true }
  });
  await harness.apply(siteInfo, url);
  assert.equal(harness.hasElement('netguard-child-banner'), true);
  assert.equal(harness.hasElement('netguard-child-overlay'), true);
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    ['banner', 'entertainment-ui', 'entertainment-log']
  );

  await harness.apply(siteInfo, url);
  assert.equal(harness.calls.length, 3);

  harness.setState({
    childModeEnabled: true,
    settings: { entertainmentLimit: false }
  });
  await harness.apply(siteInfo, url);
  assert.equal(harness.hasElement('netguard-child-banner'), false);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
  assert.equal(harness.calls.length, 3);

  harness.setState({
    childModeEnabled: true,
    settings: { entertainmentLimit: true }
  });
  await harness.apply(siteInfo, url);
  assert.equal(harness.hasElement('netguard-child-overlay'), true);
  assert.equal(harness.calls.length, 6);

  const settingsListenerSource = sourceBetween(
    CONTENT_SOURCE,
    'function setupChildModeChangeListener()',
    '// 检查当前页面是否在演示白名单中'
  );
  assert.match(settingsListenerSource, /changes\.childSettings/);
  assert.match(
    settingsListenerSource,
    /if \(isChildMode\) \{\s*checkChildModeSite\(\);/
  );
  assert.match(settingsListenerSource, /else \{\s*clearChildModeUi\(\);/);
});

test('entertainmentLimit or learningMode gates game UI and game_block while learning remains allowed', async () => {
  const gameInfo = { type: 'game', site: '本地儿童模式演示页' };
  const gameUrl = 'file:///project/demos/child/child_game_demo.html';
  assert.match(POPUP_SOURCE, /learningMode:\s*false/);

  const entertainmentHarness = createChildPolicyHarness();
  entertainmentHarness.setState({
    childModeEnabled: true,
    settings: { entertainmentLimit: true, learningMode: false }
  });
  await entertainmentHarness.apply(gameInfo, gameUrl);
  assert.equal(entertainmentHarness.hasElement('netguard-child-overlay'), true);
  assert.deepEqual(
    entertainmentHarness.calls.map(([name]) => name),
    ['game-ui', 'game-log']
  );

  const learningHarness = createChildPolicyHarness();
  learningHarness.setState({
    childModeEnabled: true,
    settings: { entertainmentLimit: false, learningMode: true }
  });
  await learningHarness.apply(gameInfo, gameUrl);
  assert.equal(learningHarness.hasElement('netguard-child-overlay'), true);
  assert.deepEqual(
    learningHarness.calls.map(([name]) => name),
    ['game-ui', 'game-log']
  );

  const disabledHarness = createChildPolicyHarness();
  disabledHarness.setState({
    childModeEnabled: true,
    settings: {
      entertainmentLimit: false,
      learningMode: false
    }
  });
  await disabledHarness.apply(gameInfo, gameUrl);
  assert.equal(disabledHarness.hasElement('netguard-child-overlay'), false);
  assert.equal(disabledHarness.calls.length, 0);

  const learningSiteHarness = createChildPolicyHarness();
  learningSiteHarness.setState({
    childModeEnabled: true,
    settings: {
      dangerousFilter: false,
      entertainmentLimit: false,
      learningMode: false
    }
  });
  await learningSiteHarness.apply(
    { type: 'learning', site: '本地儿童模式演示页' },
    'file:///project/demos/child/child_learning_demo.html'
  );
  assert.equal(learningSiteHarness.hasElement('netguard-child-banner'), true);
  assert.equal(learningSiteHarness.calls.at(-1)[0], 'banner');
});

test('child master switch pause and whitelist gate every advanced policy', async () => {
  const harness = createChildPolicyHarness();
  const enabledSettings = {
    dangerousFilter: true,
    entertainmentLimit: true,
    learningMode: true
  };

  harness.setState({
    childModeEnabled: false,
    settings: enabledSettings
  });
  await harness.apply({ type: 'dangerous', keyword: 'phishing' });
  await harness.apply({ type: 'entertainment', site: 'youtube.com' });
  await harness.apply({ type: 'game', site: '4399.com' });
  await harness.apply({ type: 'learning', site: 'coursera.org' });
  assert.equal(harness.calls.length, 0);

  harness.setState({
    childModeEnabled: true,
    skipProtection: true,
    settings: enabledSettings
  });
  await harness.apply({ type: 'game', site: '4399.com' });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
});

test('the early game fast path uses the shared game policy before scheduling and applying', () => {
  const fastGameSource = sourceBetween(
    CONTENT_SOURCE,
    '// 游戏网站快速入口',
    '// 本地文件页面正常执行检测'
  );

  assert.match(
    fastGameSource,
    /childModeEnabled\s*&&\s*resolveChildPolicyType\(\{ type: 'game' \}\) === 'game'/
  );
  assert.match(fastGameSource, /resolveChildPolicyType\(\{ type: 'game' \}\) !== 'game'/);
  assert.match(fastGameSource, /applyChildModePolicy\(/);
  assert.doesNotMatch(fastGameSource, /function injectGameBlocker/);
});

test('dangerousFilter false does not disable the background high-risk warning chain', async () => {
  const harness = await createBackgroundHarness({
    netguardUnifiedSettingsMigrated: true,
    netguardSettings: {
      adMode: 'normal',
      elderMode: false,
      childMode: true,
      paused: false
    },
    childSettings: {
      childModeEnabled: true,
      dangerousFilter: false
    }
  });
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

  await harness.context.performUrlCheck(
    'https://example.com/?phishing=1',
    31
  );

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.tabUpdates.length, 1);
  assert.match(
    harness.tabUpdates[0].updateProperties.url,
    /^chrome-extension:\/\/test\/warning\.html\?/
  );
});

test('game blocker reuses visible child overlay UI on the local game demo', () => {
  const harness = createGameBlockerHarness(
    'file:///D:/project/demos/child/child_game_demo.html'
  );
  const sharedStyle = harness.elements.get('netguard-child-blocker-styles');
  assert.ok(sharedStyle);
  assert.match(sharedStyle.textContent, /\.netguard-child-overlay/);
  assert.match(sharedStyle.textContent, /z-index:\s*999999/);
  assert.equal(harness.overlay.id, 'netguard-child-overlay');
  assert.equal(harness.popup.id, 'netguard-child-popup');
  assert.equal(harness.popup.className, 'netguard-child-popup game');
  assert.match(harness.popup.innerHTML, /游戏网站拦截/);
  assert.match(harness.popup.innerHTML, /返回演示主页/);
  assert.equal(typeof harness.backButton.click, 'function');

  harness.clickBack();
  assert.equal(
    harness.replacedTo,
    'file:///D:/project/demos/child/child_demo_home.html'
  );
  assert.equal(harness.historyBackCount, 0);
});

test('HTTP game blocker leaves the site without entering demo history or looping', () => {
  const gameUrl = 'https://www.4399.com/';
  const harness = createGameBlockerHarness(gameUrl);

  assert.match(harness.popup.innerHTML, /离开此网站/);
  assert.doesNotMatch(harness.popup.innerHTML, /返回演示主页/);
  harness.clickBack();

  assert.equal(harness.replacedTo, 'about:blank');
  assert.notEqual(harness.replacedTo, gameUrl);
  assert.doesNotMatch(harness.replacedTo, /child_demo_home\.html/);
  assert.equal(harness.historyBackCount, 0);
  assert.doesNotMatch(
    sourceBetween(
      CONTENT_SOURCE,
      'function showGameBlocker(site)',
      '// 显示危险网站拦截页面'
    ),
    /window\.history\.back\(\)/
  );
});

test('normal and strict share one bounded observer without blanket iframe hiding', () => {
  assert.doesNotMatch(CONTENT_SOURCE, /strictModeObserver/);
  assert.doesNotMatch(CONTENT_SOURCE, /cleanupSuspiciousElements/);
  assert.match(CONTENT_SOURCE, /const pendingRoots = new Set\(\)/);
  assert.match(CONTENT_SOURCE, /getAdCandidateSelector\(mode\)/);
  assert.doesNotMatch(
    CONTENT_SOURCE,
    /querySelectorAll\('div, span, img, iframe, script, a, ins'\)/
  );
  assert.match(
    CONTENT_SOURCE,
    /if \(hide && isAdElement\(iframe, 'strict'\)\) \{\s*await handleAdElement\('strict', iframe\)/
  );
  assert.doesNotMatch(
    CONTENT_SOURCE,
    /querySelectorAll\('iframe'\)\.forEach/
  );
  assert.match(CONTENT_SOURCE, /const countedAdElements = new WeakSet\(\)/);
  assert.match(CONTENT_SOURCE, /const countedAdRegionKeys = new Set\(\)/);
  assert.match(CONTENT_SOURCE, /function getAdRegionKey\(el\)/);
  assert.match(CONTENT_SOURCE, /function findStrictLabeledAdShells\(root/);
  assert.match(CONTENT_SOURCE, /reason: 'explicit-ad-label-shell'/);
  assert.match(CONTENT_SOURCE, /const labeledAdShells = mode === 'strict'/);
  assert.match(CONTENT_SOURCE, /textLength > 400 \|\| descendantCount > 120 \|\| interactiveCount > 6/);
  assert.doesNotMatch(CONTENT_SOURCE, /\[class\*="ad"\]/);

  const patternSource = CONTENT_SOURCE.match(
    /const STRICT_AD_LABEL_PATTERN = (\/[^\r\n]+\/i);/
  );
  assert.ok(patternSource);
  const strictAdLabelPattern = vm.runInNewContext(patternSource[1]);
  for (const label of ['广告', '广告×', '广告x', '关闭广告', 'Advertisement']) {
    assert.equal(strictAdLabelPattern.test(label), true);
  }
  for (const normalText of ['广告行业分析', '推广活动', 'promotion', '商品广告位说明']) {
    assert.equal(strictAdLabelPattern.test(normalText), false);
  }
  assert.match(CONTENT_SOURCE, /rule_reason: decision\.reason/);
  assert.match(CONTENT_SOURCE, /class: typeof el\.className === 'string'/);
  assert.doesNotMatch(CONTENT_SOURCE, /function setupModeChangeListener/);
  assert.doesNotMatch(CONTENT_SOURCE, /blockType/);
});

test('content, compatibility API and warning page keep the pause gate at every boundary', () => {
  assert.deepEqual(
    MANIFEST.content_scripts[0].js,
    ['api-config.js', 'extension-api.js', 'ad-detector.js', 'content.js']
  );
  assert.match(
    EXTENSION_API_SOURCE,
    /source\.protectionPaused\s*\?\?\s*unified\.protectionPaused/
  );
  assert.match(
    CONTENT_SOURCE,
    /async function checkTextWithAI\(text\) \{\s*if \(await shouldSkipProtectionNow\(\)\)/
  );
  assert.match(
    CONTENT_SOURCE,
    /async function runAIDetection\(\) \{\s*if \(isOfficialTrustedUiPage\(\)\) \{[\s\S]*?return;\s*\}\s*if \(!IS_TOP_FRAME \|\| await shouldSkipProtectionNow\(\)\)/
  );
  assert.match(
    CONTENT_SOURCE,
    /async function showHighRiskPopup\(options\) \{\s*if \(!IS_TOP_FRAME \|\| await shouldSkipProtectionNow\(\)\) return;/
  );
  assert.match(
    WARNING_SOURCE,
    /if \(await leaveWarningPageIfPaused\(\)\) return;/
  );
});

test('official file UI with its trusted marker skips automatic page-text AI scanning', () => {
  assert.equal(
    evaluateOfficialTrustedUiPage(
      'file:///D:/workspace/UI/index.html',
      'official-ui'
    ),
    true
  );
  assert.match(
    CONTENT_SOURCE,
    /async function startAIDetection\(\) \{\s*if \(isOfficialTrustedUiPage\(\)\) return;/
  );
  assert.match(
    CONTENT_SOURCE,
    /async function runAIDetection\(\) \{\s*if \(isOfficialTrustedUiPage\(\)\)/
  );
  assert.match(
    CONTENT_SOURCE,
    /window\.netguardStartAICheck = async function\(urlRiskResult\) \{\s*if \(isOfficialTrustedUiPage\(\)\) return;/
  );
});

test('official UI path without the trusted marker is not trusted', () => {
  assert.equal(
    evaluateOfficialTrustedUiPage(
      'file:///D:/workspace/UI/index.html'
    ),
    false
  );
});

test('the trusted marker does not trust a different local file', () => {
  assert.equal(
    evaluateOfficialTrustedUiPage(
      'file:///D:/workspace/other/index.html',
      'official-ui'
    ),
    false
  );
  assert.equal(
    evaluateOfficialTrustedUiPage(
      'https://example.test/UI/index.html',
      'official-ui'
    ),
    false
  );
});

test('local phishing and child demos remain outside the official trusted UI bypass', () => {
  assert.equal(
    evaluateOfficialTrustedUiPage(
      'file:///D:/workspace/demos/url/phishing-demo.html',
      'official-ui'
    ),
    false
  );
  assert.equal(
    evaluateOfficialTrustedUiPage(
      'file:///D:/workspace/demos/child/dangerous-site-demo.html',
      'official-ui'
    ),
    false
  );
  assert.match(
    CONTENT_SOURCE,
    /const CHILD_DEMO_SITE_TYPE_MAP = Object\.freeze/
  );
});

test('warning page redirects before rendering when protectionPaused is true', async () => {
  let domReady = null;
  let redirectedTo = null;
  let warningRenderAccesses = 0;
  const storageChanges = createEventTarget();
  const originalUrl = 'file:///project/demos/url/gambling-demo.html';
  const windowObject = {
    location: {
      search: `?url=${encodeURIComponent(originalUrl)}`,
      replace(url) {
        redirectedTo = url;
      }
    },
    history: {
      back() {}
    },
    chrome: {
      storage: {
        local: {
          get(_keys, callback) {
            callback({
              protectionPaused: true,
              netguardSettings: {
                protectionPaused: false,
                paused: false
              }
            });
          }
        },
        onChanged: storageChanges
      }
    }
  };
  const context = {
    URLSearchParams,
    console: { log() {} },
    document: {
      addEventListener(eventName, callback) {
        if (eventName === 'DOMContentLoaded') domReady = callback;
      },
      getElementById() {
        warningRenderAccesses += 1;
        return null;
      }
    },
    window: windowObject
  };

  vm.createContext(context);
  vm.runInContext(WARNING_SOURCE, context, { filename: WARNING_PATH });
  await domReady();

  assert.equal(redirectedTo, originalUrl);
  assert.equal(warningRenderAccesses, 0);
});

test('warning page also exits before rendering for a whitelisted target', async () => {
  let domReady = null;
  let redirectedTo = null;
  let warningRenderAccesses = 0;
  const originalUrl = 'https://sub.allowed.example/gambling-demo.html';
  const windowObject = {
    location: {
      search: `?url=${encodeURIComponent(originalUrl)}`,
      replace(url) { redirectedTo = url; }
    },
    history: { back() {} },
    chrome: {
      storage: {
        local: {
          get(_keys, callback) {
            callback({
              protectionPaused: false,
              whitelist: ['allowed.example']
            });
          }
        },
        onChanged: createEventTarget()
      }
    }
  };
  const context = {
    URL,
    URLSearchParams,
    console: { log() {} },
    document: {
      addEventListener(eventName, callback) {
        if (eventName === 'DOMContentLoaded') domReady = callback;
      },
      getElementById() {
        warningRenderAccesses += 1;
        return null;
      }
    },
    window: windowObject
  };

  vm.createContext(context);
  vm.runInContext(WARNING_SOURCE, context, { filename: WARNING_PATH });
  await domReady();

  assert.equal(redirectedTo, originalUrl);
  assert.equal(warningRenderAccesses, 0);
});

test('warning back skips only exact local child danger demo intermediates', async () => {
  async function runWarningBack(targetUrl) {
    let domReady = null;
    let goBack = null;
    let redirectedTo = null;
    let historyBackCount = 0;
    const displayElement = { style: {}, textContent: '' };
    const goBackButton = {
      addEventListener(_eventName, callback) { goBack = callback; }
    };
    const proceedButton = {
      disabled: false,
      addEventListener() {}
    };
    const chrome = {
      storage: {
        local: {
          get(_keys, callback) {
            callback({ protectionPaused: false, whitelist: [] });
          }
        },
        onChanged: createEventTarget()
      }
    };
    const windowObject = {
      chrome,
      history: { back() { historyBackCount += 1; } },
      location: {
        search: `?url=${encodeURIComponent(targetUrl)}&risk=high`,
        replace(url) { redirectedTo = url; }
      }
    };
    const context = {
      URL,
      URLSearchParams,
      console: { log() {}, warn() {} },
      document: {
        addEventListener(eventName, callback) {
          if (eventName === 'DOMContentLoaded') domReady = callback;
        },
        getElementById(id) {
          if (id === 'go-back') return goBackButton;
          if (id === 'proceed') return proceedButton;
          return displayElement;
        }
      },
      window: windowObject
    };

    vm.createContext(context);
    vm.runInContext(WARNING_SOURCE, context, { filename: WARNING_PATH });
    await domReady();
    goBack();
    return { historyBackCount, redirectedTo };
  }

  for (const fileName of [
    'child_danger_demo.html',
    'fake_gambling.html',
    'fake_violence.html'
  ]) {
    const targetUrl = `file:///D:/project/demos/child/${fileName}`;
    const result = await runWarningBack(targetUrl);
    assert.equal(
      result.redirectedTo,
      'file:///D:/project/demos/child/child_demo_home.html'
    );
    assert.equal(result.historyBackCount, 0);
  }

  for (const targetUrl of [
    'https://example.com/?phishing=1',
    'file:///tmp/fake_gambling.html',
    'file:///D:/project/demos/other/fake_gambling.html',
    'file:///D:/project/demos/child/child_game_demo.html'
  ]) {
    const result = await runWarningBack(targetUrl);
    assert.equal(result.redirectedTo, null);
    assert.equal(result.historyBackCount, 1);
  }
});

test('warning continue requests a one-time grant before navigating', async () => {
  let domReady = null;
  let proceed = null;
  let redirectedTo = null;
  let sentMessage = null;
  const targetUrl = 'https://example.com/?phishing=1&next=%25encoded';
  const proceedButton = {
    disabled: false,
    addEventListener(_eventName, callback) {
      proceed = callback;
    }
  };
  const goBackButton = {
    addEventListener() {}
  };
  const chrome = {
    runtime: {
      sendMessage(message, callback) {
        sentMessage = clone(message);
        callback({ success: true, targetUrl });
      }
    },
    storage: {
      local: {
        get(_keys, callback) {
          callback({ protectionPaused: false, whitelist: [] });
        }
      },
      onChanged: createEventTarget()
    }
  };
  const windowObject = {
    chrome,
    history: { back() {} },
    location: {
      search: `?url=${encodeURIComponent(targetUrl)}&risk=high`,
      replace(url) { redirectedTo = url; }
    }
  };
  const displayElement = { style: {}, textContent: '' };
  const context = {
    URL,
    URLSearchParams,
    console: { log() {}, warn() {} },
    document: {
      addEventListener(eventName, callback) {
        if (eventName === 'DOMContentLoaded') domReady = callback;
      },
      getElementById(id) {
        if (id === 'proceed') return proceedButton;
        if (id === 'go-back') return goBackButton;
        return displayElement;
      }
    },
    window: windowObject
  };

  vm.createContext(context);
  vm.runInContext(WARNING_SOURCE, context, { filename: WARNING_PATH });
  await domReady();
  await proceed();

  assert.deepEqual(sentMessage, {
    type: 'NETGUARD_CONTINUE_ONCE',
    targetUrl
  });
  assert.equal(redirectedTo, targetUrl);
  assert.equal(proceedButton.disabled, true);
});
