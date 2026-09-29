'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const CONTENT_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../content.js'),
  'utf8'
);

function sourceBetween(startMarker, endMarker) {
  const start = CONTENT_SOURCE.indexOf(startMarker);
  const end = CONTENT_SOURCE.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return CONTENT_SOURCE.slice(start, end);
}

class FakeElement {
  constructor(tagName, text = '', attributes = {}, children = []) {
    this.tagName = tagName.toLowerCase();
    this.ownText = text;
    this.attributes = { ...attributes };
    this.children = [];
    this.parent = null;
    children.forEach(child => this.append(child));
  }

  append(child) {
    child.parent = this;
    this.children.push(child);
    return this;
  }

  cloneNode(deep) {
    return new FakeElement(
      this.tagName,
      this.ownText,
      this.attributes,
      deep ? this.children.map(child => child.cloneNode(true)) : []
    );
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }

  isExcluded() {
    if ([
      'script', 'style', 'noscript', 'svg', 'canvas', 'template',
      'nav', 'header', 'footer', 'aside', 'textarea'
    ].includes(this.tagName)) return true;
    if (
      this.tagName === 'input' &&
      String(this.attributes.type || '').toLowerCase() === 'password'
    ) return true;
    if (
      Object.hasOwn(this.attributes, 'contenteditable') &&
      String(this.attributes.contenteditable).toLowerCase() !== 'false'
    ) return true;
    if (
      Object.hasOwn(this.attributes, 'data-netguard-owned') ||
      Object.hasOwn(this.attributes, 'data-netguard-ui')
    ) return true;
    if (String(this.attributes.id || '').startsWith('netguard-')) return true;
    return String(this.attributes.class || '').includes('netguard-');
  }

  matches() {
    return this.isExcluded();
  }

  querySelectorAll() {
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.isExcluded()) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  get innerText() {
    return [this.ownText, ...this.children.map(child => child.innerText)]
      .filter(Boolean)
      .join('\n');
  }

  get textContent() {
    return this.innerText;
  }
}

function el(tagName, text = '', attributes = {}, children = []) {
  return new FakeElement(tagName, text, attributes, children);
}

function findFirst(root, predicate) {
  if (!root) return null;
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = findFirst(child, predicate);
    if (match) return match;
  }
  return null;
}

function createDocument({ title = '', description = '', body }) {
  const meta = description === null
    ? null
    : el('meta', '', { name: 'description', content: description });
  return {
    title,
    body,
    querySelector(selector) {
      if (selector === 'meta[name="description" i]') return meta;
      if (selector === 'main') {
        return findFirst(body, node => node.tagName === 'main');
      }
      if (selector === 'article') {
        return findFirst(body, node => node.tagName === 'article');
      }
      if (selector === '[role="main"]') {
        return findFirst(body, node => node.getAttribute('role') === 'main');
      }
      return null;
    }
  };
}

function createExtractorHarness(document, href = 'https://example.test/page') {
  const extractorSource = sourceBetween(
    'const PAGE_CONTEXT_TITLE_MAX_LENGTH',
    '// ==================== \u7edf\u4e00\u98ce\u9669\u5f39\u7a97\u7cfb\u7edf'
  );
  const context = {
    console: { warn() {} },
    document,
    window: { location: { href } }
  };
  vm.createContext(context);
  vm.runInContext(`
    const MAX_TEXT_LENGTH = 3000;
    ${extractorSource}
    globalThis.extractPageContextForTest = extractPageContext;
  `, context);
  return context.extractPageContextForTest;
}

test('extractPageContext prefers main and cleans title and description', () => {
  const body = el('body', 'body fallback', {}, [
    el('article', 'article fallback'),
    el('main', '  first   line  \n\nsecond line\nfirst line  ')
  ]);
  const extract = createExtractorHarness(createDocument({
    title: `  ${'T'.repeat(205)}  `,
    description: ` summary   ${'D'.repeat(310)} `,
    body
  }));

  const result = extract();
  assert.equal(result.title.length, 200);
  assert.equal(result.meta_description.length, 300);
  assert.equal(result.content, 'first line\nsecond line');
  assert.equal(result.url, 'https://example.test/page');
});

test('extractPageContext uses article then role main before body fallback', () => {
  const articleBody = el('body', 'body text', {}, [
    el('main', '', {}, [el('nav', 'menu only')]),
    el('article', 'article text'),
    el('section', 'role text', { role: 'main' })
  ]);
  assert.equal(
    createExtractorHarness(createDocument({ body: articleBody }))().content,
    'article text'
  );

  const roleBody = el('body', 'body text', {}, [
    el('main', '', {}, [el('nav', 'menu only')]),
    el('article', '', {}, [el('footer', 'footer only')]),
    el('section', 'role text', { role: 'main' })
  ]);
  assert.equal(
    createExtractorHarness(createDocument({ body: roleBody }))().content,
    'role text'
  );
});

test('extractPageContext falls back to body when preferred roots are absent', () => {
  const body = el('body', 'body content');
  const result = createExtractorHarness(createDocument({ body }))();
  assert.equal(result.content, 'body content');
});

test('extractPageContext returns empty optional metadata when it is absent', () => {
  const result = createExtractorHarness(createDocument({
    title: '',
    description: null,
    body: el('body', 'body content')
  }))();

  assert.equal(result.title, '');
  assert.equal(result.meta_description, '');
  assert.equal(result.content, 'body content');
});

