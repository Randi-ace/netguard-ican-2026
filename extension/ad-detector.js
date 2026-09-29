(function (root, factory) {
  const detector = factory();
  if (typeof module === 'object' && module.exports) module.exports = detector;
  root.NetGuardAdDetector = detector;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EXACT_AD_MARKERS = new Set([
    'ad', 'ads', 'advert', 'advertisement', 'sponsor', 'sponsored',
    'adsbygoogle', 'adchoice', 'adchoices',
    'ad-container', 'ad-wrapper', 'ad-box', 'ad-unit', 'ad-slot',
    'ad-sense', 'ad-banner', 'ad-popup', 'ad-overlay', 'ads-iframe',
    'sponsor-box', 'sponsor-container', 'fake-ad', 'iframe-ad',
    'video-ad', 'native-ad'
  ]);

  const STRICT_PROMOTION_MARKERS = new Set(['promo', 'promotion']);
  const STRICT_CONTAINER_TAGS = new Set(['DIV', 'ASIDE', 'SPAN', 'LI', 'INS']);
  const CORE_CONTENT_SELECTOR = 'header,nav,main,article,section,form,[role="main"]';

  const PROTECTED_MARKERS = [
    'upload-markdown', 'upload-file', 'file-upload', 'file-attachment',
    'drag-and-drop', 'drag-drop', 'dropzone', 'attachment',
    'markdown-editor', 'markdown-toolbar', 'comment-form', 'text-expander',
    'header', 'adapter', 'download', 'upload', 'avatar', 'breadcrumb',
    'login', 'signin', 'signup', 'auth', 'account', 'captcha', 'recaptcha',
    'verify', 'verification', 'challenge', 'map', 'maps', 'video', 'player',
    'media', 'navigation', 'navbar', 'content', 'article', 'profile',
    'dashboard'
  ];

  const PROTECTED_SELECTOR = [
    'input', 'textarea', 'select', 'button', 'form',
    '[contenteditable="true"]', '[contenteditable=""]', '[draggable="true"]',
    'header', 'nav', 'video', 'audio',
    '[role="dialog"]', '[aria-modal="true"]',
    '[class~="captcha"]', '[class~="recaptcha"]', '[class~="login"]',
    '[class~="signin"]', '[class~="map"]', '[class~="player"]',
    '[id~="captcha"]', '[id~="login"]', '[id~="map"]', '[id~="player"]',
    '[data-upload-policy-url]', '[data-upload-repository-id]',
    'file-attachment', 'markdown-toolbar', '.js-upload-markdown-image',
    '.js-previewable-comment-form'
  ].join(',');

  const AUTHENTICATION_MARKER_PATTERN = /(?:^|[^a-z0-9])(?:log(?:in|on)|sign(?:[\s_-]?in)|signin|auth(?:entication)?|account|verif(?:y|ication)|captcha|recaptcha|hcaptcha|turnstile|qr(?:[\s_-]?code)?|qrcode|mfa|2fa|oauth|otp|one[\s_-]?time[\s_-]?(?:code|password)|password|passport)(?:[^a-z0-9]|$)|(?:登录|登入|验证码|二维码|扫码|身份验证)/i;
  const AUTHENTICATION_SCAN_LIMIT = 120;
  const AUTHENTICATION_SCAN_BOUNDARIES = new Set([
    'HTML', 'BODY', 'MAIN', 'ARTICLE', 'SECTION'
  ]);

  function stringValue(value) {
    if (typeof value === 'string') return value.toLowerCase();
    if (typeof value?.baseVal === 'string') return value.baseVal.toLowerCase();
    return '';
  }

  const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
    'com.cn', 'net.cn', 'org.cn', 'co.uk', 'org.uk', 'com.au', 'co.jp'
  ]);
  function extractUrlValue(value) {
    const text = stringValue(value);
    const cssUrl = text.match(/url\(["']?([^"')]+)["']?\)/i);
    return cssUrl ? cssUrl[1] : text;
  }

  function getHostname(value, baseUrl = '') {
    try {
      return new URL(extractUrlValue(value), baseUrl || undefined).hostname.toLowerCase();
    } catch (error) {
      return '';
    }
  }

  function getRegistrableDomain(hostname) {
    const labels = stringValue(hostname).replace(/^\.+|\.+$/g, '').split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const suffix = labels.slice(-2).join('.');
    return COMMON_SECOND_LEVEL_SUFFIXES.has(suffix)
      ? labels.slice(-3).join('.')
      : suffix;
  }

  function isSameSiteUrl(value, pageUrl) {
    const resourceHost = getHostname(value, pageUrl);
    const pageHost = getHostname(pageUrl);
    if (!resourceHost || !pageHost) return false;
    const resourceDomain = getRegistrableDomain(resourceHost);
    const pageDomain = getRegistrableDomain(pageHost);
    return resourceDomain === pageDomain;
  }

  function getElementPageUrl(element) {
    return element?.ownerDocument?.location?.href ||
      (typeof globalThis.location?.href === 'string' ? globalThis.location.href : '');
  }

  function hasProtectedMarker(value) {
    const text = stringValue(value);
    if (hasAdMarker(text)) return false;
    return PROTECTED_MARKERS.some(marker => text.includes(marker));
  }

  function hasAdMarker(value) {
    const tokens = stringValue(value).split(/\s+/).filter(Boolean);
    return tokens.some(token => {
      if (EXACT_AD_MARKERS.has(token)) return true;
      return /^(?:ad|ads|advert|advertisement|sponsor|sponsored)[-_:]/.test(token) ||
        /[-_:](?:ad|ads|advert|advertisement|sponsor|sponsored)(?:[-_:]|$)/.test(token);
    });
  }

  function hasStrongAdMarker(value) {
    const tokens = stringValue(value).split(/\s+/).filter(Boolean);
    return tokens.some(token => {
      // 裸 ad/ads 在电商页面中经常只是内部业务缩写，不能覆盖资源保护。
      if (token === 'ad' || token === 'ads') return false;
      if (EXACT_AD_MARKERS.has(token)) return true;
      return /^(?:ad|ads|advert|advertisement|sponsor|sponsored)[-_:]/.test(token) ||
        /[-_:](?:ad|ads|advert|advertisement|sponsor|sponsored)(?:[-_:]|$)/.test(token);
    });
  }

  function hasPromotionMarker(value) {
    const tokens = stringValue(value).split(/\s+/).filter(Boolean);
    return tokens.some(token => STRICT_PROMOTION_MARKERS.has(token) ||
      /^(?:promo|promotion)[-_:]/.test(token));
  }

  function isAdResourceUrl(value, pageUrl = '') {
    const url = stringValue(value);
    if (!url) return false;
    let parsedUrl;
    try {
      parsedUrl = new URL(extractUrlValue(url), pageUrl || undefined);
    } catch (error) {
      return false;
    }
    // Only network resources can be classified by host/path heuristics. Scanning
    // data/blob/file payloads would treat encoded image bytes as advertising text.
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return false;

    const hostname = parsedUrl.hostname.toLowerCase();
    const knownAdHostname = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com)$/i.test(hostname) ||
      /(^|\.)adservice\.google\.[a-z.]+$/i.test(hostname) ||
      /(^|\.)(googleads|adserver|adnetwork)\./i.test(hostname);
    if (knownAdHostname) {
      return true;
    }
    // A same-site path containing an ad-like word is not advertising evidence by itself.
    if (pageUrl && isSameSiteUrl(parsedUrl.href, pageUrl)) return false;
    if (/(^|\.)(?:ad|ads|advert|sponsor)\./i.test(hostname)) return true;
    const pathname = parsedUrl.pathname.toLowerCase();
    return /(?:^|[\/._:-])(?:ads?|advert(?:isement)?|sponsor(?:ed)?)(?:[\/._:-]|$)/.test(pathname);
  }

  function getAttribute(element, name) {
    try { return element.getAttribute?.(name) || ''; } catch (error) { return ''; }
  }

  function hasAttribute(element, name) {
    try { return Boolean(element.hasAttribute?.(name)); } catch (error) { return false; }
  }

  function hasExplicitAdEvidence(element) {
    return ['data-ad', 'data-ad-slot', 'data-ad-unit', 'data-ad-client', 'data-ad-demo', 'data-sponsor']
      .some(name => hasAttribute(element, name));
  }

  function hasAuthenticationMarker(element) {
    if (!element || element.nodeType !== 1) return false;
    const tagName = stringValue(element.tagName).toUpperCase();
    const type = getAttribute(element, 'type').toLowerCase();
    const autocomplete = getAttribute(element, 'autocomplete').toLowerCase();
    if (tagName === 'INPUT' && (
      type === 'password' ||
      autocomplete === 'current-password' ||
      autocomplete === 'new-password' ||
      autocomplete === 'one-time-code'
    )) return true;

    const evidence = [
      element.className,
      element.id,
      getAttribute(element, 'name'),
      getAttribute(element, 'aria-label'),
      getAttribute(element, 'data-testid'),
      getAttribute(element, 'data-test'),
      getAttribute(element, 'autocomplete'),
      getAttribute(element, 'action'),
      getAttribute(element, 'src'),
      getAttribute(element, 'title')
    ].map(stringValue).join(' ');
    return AUTHENTICATION_MARKER_PATTERN.test(evidence);
  }

  function containsAuthenticationEvidence(element, maxElements = AUTHENTICATION_SCAN_LIMIT) {
    if (!element || element.nodeType !== 1) return false;
    const queue = [...(element.children || [])];
    let visited = 0;
    while (queue.length > 0) {
      const current = queue.shift();
      visited++;
      if (visited > maxElements) return false;
      if (hasAuthenticationMarker(current)) return true;
      queue.push(...(current.children || []));
    }
    return false;
  }

  function isAuthenticationContext(element) {
    let current = element;
    for (let depth = 0; current && depth < 7; depth++) {
      const tagName = stringValue(current.tagName).toUpperCase();
      if (AUTHENTICATION_SCAN_BOUNDARIES.has(tagName)) break;
      if (hasAuthenticationMarker(current)) return true;

      const role = getAttribute(current, 'role').toLowerCase();
      const isAuthenticationBoundary = tagName === 'FORM' ||
        role === 'dialog' || role === 'alertdialog' ||
        getAttribute(current, 'aria-modal').toLowerCase() === 'true';
      if (isAuthenticationBoundary && containsAuthenticationEvidence(current)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function containsAuthenticationContext(element) {
    if (!element || element.nodeType !== 1) return false;
    const tagName = stringValue(element.tagName).toUpperCase();
    if (AUTHENTICATION_SCAN_BOUNDARIES.has(tagName)) return false;
    if (isAuthenticationContext(element)) return true;
    if (isLargeContentContainer(element)) return false;
    return containsAuthenticationEvidence(element);
  }

  function isProtectedInteractiveElement(element) {
    if (!element || element.nodeType !== 1) return true;
    const tagName = stringValue(element.tagName).toUpperCase();
    if ([
      'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'FORM', 'OPTION',
      'BODY', 'HEADER', 'NAV', 'MAIN', 'ARTICLE', 'SECTION', 'VIDEO', 'AUDIO'
    ].includes(tagName)) return true;
    if (hasProtectedMarker(element.className) || hasProtectedMarker(element.id)) return true;
    if (hasAttribute(element, 'data-upload-policy-url') || hasAttribute(element, 'data-upload-repository-id')) return true;
    if (getAttribute(element, 'contenteditable') !== '' && getAttribute(element, 'contenteditable') !== 'false') return true;
    if (getAttribute(element, 'draggable') === 'true') return true;
    try { return Boolean(element.closest?.(PROTECTED_SELECTOR)); } catch (error) { return false; }
  }

  function isProtectedFrame(element) {
    if (stringValue(element?.tagName).toUpperCase() !== 'IFRAME') return false;

    const evidence = [
      element.className,
      element.id,
      getAttribute(element, 'title'),
      getAttribute(element, 'name'),
      getAttribute(element, 'src'),
      getAttribute(element, 'data-src'),
      getAttribute(element, 'aria-label'),
      getAttribute(element, 'allow')
    ].map(stringValue).join(' ');

    return /(?:^|[^a-z])(?:login|signin|signup|auth|account|captcha|recaptcha|verify|verification|challenge|map|maps|video|player|media|stream|embed|checkout|payment|download)(?:[^a-z]|$)/.test(evidence) ||
      /(?:youtube\.com\/embed|youtu\.be|vimeo\.com|player\.|google\.com\/maps|openstreetmap|mapbox|recaptcha|hcaptcha|turnstile)/.test(evidence);
  }

  function isLargeContentContainer(element) {
    const tagName = stringValue(element?.tagName).toUpperCase();
    if (!['DIV', 'ASIDE', 'A', 'IMG', 'PICTURE'].includes(tagName)) return false;
    try {
      const descendantCount = element.querySelectorAll?.('*').length || 0;
      const interactiveCount = element.querySelectorAll?.(
        'input,textarea,select,button,a,[contenteditable],video,audio'
      ).length || 0;
      if (descendantCount > 120 || interactiveCount > 12) return true;
    } catch (error) {
      return true;
    }
    if (stringValue(element.textContent).length > 5000) return true;
    try {
      const rect = element.getBoundingClientRect?.();
      return Boolean(rect && (
        (rect.width >= 900 && rect.height >= 300) ||
        rect.width * rect.height > 450000
      ));
    } catch (error) {
      return true;
    }
  }

  function isInsideLargeContentContainer(element) {
    let current = element?.parentElement;
    for (let depth = 0; current && depth < 6; depth++) {
      if (isLargeContentContainer(current)) return true;
      current = current.parentElement;
    }
    return false;
  }

  function isStrictPromotionCandidate(element) {
    const tagName = stringValue(element?.tagName).toUpperCase();
    if (!STRICT_CONTAINER_TAGS.has(tagName)) return false;

    try {
      if (element.closest?.(CORE_CONTENT_SELECTOR)) return false;
      if (element.querySelector?.(CORE_CONTENT_SELECTOR)) return false;
      if (element.querySelectorAll?.('input,textarea,select,button,a,[contenteditable],video,audio').length > 4) {
        return false;
      }
      if (element.querySelectorAll?.('*').length > 80) return false;
    } catch (error) {
      return false;
    }

    if (stringValue(element.textContent).length > 2000) return false;
    try {
      const rect = element.getBoundingClientRect?.();
      if (rect && (
        (rect.width >= 700 && rect.height >= 250) ||
        rect.width * rect.height >= 250000
      )) {
        return false;
      }
    } catch (error) {
      return false;
    }
    return true;
  }

  function inspectAdElement(element, mode = 'normal') {
    const noMatch = { isAd: false, confidence: 'none', reason: '' };
    if (!element || element.nodeType !== 1 || element.__adBlocked) return noMatch;

    const tagName = stringValue(element.tagName).toUpperCase();
    // CSS cannot stop an inserted script from executing. Network blocking owns script statistics.
    if (tagName === 'SCRIPT') return noMatch;

    const hasGenericAdMarker = hasAdMarker(element.className) || hasAdMarker(element.id);
    const hasStrongMarker = hasStrongAdMarker(element.className) || hasStrongAdMarker(element.id);
    const hasExplicitEvidence = hasExplicitAdEvidence(element);
    const iframeTitle = getAttribute(element, 'title').trim();
    const hasExplicitIframeTitle = tagName === 'IFRAME' &&
      /^(advertisement|sponsored ad|广告)$/i.test(iframeTitle);
    let highConfidenceDecision = null;
    if (hasExplicitEvidence) {
      highConfidenceDecision = { isAd: true, confidence: 'high', reason: 'explicit-ad-attribute' };
    } else if (hasGenericAdMarker) {
      highConfidenceDecision = { isAd: true, confidence: 'high', reason: 'ad-marker' };
    } else if (hasExplicitIframeTitle) {
      highConfidenceDecision = { isAd: true, confidence: 'high', reason: 'explicit-ad-title' };
    }

    // Attributes/title are authoritative. A class marker alone must still pass size protection,
    // because commerce hero carousels frequently reuse ad-like internal class names.
    const isResourceLeaf = ['A', 'IMG', 'PICTURE', 'VIDEO', 'SOURCE', 'IFRAME'].includes(tagName);
    const hasWeakResourceMarkerOnly = isResourceLeaf && hasGenericAdMarker && !hasStrongMarker &&
      !hasExplicitEvidence && !hasExplicitIframeTitle;
    if (hasExplicitEvidence || hasExplicitIframeTitle) {
      return highConfidenceDecision;
    }

    const resourceUrl = element.src ||
      getAttribute(element, 'src') ||
      getAttribute(element, 'data-src');
    const pageUrl = getElementPageUrl(element);
    const linkUrl = element.href || getAttribute(element, 'href');
    const style = getAttribute(element, 'style');
    const knownResourceDecision = ['IMG', 'IFRAME', 'VIDEO', 'SOURCE'].includes(tagName) &&
      isAdResourceUrl(resourceUrl, pageUrl)
      ? { isAd: true, confidence: 'high', reason: 'known-ad-resource' }
      : tagName === 'A' && isAdResourceUrl(linkUrl, pageUrl)
        ? { isAd: true, confidence: 'high', reason: 'known-ad-link' }
        : style.includes('background-image') && isAdResourceUrl(style, pageUrl)
          ? { isAd: true, confidence: 'high', reason: 'known-ad-background' }
          : null;
    if (knownResourceDecision) return knownResourceDecision;

    // Authentication controls and their bounded modal/form context outrank class-only
    // and strict promotion evidence. Authoritative attributes/title/network returned above.
    if (isAuthenticationContext(element) || containsAuthenticationContext(element)) {
      return noMatch;
    }
    if (isLargeContentContainer(element)) return noMatch;
    // Class/promotion markers on children of a large business region are not sufficient.
    // Explicit attributes/title returned above and known ad-network URLs remain authoritative.
    if (isInsideLargeContentContainer(element)) return knownResourceDecision || noMatch;

    if (highConfidenceDecision && isResourceLeaf && !hasWeakResourceMarkerOnly) {
      return highConfidenceDecision;
    }
    if (isProtectedInteractiveElement(element)) return noMatch;
    if (highConfidenceDecision && !hasWeakResourceMarkerOnly) return highConfidenceDecision;

    if (tagName === 'IFRAME' && isProtectedFrame(element) && !isAdResourceUrl(resourceUrl, pageUrl)) {
      return noMatch;
    }

    if (['IMG', 'IFRAME', 'VIDEO', 'SOURCE'].includes(tagName) && isAdResourceUrl(resourceUrl, pageUrl)) {
      return { isAd: true, confidence: 'high', reason: 'known-ad-resource' };
    }
    if (tagName === 'A' && isAdResourceUrl(linkUrl, pageUrl)) {
      return { isAd: true, confidence: 'high', reason: 'known-ad-link' };
    }
    if (style.includes('background-image') && isAdResourceUrl(style, pageUrl)) {
      return { isAd: true, confidence: 'high', reason: 'known-ad-background' };
    }

    const businessResourceUrl = tagName === 'A' ? linkUrl : resourceUrl;
    if (['A', 'IMG', 'PICTURE', 'VIDEO', 'SOURCE'].includes(tagName) &&
        businessResourceUrl && isSameSiteUrl(businessResourceUrl, pageUrl)) {
      return {
        isAd: false,
        protected: true,
        confidence: 'none',
        reason: 'first-party-resource'
      };
    }

    const hasPromotionEvidence = hasPromotionMarker(element.className) ||
      hasPromotionMarker(element.id) || hasAttribute(element, 'data-promo');
    if (mode === 'strict' && hasPromotionEvidence && isStrictPromotionCandidate(element)) {
      return { isAd: true, confidence: 'medium', reason: 'bounded-promotion-container' };
    }
    return noMatch;
  }

  function isAdElement(element, mode = 'normal') {
    return inspectAdElement(element, mode).isAd;
  }

  return {
    hasAdMarker,
    hasStrongAdMarker,
    hasPromotionMarker,
    hasAuthenticationMarker,
    isAuthenticationContext,
    containsAuthenticationContext,
    isSameSiteUrl,
    isAdResourceUrl,
    isProtectedInteractiveElement,
    isProtectedFrame,
    isLargeContentContainer,
    isInsideLargeContentContainer,
    isStrictPromotionCandidate,
    inspectAdElement,
    isAdElement
  };
});
