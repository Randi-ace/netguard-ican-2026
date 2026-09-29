// popup.js - 统一模式、白名单与配置持久化

'use strict';

const SETTINGS_KEY = 'netguardSettings';
const SETTINGS_SYNC_PENDING_KEY = 'settingsSyncPending';
const LEGACY_SETTINGS_MIGRATED_KEY = 'netguardUnifiedSettingsMigrated';

const DEFAULT_SETTINGS = {
  adMode: 'normal',
  elderMode: false,
  childMode: false,
  protectionPaused: false,
  paused: false,
  whitelist: []
};

const DEFAULT_ELDER_SETTINGS = {
  enabled: false,
  fontScale: 1.35,
  riskHighlight: true,
  pageSimplify: false
};

const DEFAULT_CHILD_SETTINGS = {
  // 儿童模式默认关闭
  childModeEnabled: false,
  dangerousFilter: true,
  entertainmentLimit: true,
  learningMode: false,
  dailyReminderMinutes: 15,
  dailyLimitMinutes: 60,
  dangerousSites: [
    'porn',
    'xxx',
    'adult',
    'gambling',
    'casino',
    'violence',
    '暴力',
    'phishing',
    'scam',
    'malware',
    'hack',
    'torrent',
    'hacking'
  ],
  entertainmentSites: [
    'bilibili.com',
    'douyin.com',
    'youtube.com',
    'twitch.tv',
    'netflix.com',
    'hulu.com',
    'disneyplus.com',
    'tiktok.com',
    'instagram.com',
    'facebook.com',
    'twitter.com',
    'roblox.com',
    'minecraft.net',
    'steamcommunity.com'
  ],
  // Child 白名单只绕过儿童策略；全局保护白名单继续独立保存。
  childWhitelist: [],
  learningWhitelist: []
};

function normalizeDailyReminderMinutes(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 15;
  return Math.min(120, Math.max(5, Math.trunc(numericValue)));
}

function normalizeDailyLimitMinutes(value, reminderMinutes) {
  const normalizedReminder = normalizeDailyReminderMinutes(
    reminderMinutes
  );
  const numericValue = Number(value);
  const candidate = Number.isFinite(numericValue)
    ? Math.trunc(numericValue)
    : 60;
  return Math.min(1440, Math.max(normalizedReminder, candidate));
}

const btnModeNormal = document.getElementById('btnModeNormal');
const btnModeStrict = document.getElementById('btnModeStrict');

function getElement(id) {
  return document.getElementById(id);
}

function normalizeDomain(value) {
  let domain = String(value || '').trim().toLowerCase();

  if (!domain) {
    return '';
  }

  domain = domain
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0];

  return domain;
}

function normalizeTextList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : fallback;

  return [
    ...new Set(
      source
        .map(item => String(item || '').trim())
        .filter(Boolean)
    )
  ];
}

function normalizeDomainEntries(value, fallback = []) {
  return [
    ...new Set(
      normalizeTextList(value, fallback)
        .map(normalizeDomain)
        .filter(Boolean)
    )
  ];
}

function readList(id) {
  const element = getElement(id);

  if (!element) {
    return [];
  }

  return [
    ...new Set(
      element.value
        .split('\n')
        .map(item => item.trim())
        .filter(Boolean)
    )
  ];
}

function readDomainList(id) {
  return [
    ...new Set(
      readList(id)
        .map(normalizeDomain)
        .filter(Boolean)
    )
  ];
}

function setInputValue(id, value) {
  const element = getElement(id);

  if (element) {
    element.value = value;
  }
}

function setChecked(id, checked) {
  const element = getElement(id);

  if (element) {
    element.checked = Boolean(checked);
  }
}

function showStatus(message) {
  const status = getElement('status');

  if (!status) {
    console.log(message);
    return;
  }

  status.innerText = message;
  status.classList.add('show');

  clearTimeout(showStatus.timer);

  showStatus.timer = setTimeout(() => {
    status.innerText = '';
    status.classList.remove('show');
  }, 2000);
}

