const { randomUUID } = require('crypto');

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_ALLOWED_HOSTS = [
  'fal.media',
  'fal.run',
  'fal.ai',
  'apimart.ai',
  'siliconflow.cn',
  'volces.com',
  'volcengine.com',
  'volcengineapi.com',
];

const store = new Map();

function getTtlMs() {
  const value = Number.parseInt(process.env.IMAGE_GENERATION_PROXY_TTL_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TTL_MS;
}

function getAllowedHostSuffixes() {
  const fromEnv = (process.env.IMAGE_GENERATION_PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_HOSTS;
}

function extractHostname(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHostAllowed(hostname) {
  if (!hostname) {
    return false;
  }

  return getAllowedHostSuffixes().some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function purgeExpired(now = Date.now()) {
  for (const [token, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(token);
    }
  }
}

function registerResultImage({ resultUrl, provider }) {
  const host = extractHostname(resultUrl);
  if (!isHostAllowed(host)) {
    return null;
  }

  purgeExpired();

  const token = randomUUID().replace(/-/g, '');
  store.set(token, {
    resultUrl,
    provider: provider || null,
    host,
    expiresAt: Date.now() + getTtlMs(),
  });

  return {
    token,
    host,
    proxyPath: `/api/image-generation/result-image/${token}`,
    downloadPath: `/api/image-generation/result-image/${token}?download=1`,
  };
}

function registerResultImageBuffer({ buffer, contentType, provider, filename = 'ai-image-result.png' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new TypeError('Normalized image buffer is required');
    error.code = 'RESULT_PROXY_BUFFER_REQUIRED';
    throw error;
  }
  if (typeof contentType !== 'string' || !contentType.startsWith('image/')) {
    const error = new TypeError('Normalized image content type is required');
    error.code = 'RESULT_PROXY_CONTENT_TYPE_REQUIRED';
    throw error;
  }

  purgeExpired();
  const token = randomUUID().replace(/-/g, '');
  store.set(token, {
    buffer,
    contentType,
    filename,
    resultUrl: null,
    provider: provider || null,
    host: null,
    expiresAt: Date.now() + getTtlMs(),
  });

  return {
    token,
    host: null,
    proxyPath: `/api/image-generation/result-image/${token}`,
    downloadPath: `/api/image-generation/result-image/${token}?download=1`,
  };
}

function getResultImage(token) {
  if (!token) {
    return null;
  }

  const entry = store.get(token);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(token);
    return null;
  }

  return entry;
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_ALLOWED_HOSTS,
  extractHostname,
  getAllowedHostSuffixes,
  getResultImage,
  getTtlMs,
  isHostAllowed,
  registerResultImage,
  registerResultImageBuffer,
};
