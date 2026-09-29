'use strict';

const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');
const CONTENT_SOURCE = fs.readFileSync(CONTENT_PATH, 'utf8');
const NEUTRAL_URL = 'https://articles.example.test/guide/123';

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const CHILD_GATE_SOURCE = sourceBetween(
  CONTENT_SOURCE,
  'function normalizeHost(value)',
  'function clearProtectionWarnings()'
);
const SECURITY_EVENT_SOURCE = sourceBetween(
  CONTENT_SOURCE,
  'function generateSecurityEventUuid()',
  '// ==================== 统计数据管理'
);
const CHILD_CONFIG_SOURCE = sourceBetween(
  CONTENT_SOURCE,
  'const CHILD_MODE_CONFIG =',
  '// 加载儿童模式配置'
);
const CHILD_CLASSIFICATION_SOURCE = sourceBetween(
  CONTENT_SOURCE,
  'const CHILD_DEMO_SITE_TYPE_MAP =',
  '// 显示儿童模式顶部横幅'
);
const CHILD_POLICY_SOURCE = sourceBetween(
  CONTENT_SOURCE,
  'function checkSystemPage(url)',
  '// ==================== 启动'
);

class FakeTextNode {
  constructor(data, ownerDocument) {
    this.nodeType = 3;
    this.data = String(data);
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
  }

  get firstChild() {
    return null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.computedStyle = {};
    this.hidden = false;
    this.className = '';
    this._id = '';
    this._innerHTML = '';
    this.listeners = new Map();
  }

  get id() {
    return this._id;
  }

  set id(value) {
    if (this._id) this.ownerDocument.unregisterId(this._id, this);
    this._id = String(value || '');
    if (this._id) this.ownerDocument.registerId(this._id, this);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  get textContent() {
    return this.childNodes.map(child => (
      child.nodeType === 3 ? child.data : child.textContent
    )).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value));
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get firstElementChild() {
    return this.childNodes.find(child => child.nodeType === 1) || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.parentNode) child.remove();
    const index = this.childNodes.indexOf(reference);
    child.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.childNodes;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentNode = null;
    }
    this.ownerDocument.unregisterTree(this);
  }

  setAttribute(name, value) {
    const normalized = String(name);
    const stringValue = String(value);
    this.attributes.set(normalized, stringValue);
    if (normalized === 'id') this.id = stringValue;
    if (normalized.startsWith('data-')) {
      const key = normalized.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = stringValue;
    }
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return name === 'id' ? Boolean(this.id) : this.attributes.has(name);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  querySelector() {
    return null;
  }
}

class FakeDocument {
  constructor(bodySpecs = []) {
    this.elementsById = new Map();
    this.head = new FakeElement('head', this);
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    bodySpecs.forEach(spec => appendSpec(this, this.body, spec));
  }

  registerId(id, element) {
    this.elementsById.set(id, element);
  }

  unregisterId(id, element) {
    if (this.elementsById.get(id) === element) this.elementsById.delete(id);
  }