test('extractPageContext excludes layout, sensitive and extension-owned UI', () => {
  const main = el('main', 'public text', {}, [
    el('script', 'script secret'),
    el('style', 'style secret'),
    el('nav', 'navigation'),
    el('header', 'header'),
    el('footer', 'footer'),
    el('aside', 'aside'),
    el('input', 'password', { type: 'password' }),
    el('textarea', 'draft secret'),
    el('div', 'editable secret', { contenteditable: 'true' }),
    el('div', 'extension overlay', { id: 'netguard-risk-banner' }),
    el('div', 'extension class', { class: 'box netguard-popup' }),
    el('div', 'extension marker', { 'data-netguard-owned': '' }),
    el('div', 'allowed editable false', { contenteditable: 'false' })
  ]);
  const result = createExtractorHarness(createDocument({
    body: el('body', '', {}, [main])
  }))();

  assert.equal(result.content, 'public text\nallowed editable false');
});

test('extractPageContext rejects sensitive or extension-owned roots themselves', () => {
  const body = el('body', 'body fallback', {}, [
    el('main', 'editable draft', { contenteditable: 'true' }),
    el('article', 'published article')
  ]);
  const result = createExtractorHarness(createDocument({ body }))();
  assert.equal(result.content, 'published article');

  const editableBody = el('body', 'private editor', { contenteditable: 'true' });
  const editableBodyResult = createExtractorHarness(createDocument({
    body: editableBody
  }))();
  assert.equal(editableBodyResult.content, '');
});

test('extractPageContext keeps 60 percent head and 40 percent tail', () => {
  const source = `${'A'.repeat(2000)}${'B'.repeat(2000)}`;
  const result = createExtractorHarness(createDocument({
    body: el('body', '', {}, [el('main', source)])
  }))();

  assert.equal(result.content.length, 3000);
  assert.equal(result.content.slice(0, 1800), 'A'.repeat(1800));
  assert.equal(result.content.slice(-1200), 'B'.repeat(1200));
});

test('extractPageContext removes empty duplicate and symbol-only lines', () => {
  const content = [
    'Risk summary',
    '   ',
    '------',
    '。，！？',
    '🔒⚠️',
    'Risk    summary',
    '付款 100 元'
  ].join('\r\n');
  const result = createExtractorHarness(createDocument({
    body: el('body', '', {}, [el('main', content)])
  }))();

  assert.equal(result.content, 'Risk summary\n付款 100 元');
});

test('extractPageContext survives malformed preferred roots and falls back', () => {
  const body = el('body', 'safe body fallback');
  const document = createDocument({ body });
  const originalQuerySelector = document.querySelector.bind(document);
  document.querySelector = selector => {
    if (selector === 'main') {
      return {
        cloneNode() {
          throw new Error('synthetic clone failure');
        }
      };
    }
    return originalQuerySelector(selector);
  };

  const result = createExtractorHarness(document)();
  assert.equal(result.content, 'safe body fallback');
});

test('extractPageContext safely handles a document without a body', () => {
  const document = createDocument({ title: 'Orphan page', body: null });
  const result = createExtractorHarness(document)();

  assert.equal(result.title, 'Orphan page');
  assert.equal(result.meta_description, '');
  assert.equal(result.content, '');
});

test('checkTextWithAI accepts PageContext without changing response behavior', async () => {
  const checkSource = sourceBetween(
    'async function checkTextWithAI(text)',
    'const PAGE_CONTEXT_TITLE_MAX_LENGTH'
  );
  const extractorSource = sourceBetween(
    'const PAGE_CONTEXT_TITLE_MAX_LENGTH',
    'function getPageText()'
  );
  let request = null;
  const context = {
    AbortController,
    clearTimeout,
    console: { log() {}, warn() {} },
    fetch: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            code: 0,
            data: { risk_level: 'medium', score: 0.66, reason: 'test result' }
          };
        }
      };
    },
    getApiUrl: async apiPath => `http://127.0.0.1:5000${apiPath}`,
    isAIServiceOnline: async () => true,
    localAIDetect: () => ({ risk: 'safe', score: 0, reason: '' }),
    shouldSkipProtectionNow: async () => false,
    window: { location: { href: 'https://fallback.example/' } }
  };
  vm.createContext(context);
  vm.runInContext(`
    const AI_DEBUG = false;
    const AI_REQUEST_TIMEOUT = 5000;
    const MAX_TEXT_LENGTH = 3000;
    function generateSecurityEventUuid() { return '11111111-1111-4111-8111-111111111111'; }
    function createTimeoutController() {
      return { controller: new AbortController(), timeoutId: null };
    }
    ${checkSource}
    ${extractorSource}
    globalThis.checkTextWithAIForTest = checkTextWithAI;
  `, context);

  const result = await context.checkTextWithAIForTest({
    url: 'https://example.test/risk',
    title: ' Risk   title ',
    meta_description: ' Risk   summary ',
    content: ' line one \n line one \n line two '
  });

  assert.deepEqual(request.body, {
    url: 'https://example.test/risk',
    title: 'Risk title',
    meta_description: 'Risk summary',
    content: 'line one\nline two',
    source: 'extension',
    event_uuid: '11111111-1111-4111-8111-111111111111'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    risk: 'medium',
    score: 0.66,
    reason: 'test result',
    persisted_by_backend: true
  });
});

test('checkTextWithAI keeps legacy string callers compatible', async () => {
  assert.match(CONTENT_SOURCE, /async function checkTextWithAI\(text\)/);
  assert.match(CONTENT_SOURCE, /const isPageContext = Boolean/);
  assert.match(CONTENT_SOURCE, /title: ''[\s\S]*meta_description: ''/);
  assert.match(CONTENT_SOURCE, /function getPageText\(\) \{\s*return extractPageContext\(\)\.content;/);
});
