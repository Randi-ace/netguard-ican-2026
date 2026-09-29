(function (root) {
  'use strict';

  const STORAGE_KEY = 'netguardApiBaseUrl';
  const DEFAULT_API_BASE_URL = 'http://127.0.0.1:5000';

  function normalizeApiBaseUrl(value) {
    try {
      const parsed = new URL(String(value || '').trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('API 地址仅支持 http 或 https');
      }
      if (parsed.username || parsed.password) {
        throw new Error('API 地址不得包含账号或密码');
      }

      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch (_) {
      return DEFAULT_API_BASE_URL;
    }
  }

  function resolveApiBaseUrl(result = {}) {
    const settings = result.netguardSettings || {};
    return normalizeApiBaseUrl(
      result[STORAGE_KEY] ??
      settings.apiBaseUrl ??
      DEFAULT_API_BASE_URL
    );
  }

  function readStorage(storageArea) {
    return new Promise(resolve => {
      if (!storageArea?.get) {
        resolve({});
        return;
      }

      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result || {});
      };

      try {
        const possiblePromise = storageArea.get(
          [STORAGE_KEY, 'netguardSettings'],
          finish
        );
        if (possiblePromise?.then) {
          possiblePromise.then(finish, () => finish({}));
        }
      } catch (_) {
        finish({});
      }
    });
  }

  async function getApiBaseUrl(storageArea) {
    return resolveApiBaseUrl(await readStorage(storageArea));
  }

  async function getApiUrl(path, storageArea) {
    const baseUrl = await getApiBaseUrl(storageArea);
    const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
    return `${baseUrl}${normalizedPath}`;
  }

  root.NetGuardApiConfig = Object.freeze({
    STORAGE_KEY,
    DEFAULT_API_BASE_URL,
    normalizeApiBaseUrl,
    resolveApiBaseUrl,
    getApiBaseUrl,
    getApiUrl
  });
})(globalThis);