  unregisterTree(node) {
    if (node.nodeType !== 1) return;
    if (node.id) this.unregisterId(node.id, node);
    node.childNodes.forEach(child => this.unregisterTree(child));
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(data) {
    return new FakeTextNode(data, this);
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

function appendSpec(document, parent, spec) {
  if (typeof spec === 'string') {
    parent.appendChild(document.createTextNode(spec));
    return;
  }

  const element = document.createElement(spec.tag || 'div');
  if (spec.lowercaseTagName) element.tagName = element.tagName.toLowerCase();
  if (spec.id) element.id = spec.id;
  if (spec.hidden) element.hidden = true;
  if (spec.ariaHidden !== undefined) {
    element.setAttribute('aria-hidden', String(spec.ariaHidden));
  }
  if (spec.style) element.computedStyle = { ...spec.style };
  parent.appendChild(element);
  (spec.children || []).forEach(child => appendSpec(document, element, child));
}

function articleBody(text) {
  return [{ tag: 'article', children: [text] }];
}

function createChildModeHarness({
  url = NEUTRAL_URL,
  body = articleBody('普通文章内容'),
  topFrame = true,
  childModeEnabled = true,
  isChildMode = childModeEnabled,
  paused = false,
  settings = {},
  globalWhitelist = [],
  childWhitelist = [],
  mode = 'Child'
} = {}) {
  const document = new FakeDocument(body);
  const calls = [];
  const messages = [];
  const window = {
    location: { href: url },
    getComputedStyle(element) {
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        ...element.computedStyle
      };
    }
  };
  window.top = topFrame ? window : {};

  const context = {
    URL,
    calls,
    clearTimeout,
    console: { log() {}, warn() {} },
    crypto: webcrypto,
    decodeURIComponent,
    document,
    extensionAPI: {
      runtime: {
        sendMessage(message, callback) {
          messages.push(JSON.parse(JSON.stringify(message)));
          callback?.({ success: true });
        }
      }
    },
    setTimeout,
    window
  };

  vm.createContext(context);
  vm.runInContext(`
    const AI_DEBUG = false;
    const COMPAT_SCORE_FIELD = ['risk', 'score'].join('_');
    const CHILD_POLICY_DEFAULTS = Object.freeze({
      dangerousFilter: true,
      entertainmentLimit: true,
      learningMode: false
    });
    const IS_TOP_FRAME = ${topFrame ? 'true' : 'false'};
    let protectionPaused = false;
    let siteWhitelist = [];
    let childWhitelist = [];
    let childModeEnabled = true;
    let isChildMode = true;
    let childModeSettings = {};
    let childBrowsingLimitState = null;
    let activeChildPolicyKey = null;
    let childBrowsingReminderTimer = null;
    let currentMode = 'child';
    let elderModeEnabled = false;

    function removeChildBrowsingReminder() {}
    function applyChildBrowsingLimitState() { return false; }
    function checkIfDemoPage() { return false; }
    async function shouldSkipProtectionNow() { return shouldSkipProtection(); }

    function addHarnessElement(id) {
      const element = document.createElement('div');
      element.id = id;
      document.body.appendChild(element);
      return element;
    }
    function showChildModeBanner(type) {
      calls.push({ name: 'banner', value: type });
      addHarnessElement('netguard-child-banner');
    }
    function showEntertainmentBlocker(site) {
      calls.push({ name: 'entertainment-ui', value: site });
      addHarnessElement('netguard-child-overlay');
      addHarnessElement('netguard-child-popup');
    }
    function showGameBlocker(site) {
      calls.push({ name: 'game-ui', value: site });
      addHarnessElement('netguard-child-overlay');
      addHarnessElement('netguard-child-popup');
    }
    function showDangerousBlocker(keyword) {
      calls.push({ name: 'dangerous-ui', value: keyword });
      addHarnessElement('netguard-child-overlay');
      addHarnessElement('netguard-child-popup');
    }

    ${CHILD_GATE_SOURCE}
    ${SECURITY_EVENT_SOURCE}
    ${CHILD_CONFIG_SOURCE}
    ${CHILD_CLASSIFICATION_SOURCE}
    ${CHILD_POLICY_SOURCE}

    globalThis.setHarnessState = state => {
      if (Object.prototype.hasOwnProperty.call(state, 'url')) {
        window.location.href = state.url;
      }
      if (Object.prototype.hasOwnProperty.call(state, 'paused')) {
        protectionPaused = Boolean(state.paused);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'globalWhitelist')) {
        siteWhitelist = [...state.globalWhitelist];
      }
      if (Object.prototype.hasOwnProperty.call(state, 'childWhitelist')) {
        childWhitelist = [...state.childWhitelist];
      }
      if (Object.prototype.hasOwnProperty.call(state, 'childModeEnabled')) {
        childModeEnabled = Boolean(state.childModeEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'isChildMode')) {
        isChildMode = Boolean(state.isChildMode);
      }
      if (Object.prototype.hasOwnProperty.call(state, 'settings')) {
        childModeSettings = { ...state.settings };
      }
      if (Object.prototype.hasOwnProperty.call(state, 'mode')) {
        currentMode = String(state.mode).toLowerCase();
        elderModeEnabled = currentMode === 'elder';
      }
    };
  `, context, { filename: CONTENT_PATH });

  context.setHarnessState({
    childModeEnabled,
    isChildMode,
    paused,
    settings,
    globalWhitelist,
    childWhitelist,
    mode,
    url
  });

  return {
    calls,
    context,
    document,
    messages,
    async check() {
      await context.checkChildModeSite();
    },
    extractText() {
      return context.extractChildBodyText();
    },
    hasElement(id) {
      return Boolean(document.getElementById(id));
    },
    securityEvents(type) {
      return messages
        .filter(message => message.type === 'NETGUARD_SECURITY_EVENT')
        .map(message => message.event)
        .filter(event => !type || event.type === type);
    },
    setState(state) {
      context.setHarnessState(state);
    }
  };
}

async function assertDangerousBody(text, expectedReason) {
  const harness = createChildModeHarness({ body: articleBody(text) });
  await harness.check();
  assert.equal(harness.hasElement('netguard-child-overlay'), true);
  assert.equal(harness.hasElement('netguard-child-popup'), true);
  assert.equal(harness.calls.filter(call => call.name === 'dangerous-ui').length, 1);
  const events = harness.securityEvents('dangerous_block');
  assert.equal(events.length, 1);
  assert.match(events[0].reason, new RegExp(expectedReason));
}

async function assertSafeBody(text) {
  const harness = createChildModeHarness({ body: articleBody(text) });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0, text);
  assert.equal(harness.hasElement('netguard-child-overlay'), false, text);
}

const CHILD_BODY_RISK_CASES = [
  {
    name: 'RISK-041 formal gambling inducement body',
    text: '赌博平台宣传高额返利并诱导未成年人充值参与博彩',
    reason: '博彩赌博诱导'
  },
  {
    name: 'RISK-041 equivalent wording',
    text: '某赌场正用返利活动招揽儿童下注，声称投注越多奖励越高',
    reason: '博彩赌博诱导'
  },
  {
    name: 'RISK-042 formal privacy solicitation body',
    text: '陌生网友诱导儿童发送家庭住址、手机号和验证码',
    reason: '索取隐私或验证信息'
  },
  {
    name: 'RISK-042 equivalent wording',
    text: '网友要求把家庭地址和手机验证码发给他才能领取礼物',
    reason: '索取隐私或验证信息'
  },
  {
    name: 'RISK-043 formal high-value game payment body',
    text: '游戏平台诱导孩子高额充值，并教他绕过家长监管完成付费',
    reason: '高额充值或绕过监管'
  },
  {
    name: 'RISK-043 equivalent wording',
    text: '这款游戏要求大量付费，还提供绕过家长限制的充值办法',
    reason: '高额充值或绕过监管'
  },
  {
    name: 'RISK-044 formal concealed transfer body',
    text: '对方要求儿童私下转账，并强调不要告诉父母或老师',
    reason: '隐瞒或私下资金诱导'
  },
  {
    name: 'RISK-044 equivalent wording',
    text: '请把钱私下汇款到这个账户，瞒着老师和父母就能获得奖励',
    reason: '隐瞒或私下资金诱导'
  }
];

for (const scenario of CHILD_BODY_RISK_CASES) {
  test(`${scenario.name} is blocked on a neutral URL`, async () => {
    await assertDangerousBody(scenario.text, scenario.reason);
  });
}

test('custom dangerous body keywords trim blanks and match case-insensitively', async () => {
  const harness = createChildModeHarness({
    body: articleBody('文章中出现 BLUEORCHID-045 代号。'),
    settings: { dangerousSites: ['  BlueOrchid-045  ', '', '   '] }
  });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 1);
  assert.equal(
    harness.calls.find(call => call.name === 'dangerous-ui').value,
    '自定义危险关键词'
  );

  const blankOnly = createChildModeHarness({
    body: articleBody('这是一篇普通文章。'),
    settings: { dangerousSites: ['', '   ', '\t'] }
  });
  await blankOnly.check();
  assert.equal(blankOnly.securityEvents('dangerous_block').length, 0);
  assert.equal(blankOnly.hasElement('netguard-child-overlay'), false);
});

