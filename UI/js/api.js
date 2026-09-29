/**
 * ShieldFlow Web API client.
 *
 * Usage:
 *   api.get('/api/dashboard/overview');
 *   api.post('/api/settings', { mode: 'normal' });
 */
(function (global) {
  "use strict";

  const DEFAULT_BASE_URL = "http://127.0.0.1:5000";
  const DEFAULT_TIMEOUT = 10000;

  let baseUrl = DEFAULT_BASE_URL;

  class ApiError extends Error {
    constructor(message, options) {
      super(message);
      this.name = "ApiError";
      this.status = options?.status ?? null;
      this.data = options?.data ?? null;
      this.cause = options?.cause;
    }
  }

  function normalizeBaseUrl(url) {
    if (typeof url !== "string" || !url.trim()) {
      throw new TypeError("API base URL must be a non-empty string");
    }

    return url.trim().replace(/\/+$/, "");
  }

  function buildUrl(url) {
    if (typeof url !== "string" || !url.trim()) {
      throw new TypeError("API URL must be a non-empty string");
    }

    const target = url.trim();
    if (/^https?:\/\//i.test(target)) {
      return target;
    }

    return `${baseUrl}/${target.replace(/^\/+/, "")}`;
  }

  async function parseResponse(response) {
    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new ApiError("服务器返回了无效的 JSON 数据", {
          status: response.status,
          cause: error,
        });
      }
    }

    return text;
  }

  async function request(url, options) {
    const requestOptions = options || {};
    const method = String(requestOptions.method || "GET").toUpperCase();
    const timeout = requestOptions.timeout ?? DEFAULT_TIMEOUT;

    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError("Request timeout must be a positive number");
    }

    const controller = new AbortController();
    const timeoutId = global.setTimeout(() => controller.abort(), timeout);
    const headers = new Headers(requestOptions.headers || {});
    headers.set("Accept", "application/json");

    const fetchOptions = {
      method,
      headers,
      signal: controller.signal,
    };

    if (requestOptions.data !== undefined) {
      headers.set("Content-Type", "application/json");
      fetchOptions.body = JSON.stringify(requestOptions.data);
    }

    try {
      const response = await global.fetch(buildUrl(url), fetchOptions);
      const data = await parseResponse(response);

      if (!response.ok) {
        const message =
          data && typeof data === "object" && typeof data.message === "string"
            ? data.message
            : `请求失败（HTTP ${response.status}）`;

        throw new ApiError(message, {
          status: response.status,
          data,
        });
      }

      return data;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error?.name === "AbortError") {
        throw new ApiError(`请求超时（${timeout}ms）`, { cause: error });
      }

      throw new ApiError("网络请求失败，请检查后端服务或网络连接", {
        cause: error,
      });
    } finally {
      global.clearTimeout(timeoutId);
    }
  }

  const api = {
    get(url, options) {
      return request(url, {
        ...(options || {}),
        method: "GET",
      });
    },

    post(url, data, options) {
      return request(url, {
        ...(options || {}),
        method: "POST",
        data,
      });
    },

    request,

    setBaseUrl(url) {
      baseUrl = normalizeBaseUrl(url);
    },

    getBaseUrl() {
      return baseUrl;
    },

    ApiError,
  };

  global.api = api;
})(window);
