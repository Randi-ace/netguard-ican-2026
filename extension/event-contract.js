(function (root, factory) {
  const contract = factory();
  if (typeof module === 'object' && module.exports) module.exports = contract;
  root.NetGuardContract = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODES = new Set(['normal', 'strict', 'elder', 'child']);
  const RISK_LEVELS = new Set(['safe', 'low', 'medium', 'high']);

  function isPaused(settings = {}) {
    return Boolean(settings.protectionPaused || settings.paused ||
      settings.netguardSettings?.protectionPaused || settings.netguardSettings?.paused);
  }

  function resolveMode(settings = {}) {
    if (settings.childMode || settings.child_mode || settings.childSettings?.childModeEnabled) return 'child';
    if (settings.elderMode || settings.elder_mode || settings.elderSettings?.enabled) return 'elder';
    return (settings.adMode || settings.adBlockMode || settings.mode) === 'strict' ? 'strict' : 'normal';
  }

  function createSettingsPayload(settings = {}) {
    const mode = resolveMode(settings);
    return {
      mode,
      elder_mode: mode === 'elder',
      child_mode: mode === 'child',
      paused: isPaused(settings)
    };
  }

  function clampScore(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : fallback;
  }

  function createRiskEvent(input = {}, generateUuid) {
    const riskLevel = RISK_LEVELS.has(input.risk_level) ? input.risk_level : 'low';
    const defaults = { safe: 0.05, low: 0.25, medium: 0.65, high: 0.95 };
    return {
      event_uuid: input.event_uuid || generateUuid(),
      url: String(input.url || ''),
      risk_level: riskLevel,
      score: clampScore(input.score, defaults[riskLevel]),
      reason: String(input.reason || ''),
      source: 'extension'
    };
  }

  function validateRiskEvent(event) {
    return Boolean(event?.event_uuid) && typeof event.url === 'string' &&
      event.url.length > 0 && event.url.length <= 4096 && RISK_LEVELS.has(event.risk_level) &&
      typeof event.score === 'number' && !Number.isNaN(event.score) &&
      event.score >= 0 && event.score <= 1 && typeof event.reason === 'string' &&
      event.reason.length <= 1000 && event.source === 'extension';
  }

  function createAdEvent(input = {}, generateUuid) {
    const blockedCount = Number(input.blocked_count);
    const mode = MODES.has(input.mode) ? input.mode : 'normal';
    return {
      event_uuid: input.event_uuid || generateUuid(),
      page_url: String(input.page_url || ''),
      resource_type: String(input.resource_type || 'element').slice(0, 32),
      blocked_count: Number.isInteger(blockedCount) ? blockedCount : -1,
      mode
    };
  }

  function validateAdEvent(event) {
    return Boolean(event?.event_uuid) && typeof event.page_url === 'string' &&
      event.page_url.length > 0 && event.page_url.length <= 4096 &&
      typeof event.resource_type === 'string' && event.resource_type.length <= 32 &&
      Number.isInteger(event.blocked_count) && event.blocked_count >= 0 && MODES.has(event.mode);
  }

  function isTerminalEventSuccess(httpStatus, body) {
    return (httpStatus === 200 || httpStatus === 201) && (body?.code === 0 || body?.code === 1);
  }

  return { MODES, RISK_LEVELS, isPaused, resolveMode, createSettingsPayload, clampScore,
    createRiskEvent, validateRiskEvent, createAdEvent, validateAdEvent, isTerminalEventSuccess };
});
