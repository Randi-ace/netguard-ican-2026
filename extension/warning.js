console.log('🔒 [警告页面] 加载完成');

function getQueryParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

const PROTECTION_SETTINGS_KEYS = [
  'netguardSettings',
  'modeSettings',
  'protectionPaused',
  'paused',
  'whitelist',
  'siteWhitelist'
];

const LOCAL_CHILD_DANGER_DEMOS = new Set([
  'child_danger_demo.html',
  'fake_gambling.html',
  'fake_violence.html'
]);

function getLocalChildDemoHomeUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'file:') return null;

    const pathParts = decodeURIComponent(parsed.pathname)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
    if (pathParts.length < 3) return null;

    const fileName = pathParts[pathParts.length - 1];
    const parentDirectory = pathParts[pathParts.length - 2];
    const demoDirectory = pathParts[pathParts.length - 3];
    if (
      demoDirectory !== 'demos' ||
      parentDirectory !== 'child' ||
      !LOCAL_CHILD_DANGER_DEMOS.has(fileName)
    ) {
      return null;
    }

    return new URL('child_demo_home.html', parsed).href;
  } catch (_) {
    return null;
  }
}

function resolveProtectionPaused(result = {}) {
  const unified = result.netguardSettings || result.modeSettings || {};
  return Boolean(
    result.protectionPaused ??
    unified.protectionPaused ??
    result.paused ??
    unified.paused ??
    false
  );
}

function normalizeHost(value) {
  try {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const parsed = new URL(
      raw.includes('://') ? raw : `https://${raw}`
    );
    return parsed.hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function isWhitelisted(url, list) {
  if (!Array.isArray(list)) return false;
  const currentHost = normalizeHost(url);
  return Boolean(currentHost) && list.some(value => {
    const allowedHost = normalizeHost(value);
    return allowedHost && (
      currentHost === allowedHost ||
      currentHost.endsWith(`.${allowedHost}`)
    );
  });
}

function getProtectionBypass() {
  return new Promise(resolve => {
    const api = window.browser || window.chrome;
    const local = api?.storage?.local;

    if (!local) {
      resolve(false);
      return;
    }

    try {
      local.get(PROTECTION_SETTINGS_KEYS, result => {
        const state = result || {};
        const unified = state.netguardSettings || state.modeSettings || {};
        const whitelist =
          unified.whitelist ||
          state.whitelist ||
          state.siteWhitelist ||
          [];
        resolve(
          resolveProtectionPaused(state) ||
          isWhitelisted(getQueryParam('url'), whitelist)
        );
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function leaveWarningPageIfPaused() {
  if (!await getProtectionBypass()) return false;

  const blockedUrl = getQueryParam('url');
  if (blockedUrl) {
    window.location.replace(blockedUrl);
  } else {
    window.history.back();
  }

  return true;
}

function initWarningPage() {
  const blockedUrl = getQueryParam('url');
  const riskLevel = getQueryParam('risk');
  const riskReason = getQueryParam('reason');
  
  console.log(`🔒 [警告页面] 参数:`, {
    url: blockedUrl,
    risk: riskLevel,
    reason: riskReason
  });

  const urlDisplay = document.getElementById('blocked-url');
  const riskDisplay = document.getElementById('risk-level');
  const reasonDisplay = document.getElementById('risk-reason');

  if (blockedUrl) {
    urlDisplay.textContent = blockedUrl;
  } else {
    urlDisplay.textContent = '未知网址';
  }

  if (riskLevel) {
    riskDisplay.textContent = riskLevel.toUpperCase();
    setRiskLevelStyle(riskDisplay, riskLevel);
  }

  if (riskReason) {
    reasonDisplay.textContent = decodeURIComponent(riskReason);
  } else {
    reasonDisplay.textContent = '检测到安全风险';
  }
}

function setRiskLevelStyle(element, level) {
  const levelStyles = {
    'high': {
      background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
      color: 'white'
    },
    'medium': {
      background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
      color: 'white'
    },
    'low': {
      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
      color: 'white'
    },
    'safe': {
      background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
      color: 'white'
    }
  };

  const style = levelStyles[level.toLowerCase()] || levelStyles['high'];
  element.style.background = style.background;
  element.style.color = style.color;
}

function initEventListeners() {
  const goBackBtn = document.getElementById('go-back');
  const proceedBtn = document.getElementById('proceed');

  goBackBtn.addEventListener('click', () => {
    console.log('🔒 [警告页面] 用户点击返回上一页');
    const childDemoHomeUrl = getLocalChildDemoHomeUrl(
      getQueryParam('url')
    );
    if (childDemoHomeUrl) {
      window.location.replace(childDemoHomeUrl);
      return;
    }
    window.history.back();
  });

  proceedBtn.addEventListener('click', async () => {
    const blockedUrl = getQueryParam('url');
    if (!blockedUrl || proceedBtn.disabled) return;

    console.log('🔒 [警告页面] 用户选择继续访问:', blockedUrl);
    proceedBtn.disabled = true;

    const api = window.browser || window.chrome;
    const response = await new Promise(resolve => {
      if (!api?.runtime?.sendMessage) {
        resolve({ success: false });
        return;
      }

      try {
        api.runtime.sendMessage({
          type: 'NETGUARD_CONTINUE_ONCE',
          targetUrl: blockedUrl
        }, result => resolve(result || { success: false }));
      } catch (_) {
        resolve({ success: false });
      }
    });

    if (response.success && response.targetUrl) {
      window.location.replace(response.targetUrl);
      return;
    }

    proceedBtn.disabled = false;
    console.warn('⚠️ [警告页面] 一次性继续访问申请失败');
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // 渲染前最终检查：暂停或白名单站点不显示风险内容。
  if (await leaveWarningPageIfPaused()) return;

  initWarningPage();
  initEventListeners();
  console.log('🔒 [警告页面] 初始化完成');
});

const extensionStorage = (window.browser || window.chrome)?.storage;
extensionStorage?.onChanged?.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;
  if (!PROTECTION_SETTINGS_KEYS.some(key => changes[key])) return;
  await leaveWarningPageIfPaused();
});
