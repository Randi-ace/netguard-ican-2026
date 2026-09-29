// background.js - 净网护航后台服务

'use strict';

if (typeof importScripts === 'function') {
  importScripts('api-config.js');
}

const extensionAPI =
  typeof browser !== 'undefined'
    ? browser
    : chrome;

const REQUEST_TIMEOUT = 5000;

const SETTINGS_KEY = 'netguardSettings';
const SETTINGS_SYNC_PENDING_KEY = 'settingsSyncPending';
const LEGACY_SETTINGS_MIGRATED_KEY = 'netguardUnifiedSettingsMigrated';
const EVENT_QUEUE_KEY = 'pendingSecurityEvents';
const SECURITY_RETRY_STATE_KEY = 'securityEventRetryState';
const FAILED_SECURITY_EVENTS_KEY = 'failedSecurityEvents';
const PENDING_AD_EVENT_KEY = 'pendingAdApiEvent';
const AD_EVENT_QUEUE_KEY = 'pendingAdApiEvents';
const AD_PAGE_AGGREGATES_KEY = 'pendingAdPageAggregates';
const COMPLETED_AD_PAGE_SESSIONS_KEY = 'completedAdPageSessions';
const AD_RETRY_STATE_KEY = 'adEventRetryState';
const FAILED_AD_EVENTS_KEY = 'failedAdEvents';
const CONTINUE_BYPASS_KEY = 'netguardOneTimeContinueBypasses';
const ACTIVE_CONTINUE_NAVIGATION_KEY = 'netguardActiveContinueNavigations';
const CONTINUE_BYPASS_TTL = 45000;
const EVENT_BATCH_SIZE = 20;
const EVENT_QUEUE_LIMIT = 500;
const AD_EVENT_QUEUE_LIMIT = 500;
const FAILED_EVENT_LIMIT = 100;
const MAX_SERVER_ERROR_RETRIES = 3;
const COMPLETED_AD_SESSION_LIMIT = 200;
const AD_PAGE_SETTLE_DELAY = 1500;
const AD_PAGE_MAX_WAIT = 30000;
const FLUSH_ALARM = 'netguardBatchUpload';
const CHILD_BROWSING_REMINDER_ALARM = 'netguardChildBrowsingReminderTick';
const CHILD_BROWSING_REMINDER_STATE_KEY = 'childBrowsingReminderState';
const CHILD_BROWSING_REMINDER_PERIOD_MINUTES = 1;
const DEFAULT_CHILD_REMINDER_MINUTES = 15;
const MIN_CHILD_REMINDER_MINUTES = 5;
const MAX_CHILD_REMINDER_MINUTES = 120;
const DEFAULT_CHILD_DAILY_LIMIT_MINUTES = 60;
const MAX_CHILD_DAILY_LIMIT_MINUTES = 1440;
let childBrowsingReminderOperation = Promise.resolve();
let settingsSyncOperation = Promise.resolve();
const WHITELIST_RULE_ID = 900001;
const PAUSED_RULE_ID = 900002;
const COMPAT_SCORE_FIELD = ['risk', 'score'].join('_');

const DEFAULT_SETTINGS = {
  adMode: 'normal',
  elderMode: false,
  childMode: false,
  protectionPaused: false,
  paused: false,
  whitelist: []
};

const DANGEROUS_URL_KEYWORDS = [
  'gambling',
  'casino',
  'bet',
  'porn',
  'adult',
  'xxx',
  'phishing',
  'bank-login',
  'fake-bank',
  'lottery',
  'hack'
];

console.log('🔒 [Background] Service Worker 启动');

const storage = {
  get(keys) {
    return new Promise(resolve => {
      extensionAPI.storage.local.get(
        keys,
        result => resolve(result || {})
      );
    });
  },

  set(items) {
    return new Promise(resolve => {
      extensionAPI.storage.local.set(
        items,
        resolve
      );
    });
  },

  remove(keys) {
    return new Promise(resolve => {
      extensionAPI.storage.local.remove(
        keys,
        resolve
      );
    });
  }
};

// 一次性继续访问状态优先放在 session，避免 MV3 Service Worker 重启丢失。
// 旧环境没有 storage.session 时才回退到 local，且仍受短 TTL 约束。
const continueBypassStorageArea =
  extensionAPI.storage.session ||
  extensionAPI.storage.local;
const continueBypassStorage = {
  get(keys) {
    return new Promise(resolve => {
      continueBypassStorageArea.get(
        keys,
        result => resolve(result || {})
      );
    });
  },

  set(items) {
    return new Promise(resolve => {
      continueBypassStorageArea.set(items, resolve);
    });
  }
};

const apiConfig = globalThis.NetGuardApiConfig || {
  // 仅供无 importScripts 的测试沙箱使用；浏览器始终加载 api-config.js。
  getApiUrl(path) {
    const testHost = ['127', '0', '0', '1'].join('.');
    const testOrigin = `http://${testHost}:${5000}`;
    return Promise.resolve(`${testOrigin}${path}`);
  }
};

async function getApiUrl(path) {
  return apiConfig.getApiUrl(
    path,
    extensionAPI.storage.local
  );
}

function normalizeHost(value) {
  try {
    const raw = String(value || '')
      .trim()
      .toLowerCase();

    if (!raw) {
      return '';
    }

    const parsed = new URL(
      raw.includes('://')
        ? raw
        : `https://${raw}`
    );

    return parsed.hostname.replace(/^www\./, '');
  } catch (_) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .replace(/^www\./, '');
  }
}

function normalizeWhitelist(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return [
    ...new Set(
      list
        .map(normalizeHost)
        .filter(Boolean)
    )
  ];
}

function normalizeSharedSettings(source = {}) {
  const candidate = source && typeof source === 'object'
    ? source
    : {};
  const unified = (
    candidate[SETTINGS_KEY] &&
    typeof candidate[SETTINGS_KEY] === 'object'
  ) ? candidate[SETTINGS_KEY] : {};
  const rawMode = String(
    candidate.mode ??
    candidate.adMode ??
    candidate.adBlockMode ??
    unified.mode ??
    unified.adMode ??
    'normal'
  ).toLowerCase();
  const childRequested = (
    rawMode === 'child' ||
    Boolean(
      candidate.child_mode ??
      candidate.childMode ??
      unified.child_mode ??
      unified.childMode ??
      false
    )
  );
  const elderRequested = (
    rawMode === 'elder' ||
    Boolean(
      candidate.elder_mode ??
      candidate.elderMode ??
      unified.elder_mode ??
      unified.elderMode ??
      false
    )
  );
  const mode = childRequested
    ? 'child'
    : elderRequested
      ? 'elder'
      : rawMode === 'strict'
        ? 'strict'
        : 'normal';

  return {
    mode,
    elder_mode: mode === 'elder',
    child_mode: mode === 'child',
    paused: Boolean(
      candidate.paused ??
      candidate.protectionPaused ??
      unified.paused ??
      unified.protectionPaused ??
      false
    )
  };
}

function applySharedSettingsToLocal(
  sharedSettings,
  currentSettings = {}
) {
  const normalized = normalizeSharedSettings(sharedSettings);

  return {
    ...currentSettings,
    adMode: normalized.mode === 'strict'
      ? 'strict'
      : normalized.mode === 'normal'
        ? 'normal'
        : currentSettings.adMode === 'strict'
          ? 'strict'
          : 'normal',
    elderMode: normalized.elder_mode,
    childMode: normalized.child_mode,
    protectionPaused: normalized.paused,
    paused: normalized.paused
  };
}

function sharedSettingsEqual(left, right) {
  const normalizedLeft = normalizeSharedSettings(left);
  const normalizedRight = normalizeSharedSettings(right);

  return (
    normalizedLeft.mode === normalizedRight.mode &&
    normalizedLeft.elder_mode === normalizedRight.elder_mode &&
    normalizedLeft.child_mode === normalizedRight.child_mode &&
    normalizedLeft.paused === normalizedRight.paused
  );
}

function isWhitelisted(url, whitelist) {
  const currentHost = normalizeHost(url);

  if (!currentHost) {
    return false;
  }

  return whitelist.some(item => {
    const allowedHost = normalizeHost(item);

    return (
      allowedHost &&
      (
        currentHost === allowedHost ||
        currentHost.endsWith(`.${allowedHost}`)
      )
    );
  });
}

function isSupportedUrl(url) {
  return (
    typeof url === 'string' &&
    (
      url.startsWith('http://') ||
      url.startsWith('https://') ||
      url.startsWith('file://')
    )
  );
}

function isExtensionUrl(url) {
  if (!url) {
    return false;
  }

  return (
    url.startsWith('chrome-extension://') ||
    url.startsWith('moz-extension://') ||
    url.startsWith(
      extensionAPI.runtime.getURL('')
    )
  );
}