async function syncSettingsToBackend(reason = 'popup') {
  if (!chrome.runtime?.sendMessage) {
    return {
      success: false,
      error: 'Background settings coordinator unavailable'
    };
  }

  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'NETGUARD_SYNC_SETTINGS',
          reason
        },
        async response => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            console.warn(
              `⚠️ 后端同步失败: ${runtimeError.message}`
            );
            resolve({
              success: false,
              error: runtimeError.message
            });
            return;
          }

          if (response?.success) {
            await renderAll();
          } else {
            console.warn(
              `⚠️ 后端同步失败: ${response?.error || 'unknown error'}`
            );
          }
          resolve(response || {
            success: false,
            error: 'Background did not respond'
          });
        }
      );
    } catch (error) {
      console.warn(`⚠️ 后端同步失败: ${error.message}`);
      resolve({
        success: false,
        error: error.message
      });
    }
  });
}

async function getStoredState() {
  const result = await chrome.storage.local.get([
    SETTINGS_KEY,
    'adMode',
    'adBlockMode',
    'elderMode',
    'childMode',
    'protectionPaused',
    'paused',
    'whitelist',
    'siteWhitelist',
    'elderSettings',
    'childSettings',
    LEGACY_SETTINGS_MIGRATED_KEY
  ]);

  const elderSettings = {
    ...DEFAULT_ELDER_SETTINGS,
    ...(result.elderSettings || {})
  };

  const storedChildSettings = (
    result.childSettings &&
    typeof result.childSettings === 'object' &&
    !Array.isArray(result.childSettings)
  ) ? result.childSettings : {};
  const childSettings = {
    ...DEFAULT_CHILD_SETTINGS,
    ...storedChildSettings
  };
  childSettings.dailyReminderMinutes = normalizeDailyReminderMinutes(
    childSettings.dailyReminderMinutes
  );
  childSettings.dailyLimitMinutes = normalizeDailyLimitMinutes(
    childSettings.dailyLimitMinutes,
    childSettings.dailyReminderMinutes
  );
  childSettings.dangerousSites = normalizeTextList(
    childSettings.dangerousSites,
    DEFAULT_CHILD_SETTINGS.dangerousSites
  );
  childSettings.entertainmentSites = normalizeDomainEntries(
    childSettings.entertainmentSites,
    DEFAULT_CHILD_SETTINGS.entertainmentSites
  );
  const storedChildWhitelist = Object.prototype.hasOwnProperty.call(
    storedChildSettings,
    'childWhitelist'
  )
    ? storedChildSettings.childWhitelist
    : storedChildSettings.learningWhitelist;
  childSettings.childWhitelist = normalizeDomainEntries(
    storedChildWhitelist,
    []
  );
  childSettings.learningWhitelist = childSettings.childWhitelist;

  const storedSettings = result[SETTINGS_KEY] || {};
  const hasUnifiedSettings = Boolean(
    result[LEGACY_SETTINGS_MIGRATED_KEY] ||
    Object.keys(storedSettings).length > 0
  );
  const protectionPaused = Boolean(
    result.protectionPaused ??
    storedSettings.protectionPaused ??
    result.paused ??
    storedSettings.paused ??
    false
  );

  const settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    adMode:
      storedSettings.adMode ||
      result.adMode ||
      result.adBlockMode ||
      'normal',
    elderMode:
      storedSettings.elderMode ??
      (hasUnifiedSettings ? result.elderMode : false) ??
      false,
    childMode:
      storedSettings.childMode ??
      (hasUnifiedSettings ? result.childMode : false) ??
      false,
    protectionPaused,
    paused: protectionPaused,
    whitelist:
      storedSettings.whitelist ||
      result.whitelist ||
      result.siteWhitelist ||
      []
  };

  if (!['normal', 'strict'].includes(settings.adMode)) {
    settings.adMode = 'normal';
  }

  if (!Array.isArray(settings.whitelist)) {
    settings.whitelist = [];
  }

  settings.whitelist = [
    ...new Set(
      settings.whitelist
        .map(normalizeDomain)
        .filter(Boolean)
    )
  ];
  // 防止旧配置中儿童模式和老人模式同时开启
  if (settings.childMode && settings.elderMode) {
    settings.elderMode = false;
    elderSettings.enabled = false;
  }

  childSettings.childModeEnabled = settings.childMode;
  elderSettings.enabled = settings.elderMode;

  return {
    settings,
    elderSettings,
    childSettings
  };
}

