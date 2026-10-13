const dns = require('dns/promises');
const net = require('net');
const { Agent, fetch: undiciFetch } = require('undici');
const { isPrivateIP } = require('@librechat/api');

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);
const ALLOWED_PROVIDERS = new Set(['apimart', 'fal']);

function createResultError(message, code, errorKind, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.errorKind = errorKind;
  error.statusCode = 502;
  Object.assign(error, details);
  return error;
}

function getSafeHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isRestrictedHostname(hostname) {
  const normalized = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    !normalized ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized === 'metadata.google.internal'
  );
}

async function resolvePublicAddresses(hostname, lookup) {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(normalized)) {
    addresses = [{ address: normalized, family: net.isIP(normalized) }];
  } else {
    try {
      addresses = await lookup(normalized, { all: true, verbatim: true });
    } catch (cause) {
      throw createResultError(
        '生成结果地址解析失败。',
        'RESULT_DNS_FAILED',
        'result_download_failed',
        { hostname, cause },
      );
    }
  }

  if (!Array.isArray(addresses) || !addresses.length) {
    throw createResultError(
      '生成结果地址解析失败。',
      'RESULT_DNS_FAILED',
      'result_download_failed',
      { hostname },
    );
  }
  if (addresses.some((entry) => isPrivateIP(entry.address))) {
    throw createResultError(
      '生成结果地址未通过安全校验。',
      'RESULT_URL_REJECTED',
      'result_url_rejected',
      { hostname },
    );
  }
  return addresses;
}

function createPinnedDispatcher(addresses) {
  let cursor = 0;
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(null, addresses);
          return;
        }
        const entry = addresses[cursor % addresses.length];
        cursor += 1;
        callback(null, entry.address, entry.family);
      },
    },
  });
}

function sniffImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

async function readLimitedBody(response, maxBytes, hostname) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw createResultError(
      '生成结果图片过大。',
      'RESULT_DOWNLOAD_TOO_LARGE',
      'result_download_failed',
      { hostname, responseBytes: declaredLength },
    );
  }
  if (!response.body) {
    throw createResultError(
      '生成结果图片内容为空。',
      'RESULT_DOWNLOAD_FAILED',
      'result_download_failed',
      { hostname },
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw createResultError(
        '生成结果图片过大。',
        'RESULT_DOWNLOAD_TOO_LARGE',
        'result_download_failed',
        { hostname, responseBytes: totalBytes },
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes);
}

async function validateProviderURL(url, provider, lookup) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createResultError(
      '生成结果地址未通过安全校验。',
      'RESULT_URL_REJECTED',
      'result_url_rejected',
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    !ALLOWED_PROVIDERS.has(provider) ||
    parsed.protocol !== 'https:' ||
    isRestrictedHostname(hostname)
  ) {
    throw createResultError(
      '生成结果地址未通过安全校验。',
      'RESULT_URL_REJECTED',
      'result_url_rejected',
      { hostname },
    );
  }
  const addresses = await resolvePublicAddresses(hostname, lookup);
  return { parsed, hostname, addresses };
}

async function downloadProviderResult({
  url,
  provider,
  fetchImpl = undiciFetch,
  lookup = dns.lookup,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}) {
  let currentURL = url;
  let initialHostname = null;
  const redirectHostnames = [];

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let validated;
    try {
      validated = await validateProviderURL(currentURL, provider, lookup);
    } catch (error) {
      if (redirectCount > 0 && error?.errorKind === 'result_url_rejected') {
        error.redirectHostname = getSafeHostname(currentURL);
      }
      throw error;
    }
    initialHostname ||= validated.hostname;
    const dispatcher = createPinnedDispatcher(validated.addresses);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortHandler = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) {
      controller.abort(signal.reason);
    }
    try {
      let response;
      try {
        response = await fetchImpl(validated.parsed, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'image/*' },
          signal: controller.signal,
          dispatcher,
        });
      } catch (cause) {
        const isTimeout = cause?.name === 'AbortError';
        throw createResultError(
          isTimeout ? '生成结果图片下载超时。' : '生成结果图片下载失败。',
          isTimeout ? 'RESULT_DOWNLOAD_TIMEOUT' : 'RESULT_DOWNLOAD_FAILED',
          'result_download_failed',
          { hostname: validated.hostname, cause },
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirectCount >= maxRedirects) {
          throw createResultError(
            '生成结果地址重定向未通过安全校验。',
            'RESULT_URL_REJECTED',
            'result_url_rejected',
            { hostname: validated.hostname },
          );
        }
        currentURL = new URL(location, validated.parsed).toString();
        redirectHostnames.push(getSafeHostname(currentURL));
        continue;
      }

      if (EXPIRED_STATUSES.has(response.status)) {
        throw createResultError(
          '生成结果地址已失效。',
          'RESULT_URL_EXPIRED',
          'result_download_failed',
          {
            hostname: validated.hostname,
            statusCode: response.status,
            retryMode: 'resume_polling',
          },
        );
      }
      if (!response.ok) {
        throw createResultError(
          '生成结果图片下载失败。',
          'RESULT_DOWNLOAD_FAILED',
          'result_download_failed',
          { hostname: validated.hostname, statusCode: response.status },
        );
      }

      const declaredType = (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!declaredType.startsWith('image/')) {
        throw createResultError('生成结果不是有效图片。', 'INVALID_RESULT_IMAGE', 'invalid_image', {
          hostname: validated.hostname,
        });
      }
      const buffer = await readLimitedBody(response, maxBytes, validated.hostname);
      const contentType = sniffImageContentType(buffer);
      if (!contentType) {
        throw createResultError('生成结果不是有效图片。', 'INVALID_RESULT_IMAGE', 'invalid_image', {
          hostname: validated.hostname,
        });
      }
      return {
        buffer,
        contentType,
        hostname: initialHostname,
        redirectHostnames,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortHandler);
      dispatcher.destroy();
    }
  }

  throw createResultError(
    '生成结果地址重定向未通过安全校验。',
    'RESULT_URL_REJECTED',
    'result_url_rejected',
    { hostname: initialHostname },
  );
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  downloadProviderResult,
  sniffImageContentType,
};