async function getSettings() {
  const result = await storage.get([
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

  const unified = result[SETTINGS_KEY] || {};
  const hasUnifiedSettings = Boolean(
    result[LEGACY_SETTINGS_MIGRATED_KEY] ||
    Object.keys(unified).length > 0
  );
  const protectionPaused = Boolean(
    result.protectionPaused ??
    unified.protectionPaused ??
    result.paused ??
    unified.paused ??
    false
  );

  const settings = {
    ...DEFAULT_SETTINGS,
    ...unified,
    adMode:
      unified.adMode ||
      result.adMode ||
      result.adBlockMode ||
      'normal',
    elderMode:
      unified.elderMode ??
      (hasUnifiedSettings ? result.elderMode : false) ??
      false,
    childMode:
      unified.childMode ??
      (hasUnifiedSettings ? result.childMode : false) ??
      false,
    protectionPaused,
    paused: protectionPaused,
    whitelist: normalizeWhitelist(
      unified.whitelist ||
      result.whitelist ||
      result.siteWhitelist ||
      []
    )
  };

  if (!['normal', 'strict'].includes(
    settings.adMode
  )) {
    settings.adMode = 'normal';
  }

  if (
    settings.childMode &&
    settings.elderMode
  ) {
    settings.elderMode = false;
  }

  return settings;
}

function normalizeChildReminderMinutes(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_CHILD_REMINDER_MINUTES;
  }

  return Math.min(
    MAX_CHILD_REMINDER_MINUTES,
    Math.max(
      MIN_CHILD_REMINDER_MINUTES,
      Math.trunc(numericValue)
    )
  );
}

function normalizeChildDailyLimitMinutes(
  value,
  reminderMinutes = DEFAULT_CHILD_REMINDER_MINUTES
) {
  const normalizedReminder = normalizeChildReminderMinutes(
    reminderMinutes
  );
  const numericValue = Number(value);
  const candidate = Number.isFinite(numericValue)
    ? Math.trunc(numericValue)
    : DEFAULT_CHILD_DAILY_LIMIT_MINUTES;

  return Math.min(
    MAX_CHILD_DAILY_LIMIT_MINUTES,
    Math.max(normalizedReminder, candidate)
  );
}

function getChildBrowsingDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createChildBrowsingReminderState(
  dailyReminderMinutes,
  dailyLimitMinutes,
  dateKey = getChildBrowsingDateKey()
) {
  return {
    version: 3,
    dateKey,
    dailyReminderMinutes,
    dailyLimitMinutes,
    elapsedMinutes: 0,
    limitReached: false,
    nextReminderAtMinutes: dailyReminderMinutes,
    cycleId: 1,
    lastNotifiedCycleId: 0,
    pendingNotificationCycleId: null,
    pendingNotificationType: null,
    pendingNotificationStatus: null
  };
}

function queueChildBrowsingReminderOperation(operation) {
  const result = childBrowsingReminderOperation.then(
    operation,
    operation
  );
  childBrowsingReminderOperation = result.catch(() => {});
  return result;
}

function normalizeChildBrowsingReminderState(
  value,
  dailyReminderMinutes,
  dailyLimitMinutes
) {
  const normalizedReminder = normalizeChildReminderMinutes(
    dailyReminderMinutes
  );
  const normalizedLimit = normalizeChildDailyLimitMinutes(
    dailyLimitMinutes,
    normalizedReminder
  );
  if (!value || typeof value !== 'object') {
    return createChildBrowsingReminderState(
      normalizedReminder,
      normalizedLimit
    );
  }

  const state = value;
  const today = getChildBrowsingDateKey();

  if (state.dateKey !== today) {
    return createChildBrowsingReminderState(
      normalizedReminder,
      normalizedLimit,
      today
    );
  }

  const rawElapsedMinutes = Math.max(
    0,
    Math.trunc(Number(state.elapsedMinutes)) || 0
  );
  const isCurrentStateVersion = state.version === 3;
  const configChanged = !isCurrentStateVersion ||
    state.dailyReminderMinutes !== normalizedReminder ||
    state.dailyLimitMinutes !== normalizedLimit;
  const limitReached = (
    isCurrentStateVersion && Boolean(state.limitReached)
  ) || rawElapsedMinutes >= normalizedLimit;
  const completedReminderCycles = Math.floor(
    Math.min(rawElapsedMinutes, normalizedLimit) /
    normalizedReminder
  );

  let cycleId = configChanged
    ? completedReminderCycles + 1
    : Math.max(
        1,
        Math.trunc(Number(state.cycleId)) || 1
      );
  let nextReminderAtMinutes = configChanged
    ? cycleId * normalizedReminder
    : Math.max(
        normalizedReminder,
        Math.trunc(Number(state.nextReminderAtMinutes)) ||
          normalizedReminder
      );
  if (nextReminderAtMinutes <= rawElapsedMinutes) {
    cycleId = Math.max(cycleId, completedReminderCycles + 1);
    nextReminderAtMinutes = cycleId * normalizedReminder;
  }

  let pendingCycle = isCurrentStateVersion && !configChanged &&
    Number.isInteger(state.pendingNotificationCycleId) &&
    state.pendingNotificationCycleId > 0
    ? state.pendingNotificationCycleId
    : null;
  let pendingType = pendingCycle &&
    ['reminder', 'limit'].includes(state.pendingNotificationType)
    ? state.pendingNotificationType
    : null;
  let pendingStatus = pendingCycle && pendingType &&
    state.pendingNotificationStatus === 'retry'
    ? 'retry'
    : pendingCycle && pendingType
      ? 'sending'
      : null;
  let lastNotifiedCycleId = configChanged
    ? completedReminderCycles
    : Math.max(
        0,
        Math.trunc(Number(state.lastNotifiedCycleId)) || 0
      );

  if (
    !pendingType ||
    (limitReached && pendingType !== 'limit') ||
    (!limitReached && pendingType === 'limit')
  ) {
    pendingCycle = null;
    pendingType = null;
    pendingStatus = null;
  }

  // worker 若在发送调用后、结果落盘前终止，按已尝试处理，避免恢复后重复发送。
  // 只有明确收到“无 receiver”等失败结果并标为 retry 的周期才会补发。
  if (pendingCycle && pendingStatus === 'sending') {
    lastNotifiedCycleId = Math.max(
      lastNotifiedCycleId,
      pendingCycle
    );
    pendingCycle = null;
    pendingType = null;
    pendingStatus = null;
  }

  return {
    version: 3,
    dateKey: today,
    dailyReminderMinutes: normalizedReminder,
    dailyLimitMinutes: normalizedLimit,
    elapsedMinutes: Math.min(normalizedLimit, rawElapsedMinutes),
    limitReached,
    nextReminderAtMinutes,
    cycleId: Math.max(
      cycleId,
      lastNotifiedCycleId + 1,
      (pendingCycle || 0) + 1
    ),
    lastNotifiedCycleId,
    pendingNotificationCycleId: pendingCycle,
    pendingNotificationType: pendingType,
    pendingNotificationStatus: pendingStatus
  };
}

async function getChildBrowsingReminderConfig() {
  const [settings, result] = await Promise.all([
    getSettings(),
    storage.get('childSettings')
  ]);

  const childSettings = result.childSettings || {};
  const childWhitelistSource = Array.isArray(
    childSettings.childWhitelist
  )
    ? childSettings.childWhitelist
    : childSettings.learningWhitelist;

  const dailyReminderMinutes = normalizeChildReminderMinutes(
    childSettings.dailyReminderMinutes
  );

  return {
    childMode: Boolean(settings.childMode),
    paused: Boolean(
      settings.protectionPaused ?? settings.paused
    ),
    globalWhitelist: normalizeWhitelist(settings.whitelist),
    childWhitelist: normalizeWhitelist(childWhitelistSource),
    dailyReminderMinutes,
    dailyLimitMinutes: normalizeChildDailyLimitMinutes(
      childSettings.dailyLimitMinutes,
      dailyReminderMinutes
    )
  };
}

async function getChildBrowsingReminderState(
  dailyReminderMinutes,
  dailyLimitMinutes
) {
  const result = await storage.get(
    CHILD_BROWSING_REMINDER_STATE_KEY
  );
  return normalizeChildBrowsingReminderState(
    result[CHILD_BROWSING_REMINDER_STATE_KEY],
    dailyReminderMinutes,
    dailyLimitMinutes
  );
}

async function saveChildBrowsingReminderState(state) {
  await storage.set({
    [CHILD_BROWSING_REMINDER_STATE_KEY]: state
  });
}

async function ensureChildBrowsingReminderAlarm() {
  const existing = typeof extensionAPI.alarms.get === 'function'
    ? await extensionAPI.alarms.get(
      CHILD_BROWSING_REMINDER_ALARM
    )
    : null;
  if (existing) return false;

  await extensionAPI.alarms.create(
    CHILD_BROWSING_REMINDER_ALARM,
    {
      periodInMinutes:
        CHILD_BROWSING_REMINDER_PERIOD_MINUTES
    }
  );
  return true;
}

async function clearChildBrowsingReminderAlarm() {
  if (typeof extensionAPI.alarms.clear === 'function') {
    await extensionAPI.alarms.clear(
      CHILD_BROWSING_REMINDER_ALARM
    );
  }
}

function isChildReminderSupportedUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Chromium 扩展无法在浏览器扩展商店页面注入 content script。
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return !(
      hostname === 'chromewebstore.google.com' ||
      (
        hostname === 'chrome.google.com' &&
        path.startsWith('/webstore')
      ) ||
      (
        hostname === 'microsoftedge.microsoft.com' &&
        path.startsWith('/addons')
      )
    );
  } catch (_) {
    return false;
  }
}

async function getEligibleChildBrowsingTab(config) {
  if (!config.childMode || config.paused) {
    return null;
  }

  try {
    const idleState = await extensionAPI.idle.queryState(60);
    if (idleState !== 'active') return null;

    const focusedWindow =
      await extensionAPI.windows.getLastFocused({
        populate: false
      });
    if (!focusedWindow || focusedWindow.focused !== true) {
      return null;
    }

    const tabs = await extensionAPI.tabs.query({
      active: true,
      windowId: focusedWindow.id
    });
    const tab = tabs[0];
    if (!tab || !Number.isInteger(tab.id) ||
        !isChildReminderSupportedUrl(tab.url) ||
        isWhitelisted(tab.url, config.globalWhitelist) ||
        isWhitelisted(tab.url, config.childWhitelist)) {
      return null;
    }
    return tab;
  } catch (error) {
    console.warn(
      '⚠️ [儿童浏览提醒] 活动标签页判定失败:',
      error.message
    );
    return null;
  }
}

async function sendChildBrowsingNotification(
  tabId,
  cycleId,
  notificationType,
  dateKey
) {
  try {
    const message = notificationType === 'limit'
      ? {
          type: 'NETGUARD_CHILD_BROWSING_LIMIT_REACHED',
          cycleId,
          dateKey
        }
      : {
          type: 'NETGUARD_CHILD_BROWSING_REMINDER',
          cycleId
        };
    const response = await extensionAPI.tabs.sendMessage(
      tabId,
      message,
      { frameId: 0 }
    );
    return response?.shown !== false;
  } catch (error) {
    // 页面刷新或不可注入页面可能暂时没有 receiver；提醒失败不能影响 alarm。
    console.warn(
      '⚠️ [儿童浏览提醒] 页面暂时无法接收提醒:',
      error.message
    );
    return false;
  }
}