async function persistState(
  settings,
  elderSettings,
  childSettings,
  options = {}
) {
  const protectionPaused = Boolean(
    settings.protectionPaused ??
    settings.paused
  );
  // netguardSettings 只保留团队约定的四个模式字段。
  const childMode = Boolean(settings.childMode);
  const elderMode = Boolean(settings.elderMode) && !childMode;
  const unifiedSettings = {
    adMode:
      settings.adMode === 'strict'
        ? 'strict'
        : 'normal',
    elderMode,
    childMode,
    paused: protectionPaused
  };
  const normalizedWhitelist = [
    ...new Set(
      (settings.whitelist || [])
        .map(normalizeDomain)
        .filter(Boolean)
    )
  ];
  const normalizedSettings = {
    ...unifiedSettings,
    protectionPaused,
    whitelist: normalizedWhitelist
  };

  const normalizedElderSettings = {
    ...DEFAULT_ELDER_SETTINGS,
    ...(elderSettings || {}),
    enabled: normalizedSettings.elderMode
  };

  const rawChildSettings = (
    childSettings &&
    typeof childSettings === 'object' &&
    !Array.isArray(childSettings)
  ) ? childSettings : {};
  const childWhitelistSource = Object.prototype.hasOwnProperty.call(
    rawChildSettings,
    'childWhitelist'
  )
    ? rawChildSettings.childWhitelist
    : rawChildSettings.learningWhitelist;
  const normalizedChildWhitelist = normalizeDomainEntries(
    childWhitelistSource,
    []
  );
  const normalizedChildSettings = {
    ...DEFAULT_CHILD_SETTINGS,
    ...rawChildSettings,
    childModeEnabled: normalizedSettings.childMode,
    childWhitelist: normalizedChildWhitelist,
    learningWhitelist: normalizedChildWhitelist
  };
  normalizedChildSettings.dailyReminderMinutes = normalizeDailyReminderMinutes(
    normalizedChildSettings.dailyReminderMinutes
  );
  normalizedChildSettings.dailyLimitMinutes = normalizeDailyLimitMinutes(
    normalizedChildSettings.dailyLimitMinutes,
    normalizedChildSettings.dailyReminderMinutes
  );
  normalizedChildSettings.dangerousSites = normalizeTextList(
    normalizedChildSettings.dangerousSites,
    DEFAULT_CHILD_SETTINGS.dangerousSites
  );
  normalizedChildSettings.entertainmentSites = normalizeDomainEntries(
    normalizedChildSettings.entertainmentSites,
    DEFAULT_CHILD_SETTINGS.entertainmentSites
  );

  const storageUpdate = {
    // 新的统一结构
    [SETTINGS_KEY]: unifiedSettings,
    whitelist: normalizedSettings.whitelist,
    siteWhitelist: normalizedSettings.whitelist,
    elderSettings: normalizedElderSettings,
    childSettings: normalizedChildSettings,
    [LEGACY_SETTINGS_MIGRATED_KEY]: true
  };
  if (options.markPending) {
    storageUpdate[SETTINGS_SYNC_PENDING_KEY] = true;
  }
  await chrome.storage.local.set(storageUpdate);

  // 迁移后删除旧的顶层模式键，避免出现两套状态源。
  if (typeof chrome.storage.local.remove === 'function') {
    await chrome.storage.local.remove([
      'adMode',
      'adBlockMode',
      'elderMode',
      'childMode',
      'protectionPaused',
      'paused'
    ]);
  }

  return {
    settings: normalizedSettings,
    elderSettings: normalizedElderSettings,
    childSettings: normalizedChildSettings
  };
}

async function updateSettings(patch) {
  const state = await getStoredState();

  const settings = {
    ...state.settings,
    ...patch
  };

  if (settings.childMode) {
    settings.elderMode = false;
  }

  return persistState(
    settings,
    {
      ...state.elderSettings,
      enabled: settings.elderMode
    },
    {
      ...state.childSettings,
      childModeEnabled: settings.childMode
    },
    { markPending: true }
  );
}

function getPauseToggle() {
  return (
    getElement('pausedToggle') ||
    getElement('pauseToggle') ||
    getElement('pauseProtectionToggle')
  );
}

function renderModeUI(settings) {
  if (btnModeNormal) {
    btnModeNormal.classList.toggle(
      'active',
      settings.adMode === 'normal'
    );
  }

  if (btnModeStrict) {
    btnModeStrict.classList.toggle(
      'active',
      settings.adMode === 'strict'
    );
  }

  const pauseToggle = getPauseToggle();

  if (pauseToggle) {
    pauseToggle.checked = settings.paused;
  }

  console.log('📊 [Popup] 当前统一配置:', settings);
}