test('RISK-045 custom keyword is detected from body only on a neutral URL', async () => {
  const harness = createChildModeHarness({
    body: articleBody('普通文章正文包含 RISK-045 自定义标记。'),
    settings: { dangerousSites: ['risk-045'] }
  });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 1);
  assert.equal(
    harness.calls.find(call => call.name === 'dangerous-ui').value,
    '自定义危险关键词'
  );
});

test('custom dangerous keywords retain URL matching', async () => {
  const harness = createChildModeHarness({
    url: 'https://articles.example.test/archive/blueorchid-045',
    body: articleBody('这是一篇普通文章。'),
    settings: { dangerousSites: ['  BlueOrchid-045  '] }
  });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 1);
  assert.equal(
    harness.calls.find(call => call.name === 'dangerous-ui').value,
    'blueorchid-045'
  );
});

test('removing a custom dangerous keyword clears the same body on recheck', async () => {
  const harness = createChildModeHarness({
    body: articleBody('正文包含 blueorchid-045。'),
    settings: { dangerousSites: ['blueorchid-045'] }
  });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 1);
  assert.equal(harness.hasElement('netguard-child-overlay'), true);

  harness.setState({ settings: { dangerousSites: [] } });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 1);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
  assert.equal(harness.hasElement('netguard-child-popup'), false);
  assert.equal(harness.hasElement('netguard-child-banner'), true);
});