async function reconcileChildBrowsingReminderState() {
  const config = await getChildBrowsingReminderConfig();
  const result = await storage.get(
    CHILD_BROWSING_REMINDER_STATE_KEY
  );
  const existing = result[CHILD_BROWSING_REMINDER_STATE_KEY];
  const normalized = normalizeChildBrowsingReminderState(
    existing,
    config.dailyReminderMinutes,
    config.dailyLimitMinutes
  );

  if (!config.childMode) {
    await clearChildBrowsingReminderAlarm();
    if (
      existing &&
      JSON.stringify(existing) !== JSON.stringify(normalized)
    ) {
      await saveChildBrowsingReminderState(normalized);
    }
    return;
  }

  await ensureChildBrowsingReminderAlarm();

  if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
    await saveChildBrowsingReminderState(normalized);
  }
}

async function handleChildBrowsingReminderTick() {
  const config = await getChildBrowsingReminderConfig();
  if (!config.childMode) {
    await clearChildBrowsingReminderAlarm();
    return;
  }

  const state = await getChildBrowsingReminderState(
    config.dailyReminderMinutes,
    config.dailyLimitMinutes
  );
  const tab = await getEligibleChildBrowsingTab(config);
  if (!tab) {
    await saveChildBrowsingReminderState(state);
    return;
  }

  if (state.pendingNotificationCycleId) {
    const pendingCycleId = state.pendingNotificationCycleId;
    const pendingType = state.pendingNotificationType;
    state.pendingNotificationStatus = 'sending';
    await saveChildBrowsingReminderState(state);
    const delivered = await sendChildBrowsingNotification(
      tab.id,
      pendingCycleId,
      pendingType,
      state.dateKey
    );
    if (!delivered) {
      state.pendingNotificationStatus = 'retry';
      await saveChildBrowsingReminderState(state);
      return;
    }
    state.lastNotifiedCycleId = Math.max(
      state.lastNotifiedCycleId,
      pendingCycleId
    );
    state.pendingNotificationCycleId = null;
    state.pendingNotificationType = null;
    state.pendingNotificationStatus = null;
    await saveChildBrowsingReminderState(state);
  }

  if (state.limitReached) {
    await saveChildBrowsingReminderState(state);
    return;
  }

  state.elapsedMinutes = Math.min(
    state.dailyLimitMinutes,
    state.elapsedMinutes + 1
  );

  let notificationType = null;
  if (state.elapsedMinutes >= state.dailyLimitMinutes) {
    state.elapsedMinutes = state.dailyLimitMinutes;
    state.limitReached = true;
    notificationType = 'limit';
  } else if (state.elapsedMinutes >= state.nextReminderAtMinutes) {
    notificationType = 'reminder';
    do {
      state.nextReminderAtMinutes += state.dailyReminderMinutes;
    } while (state.nextReminderAtMinutes <= state.elapsedMinutes);
  }

  if (!notificationType) {
    await saveChildBrowsingReminderState(state);
    return;
  }

  const completedCycleId = state.cycleId;
  state.cycleId += 1;
  state.pendingNotificationCycleId = completedCycleId;
  state.pendingNotificationType = notificationType;
  state.pendingNotificationStatus = 'sending';
  await saveChildBrowsingReminderState(state);

  const delivered = await sendChildBrowsingNotification(
    tab.id,
    completedCycleId,
    notificationType,
    state.dateKey
  );

  if (delivered) {
    state.lastNotifiedCycleId = completedCycleId;
    state.pendingNotificationCycleId = null;
    state.pendingNotificationType = null;
    state.pendingNotificationStatus = null;
  } else {
    state.pendingNotificationStatus = 'retry';
  }
  await saveChildBrowsingReminderState(state);
}

async function persistSettings(settings, options = {}) {
  const sharedSettings = normalizeSharedSettings(settings);
  const protectionPaused = sharedSettings.paused;
  const unifiedSettings = {
    adMode: settings.adMode === 'strict'
      ? 'strict'
      : 'normal',
    elderMode: sharedSettings.elder_mode,
    childMode: sharedSettings.child_mode,
    paused: protectionPaused
  };
  const normalized = {
    ...unifiedSettings,
    protectionPaused,
    whitelist: normalizeWhitelist(
      settings.whitelist
    )
  };

  const storageUpdate = {
    // 团队约定的统一模式结构只包含四个字段。
    [SETTINGS_KEY]: unifiedSettings,
    whitelist: normalized.whitelist,
    siteWhitelist: normalized.whitelist,
    [LEGACY_SETTINGS_MIGRATED_KEY]: true
  };
  if (typeof options.settingsSyncPending === 'boolean') {
    storageUpdate[SETTINGS_SYNC_PENDING_KEY] =
      options.settingsSyncPending;
  }
  await storage.set(storageUpdate);

  await storage.remove([
    'adMode',
    'adBlockMode',
    'elderMode',
    'childMode',
    'protectionPaused',
    'paused'
  ]);

  return normalized;
}

function isProtectionPaused(settings) {
  return Boolean(
    settings?.protectionPaused ??
    settings?.paused
  );
}

async function shouldSkipRiskProtection(url) {
  const settings = await getSettings();

  return (
    isProtectionPaused(settings) ||
    isWhitelisted(url, settings.whitelist)
  );
}

async function initializeSettings() {
  const settings = await getSettings();
  await persistSettings(settings);

  console.log(
    '✅ [Background] 配置初始化完成:',
    settings
  );
}

async function fetchWithTimeout(
  url,
  options = {}
) {
  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

class ApiRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = Number(details.status || 0);
    this.code = details.code != null && Number.isFinite(Number(details.code))
      ? Number(details.code)
      : null;
    this.body = details.body || null;
  }
}

async function ensureApiSuccess(
  response,
  acceptedCodes = [0]
) {
  const body = await response.json().catch(() => null);
  const bodyCode = typeof body?.code === 'number'
    ? body.code
    : null;
  const businessFailed = (
    body?.success === false ||
    (
      bodyCode !== null &&
      !acceptedCodes.includes(bodyCode)
    )
  );

  if (!response.ok || businessFailed) {
    throw new ApiRequestError(
      body?.message ||
      body?.error?.message ||
      `HTTP ${response.status}`,
      {
        status: response.status,
        code: bodyCode,
        body
      }
    );
  }

  return body;
}

async function getSettingsSyncPending() {
  const result = await storage.get(
    SETTINGS_SYNC_PENDING_KEY
  );
  return Boolean(result[SETTINGS_SYNC_PENDING_KEY]);
}

async function fetchSharedSettings(method, payload = null) {
  const options = { method };
  if (payload) {
    options.headers = {
      'Content-Type': 'application/json'
    };
    options.body = JSON.stringify(payload);
  }

  const response = await fetchWithTimeout(
    await getApiUrl('/api/settings'),
    options
  );
  const body = await ensureApiSuccess(response);

  if (
    !body?.data ||
    typeof body.data !== 'object' ||
    Array.isArray(body.data) ||
    typeof body.data.mode !== 'string'
  ) {
    throw new ApiRequestError(
      '设置接口缺少有效 data',
      {
        status: response.status,
        code: body?.code,
        body
      }
    );
  }

  return normalizeSharedSettings(body.data);
}

async function runSettingsSynchronization(reason) {
  const pending = await getSettingsSyncPending();
  const localSettings = await getSettings();

  try {
    if (pending) {
      const localSharedSettings = normalizeSharedSettings(
        localSettings
      );
      const serverSettings = await fetchSharedSettings(
        'POST',
        localSharedSettings
      );
      const latestLocalSettings = await getSettings();
      const latestPending = await getSettingsSyncPending();
      if (
        latestPending &&
        !sharedSettingsEqual(
          latestLocalSettings,
          localSharedSettings
        )
      ) {
        return {
          success: true,
          direction: 'push',
          reason,
          superseded: true,
          settings: normalizeSharedSettings(latestLocalSettings)
        };
      }
      const synchronizedLocal = applySharedSettingsToLocal(
        serverSettings,
        localSettings
      );
      await persistSettings(synchronizedLocal, {
        settingsSyncPending: false
      });

      return {
        success: true,
        direction: 'push',
        reason,
        settings: serverSettings
      };
    }

    const serverSettings = await fetchSharedSettings('GET');
    if (await getSettingsSyncPending()) {
      return {
        success: true,
        direction: 'pull',
        reason,
        superseded: true,
        settings: normalizeSharedSettings(await getSettings())
      };
    }
    const synchronizedLocal = applySharedSettingsToLocal(
      serverSettings,
      localSettings
    );
    await persistSettings(synchronizedLocal);

    return {
      success: true,
      direction: 'pull',
      reason,
      settings: serverSettings
    };
  } catch (error) {
    console.warn(
      `⚠️ [设置同步] ${reason} 失败，保留本地状态:`,
      error.message
    );
    return {
      success: false,
      direction: pending ? 'push' : 'pull',
      reason,
      error: error.message
    };
  }
}

function synchronizeSettingsWithBackend(reason = 'manual') {
  const operation = settingsSyncOperation.then(
    () => runSettingsSynchronization(reason)
  );
  settingsSyncOperation = operation.catch(() => {});
  return operation;
}

function classifyEventFailure(error, previousAttempts = 0) {
  const attempts = previousAttempts + 1;
  const status = Number(error?.status || 0);
  const code = Number(error?.code || 0);
  const validationFailure = status === 400 || code === 400;
  const serverFailure = status === 500 || code === 500;

  if (validationFailure) {
    return {
      attempts,
      retry: false,
      reason: 'validation'
    };
  }

  if (serverFailure && attempts >= MAX_SERVER_ERROR_RETRIES) {
    return {
      attempts,
      retry: false,
      reason: 'server_retry_exhausted'
    };
  }

  return {
    attempts,
    retry: true,
    reason: serverFailure ? 'server' : 'temporary'
  };
}

function createFailedEventRecord(payload, error, decision) {
  return {
    payload,
    failure_reason: decision.reason,
    attempts: decision.attempts,
    http_status: Number(error?.status || 0),
    code: error?.code != null && Number.isFinite(Number(error.code))
      ? Number(error.code)
      : null,
    message: String(error?.message || '事件上传失败').slice(0, 500),
    failed_at: new Date().toISOString()
  };
}