function renderElderSettings(settings) {
  setChecked('elderModeToggle', settings.enabled);
  setInputValue('fontScale', settings.fontScale);
  setChecked('riskHighlight', settings.riskHighlight);
  setChecked('pageSimplify', settings.pageSimplify);
}

function renderChildSettings(settings) {
  setChecked(
    'childModeToggle',
    settings.childModeEnabled
  );
  setChecked(
    'dangerousFilter',
    settings.dangerousFilter
  );
  setChecked(
    'entertainmentLimit',
    settings.entertainmentLimit
  );
  setChecked(
    'learningMode',
    settings.learningMode
  );

  setInputValue(
    'reminderMinutes',
    settings.dailyReminderMinutes
  );
  setInputValue(
    'dailyLimitMinutes',
    settings.dailyLimitMinutes
  );
  setInputValue(
    'dangerList',
    (settings.dangerousSites || []).join('\n')
  );
  setInputValue(
    'entertainList',
    (settings.entertainmentSites || []).join('\n')
  );
  setInputValue(
    'whitelist',
    (settings.childWhitelist || settings.learningWhitelist || []).join('\n')
  );
}

function updateElderAvailability() {
  const childToggle = getElement('childModeToggle');
  const elderToggle = getElement('elderModeToggle');

  if (!childToggle || !elderToggle) {
    return;
  }

  const elderDetails = elderToggle
    .closest('.section')
    ?.querySelector('details');

  const childEnabled = childToggle.checked;

  elderToggle.disabled = childEnabled;
  elderToggle.style.opacity = childEnabled
    ? '0.5'
    : '1';

  if (elderDetails) {
    elderDetails.style.opacity = childEnabled
      ? '0.5'
      : '1';
  }
}

async function renderAll() {
  const state = await getStoredState();

  renderModeUI(state.settings);
  renderElderSettings(state.elderSettings);
  renderChildSettings(state.childSettings);
  updateElderAvailability();

  return state;
}

async function changeAdMode(mode) {
  const nextMode = mode === 'strict'
    ? 'strict'
    : 'normal';

  const state = await updateSettings({
    adMode: nextMode,
    elderMode: false,
    childMode: false
  });

  renderModeUI(state.settings);

  showStatus(
    nextMode === 'strict'
      ? '✅ 已切换到严格模式'
      : '✅ 已切换到普通模式'
  );

  await syncSettingsToBackend('popup-mode-change');
}

async function saveElderSettings() {
  const state = await getStoredState();

  const enabled = Boolean(
    getElement('elderModeToggle')?.checked
  );

  const elderSettings = {
    enabled,
    fontScale:
      parseFloat(getElement('fontScale')?.value) ||
      DEFAULT_ELDER_SETTINGS.fontScale,
    riskHighlight: Boolean(
      getElement('riskHighlight')?.checked
    ),
    pageSimplify: Boolean(
      getElement('pageSimplify')?.checked
    )
  };

  const settings = {
    ...state.settings,
    elderMode: enabled,
    childMode: enabled
      ? false
      : state.settings.childMode
  };

  const childSettings = {
    ...state.childSettings,
    childModeEnabled: settings.childMode
  };

  await persistState(
    settings,
    elderSettings,
    childSettings,
    { markPending: true }
  );

  await renderAll();
  showStatus('✅ 老人模式设置已保存');

  await syncSettingsToBackend('popup-elder-change');
}

async function resetElderSettings() {
  const state = await getStoredState();

  await persistState(
    {
      ...state.settings,
      elderMode: false
    },
    DEFAULT_ELDER_SETTINGS,
    state.childSettings,
    { markPending: true }
  );

  await renderAll();
  showStatus('🔄 已恢复老人模式默认设置');
  await syncSettingsToBackend('popup-elder-reset');
}