test('both child mode flags independently gate body scanning and policy', async () => {
  for (const flags of [
    { childModeEnabled: false, isChildMode: true },
    { childModeEnabled: true, isChildMode: false }
  ]) {
    const harness = createChildModeHarness({
      ...flags,
      body: articleBody(CHILD_BODY_RISK_CASES[0].text)
    });
    await harness.check();
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.securityEvents().length, 0);
  }
});

test('subframes cannot run the child body policy', async () => {
  const harness = createChildModeHarness({
    topFrame: false,
    body: articleBody(CHILD_BODY_RISK_CASES[1].text)
  });
  await harness.check();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.securityEvents().length, 0);
});

test('paused protection gates child body policy', async () => {
  const harness = createChildModeHarness({
    paused: true,
    body: articleBody(CHILD_BODY_RISK_CASES[2].text)
  });
  await harness.check();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.securityEvents().length, 0);
});

test('global whitelist gates child body policy for matching subdomains', async () => {
  const harness = createChildModeHarness({
    globalWhitelist: ['example.test'],
    body: articleBody(CHILD_BODY_RISK_CASES[3].text)
  });
  await harness.check();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.securityEvents().length, 0);
});

test('child whitelist gates child body policy for matching subdomains', async () => {
  const harness = createChildModeHarness({
    childWhitelist: ['https://example.test/learning'],
    body: articleBody(CHILD_BODY_RISK_CASES[4].text)
  });
  await harness.check();
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.securityEvents().length, 0);
});

test('dangerousFilter false suppresses body blocker and dangerous event', async () => {
  const harness = createChildModeHarness({
    body: articleBody(CHILD_BODY_RISK_CASES[5].text),
    settings: { dangerousFilter: false }
  });
  await harness.check();
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
  assert.equal(harness.securityEvents('dangerous_block').length, 0);
  assert.equal(harness.hasElement('netguard-child-banner'), true);
});

for (const mode of ['Normal', 'Strict', 'Elder']) {
  test(`${mode} mode is isolated from child body blocking`, async () => {
    const harness = createChildModeHarness({
      mode,
      childModeEnabled: false,
      isChildMode: false,
      body: articleBody(CHILD_BODY_RISK_CASES[6].text)
    });
    await harness.check();
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.securityEvents().length, 0);
    assert.equal(harness.hasElement('netguard-child-overlay'), false);
  });
}

for (const scenario of [
  {
    name: 'entertainmentLimit alone blocks game sites',
    settings: { entertainmentLimit: true, learningMode: false },
    blocked: true
  },
  {
    name: 'learningMode alone blocks game sites',
    settings: { entertainmentLimit: false, learningMode: true },
    blocked: true
  },
  {
    name: 'game sites are allowed when both game gates are false',
    settings: { entertainmentLimit: false, learningMode: false },
    blocked: false
  }
]) {
  test(scenario.name, async () => {
    const harness = createChildModeHarness({
      url: 'https://play.4399.com/flash/123',
      settings: scenario.settings
    });
    await harness.check();
    assert.equal(harness.hasElement('netguard-child-overlay'), scenario.blocked);
    assert.equal(
      harness.securityEvents('game_block').length,
      scenario.blocked ? 1 : 0
    );
  });
}