function isDangerousUrl(url) {
  try {
    const parsed = new URL(url);
    const target = (
      parsed.hostname +
      parsed.pathname +
      parsed.search
    ).toLowerCase();

    return DANGEROUS_URL_KEYWORDS.some(
      keyword => target.includes(keyword)
    );
  } catch (_) {
    return false;
  }
}

async function checkUrlWithFlask(url) {
  if (isProtectionPaused(await getSettings())) {
    console.log('⏸️ [URL检测] 保护已暂停，不调用风险接口');
    return null;
  }

  const eventUuid = generateEventUuid();

  try {
    const response = await fetchWithTimeout(
      await getApiUrl('/api/risk/check'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url,
          content: '',
          source: 'extension',
          event_uuid: eventUuid
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const result = await response.json();

    if (result.code !== 0 || !result.data) {
      throw new Error(
        result.message || '后端返回业务错误'
      );
    }

    if (isProtectionPaused(await getSettings())) {
      console.log('⏸️ [URL检测] 请求期间已暂停，丢弃检测结果');
      return null;
    }

    return {
      risk_level: result.data.risk_level,
      score: Number(result.data.score || 0),
      reason: result.data.reason || ''
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn(
        '⏱️ [URL检测] 请求超时'
      );
    } else {
      console.warn(
        '⚠️ [URL检测] 后端不可用:',
        error.message
      );
    }

    return null;
  }
}

function generateEventUuid() {
  if (
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    .replace(/[xy]/g, character => {
      const random = Math.floor(Math.random() * 16);
      const value = character === 'x'
        ? random
        : (random & 0x3) | 0x8;
      return value.toString(16);
    });
}

function isValidEventUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function defaultRiskScore(riskLevel) {
  return {
    safe: 0.05,
    low: 0.25,
    medium: 0.65,
    high: 0.95
  }[riskLevel] ?? 0.5;
}

function normalizeRiskScore(value, riskLevel) {
  const score = (
    typeof value === 'boolean' ||
    value === null ||
    value === ''
  )
    ? Number.NaN
    : Number(value);

  return (
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 1
  )
    ? score
    : defaultRiskScore(riskLevel);
}

function normalizeRiskCheckType(event = {}) {
  const detectionType = String(
    event.type || event.event_type || ''
  )
    .trim()
    .toLowerCase();

  if (detectionType === 'ai_check') {
    return 'ai';
  }

  if (detectionType === 'url_check') {
    return 'url';
  }

  if (detectionType) {
    return 'rule';
  }

  const queuedCheckType = String(event.check_type || '')
    .trim()
    .toLowerCase();

  if (queuedCheckType === 'text') {
    return 'ai';
  }

  return ['ai', 'url', 'rule'].includes(queuedCheckType)
    ? queuedCheckType
    : 'rule';
}

function createRiskEvent(event = {}) {
  const requestedRiskLevel = String(
    event.risk_level ||
    event.level ||
    'low'
  ).toLowerCase();
  const riskLevel = [
    'safe',
    'low',
    'medium',
    'high'
  ].includes(requestedRiskLevel)
    ? requestedRiskLevel
    : 'low';

  return {
    event_uuid:
      isValidEventUuid(event.event_uuid)
        ? event.event_uuid
        : isValidEventUuid(event.id)
          ? event.id
          : generateEventUuid(),
    url: String(event.url || '')
      .trim()
      .slice(0, 4096),
    risk_level: riskLevel,
    score: normalizeRiskScore(
      event.score ?? event[COMPAT_SCORE_FIELD],
      riskLevel
    ),
    reason: String(event.reason || '')
      .slice(0, 1000),
    source: 'extension',
    check_type: normalizeRiskCheckType(event)
  };
}

function createRiskApiPayload(event) {
  const normalized = createRiskEvent(event);

  return {
    event_uuid: normalized.event_uuid,
    url: normalized.url,
    risk_level: normalized.risk_level,
    score: normalized.score,
    reason: normalized.reason,
    source: normalized.source,
    check_type: normalized.check_type
  };
}

function isCanonicalRiskEvent(rawEvent, normalizedEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return false;
  }

  const fields = [
    'event_uuid',
    'url',
    'risk_level',
    'score',
    'reason',
    'source',
    'check_type'
  ];

  return (
    Object.keys(rawEvent).length === fields.length &&
    fields.every(field =>
      Object.prototype.hasOwnProperty.call(
        rawEvent,
        field
      ) &&
      rawEvent[field] === normalizedEvent[field]
    )
  );
}

async function syncWhitelistRules(settings = null) {
  const currentSettings = settings || await getSettings();
  const domains = normalizeWhitelist(currentSettings.whitelist);
  const update = { removeRuleIds: [WHITELIST_RULE_ID, PAUSED_RULE_ID] };
  const allResourceTypes = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
    'font', 'object', 'xmlhttprequest', 'ping', 'csp_report',
    'media', 'websocket', 'other'
  ];

  update.addRules = [];

  if (isProtectionPaused(currentSettings)) {
    update.addRules.push({
      id: PAUSED_RULE_ID,
      priority: 200,
      action: { type: 'allow' },
      condition: { resourceTypes: allResourceTypes }
    });
  }

  if (domains.length > 0) {
    update.addRules.push({
      id: WHITELIST_RULE_ID,
      priority: 100,
      action: { type: 'allow' },
      condition: {
        initiatorDomains: domains,
        resourceTypes: allResourceTypes
      }
    });
  }

  if (update.addRules.length === 0) delete update.addRules;

  try {
    await extensionAPI.declarativeNetRequest.updateDynamicRules(update);
    console.log(`✅ [保护规则] 白名单 ${domains.length} 个，暂停=${isProtectionPaused(currentSettings)}`);
  } catch (error) {
    console.warn('⚠️ [白名单] 动态规则同步失败:', error.message);
  }
}

let securityEventQueueTask = Promise.resolve();

function runSecurityEventQueueTask(task) {
  const currentTask = securityEventQueueTask.then(task, task);
  securityEventQueueTask = currentTask.catch(() => {});
  return currentTask;
}

async function enqueueSecurityEventUnlocked(event) {
  const settings = await getSettings();

  if (
    isProtectionPaused(settings) ||
    isWhitelisted(
      event.url,
      settings.whitelist
    )
  ) {
    return;
  }

  const result = await storage.get(
    EVENT_QUEUE_KEY
  );

  const rawQueue = Array.isArray(
    result[EVENT_QUEUE_KEY]
  )
    ? result[EVENT_QUEUE_KEY]
    : [];

  const queue = rawQueue.map(createRiskEvent);

  queue.push(createRiskEvent(event));

  await storage.set({
    [EVENT_QUEUE_KEY]:
      queue.slice(-EVENT_QUEUE_LIMIT)
  });

  if (queue.length >= EVENT_BATCH_SIZE) {
    await flushSecurityEventsUnlocked();
  }
}

function enqueueSecurityEvent(event) {
  return runSecurityEventQueueTask(
    () => enqueueSecurityEventUnlocked(event)
  );
}

async function flushSecurityEventsUnlocked() {
  if (isProtectionPaused(await getSettings())) {
    return 0;
  }

  const result = await storage.get([
    EVENT_QUEUE_KEY,
    SECURITY_RETRY_STATE_KEY
  ]);

  const rawQueue = Array.isArray(
    result[EVENT_QUEUE_KEY]
  )
    ? result[EVENT_QUEUE_KEY]
    : [];

  const queue = rawQueue.map(createRiskEvent);

  if (queue.length === 0) {
    return 0;
  }

  if (queue.some((item, index) =>
    !isCanonicalRiskEvent(
      rawQueue[index],
      item
    )
  )) {
    await storage.set({ [EVENT_QUEUE_KEY]: queue });
  }

  const batch = queue.slice(
    0,
    EVENT_BATCH_SIZE
  );
  const retryState = result[SECURITY_RETRY_STATE_KEY] || {};
  const riskApiUrl = await getApiUrl('/api/events/risk');
  const uploadResults = await Promise.all(
    batch.map(async event => {
      const payload = createRiskApiPayload(event);
      try {
        const response = await fetchWithTimeout(
          riskApiUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }
        );
        await ensureApiSuccess(response, [0, 1]);
        return { payload, status: 'uploaded' };
      } catch (error) {
        const previousAttempts = Number(
          retryState[payload.event_uuid]?.attempts || 0
        );
        const decision = classifyEventFailure(error, previousAttempts);
        return {
          payload,
          status: decision.retry ? 'retry' : 'failed',
          error,
          decision
        };
      }
    })
  );

  const uploadedIds = new Set(
    uploadResults
      .filter(item => item.status === 'uploaded')
      .map(item => item.payload.event_uuid)
  );
  const failedIds = new Set(
    uploadResults
      .filter(item => item.status === 'failed')
      .map(item => item.payload.event_uuid)
  );
  const completedIds = new Set([...uploadedIds, ...failedIds]);
  const latest = await storage.get([
    EVENT_QUEUE_KEY,
    SECURITY_RETRY_STATE_KEY,
    FAILED_SECURITY_EVENTS_KEY
  ]);
  const latestQueue = Array.isArray(latest[EVENT_QUEUE_KEY])
    ? latest[EVENT_QUEUE_KEY]
    : [];
  const nextRetryState = {
    ...(latest[SECURITY_RETRY_STATE_KEY] || {})
  };

  uploadResults.forEach(item => {
    const eventUuid = item.payload.event_uuid;
    if (item.status === 'retry') {
      nextRetryState[eventUuid] = {
        attempts: item.decision.attempts,
        reason: item.decision.reason
      };
    } else {
      delete nextRetryState[eventUuid];
    }
  });

  const failedEvents = uploadResults
    .filter(item => item.status === 'failed')
    .map(item => createFailedEventRecord(
      item.payload,
      item.error,
      item.decision
    ));
  const existingFailed = Array.isArray(
    latest[FAILED_SECURITY_EVENTS_KEY]
  ) ? latest[FAILED_SECURITY_EVENTS_KEY] : [];

  await storage.set({
    [EVENT_QUEUE_KEY]: latestQueue.filter(item =>
      !completedIds.has(item.event_uuid || item.id)
    ),
    [SECURITY_RETRY_STATE_KEY]: nextRetryState,
    [FAILED_SECURITY_EVENTS_KEY]: [
      ...existingFailed,
      ...failedEvents
    ].slice(-FAILED_EVENT_LIMIT)
  });

  if (failedEvents.length > 0) {
    console.warn(`⚠️ [风险事件] ${failedEvents.length} 条已停止重试并进入失败隔离区`);
  }
  console.log(`✅ [风险事件] 成功 ${uploadedIds.size}/${batch.length} 条`);
  return uploadedIds.size;
}

