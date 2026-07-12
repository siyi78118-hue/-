(function initApiEndpoint(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ALApiEndpoint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createApiEndpoint() {
  function normalizeApiBaseUrl(value, options = {}) {
    const label = options.label || '接口';
    const raw = String(value || '').trim();
    if (!raw) throw new Error(`${label}地址为空`);
    if (!/^https?:\/\//i.test(raw)) throw new Error(`${label}地址必须是以 http:// 或 https:// 开头的完整地址`);

    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`${label}地址格式不正确`);
    }

    const appOrigin = String(options.appOrigin || '').replace(/\/+$/, '');
    const pointsToCurrentApp = appOrigin && parsed.origin === appOrigin;
    const pointsToHostedApp = /github\.io$/i.test(parsed.hostname) && /\/(?:[^/]+\/)*tavern-app(?:\/|$)/i.test(parsed.pathname);
    if (pointsToCurrentApp || pointsToHostedApp) {
      throw new Error(`${label}地址指向了 AL 页面，不是模型接口；请重新填写服务商提供的 API 地址`);
    }

    parsed.pathname = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\/(?:chat\/completions|messages|models)$/i, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  }

  function buildApiEndpoint(value, route, options = {}) {
    return normalizeApiBaseUrl(value, options) + '/' + String(route || '').replace(/^\/+/, '');
  }

  function assertNonHtmlApiResponse(raw, response, options = {}) {
    const label = options.label || '接口';
    const endpoint = options.endpoint || '';
    const contentType = String(response?.headers?.get?.('content-type') || '');
    if (/text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(String(raw || ''))) {
      throw new Error(`${label}请求落到了网页而不是模型接口：${endpoint}。请检查地址是否填写了正确的 API 根路径`);
    }
  }

  return { normalizeApiBaseUrl, buildApiEndpoint, assertNonHtmlApiResponse };
});