test('body danger uses the real dangerous_block event chain and is idempotent', async () => {
  const harness = createChildModeHarness({
    body: articleBody(CHILD_BODY_RISK_CASES[0].text)
  });
  await harness.check();
  await harness.check();

  const events = harness.securityEvents('dangerous_block');
  assert.equal(events.length, 1);
  assert.equal(harness.calls.filter(call => call.name === 'dangerous-ui').length, 1);
  assert.equal(events[0].url, NEUTRAL_URL);
  assert.equal(events[0].risk_level, 'high');
  assert.equal(events[0].score, 0.95);
  assert.equal(events[0].source, 'extension');
  assert.match(
    events[0].event_uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.match(events[0].reason, /危险网站拦截: 博彩赌博诱导/);
});

test('anti-fraud warning with verification and transfer terms is not blocked', async () => {
  const harness = createChildModeHarness({
    body: articleBody('反诈宣传：请勿向陌生人提供手机号和验证码，也不要私下转账。')
  });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
});

test('parent safety education with gambling and payment terms is not blocked', async () => {
  const harness = createChildModeHarness({
    body: articleBody('家长应教育儿童不要参与网络赌博，也不要进行高额游戏充值。')
  });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
});

test('explicit safety guidance variants are not blocked', async () => {
  for (const text of [
    '请警惕，陌生人会要求你发送手机号和验证码。',
    '安全提示，博彩平台常以高额返利诱导充值，请提高警惕。',
    '不要把验证码发给网友，切勿将家庭住址告诉陌生人。',
    '陌生人索取验证码可能是诈骗，应当立即拒绝。'
  ]) {
    const harness = createChildModeHarness({ body: articleBody(text) });
    await harness.check();
    assert.equal(harness.securityEvents('dangerous_block').length, 0, text);
    assert.equal(harness.hasElement('netguard-child-overlay'), false, text);
  }
});

test('safety words and negated claims cannot hide adjacent inducement', async () => {
  for (const text of [
    '不要泄露密码，博彩平台高额返利诱导充值。',
    '请勿向陌生人提供验证码，随后私下转账并瞒着父母。',
    '博彩充值可能没有风险，点击参加返利。',
    '赌博充值将不会造成损失，马上参与。',
    '运动会造成风险，立即充值参与博彩。',
    '安全提示：不要错过博彩高额返利立即充值。',
    '警方提醒：不要犹豫私下转账并瞒着父母。',
    '博彩充值不一定会造成损失，马上参与返利。'
  ]) {
    const harness = createChildModeHarness({ body: articleBody(text) });
    await harness.check();
    assert.equal(harness.securityEvents('dangerous_block').length, 1, text);
    assert.equal(harness.hasElement('netguard-child-overlay'), true, text);
  }
});

test('child body extraction is bounded before late-page risky content', async () => {
  const harness = createChildModeHarness({
    body: [{
      tag: 'main',
      children: [
        'a'.repeat(13000),
        CHILD_BODY_RISK_CASES[0].text
      ]
    }]
  });
  const extracted = harness.extractText();
  assert.ok(extracted.length <= 12000);
  assert.ok(extracted.length > 11000);
  assert.equal(extracted.includes('赌博'), false);
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
});

test('child body extraction also stops at the node limit', async () => {
  const harmlessNodes = Array.from({ length: 800 }, () => ({
    tag: 'span',
    children: ['x']
  }));
  const harness = createChildModeHarness({
    body: [
      ...harmlessNodes,
      { tag: 'p', children: [CHILD_BODY_RISK_CASES[0].text] }
    ]
  });
  assert.equal(harness.extractText().includes('赌博'), false);
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0);
});

test('hidden, ignored, and extension-owned text is excluded from child scanning', async () => {
  const risky = CHILD_BODY_RISK_CASES[2].text;
  const harness = createChildModeHarness({
    body: [
      { tag: 'section', hidden: true, children: [risky] },
      { tag: 'div', ariaHidden: true, children: [risky] },
      { tag: 'div', style: { display: 'none' }, children: [risky] },
      { tag: 'div', style: { visibility: 'hidden' }, children: [risky] },
      { tag: 'div', style: { opacity: '0' }, children: [risky] },
      { tag: 'script', children: [risky] },
      {
        tag: 'svg',
        children: [{ tag: 'script', lowercaseTagName: true, children: [risky] }]
      },
      { tag: 'div', id: 'netguard-test-owned', children: [risky] },
      { tag: 'article', children: ['普通可见文章内容。'] }
    ]
  });
  assert.equal(harness.extractText().includes('验证码'), false);
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0);
  assert.equal(harness.hasElement('netguard-child-overlay'), false);
});