function flushSecurityEvents() {
  return runSecurityEventQueueTask(
    flushSecurityEventsUnlocked
  );
}

const LEGACY_STAT_FIELD_MAP = {
  adBlock: 'adBlockCount',
  urlDetect: 'urlDetectCount',
  aiDetect: 'aiDetectCount'
};

function normalizeStoredStatistics(oldStats = {}) {
  const stats = { ...oldStats };
  let changed = false;

  Object.entries(LEGACY_STAT_FIELD_MAP).forEach(
    ([legacyField, canonicalField]) => {
      if (!Object.prototype.hasOwnProperty.call(
        stats,
        legacyField
      )) {
        return;
      }

      if (stats[canonicalField] == null) {
        stats[canonicalField] = stats[legacyField];
      }
      delete stats[legacyField];
      changed = true;
    }
  );

  return { stats, changed };
}

async function getAdBlockTotal() {
  const result = await storage.get(
    'netguardStats'
  );

  const oldStats = result.netguardStats || {};
  const adBlockCount = Number(
    oldStats.adBlockCount ??
    oldStats.adBlock ??
    0
  );
  const normalized = normalizeStoredStatistics(
    oldStats
  );

  if (normalized.changed) {
    await storage.set({
      netguardStats: normalized.stats
    });
  }

  return adBlockCount;
}

async function syncLegacyAdBlockCursor() {
  const total = await getAdBlockTotal();

  if (!Number.isInteger(total) || total < 0) {
    return;
  }

  await storage.set({
    lastUploadedAdBlockCount: total
  });
}

function normalizeAdPageUrl(value) {
  const pageUrl = String(value || '')
    .trim()
    .slice(0, 4096);

  if (!pageUrl) {
    return '';
  }

  try {
    const parsed = new URL(pageUrl);
    if (![
      'http:',
      'https:',
      'file:'
    ].includes(parsed.protocol)) {
      return '';
    }
  } catch (_) {
    return '';
  }

  return pageUrl;
}

function normalizeAdBlockedCount(value) {
  const blockedCount = (
    typeof value === 'boolean' ||
    value === null ||
    value === ''
  )
    ? Number.NaN
    : Number(value);

  return (
    Number.isInteger(blockedCount) &&
    blockedCount >= 0
  )
    ? blockedCount
    : null;
}

function createAdApiPayload(
  event,
  fallbackPageUrl = ''
) {
  const pageUrl =
    normalizeAdPageUrl(event.page_url) ||
    normalizeAdPageUrl(fallbackPageUrl);
  const blockedCount = normalizeAdBlockedCount(
    event.blocked_count
  );

  if (!pageUrl) {
    throw new Error('广告事件缺少有效页面 URL');
  }

  if (blockedCount === null) {
    throw new Error('广告事件 blocked_count 必须为非负整数');
  }

  return {
    event_uuid: isValidEventUuid(event.event_uuid)
      ? event.event_uuid
      : generateEventUuid(),
    page_url: pageUrl,
    blocked_count: blockedCount,
    mode: [
      'normal',
      'strict',
      'elder',
      'child'
    ].includes(event.mode)
      ? event.mode
      : 'normal',
    resource_type: String(
      event.resource_type || 'mixed'
    ).slice(0, 32)
  };
}

function isCanonicalAdApiEvent(rawEvent, normalizedEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return false;
  }

  const fields = [
    'event_uuid',
    'page_url',
    'blocked_count',
    'mode',
    'resource_type'
  ];

  return (
    Object.keys(rawEvent).length === fields.length &&
    fields.every(field =>
      Object.prototype.hasOwnProperty.call(
        rawEvent,
        field
      ) &&
      rawEvent[field] === normalizedEvent[field]
    )
  );
}

function normalizeAdEventQueue(rawQueue) {
  if (!Array.isArray(rawQueue)) {
    return { queue: [], changed: Boolean(rawQueue) };
  }

  const queue = [];
  let changed = false;

  rawQueue.forEach(rawEvent => {
    try {
      const normalized = createAdApiPayload(rawEvent);
      queue.push(normalized);
      if (!isCanonicalAdApiEvent(rawEvent, normalized)) {
        changed = true;
      }
    } catch (error) {
      changed = true;
      console.warn(
        '⚠️ [广告事件] 丢弃无法修复的旧队列项:',
        error.message
      );
    }
  });

  return { queue, changed };
}

let adEventQueueTask = Promise.resolve();
const adPageFlushTimers = new Map();

function runAdEventQueueTask(task) {
  const currentTask = adEventQueueTask.then(
    task,
    task
  );

  adEventQueueTask = currentTask.catch(() => {});
  return currentTask;
}

async function flushAdEventQueueUnlocked() {
  if (isProtectionPaused(await getSettings())) {
    return 0;
  }

  const result = await storage.get([
    AD_EVENT_QUEUE_KEY,
    AD_RETRY_STATE_KEY
  ]);
  const normalized = normalizeAdEventQueue(
    result[AD_EVENT_QUEUE_KEY]
  );
  const queue = normalized.queue;

  if (normalized.changed) {
    await storage.set({
      [AD_EVENT_QUEUE_KEY]: queue
    });
  }

  if (queue.length === 0) {
    return 0;
  }

  const batch = queue.slice(0, EVENT_BATCH_SIZE);
  const retryState = result[AD_RETRY_STATE_KEY] || {};
  const adApiUrl = await getApiUrl('/api/events/ad');
  const uploadResults = await Promise.all(
    batch.map(async payload => {
      try {
        console.log('[AD_UPLOAD]', {
          url: adApiUrl,
          payload
        });
        console.log('[BG_UPLOAD_AD]', payload);
        const response = await fetchWithTimeout(
          adApiUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }
        );

        await ensureApiSuccess(response, [0, 1]);
        return { payload, status: 'uploaded' };
      } catch (error) {
        const previousAttempts = Number(
          retryState[payload.event_uuid]?.attempts || 0
        );
        const decision = classifyEventFailure(
          error,
          previousAttempts
        );
        return {
          payload,
          status: decision.retry ? 'retry' : 'failed',
          error,
          decision
        };
      }
    })
  );

  const uploadedIds = new Set(
    uploadResults
      .filter(item => item.status === 'uploaded')
      .map(item => item.payload.event_uuid)
  );
  const failedIds = new Set(
    uploadResults
      .filter(item => item.status === 'failed')
      .map(item => item.payload.event_uuid)
  );
  const completedIds = new Set([...uploadedIds, ...failedIds]);
  const latest = await storage.get([
    AD_EVENT_QUEUE_KEY,
    AD_RETRY_STATE_KEY,
    FAILED_AD_EVENTS_KEY
  ]);
  const latestQueue = normalizeAdEventQueue(
    latest[AD_EVENT_QUEUE_KEY]
  ).queue;
  const nextRetryState = {
    ...(latest[AD_RETRY_STATE_KEY] || {})
  };

  uploadResults.forEach(item => {
    const eventUuid = item.payload.event_uuid;
    if (item.status === 'retry') {
      nextRetryState[eventUuid] = {
        attempts: item.decision.attempts,
        reason: item.decision.reason
      };
    } else {
      delete nextRetryState[eventUuid];
    }
  });

  const failedEvents = uploadResults
    .filter(item => item.status === 'failed')
    .map(item => createFailedEventRecord(
      item.payload,
      item.error,
      item.decision
    ));
  const existingFailed = Array.isArray(
    latest[FAILED_AD_EVENTS_KEY]
  ) ? latest[FAILED_AD_EVENTS_KEY] : [];

  await storage.set({
    [AD_EVENT_QUEUE_KEY]: latestQueue.filter(
      event => !completedIds.has(event.event_uuid)
    ),
    [AD_RETRY_STATE_KEY]: nextRetryState,
    [FAILED_AD_EVENTS_KEY]: [
      ...existingFailed,
      ...failedEvents
    ].slice(-FAILED_EVENT_LIMIT)
  });

  if (uploadedIds.size > 0) {
    // 旧累计游标仅作为兼容状态，不再作为事件上传来源。
    await syncLegacyAdBlockCursor();
  }

  if (failedEvents.length > 0) {
    console.warn(
      `⚠️ [广告事件] ${failedEvents.length} 条已停止重试并进入失败隔离区`
    );
  }
  console.log(
    `✅ [广告事件] 成功 ${uploadedIds.size}/${batch.length} 条`
  );
  return uploadedIds.size;
}

function flushAdEventQueue() {
  return runAdEventQueueTask(
    flushAdEventQueueUnlocked
  );
}

function normalizeAdMode(mode, settings = DEFAULT_SETTINGS) {
  if (settings.childMode) {
    return 'child';
  }

  if (settings.elderMode) {
    return 'elder';
  }

  return [
    'normal',
    'strict',
    'elder',
    'child'
  ].includes(mode)
    ? mode
    : settings.adMode;
}

function normalizeAdResourceType(value) {
  const resourceType = String(value || 'element')
    .trim()
    .toLowerCase()
    .slice(0, 32);

  return resourceType || 'element';
}

function getAdPageSession(event = {}, sender = {}) {
  const pageUrl = normalizeAdPageUrl(
    event.page_url || sender.tab?.url
  );
  const tabId = Number.isInteger(sender.tab?.id)
    ? sender.tab.id
    : null;

  if (!pageUrl) {
    throw new Error('广告统计缺少有效页面 URL');
  }

  return {
    pageUrl,
    tabId,
    sessionKey: tabId === null
      ? `page:${pageUrl}`
      : `tab:${tabId}:${pageUrl}`
  };
}