async function saveChildSettings() {
  const state = await getStoredState();

  const enabled = Boolean(
    getElement('childModeToggle')?.checked
  );

  const childWhitelist = readDomainList('whitelist');
  const dailyReminderMinutes = normalizeDailyReminderMinutes(
    getElement('reminderMinutes')?.value
  );
  const requestedDailyLimit = Number(
    getElement('dailyLimitMinutes')?.value
  );
  const dailyLimitMinutes = normalizeDailyLimitMinutes(
    requestedDailyLimit,
    dailyReminderMinutes
  );
  const dailyLimitAdjusted = Number.isFinite(requestedDailyLimit) &&
    Math.trunc(requestedDailyLimit) < dailyReminderMinutes;

  const childSettings = {
    childModeEnabled: enabled,
    dangerousFilter: Boolean(
      getElement('dangerousFilter')?.checked
    ),
    entertainmentLimit: Boolean(
      getElement('entertainmentLimit')?.checked
    ),
    learningMode: Boolean(
      getElement('learningMode')?.checked
    ),
    dailyReminderMinutes,
    dailyLimitMinutes,
    dangerousSites: readList('dangerList'),
    entertainmentSites: readDomainList(
      'entertainList'
    ),
    childWhitelist,
    learningWhitelist: childWhitelist
  };

  const settings = {
    ...state.settings,
    childMode: enabled,
    elderMode: enabled
      ? false
      : state.settings.elderMode
  };

  const elderSettings = {
    ...state.elderSettings,
    enabled: settings.elderMode
  };

  await persistState(
    settings,
    elderSettings,
    childSettings,
    { markPending: true }
  );

  await renderAll();
  showStatus(
    dailyLimitAdjusted
      ? '⚠️ 每日浏览上限已调整为不低于提醒间隔'
      : '✅ 儿童模式和白名单已保存'
  );

  await syncSettingsToBackend('popup-child-change');
}

async function resetChildSettings() {
  const state = await getStoredState();

  await persistState(
    {
      ...state.settings,
      childMode: false
    },
    state.elderSettings,
    DEFAULT_CHILD_SETTINGS,
    { markPending: true }
  );

  await renderAll();
  showStatus('🔄 已恢复儿童模式默认设置');
  await syncSettingsToBackend('popup-child-reset');
}

async function savePauseState(paused) {
  const protectionPaused = Boolean(paused);

  // 先写统一结构中的最高优先级闩锁，避免立即导航的竞态。
  const current = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = current[SETTINGS_KEY] || {};
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      adMode: stored.adMode === 'strict' ? 'strict' : 'normal',
      elderMode: Boolean(stored.elderMode),
      childMode: Boolean(stored.childMode),
      paused: protectionPaused
    },
    [SETTINGS_SYNC_PENDING_KEY]: true
  });

  const state = await updateSettings({
    protectionPaused,
    paused: protectionPaused
  });

  renderModeUI(state.settings);

  showStatus(
    paused
      ? '⏸️ 当前网站保护已暂停'
      : '▶️ 网站保护已恢复'
  );

  await syncSettingsToBackend('popup-pause-change');
}

function bindClick(id, handler) {
  const element = getElement(id);

  if (element) {
    element.addEventListener('click', handler);
  }
}

function bindChange(id, handler) {
  const element = getElement(id);

  if (element) {
    element.addEventListener('change', handler);
  }
}

document.addEventListener(
  'DOMContentLoaded',
  async () => {
    // 首次运行时完成旧配置迁移并持久化
    const initialState = await getStoredState();

    await persistState(
      initialState.settings,
      initialState.elderSettings,
      initialState.childSettings
    );

    await renderAll();

    if (btnModeNormal) {
      btnModeNormal.addEventListener(
        'click',
        () => changeAdMode('normal')
      );
    }

    if (btnModeStrict) {
      btnModeStrict.addEventListener(
        'click',
        () => changeAdMode('strict')
      );
    }

    bindClick(
      'saveElderBtn',
      saveElderSettings
    );
    bindClick(
      'resetElderBtn',
      resetElderSettings
    );
    bindClick(
      'saveChildBtn',
      saveChildSettings
    );
    bindClick(
      'resetChildBtn',
      resetChildSettings
    );

    bindChange(
      'childModeToggle',
      async () => {
        await saveChildSettings();
      }
    );

    bindChange(
      'elderModeToggle',
      async () => {
        await saveElderSettings();
      }
    );

    const pauseToggle = getPauseToggle();

    if (pauseToggle) {
      pauseToggle.addEventListener(
        'change',
        () => savePauseState(
          pauseToggle.checked
        )
      );
    }

    await syncSettingsToBackend('popup-open');
  }
);