const SECOND_ROUND_SAFE_CASES = [
  ['bank login may require a phone number and verification code', '为了完成登录，银行系统要求客户提交手机号和验证码。'],
  ['gambling and recharging are described as harmful', '网络赌博和充值会危害未成年人身心健康。'],
  ['a game has lots of free content and needs no payment', '这款游戏包含大量免费内容，不需要付费。'],
  ['a game platform describes free levels and paid props', '游戏平台提供大量免费关卡和付费道具说明。'],
  ['children are told not to give strangers private data', '请勿向陌生人提供手机号和验证码。'],
  ['police warn against transferring money to strangers', '警方提醒不要向陌生人转账。'],
  ['parents teach children to avoid gambling and private transfers', '家长应教育儿童不要参与网络赌博或私下转账。'],
  ['a high game recharge is explicitly prohibited', '请勿进行高额游戏充值。']
];

for (const [name, text] of SECOND_ROUND_SAFE_CASES) {
  test(`second-round safe regression: ${name}`, async () => {
    const harness = createChildModeHarness({ body: articleBody(text) });
    await harness.check();
    assert.equal(harness.securityEvents('dangerous_block').length, 0, text);
    assert.equal(harness.hasElement('netguard-child-overlay'), false, text);
  });
}

const SECOND_ROUND_DANGER_CASES = [
  ['gambling platform offers a high return after recharging', '博彩平台高额返利，充值后马上参与。'],
  ['joining a gambling platform promises a high return', '加入赌博平台充值即可获得高额返利。'],
  ['an online stranger requests a phone number and code', '陌生网友要求把手机号和验证码发给他。'],
  ['a stranger asks for an address and phone number', '陌生人让你发送家庭住址和手机号。'],
  ['a game recharge is hidden from parents', '不要告诉父母，偷偷给游戏充值。'],
  ['a high game recharge bypasses parental controls', '绕过家长监管进行高额游戏充值。'],
  ['a private transfer is hidden from parents and teachers', '私下转账给我，不要告诉父母和老师。'],
  ['a warning prefix does not hide gambling inducement', '请警惕，博彩高返利充值马上参与。'],
  ['a safety prefix does not hide gambling inducement', '安全提示：请注意立即充值参加博彩返利。'],
  ['a friendly reminder does not hide a secret transfer', '温馨提示：不要告诉父母，马上私下转账给我。'],
  ['a warning suffix does not hide a direct gambling instruction', '博彩平台高额返利马上参与，请提高警惕。']
];

for (const [name, text] of SECOND_ROUND_DANGER_CASES) {
  test(`second-round danger regression: ${name}`, async () => {
    const harness = createChildModeHarness({ body: articleBody(text) });
    await harness.check();
    assert.equal(harness.securityEvents('dangerous_block').length, 1, text);
    assert.equal(harness.hasElement('netguard-child-overlay'), true, text);
  });
}

const THIRD_ROUND_DANGER_CASES = [
  ['three-clause privacy request', '陌生网友要求你，把手机号和验证码，发给他。'],
  ['three-clause private-data solicitation', '陌生账号先联系儿童，然后让他把家庭住址，手机号和验证码，私发过去。'],
  ['concealed high-value mobile-game recharge', '瞒着家里给手游充几千元，不要让父母知道。'],
  ['secret high-value game recharge', '偷偷给游戏充上千元，别告诉家长。'],
  ['secret transfer using common wording', '先偷偷转钱给这个账号，别告诉老师和家长。'],
  ['private transfer with amount and concealed guardian', '私下转给他500元，不要让父母知道。'],
  ['gambling high-return participation', '博彩平台高额返利，充值后马上参与。'],
  ['gambling reward followed by immediate betting', '博彩平台奖励新用户，充值后立即下注。']
];

for (const [name, text] of THIRD_ROUND_DANGER_CASES) {
  test(`third-round danger regression: ${name}`, async () => {
    const harness = createChildModeHarness({ body: articleBody(text) });
    await harness.check();
    assert.equal(harness.securityEvents('dangerous_block').length, 1, text);
    assert.equal(harness.hasElement('netguard-child-overlay'), true, text);
  });
}