function clearAdPageFlushTimer(sessionKey) {
  const timer = adPageFlushTimers.get(sessionKey);
  if (timer) {
    clearTimeout(timer.timerId);
    adPageFlushTimers.delete(sessionKey);
  }
}

function scheduleAdPageFinalization(aggregate) {
  clearAdPageFlushTimer(aggregate.session_key);

  const now = Date.now();
  const targetTime = aggregate.page_complete
    ? Number(aggregate.updated_at) + AD_PAGE_SETTLE_DELAY
    : Number(aggregate.created_at) + AD_PAGE_MAX_WAIT;
  const delay = Math.max(0, targetTime - now);
  const timerId = setTimeout(() => {
    adPageFlushTimers.delete(aggregate.session_key);
    finalizeAdPageAggregates({
      sessionKey: aggregate.session_key
    }).catch(error => {
      console.warn(
        '⚠️ [广告聚合] 定时归并失败:',
        error.message
      );
    });
  }, delay);

  adPageFlushTimers.set(aggregate.session_key, {
    timerId,
    tabId: aggregate.tab_id
  });
}

async function recordAdPageBlockUnlocked(event = {}, sender = {}) {
  const settings = await getSettings();

  if (isProtectionPaused(settings)) {
    return { accepted: false, skipped: true };
  }

  const session = getAdPageSession(event, sender);
  if (isWhitelisted(session.pageUrl, settings.whitelist)) {
    return { accepted: false, skipped: true };
  }

  const increment = normalizeAdBlockedCount(
    event.increment ?? event.blocked_count
  );
  if (increment === null || increment <= 0) {
    throw new Error('广告聚合 increment 必须为正整数');
  }

  const result = await storage.get([
    AD_PAGE_AGGREGATES_KEY,
    COMPLETED_AD_PAGE_SESSIONS_KEY
  ]);
  const aggregates = {
    ...(result[AD_PAGE_AGGREGATES_KEY] || {})
  };
  const completed = Array.isArray(
    result[COMPLETED_AD_PAGE_SESSIONS_KEY]
  ) ? result[COMPLETED_AD_PAGE_SESSIONS_KEY] : [];

  if (completed.some(item =>
    item.session_key === session.sessionKey
  )) {
    return {
      accepted: false,
      skipped: true,
      completed: true
    };
  }

  const now = Date.now();
  const existing = aggregates[session.sessionKey];
  const blockedCount = Number(existing?.blocked_count || 0) + increment;
  if (!Number.isSafeInteger(blockedCount)) {
    throw new Error('广告聚合 blocked_count 超出安全整数范围');
  }

  const resourceTypes = new Set(
    Array.isArray(existing?.resource_types)
      ? existing.resource_types
      : []
  );
  resourceTypes.add(
    normalizeAdResourceType(event.resource_type)
  );

  const aggregate = {
    session_key: session.sessionKey,
    event_uuid: existing?.event_uuid || generateEventUuid(),
    page_url: session.pageUrl,
    blocked_count: blockedCount,
    mode: normalizeAdMode(event.mode, settings),
    resource_types: [...resourceTypes],
    tab_id: session.tabId,
    page_complete: Boolean(
      existing?.page_complete || event.page_complete
    ),
    created_at: Number(existing?.created_at || now),
    updated_at: now
  };

  if (!existing) {
    console.log('[AD_PENDING_CREATE]', {
      event_uuid: aggregate.event_uuid,
      page_url: aggregate.page_url
    });
    console.log('[BG_PENDING]', aggregate);
  }

  aggregates[session.sessionKey] = aggregate;
  await storage.set({
    [AD_PAGE_AGGREGATES_KEY]: aggregates
  });
  scheduleAdPageFinalization(aggregate);

  return {
    accepted: true,
    aggregated: true,
    blocked_count: aggregate.blocked_count
  };
}

function recordAdPageBlock(event, sender) {
  return runAdEventQueueTask(
    () => recordAdPageBlockUnlocked(event, sender)
  );
}

async function finalizeAdPageAggregatesUnlocked(options = {}) {
  if (isProtectionPaused(await getSettings())) {
    return 0;
  }

  const result = await storage.get([
    AD_PAGE_AGGREGATES_KEY,
    COMPLETED_AD_PAGE_SESSIONS_KEY,
    AD_EVENT_QUEUE_KEY
  ]);
  const aggregates = {
    ...(result[AD_PAGE_AGGREGATES_KEY] || {})
  };
  const completed = Array.isArray(
    result[COMPLETED_AD_PAGE_SESSIONS_KEY]
  ) ? result[COMPLETED_AD_PAGE_SESSIONS_KEY] : [];
  const normalizedQueue = normalizeAdEventQueue(
    result[AD_EVENT_QUEUE_KEY]
  );
  const queue = normalizedQueue.queue;
  const now = Date.now();
  const finalized = [];

  for (const aggregate of Object.values(aggregates)) {
    const matchesSession = !options.sessionKey ||
      aggregate.session_key === options.sessionKey;
    const matchesTab = options.tabId == null ||
      aggregate.tab_id === options.tabId;
    if (!matchesSession || !matchesTab) {
      continue;
    }

    const pageSettled = aggregate.page_complete &&
      now - Number(aggregate.updated_at || 0) >= AD_PAGE_SETTLE_DELAY;
    const maxWaitReached = now - Number(aggregate.created_at || now) >=
      AD_PAGE_MAX_WAIT;
    if (!options.force && !pageSettled && !maxWaitReached) {
      scheduleAdPageFinalization(aggregate);
      continue;
    }

    if (queue.length >= AD_EVENT_QUEUE_LIMIT) {
      scheduleAdPageFinalization(aggregate);
      continue;
    }

    const resourceTypes = Array.isArray(aggregate.resource_types)
      ? [...new Set(aggregate.resource_types)]
      : [];
    const payload = createAdApiPayload({
      event_uuid: aggregate.event_uuid,
      page_url: aggregate.page_url,
      blocked_count: aggregate.blocked_count,
      mode: aggregate.mode,
      resource_type: resourceTypes.length === 1
        ? resourceTypes[0]
        : 'mixed'
    });

    if (!queue.some(item => item.event_uuid === payload.event_uuid)) {
      queue.push(payload);
    }
    delete aggregates[aggregate.session_key];
    clearAdPageFlushTimer(aggregate.session_key);
    finalized.push({
      session_key: aggregate.session_key,
      tab_id: aggregate.tab_id,
      completed_at: now
    });
  }

  if (finalized.length === 0) {
    if (normalizedQueue.changed) {
      await storage.set({ [AD_EVENT_QUEUE_KEY]: queue });
    }
    return 0;
  }

  const finalizedKeys = new Set(
    finalized.map(item => item.session_key)
  );
  await storage.set({
    [AD_PAGE_AGGREGATES_KEY]: aggregates,
    [AD_EVENT_QUEUE_KEY]: queue,
    [COMPLETED_AD_PAGE_SESSIONS_KEY]: [
      ...completed.filter(item =>
        !finalizedKeys.has(item.session_key)
      ),
      ...finalized
    ].slice(-COMPLETED_AD_SESSION_LIMIT)
  });

  await flushAdEventQueueUnlocked();
  return finalized.length;
}

function finalizeAdPageAggregates(options = {}) {
  return runAdEventQueueTask(
    () => finalizeAdPageAggregatesUnlocked(options)
  );
}

async function markAdPageCompleteUnlocked(
  event = {},
  sender = {},
  force = false
) {
  const settings = await getSettings();
  if (isProtectionPaused(settings)) {
    return { accepted: false, skipped: true };
  }

  const session = getAdPageSession(event, sender);
  const result = await storage.get(AD_PAGE_AGGREGATES_KEY);
  const aggregates = {
    ...(result[AD_PAGE_AGGREGATES_KEY] || {})
  };
  const aggregate = aggregates[session.sessionKey];
  if (!aggregate) {
    return { accepted: false, empty: true };
  }

  aggregate.page_complete = true;
  aggregate.updated_at = Date.now();
  aggregates[session.sessionKey] = aggregate;
  await storage.set({
    [AD_PAGE_AGGREGATES_KEY]: aggregates
  });

  if (force) {
    await finalizeAdPageAggregatesUnlocked({
      sessionKey: session.sessionKey,
      force: true
    });
  } else {
    scheduleAdPageFinalization(aggregate);
  }

  return { accepted: true, aggregated: true };
}

function markAdPageComplete(event, sender, force = false) {
  return runAdEventQueueTask(
    () => markAdPageCompleteUnlocked(event, sender, force)
  );
}

function handleAdPageNavigation(tabId) {
  return runAdEventQueueTask(async () => {
    await finalizeAdPageAggregatesUnlocked({
      tabId,
      force: true
    });

    const result = await storage.get(
      COMPLETED_AD_PAGE_SESSIONS_KEY
    );
    const completed = Array.isArray(
      result[COMPLETED_AD_PAGE_SESSIONS_KEY]
    ) ? result[COMPLETED_AD_PAGE_SESSIONS_KEY] : [];
    await storage.set({
      [COMPLETED_AD_PAGE_SESSIONS_KEY]: completed.filter(
        item => item.tab_id !== tabId
      )
    });

    for (const [sessionKey, timer] of adPageFlushTimers) {
      if (timer.tabId === tabId) {
        clearAdPageFlushTimer(sessionKey);
      }
    }
  });
}