const THIRD_ROUND_SAFE_CASES = [
  ['police report gambling promotion', '警方通报赌博平台推广行为，提醒公众举报。'],
  ['police investigate private-transfer case', '警方调查私下转账案件。'],
  ['media describe gambling-platform promotion', '媒体报道某赌博平台曾通过推广吸引用户。'],
  ['school publishes gambling education case', '学校公布网络赌博典型案例并提醒学生远离。'],
  ['platform publishes private-transfer violation case', '平台公布私下转账违规案例。'],
  ['teacher warns against private transfers', '老师提醒学生不要私下转钱给陌生账号。'],
  ['parent prevents concealed mobile-game recharge', '家长应防止儿童瞒着家里给手游充值几千元。'],
  ['mobile game describes optional low-value props', '该手游包含价值几十元的可选付费道具。'],
  ['news reports a high-value game recharge dispute', '媒体报道某网络游戏用户充值上万元的消费纠纷。']
];

for (const [name, text] of THIRD_ROUND_SAFE_CASES) {
  test(`third-round safe regression: ${name}`, async () => {
    const harness = createChildModeHarness({ body: articleBody(text) });
    await harness.check();
    assert.equal(harness.securityEvents('dangerous_block').length, 0, text);
    assert.equal(harness.hasElement('netguard-child-overlay'), false, text);
  });
}

for (const [name, text] of [
  ['colon keeps privacy relation', '陌生网友要求你：把手机号和验证码发给他。'],
  ['enumeration comma keeps privacy relation', '陌生网友要求你、把手机号和验证码、发给他。']
]) {
  test(`third-round punctuation regression: ${name}`, async () => {
    await assertDangerousBody(text, '索取隐私或验证信息');
  });
}

const FOURTH_ROUND_DESCRIPTIVE_SAFE_CASES = [
  ['news reports a verification-code scam', '新闻机构报道一起诈骗案，嫌疑人曾让未成年人把验证码发给陌生账号。'],
  ['police report a concealed student transfer', '警方通报称，嫌疑人诱骗学生私下转钱给某账号并瞒着家长。'],
  ['school analyzes a gambling-site scam', '学校课堂分析博彩网站要求用户充值下注的骗局。'],
  ['teacher explains a personal-data scam pattern', '老师讲解骗子要求学生提供手机号和验证码的常见套路。'],
  ['media expose induced high game payments', '媒体曝光某游戏平台诱导未成年人进行高额充值。'],
  ['police investigate a concealed transfer case', '警方调查嫌疑人偷偷向某账户转钱并隐瞒家长的案件。']
];

for (const [name, text] of FOURTH_ROUND_DESCRIPTIVE_SAFE_CASES) {
  test(`fourth-round descriptive safe regression: ${name}`, async () => {
    await assertSafeBody(text);
  });
}

const FOURTH_ROUND_PREFIXED_DANGER_CASES = [
  ['police prefix does not hide direct privacy command', '警方提醒：把验证码发给这个账号即可领取奖励。', '索取隐私或验证信息'],
  ['news prefix does not hide direct gambling command', '新闻提示：博彩平台充值返利，马上参与即可获得奖金。', '博彩赌博诱导'],
  ['classroom prefix does not hide secret transfer command', '安全课堂：偷偷转钱给这个账号，不要告诉父母。', '隐瞒或私下资金诱导'],
  ['media prefix does not hide game-payment command', '媒体提醒：绕过家长限制，马上给手游充值几千元。', '高额充值或绕过监管']
];

for (const [name, text, reason] of FOURTH_ROUND_PREFIXED_DANGER_CASES) {
  test(`fourth-round prefixed danger regression: ${name}`, async () => {
    await assertDangerousBody(text, reason);
  });
}

const FOURTH_ROUND_SOFT_CLAUSE_CASES = [
  ['four soft clauses with an address and phone number', '陌生人对孩子说：把家庭地址、手机号码，发送给我。'],
  ['four soft clauses with form fields and a verification code', '陌生账号告诉孩子：填写家庭地址、手机号码，再把验证码发送给他。'],
  ['privacy enumeration keeps the subject and outbound action related', '陌生网友说：把地址、手机号、验证码，全部私发给我。']
];

for (const [name, text] of FOURTH_ROUND_SOFT_CLAUSE_CASES) {
  test(`fourth-round soft-clause regression: ${name}`, async () => {
    await assertDangerousBody(text, '索取隐私或验证信息');
  });
}

const FOURTH_ROUND_HARD_BOUNDARY_CASES = [
  ['school warning remains separate from a stranger contact', '陌生网友联系了孩子。学校提醒不要泄露手机号和验证码。'],
  ['bank input remains separate from an address mention', '陌生人提到家庭地址。银行页面要求客户输入手机号和验证码。'],
  ['school prevention remains separate from historical gambling', '博彩网站曾经诱导用户。学校课堂提醒学生不要充值下注。']
];

for (const [name, text] of FOURTH_ROUND_HARD_BOUNDARY_CASES) {
  test(`fourth-round hard-boundary regression: ${name}`, async () => {
    await assertSafeBody(text);
  });
}

const FOURTH_ROUND_DESCRIPTION_COMMAND_PAIRS = [
  {
    name: 'privacy description versus direct command',
    safe: '新闻案件分析称诈骗分子要求受害者把验证码发给陌生账号。',
    danger: '陌生账号要求你把验证码发给他。',
    reason: '索取隐私或验证信息'
  },
  {
    name: 'transfer description versus direct command',
    safe: '警方通报嫌疑人偷偷转账并隐瞒家长的案件。',
    danger: '偷偷转账给这个账号，不要告诉家长。',
    reason: '隐瞒或私下资金诱导'
  },
  {
    name: 'gambling description versus direct command',
    safe: '课堂分析博彩平台如何诱导用户充值下注的骗局。',
    danger: '博彩平台充值返利，立即下注参与。',
    reason: '博彩赌博诱导'
  }
];

for (const scenario of FOURTH_ROUND_DESCRIPTION_COMMAND_PAIRS) {
  test(`fourth-round paired relation: ${scenario.name}`, async () => {
    await assertSafeBody(scenario.safe);
    await assertDangerousBody(scenario.danger, scenario.reason);
  });
}

const FIFTH_ROUND_URGING_DANGER_CASES = [
  ['stranger service urges verification-code submission', '陌生客服催你把短信验证码提交给这个账号'],
  ['stranger service urges phone-code delivery', '陌生客服催促你把手机验证码发送给该账号'],
  ['stranger contact repeatedly urges code delivery', '陌生网友一直催你把验证码发给他'],
  ['stranger account urges child to send an address and phone number', '陌生账号催促孩子把家庭住址和手机号私发过去'],
  ['unfamiliar person urges a verification code', '不认识的人催你赶紧把验证码告诉他']
];

for (const [name, text] of FIFTH_ROUND_URGING_DANGER_CASES) {
  test(`fifth-round urging danger regression: ${name}`, async () => {
    await assertDangerousBody(text, '索取隐私或验证信息');
  });
}

const FIFTH_ROUND_URGING_SAFE_CASES = [
  ['bank service urges identity verification', '银行客服催促客户及时完成实名认证'],
  ['platform urges phone-number binding', '平台催促用户完善绑定手机号'],
  ['news reports an urging scam case', '新闻报道诈骗分子催促受害者提交验证码的案件'],
  ['police explain an urging scam pattern', '警方介绍骗子催用户把验证码发给陌生账号的套路']
];

for (const [name, text] of FIFTH_ROUND_URGING_SAFE_CASES) {
  test(`fifth-round urging safe regression: ${name}`, async () => {
    await assertSafeBody(text);
  });
}

test('hard sentence boundaries do not combine unrelated privacy terms', async () => {
  const text = '陌生网友联系了孩子。学校提醒不要泄露手机号和验证码。';
  const harness = createChildModeHarness({ body: articleBody(text) });
  await harness.check();
  assert.equal(harness.securityEvents('dangerous_block').length, 0, text);
  assert.equal(harness.hasElement('netguard-child-overlay'), false, text);
});

for (const [name, text] of [
  ['mobile-game recharge uses 充钱', '瞒着家长给手游充钱，别告诉老师。'],
  ['game recharge uses 几百元', '偷偷给网络游戏充几百元，不要告诉父母。'],
  ['game recharge uses 上万元', '私下给游戏账号充上万元，不要让监护人知道。']
]) {
  test(`third-round payment synonym regression: ${name}`, async () => {
    await assertDangerousBody(text, '高额充值或绕过监管');
  });
}