function enqueueAdEvent(event, totalSnapshot) {
  return runAdEventQueueTask(async () => {
    const settings = await getSettings();

    if (isProtectionPaused(settings)) {
      return { accepted: false, skipped: true };
    }

    const payload = createAdApiPayload(event);

    if (
      isWhitelisted(
        payload.page_url,
        settings.whitelist
      )
    ) {
      return { accepted: false, skipped: true };
    }

    if (payload.blocked_count === 0) {
      return { accepted: false, skipped: true };
    }

    const result = await storage.get([
      AD_EVENT_QUEUE_KEY,
      'lastUploadedAdBlockCount'
    ]);
    const queue = normalizeAdEventQueue(
      result[AD_EVENT_QUEUE_KEY]
    ).queue;

    if (queue.length >= AD_EVENT_QUEUE_LIMIT) {
      throw new Error('广告事件队列已满');
    }

    queue.push(payload);

    const updates = {
      [AD_EVENT_QUEUE_KEY]: queue
    };
    const snapshot = normalizeAdBlockedCount(
      totalSnapshot
    );
    const lastUploaded = normalizeAdBlockedCount(
      result.lastUploadedAdBlockCount
    );

    if (snapshot !== null) {
      updates.lastUploadedAdBlockCount = Math.max(
        snapshot,
        lastUploaded ?? 0
      );
    }

    await storage.set(updates);
    await flushAdEventQueueUnlocked();

    return { accepted: true };
  });
}

async function flushAdStatistics() {
  if (isProtectionPaused(await getSettings())) {
    return 0;
  }

  return runAdEventQueueTask(async () => {
    const result = await storage.get([
      PENDING_AD_EVENT_KEY,
      AD_EVENT_QUEUE_KEY,
      'lastAdBlockContext'
    ]);
    const pending = result[PENDING_AD_EVENT_KEY];

    if (!pending) {
      // 裸累计值无法证明尚未通过页面聚合链路上传，只同步兼容游标。
      await syncLegacyAdBlockCursor();
      return 0;
    }

    let payload;
    try {
      payload = createAdApiPayload(
        pending,
        result.lastAdBlockContext?.page_url
      );
    } catch (error) {
      // 无法规范化的旧 pending 原样保留，避免静默丢失。
      console.warn(
        '⚠️ [广告统计迁移] 旧 pending 无效，已保留:',
        error.message
      );
      return 0;
    }

    const normalized = normalizeAdEventQueue(
      result[AD_EVENT_QUEUE_KEY]
    );
    const queue = normalized.queue;

    if (!queue.some(event =>
      event.event_uuid === payload.event_uuid
    )) {
      if (queue.length >= AD_EVENT_QUEUE_LIMIT) {
        console.warn(
          '⚠️ [广告统计迁移] 主队列已满，旧 pending 暂时保留'
        );
        return 0;
      }
      queue.push(payload);
    }

    // 先持久化主队列，再删除旧 key。中途重启时按 UUID 去重迁移。
    await storage.set({
      [AD_EVENT_QUEUE_KEY]: queue
    });
    await storage.remove(PENDING_AD_EVENT_KEY);
    console.log('[BG_PENDING]', payload);
    console.log(
      '[广告统计迁移] 旧 pending 已并入页面聚合上传队列'
    );

    await syncLegacyAdBlockCursor();
    return flushAdEventQueueUnlocked();
  });
}

async function updateStats(
  type,
  increment = 1
) {
  const result = await storage.get(
    'netguardStats'
  );

  const oldStats = result.netguardStats || {};
  const normalized = normalizeStoredStatistics(
    oldStats
  ).stats;
  const canonicalType =
    LEGACY_STAT_FIELD_MAP[type] || type;
  const stats = {
    ...normalized,
    [canonicalType]:
      Number(normalized[canonicalType] || 0) +
      increment,
    lastUpdateTime: new Date().toISOString()
  };

  await storage.set({
    netguardStats: stats
  });
}

async function addRiskLog(log) {
  const result = await storage.get(
    'netguardRiskLogs'
  );

  const logs = Array.isArray(
    result.netguardRiskLogs
  )
    ? result.netguardRiskLogs
    : [];

  logs.unshift({
    id: Date.now(),
    type: log.type || 'unknown',
    level: log.level || 'low',
    url: log.url || '',
    reason: log.reason || '',
    date: new Date().toISOString()
  });

  await storage.set({
    netguardRiskLogs: logs.slice(0, 100)
  });
}

function getWarningPageUrl(
  originalUrl,
  risk,
  reason
) {
  const params = new URLSearchParams({
    type: 'url_block',
    url: originalUrl,
    risk: risk || 'high',
    reason:
      reason || '检测到危险网站',
    source: originalUrl
  });

  return (
    extensionAPI.runtime.getURL(
      'warning.html'
    ) +
    '?' +
    params.toString()
  );
}

const recentChecks = new Map();
let continueBypassOperation = Promise.resolve();

function serializeContinueBypassOperation(operation) {
  const result = continueBypassOperation.then(
    operation,
    operation
  );
  continueBypassOperation = result.catch(() => {});
  return result;
}

function canonicalizeContinueTarget(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      return '';
    }
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function getContinueTabKey(tabId) {
  return Number.isInteger(tabId) && tabId >= 0
    ? String(tabId)
    : '';
}

function removeExpiredContinueEntries(entries, now) {
  const cleaned = { ...(entries || {}) };
  let changed = false;

  Object.entries(cleaned).forEach(([key, entry]) => {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      delete cleaned[key];
      changed = true;
    }
  });

  return { entries: cleaned, changed };
}

async function readContinueBypassState(now = Date.now()) {
  const result = await continueBypassStorage.get([
    CONTINUE_BYPASS_KEY,
    ACTIVE_CONTINUE_NAVIGATION_KEY
  ]);
  const pendingResult = removeExpiredContinueEntries(
    result[CONTINUE_BYPASS_KEY],
    now
  );

  return {
    pending: pendingResult.entries,
    // consumed suppression 跟随 document 生命周期，不使用 pending TTL。
    active: { ...(result[ACTIVE_CONTINUE_NAVIGATION_KEY] || {}) },
    changed: pendingResult.changed
  };
}

async function writeContinueBypassState(state) {
  await continueBypassStorage.set({
    [CONTINUE_BYPASS_KEY]: state.pending,
    [ACTIVE_CONTINUE_NAVIGATION_KEY]: state.active
  });
}

function isWarningPageSender(sender, targetUrl) {
  const tabKey = getContinueTabKey(sender?.tab?.id);
  const senderUrl = sender?.url || sender?.tab?.url;
  if (!tabKey || !senderUrl) return false;

  try {
    const actual = new URL(senderUrl);
    const expected = new URL(
      extensionAPI.runtime.getURL('warning.html')
    );
    const isWarningPage =
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname;
    const warningTarget = canonicalizeContinueTarget(
      actual.searchParams.get('url')
    );

    return isWarningPage && warningTarget === targetUrl;
  } catch (_) {
    return false;
  }
}

async function registerOneTimeContinueBypass(target, sender) {
  const targetUrl = canonicalizeContinueTarget(target);
  const tabKey = getContinueTabKey(sender?.tab?.id);
  if (!targetUrl || !tabKey || !isWarningPageSender(sender, targetUrl)) {
    return { success: false, error: 'invalid_continue_request' };
  }

  return serializeContinueBypassOperation(async () => {
    const now = Date.now();
    const state = await readContinueBypassState(now);
    state.pending[tabKey] = {
      tabId: sender.tab.id,
      targetUrl,
      expiresAt: now + CONTINUE_BYPASS_TTL
    };
    delete state.active[tabKey];
    await writeContinueBypassState(state);

    return { success: true, targetUrl };
  });
}

async function clearContinueBypassForTab(tabId) {
  const tabKey = getContinueTabKey(tabId);
  if (!tabKey) return;

  await serializeContinueBypassOperation(async () => {
    const state = await readContinueBypassState();
    const hadEntry = Boolean(
      state.pending[tabKey] || state.active[tabKey]
    );
    delete state.pending[tabKey];
    delete state.active[tabKey];
    if (hadEntry || state.changed) {
      await writeContinueBypassState(state);
    }
  });
}

async function shouldBypassContinuedNavigation(
  tabId,
  target,
  context = {}
) {
  const tabKey = getContinueTabKey(tabId);
  const targetUrl = canonicalizeContinueTarget(target);
  if (!tabKey || !targetUrl) return false;

  return serializeContinueBypassOperation(async () => {
    const now = Date.now();
    const state = await readContinueBypassState(now);
    const source = context.source || 'background';
    const documentId = context.documentId || null;
    const pending = state.pending[tabKey];
    let active = state.active[tabKey];

    if (pending?.targetUrl === targetUrl) {
      // 待用凭证在第一次命中时立即删除；active 只标记当前这次导航，
      // 供后台与内容脚本的多个检测入口共享，不可用于下一次 loading。
      delete state.pending[tabKey];
      active = {
        tabId,
        targetUrl,
        loadingSeen: source === 'tabs-loading' || source === 'content',
        documentId
      };
      state.active[tabKey] = active;
      recentChecks.delete(`${tabId}:${target}`);
      recentChecks.delete(`${tabId}:${targetUrl}`);
      await writeContinueBypassState(state);
      return true;
    }

    if (!active) {
      if (state.changed) await writeContinueBypassState(state);
      return false;
    }

    if (active.targetUrl !== targetUrl) {
      delete state.active[tabKey];
      await writeContinueBypassState(state);
      return false;
    }

    if (source === 'tabs-loading') {
      if (active.loadingSeen) {
        // 相同 tab 的下一次刷新/导航立即结束本次抑制。
        delete state.active[tabKey];
        await writeContinueBypassState(state);
        return false;
      }
      active.loadingSeen = true;
      state.active[tabKey] = active;
      await writeContinueBypassState(state);
      return true;
    }

    if (
      documentId &&
      active.documentId &&
      active.documentId !== documentId
    ) {
      delete state.active[tabKey];
      await writeContinueBypassState(state);
      return false;
    }

    if (documentId && !active.documentId) {
      active.documentId = documentId;
      state.active[tabKey] = active;
      await writeContinueBypassState(state);
    } else if (state.changed) {
      await writeContinueBypassState(state);
    }

    return true;
  });
}

function isDuplicateCheck(tabId, url) {
  const key = `${tabId}:${url}`;
  const now = Date.now();
  const lastTime =
    recentChecks.get(key) || 0;

  recentChecks.set(key, now);

  for (const [item, time] of recentChecks) {
    if (now - time > 10000) {
      recentChecks.delete(item);
    }
  }

  return now - lastTime < 2000;
}

async function performUrlCheck(
  url,
  tabId,
  navigationContext = {}
) {
  if (
    !isSupportedUrl(url) ||
    isExtensionUrl(url)
  ) {
    return;
  }

  if (await shouldSkipRiskProtection(url)) {
    console.log(
      '⏸️ [URL检测] 暂停或白名单状态，直接跳过'
    );
    return;
  }

  if (
    await shouldBypassContinuedNavigation(
      tabId,
      url,
      navigationContext
    )
  ) {
    console.log('➡️ [URL检测] 已消费本次继续访问，跳过风险检测');
    return;
  }

  if (isDuplicateCheck(tabId, url)) {
    return;
  }

  await updateStats('urlDetectCount');

  if (!isDangerousUrl(url)) {
    return;
  }

  // 风险接口调用前再次读取最新状态，避免 Popup 切换与导航竞态。
  if (await shouldSkipRiskProtection(url)) {
    return;
  }

  const result =
    await checkUrlWithFlask(url);

  // 请求期间可能刚刚暂停；旧结果不得继续记日志或触发 warning。
  if (await shouldSkipRiskProtection(url)) {
    return;
  }

  if (
    !result ||
    result.risk_level !== 'high'
  ) {
    return;
  }

  await updateStats('highRisk');

  await addRiskLog({
    type: 'URL检测',
    level: 'high',
    url,
    reason: result.reason
  });

  const warningUrl =
    getWarningPageUrl(
      url,
      result.risk_level,
      result.reason
    );

  // warning 页面导航是最后一道保护边界，必须使用最新暂停状态。
  if (await shouldSkipRiskProtection(url)) {
    return;
  }

  try {
    await extensionAPI.tabs.update(
      tabId,
      { url: warningUrl }
    );
  } catch (error) {
    console.warn(
      '⚠️ [URL检测] 无法打开警告页:',
      error.message
    );
  }
}

extensionAPI.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message?.type === 'NETGUARD_SYNC_SETTINGS') {
      synchronizeSettingsWithBackend(
        message.reason || 'runtime-message'
      ).then(sendResponse).catch(error => {
        sendResponse?.({
          success: false,
          error: error.message
        });
      });
      return true;
    }

    if (message?.type === 'NETGUARD_CONTINUE_ONCE') {
      registerOneTimeContinueBypass(
        message.targetUrl,
        sender
      ).then(sendResponse).catch(error => {
        sendResponse?.({
          success: false,
          error: error.message
        });
      });
      return true;
    }

    if (message?.type === 'NETGUARD_QUERY_CONTINUE_BYPASS') {
      const senderUrl = canonicalizeContinueTarget(
        sender?.url || sender?.tab?.url
      );
      const requestedUrl = canonicalizeContinueTarget(message.url);
      const isTopFrame = sender?.frameId === undefined || sender.frameId === 0;

      if (
        !isTopFrame ||
        !requestedUrl ||
        requestedUrl !== senderUrl
      ) {
        sendResponse?.({ success: false, bypass: false });
        return false;
      }

      shouldBypassContinuedNavigation(
        sender?.tab?.id,
        requestedUrl,
        {
          source: 'content',
          documentId: sender?.documentId
        }
      ).then(bypass => {
        sendResponse?.({ success: true, bypass });
      }).catch(() => {
        sendResponse?.({ success: false, bypass: false });
      });
      return true;
    }

    if (
      message?.type ===
      'NETGUARD_SECURITY_EVENT'
    ) {
      enqueueSecurityEvent(
        message.event || message.data || {}
      ).then(() => {
        sendResponse?.({ success: true });
      });

      return true;
    }

    if (
      message?.type ===
      'NETGUARD_FLUSH_EVENTS'
    ) {
      (async () => {
        await flushSecurityEvents();
        await finalizeAdPageAggregates({ force: true });
        await flushAdEventQueue();
        await flushAdStatistics();
      })().then(() => {
        sendResponse?.({ success: true });
      });

      return true;
    }

    if (
      message?.type ===
      'NETGUARD_AD_BLOCKED'
    ) {
      recordAdPageBlock(
        message.event || {},
        sender
      ).then(result => {
        sendResponse?.({
          success: true,
          ...result
        });
      }).catch(error => {
        console.warn(
          '⚠️ [广告聚合] 计数失败:',
          error.message
        );
        sendResponse?.({
          success: false,
          error: error.message
        });
      });

      return true;
    }

    if (
      message?.type ===
      'NETGUARD_AD_PAGE_COMPLETE'
    ) {
      markAdPageComplete(
        message.event || {},
        sender,
        Boolean(message.force)
      ).then(result => {
        sendResponse?.({
          success: true,
          ...result
        });
      }).catch(error => {
        console.warn(
          '⚠️ [广告聚合] 页面归并失败:',
          error.message
        );
        sendResponse?.({
          success: false,
          error: error.message
        });
      });

      return true;
    }

    if (
      message?.type ===
      'NETGUARD_AD_EVENT'
    ) {
      enqueueAdEvent(
        message.event || {},
        message.total_snapshot
      ).then(result => {
        sendResponse?.({
          success: true,
          ...result
        });
      }).catch(error => {
        console.warn(
          '⚠️ [广告事件] 入队失败:',
          error.message
        );
        sendResponse?.({
          success: false,
          error: error.message
        });
      });

      return true;
    }

    if (
      message?.type ===
      'NETGUARD_AD_STAT_UPDATED'
    ) {
      console.log(
        '[BG_RECEIVE_AD_STAT_UPDATED]',
        message
      );
      console.log(
        '[BG_FLUSH_START]'
      );
      flushAdStatistics().then(() => {
        sendResponse?.({ success: true });
      }).catch(error => {
        console.warn(
          '⚠️ [广告统计] 消息触发上传失败:',
          error.message
        );
        sendResponse?.({
          success: false,
          error: error.message
        });
      });

      return true;
    }

    return false;
  }
);

extensionAPI.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local') return;
  const protectionRuleKeys = [
    SETTINGS_KEY, 'protectionPaused', 'paused', 'whitelist',
    'siteWhitelist'
  ];
  if (protectionRuleKeys.some(key => changes[key])) {
    await syncWhitelistRules();
  }

  const childReminderKeys = [
    ...protectionRuleKeys,
    'childSettings'
  ];
  if (childReminderKeys.some(key => changes[key])) {
    await queueChildBrowsingReminderOperation(
      reconcileChildBrowsingReminderState
    );
  }
});

extensionAPI.tabs.onUpdated.addListener(
  async (
    tabId,
    changeInfo,
    tab
  ) => {
    if (changeInfo.status === 'complete') {
      await markAdPageComplete(
        {
          page_url: tab.url || changeInfo.url,
          page_complete: true
        },
        { tab },
        false
      ).catch(() => {});
      return;
    }

    if (changeInfo.status !== 'loading') {
      return;
    }

    await handleAdPageNavigation(tabId);
    await performUrlCheck(
      tab.url || changeInfo.url,
      tabId,
      { source: 'tabs-loading' }
    );
  }
);

extensionAPI.tabs.onRemoved?.addListener(
  async tabId => {
    await handleAdPageNavigation(tabId);
    await clearContinueBypassForTab(tabId);
  }
);

extensionAPI.tabs.onActivated.addListener(
  async activeInfo => {
    try {
      const tab =
        await extensionAPI.tabs.get(
          activeInfo.tabId
        );

      await performUrlCheck(
        tab.url,
        activeInfo.tabId,
        { source: 'tab-activated' }
      );
    } catch (error) {
      console.warn(
        '⚠️ [标签切换] 检测失败:',
        error.message
      );
    }
  }
);

extensionAPI.webNavigation
  .onCommitted
  .addListener(
    async details => {
      if (details.frameId !== 0) {
        return;
      }

      await performUrlCheck(
        details.url,
        details.tabId,
        {
          source: 'web-navigation',
          documentId: details.documentId
        }
      );
    },
    {
      url: [
        {
          schemes: [
            'http',
            'https',
            'file'
          ]
        }
      ]
    }
  );

extensionAPI.alarms.onAlarm.addListener(
  async alarm => {
    if (alarm.name === CHILD_BROWSING_REMINDER_ALARM) {
      await queueChildBrowsingReminderOperation(
        handleChildBrowsingReminderTick
      );
      return;
    }

    if (alarm.name !== FLUSH_ALARM) {
      return;
    }

    await synchronizeSettingsWithBackend('periodic-alarm');
    await flushSecurityEvents();
    await finalizeAdPageAggregates();
    await flushAdEventQueue();
    await flushAdStatistics();
  }
);

extensionAPI.runtime.onInstalled.addListener(
  async () => {
    await initializeSettings();
    await synchronizeSettingsWithBackend(
      'background-installed'
    );
    await queueChildBrowsingReminderOperation(
      reconcileChildBrowsingReminderState
    );

    extensionAPI.alarms.create(
      FLUSH_ALARM,
      {
        periodInMinutes: 1
      }
    );
  }
);

extensionAPI.runtime.onStartup.addListener(
  async () => {
    await initializeSettings();
    await synchronizeSettingsWithBackend(
      'background-startup'
    );
    await queueChildBrowsingReminderOperation(
      reconcileChildBrowsingReminderState
    );

    extensionAPI.alarms.create(
      FLUSH_ALARM,
      {
        periodInMinutes: 1
      }
    );
    await flushSecurityEvents();
    await finalizeAdPageAggregates();
    await flushAdEventQueue();
    await flushAdStatistics();
  }
);

async function initializeBackground() {
  await initializeSettings();
  await syncWhitelistRules();

  extensionAPI.alarms.create(
    FLUSH_ALARM,
    {
      periodInMinutes: 1
    }
  );
  await queueChildBrowsingReminderOperation(
    reconcileChildBrowsingReminderState
  );

  const tabs =
    await extensionAPI.tabs.query({
      active: true,
      currentWindow: true
    });

  if (tabs[0]) {
    await performUrlCheck(
      tabs[0].url,
      tabs[0].id
    );
  }

  await flushSecurityEvents();
  await finalizeAdPageAggregates();
  await flushAdEventQueue();
  await flushAdStatistics();

  console.log(
    '✅ [Background] 初始化完成'
  );
}

initializeBackground().catch(error => {
  console.error(
    '❌ [Background] 初始化失败:',
    error
  );
});
