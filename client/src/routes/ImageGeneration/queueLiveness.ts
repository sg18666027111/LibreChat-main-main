export const IMAGE_GENERATION_CLIENT_SOFT_WAIT_MS = 5 * 60 * 1000;
export const IMAGE_GENERATION_CLIENT_RESPONSE_BUFFER_MS = 60 * 1000;
export const IMAGE_GENERATION_CLIENT_DEFAULT_PROVIDER_TIMEOUT_MS = 5 * 60 * 1000;
export const IMAGE_GENERATION_CLIENT_APIMART_MULTI_REFERENCE_PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;
export const IMAGE_GENERATION_CLIENT_SOFT_WAIT_MESSAGE = '生成时间较长，任务仍在处理中';
export const IMAGE_GENERATION_CLIENT_TIMEOUT_ERROR_CODE = 'CLIENT_WAIT_TIMEOUT';
export const IMAGE_GENERATION_LOCAL_ABORT_ERROR_CODE = 'CLIENT_LOCAL_ABORT';
export const IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE =
  '等待响应超时，当前无法确认任务是否已被后端或 Provider 接收，也无法在当前页面恢复查询最终结果。为避免重复生成，请不要立即再次提交。';
export const IMAGE_GENERATION_LOCAL_ABORT_MESSAGE =
  '已停止本地等待，当前无法确认任务是否仍在远端执行。';
export const IMAGE_GENERATION_LEASE_STORAGE_KEY = 'jingjicang_image_generation_active_lease';
export const IMAGE_GENERATION_LEASE_CHANNEL_NAME = 'jingjicang_image_generation_lease';
export const IMAGE_GENERATION_LEASE_UPDATED_MESSAGE = 'image_generation_lease_updated';
export const IMAGE_GENERATION_LEASE_CLEARED_MESSAGE = 'image_generation_lease_cleared';
export const IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT = 7;
export const IMAGE_GENERATION_CROSS_TAB_CAPACITY_MESSAGE =
  '当前已有 7 个任务正在生成，请等待任一任务完成后继续。';
export const IMAGE_GENERATION_CROSS_TAB_DUPLICATE_MESSAGE =
  '另一个页面正在生成相同内容，继续提交可能产生重复图片和额外费用。';

export const IMAGE_GENERATION_CLIENT_WAIT_CONFIG = {
  default: {
    profile: 'default',
    softTimeoutMs: IMAGE_GENERATION_CLIENT_SOFT_WAIT_MS,
    hardTimeoutMs:
      IMAGE_GENERATION_CLIENT_DEFAULT_PROVIDER_TIMEOUT_MS +
      IMAGE_GENERATION_CLIENT_RESPONSE_BUFFER_MS,
    unknownProtectionMs:
      IMAGE_GENERATION_CLIENT_DEFAULT_PROVIDER_TIMEOUT_MS +
      IMAGE_GENERATION_CLIENT_RESPONSE_BUFFER_MS,
  },
  apimartMultiReference: {
    profile: 'apimart_multi_reference',
    softTimeoutMs: IMAGE_GENERATION_CLIENT_SOFT_WAIT_MS,
    hardTimeoutMs:
      IMAGE_GENERATION_CLIENT_APIMART_MULTI_REFERENCE_PROVIDER_TIMEOUT_MS +
      IMAGE_GENERATION_CLIENT_RESPONSE_BUFFER_MS,
    unknownProtectionMs:
      IMAGE_GENERATION_CLIENT_APIMART_MULTI_REFERENCE_PROVIDER_TIMEOUT_MS +
      IMAGE_GENERATION_CLIENT_RESPONSE_BUFFER_MS,
  },
} as const;

const APIMART_MODEL_KEYS = new Set([
  'apimart_gpt_image_2',
  'apimart_gpt_image_2_5_sunburst',
  'apimart_gpt_image_2_text',
  'apimart_gemini_3_1_flash',
  'apimart_gemini_2_5_flash',
]);

const APIMART_MODELS = new Set([
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image-preview',
]);

export function getImageGenerationClientWaitConfig(task: {
  taskType?: string | null;
  modelKey?: string | null;
  model?: string | null;
}) {
  const isAPIMart =
    (task.modelKey ? APIMART_MODEL_KEYS.has(task.modelKey) : false) ||
    (task.model ? APIMART_MODELS.has(task.model) : false);

  if (task.taskType === 'dual-product-replace' && isAPIMart) {
    return IMAGE_GENERATION_CLIENT_WAIT_CONFIG.apimartMultiReference;
  }

  return IMAGE_GENERATION_CLIENT_WAIT_CONFIG.default;
}

const TAB_SESSION_STORAGE_KEY = 'jingjicang_image_generation_tab_session_id';
const IMAGE_GENERATION_LEASE_REGISTRY_VERSION = 1;
const IMAGE_GENERATION_LEASE_LOCK_NAME = 'jingjicang_image_generation_lease_claim';

export type ImageGenerationClientWaitReason = 'client_timeout' | 'cancelled_local';
export type ImageGenerationLeaseStatus = 'running' | 'status_unknown';

export type ImageGenerationLease = {
  tabSessionId: string;
  localTaskId: string;
  taskType: string;
  jobFingerprint?: string;
  startedAt: number;
  leaseExpiresAt: number;
  status: ImageGenerationLeaseStatus;
};

export type ImageGenerationLeaseRegistry = {
  version: typeof IMAGE_GENERATION_LEASE_REGISTRY_VERSION;
  leases: Record<string, ImageGenerationLease>;
};

type ImageGenerationLeaseMessage =
  | {
      type: typeof IMAGE_GENERATION_LEASE_UPDATED_MESSAGE;
      lease: ImageGenerationLease;
    }
  | {
      type: typeof IMAGE_GENERATION_LEASE_CLEARED_MESSAGE;
      tabSessionId?: string;
      localTaskId?: string;
    };

export type ImageGenerationLeaseClaimResult =
  | { ok: true; lease: ImageGenerationLease }
  | {
      ok: false;
      reason: 'concurrency_limit' | 'duplicate_fingerprint' | 'claim_conflict';
      blockingLease: ImageGenerationLease | null;
      activeCount: number;
    };

export class ImageGenerationClientWaitError extends Error {
  errorCode: string;
  state: ImageGenerationClientWaitReason;

  constructor(reason: ImageGenerationClientWaitReason) {
    super(
      reason === 'client_timeout'
        ? IMAGE_GENERATION_CLIENT_TIMEOUT_MESSAGE
        : IMAGE_GENERATION_LOCAL_ABORT_MESSAGE,
    );
    this.name = 'ImageGenerationClientWaitError';
    this.errorCode =
      reason === 'client_timeout'
        ? IMAGE_GENERATION_CLIENT_TIMEOUT_ERROR_CODE
        : IMAGE_GENERATION_LOCAL_ABORT_ERROR_CODE;
    this.state = reason;
  }
}

export function isImageGenerationClientWaitError(
  error: unknown,
): error is ImageGenerationClientWaitError {
  return error instanceof ImageGenerationClientWaitError;
}

export function getImageGenerationTabSessionId() {
  if (typeof window === 'undefined') {
    return 'server';
  }

  const existing = window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const next =
    globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, next);
  return next;
}

export function logImageGenerationLivenessEvent(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
) {
  console.info('[ImageGeneration liveness]', {
    event,
    tabSessionId: getImageGenerationTabSessionId(),
    ...fields,
  });
}

const FINGERPRINT_IGNORED_KEYS = new Set([
  'tabSessionId',
  'localTaskId',
  'startedAt',
  'createdAt',
  'updatedAt',
  'leaseExpiresAt',
  'requestId',
  'requestStartedAt',
  'traceId',
  'ignoredRuntimeFields',
]);

type FingerprintValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FingerprintValue[]
  | { [key: string]: FingerprintValue };

function canonicalizeFingerprintValue(value: FingerprintValue): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeFingerprintValue(entry)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([key, entry]) => !FINGERPRINT_IGNORED_KEYS.has(key) && entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeFingerprintValue(entry)}`);
  return `{${entries.join(',')}}`;
}

function bufferToHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function rightRotate(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Fallback(payload: Uint8Array) {
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = payload.length * 8;
  const paddedLength = Math.ceil((payload.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(payload);
  padded[payload.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rightRotate(words[index - 15], 7) ^
        rightRotate(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 =
        rightRotate(words[index - 2], 17) ^
        rightRotate(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function encodeUtf8(input: string) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(input);
  }

  const bytes: number[] = [];
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export async function createImageGenerationJobFingerprint(descriptor: FingerprintValue) {
  const canonical = canonicalizeFingerprintValue(descriptor);
  const payload = encodeUtf8(canonical);
  if (!globalThis.crypto?.subtle) {
    return sha256Fallback(payload);
  }
  return bufferToHex(await globalThis.crypto.subtle.digest('SHA-256', payload));
}

function getStorage() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeImageGenerationLease(value: unknown): ImageGenerationLease | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const lease = value as Partial<ImageGenerationLease>;
  if (
    typeof lease.tabSessionId !== 'string' ||
    typeof lease.localTaskId !== 'string' ||
    typeof lease.taskType !== 'string' ||
    typeof lease.startedAt !== 'number' ||
    typeof lease.leaseExpiresAt !== 'number' ||
    (lease.status !== 'running' && lease.status !== 'status_unknown')
  ) {
    return null;
  }

  return {
    tabSessionId: lease.tabSessionId,
    localTaskId: lease.localTaskId,
    taskType: lease.taskType,
    jobFingerprint: typeof lease.jobFingerprint === 'string' ? lease.jobFingerprint : undefined,
    startedAt: lease.startedAt,
    leaseExpiresAt: lease.leaseExpiresAt,
    status: lease.status,
  };
}

export function getImageGenerationLeaseId(lease: { tabSessionId: string; localTaskId: string }) {
  return `${lease.tabSessionId}:${lease.localTaskId}`;
}

function emptyImageGenerationLeaseRegistry(): ImageGenerationLeaseRegistry {
  return {
    version: IMAGE_GENERATION_LEASE_REGISTRY_VERSION,
    leases: {},
  };
}

function normalizeImageGenerationLeaseRegistry(value: unknown): ImageGenerationLeaseRegistry {
  const singleLease = normalizeImageGenerationLease(value);
  if (singleLease) {
    return {
      version: IMAGE_GENERATION_LEASE_REGISTRY_VERSION,
      leases: {
        [getImageGenerationLeaseId(singleLease)]: singleLease,
      },
    };
  }

  if (!value || typeof value !== 'object') {
    return emptyImageGenerationLeaseRegistry();
  }

  const candidate = value as {
    leases?: unknown;
  };
  const leaseContainer =
    candidate.leases && typeof candidate.leases === 'object'
      ? (candidate.leases as Record<string, unknown>)
      : (value as Record<string, unknown>);
  const leases: Record<string, ImageGenerationLease> = {};
  Object.values(leaseContainer).forEach((entry) => {
    const lease = normalizeImageGenerationLease(entry);
    if (lease) {
      leases[getImageGenerationLeaseId(lease)] = lease;
    }
  });

  return {
    version: IMAGE_GENERATION_LEASE_REGISTRY_VERSION,
    leases,
  };
}

export function readStoredImageGenerationLeaseRegistry(): ImageGenerationLeaseRegistry {
  const storage = getStorage();
  if (!storage) {
    return emptyImageGenerationLeaseRegistry();
  }

  try {
    const raw = storage.getItem(IMAGE_GENERATION_LEASE_STORAGE_KEY);
    if (!raw) {
      return emptyImageGenerationLeaseRegistry();
    }
    return normalizeImageGenerationLeaseRegistry(JSON.parse(raw));
  } catch {
    return emptyImageGenerationLeaseRegistry();
  }
}

function writeImageGenerationLeaseRegistry(registry: ImageGenerationLeaseRegistry) {
  const storage = getStorage();
  try {
    if (Object.keys(registry.leases).length === 0) {
      storage?.removeItem(IMAGE_GENERATION_LEASE_STORAGE_KEY);
      return;
    }
    storage?.setItem(IMAGE_GENERATION_LEASE_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // BroadcastChannel can still notify live tabs if persistent storage is unavailable.
  }
}

function sortImageGenerationLeases(leases: ImageGenerationLease[]) {
  return [...leases].sort((left, right) => {
    const startedDelta = left.startedAt - right.startedAt;
    if (startedDelta !== 0) {
      return startedDelta;
    }
    return getImageGenerationLeaseId(left).localeCompare(getImageGenerationLeaseId(right));
  });
}

function pruneExpiredImageGenerationLeaseRegistry(
  registry: ImageGenerationLeaseRegistry,
  now = Date.now(),
) {
  const activeEntries = Object.entries(registry.leases).filter(
    ([, lease]) => lease.leaseExpiresAt > now,
  );
  const nextRegistry: ImageGenerationLeaseRegistry = {
    version: IMAGE_GENERATION_LEASE_REGISTRY_VERSION,
    leases: Object.fromEntries(activeEntries),
  };

  return {
    registry: nextRegistry,
    changed: activeEntries.length !== Object.keys(registry.leases).length,
  };
}

function postImageGenerationLeaseMessage(message: ImageGenerationLeaseMessage) {
  if (typeof BroadcastChannel === 'undefined') {
    return;
  }

  try {
    const channel = new BroadcastChannel(IMAGE_GENERATION_LEASE_CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch {
    // localStorage remains the compatibility path when BroadcastChannel is blocked.
  }
}

export function getActiveImageGenerationLease(now = Date.now()) {
  return getActiveImageGenerationLeases(now)[0] ?? null;
}

export function getActiveImageGenerationLeases(now = Date.now()) {
  const { registry, changed } = pruneExpiredImageGenerationLeaseRegistry(
    readStoredImageGenerationLeaseRegistry(),
    now,
  );
  if (changed) {
    writeImageGenerationLeaseRegistry(registry);
  }
  return sortImageGenerationLeases(Object.values(registry.leases));
}

export function createImageGenerationLease({
  localTaskId,
  taskType,
  jobFingerprint,
  hardTimeoutMs,
  status,
  startedAt = Date.now(),
  tabSessionId = getImageGenerationTabSessionId(),
}: {
  localTaskId: string;
  taskType: string;
  jobFingerprint?: string;
  hardTimeoutMs: number;
  status: ImageGenerationLeaseStatus;
  startedAt?: number;
  tabSessionId?: string;
}): ImageGenerationLease {
  return {
    tabSessionId,
    localTaskId,
    taskType,
    jobFingerprint,
    startedAt,
    leaseExpiresAt: startedAt + hardTimeoutMs,
    status,
  };
}

export function writeImageGenerationLease(lease: ImageGenerationLease) {
  const { registry } = pruneExpiredImageGenerationLeaseRegistry(
    readStoredImageGenerationLeaseRegistry(),
  );
  registry.leases[getImageGenerationLeaseId(lease)] = lease;
  writeImageGenerationLeaseRegistry(registry);
  postImageGenerationLeaseMessage({
    type: IMAGE_GENERATION_LEASE_UPDATED_MESSAGE,
    lease,
  });
}

export function clearImageGenerationLease(match?: { tabSessionId?: string; localTaskId?: string }) {
  if (!match?.tabSessionId || !match.localTaskId) {
    return false;
  }

  const leaseId = getImageGenerationLeaseId({
    tabSessionId: match.tabSessionId,
    localTaskId: match.localTaskId,
  });
  const { registry } = pruneExpiredImageGenerationLeaseRegistry(
    readStoredImageGenerationLeaseRegistry(),
  );
  if (!registry.leases[leaseId]) {
    writeImageGenerationLeaseRegistry(registry);
    return false;
  }

  delete registry.leases[leaseId];
  writeImageGenerationLeaseRegistry(registry);
  postImageGenerationLeaseMessage({
    type: IMAGE_GENERATION_LEASE_CLEARED_MESSAGE,
    tabSessionId: match?.tabSessionId,
    localTaskId: match?.localTaskId,
  });
  return true;
}

function getImageGenerationLeaseClaimBlock(
  lease: ImageGenerationLease,
  registry: ImageGenerationLeaseRegistry,
  force: boolean,
) {
  const leaseId = getImageGenerationLeaseId(lease);
  const otherLeases = sortImageGenerationLeases(Object.values(registry.leases)).filter(
    (candidate) => getImageGenerationLeaseId(candidate) !== leaseId,
  );
  const claimedActiveCount = otherLeases.length + 1;

  if (claimedActiveCount > IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT) {
    return {
      ok: false as const,
      reason: 'concurrency_limit' as const,
      blockingLease: otherLeases[0] ?? null,
      activeCount: otherLeases.length,
    };
  }

  const duplicateLease =
    lease.jobFingerprint &&
    otherLeases.find((candidate) => candidate.jobFingerprint === lease.jobFingerprint);
  if (duplicateLease && !force) {
    return {
      ok: false as const,
      reason: 'duplicate_fingerprint' as const,
      blockingLease: duplicateLease,
      activeCount: otherLeases.length,
    };
  }

  return null;
}

function hasMatchingStoredImageGenerationLease(lease: ImageGenerationLease) {
  const stored = readStoredImageGenerationLeaseRegistry().leases[getImageGenerationLeaseId(lease)];
  return (
    stored?.tabSessionId === lease.tabSessionId &&
    stored.localTaskId === lease.localTaskId &&
    stored.taskType === lease.taskType &&
    stored.jobFingerprint === lease.jobFingerprint &&
    stored.startedAt === lease.startedAt &&
    stored.leaseExpiresAt === lease.leaseExpiresAt &&
    stored.status === lease.status
  );
}

function claimImageGenerationLeaseWithoutLock(
  lease: ImageGenerationLease,
  { force = false } = {},
): ImageGenerationLeaseClaimResult {
  const { registry } = pruneExpiredImageGenerationLeaseRegistry(
    readStoredImageGenerationLeaseRegistry(),
  );
  const block = getImageGenerationLeaseClaimBlock(lease, registry, force);
  if (block) {
    writeImageGenerationLeaseRegistry(registry);
    return block;
  }

  registry.leases[getImageGenerationLeaseId(lease)] = lease;
  writeImageGenerationLeaseRegistry(registry);
  postImageGenerationLeaseMessage({
    type: IMAGE_GENERATION_LEASE_UPDATED_MESSAGE,
    lease,
  });

  if (!hasMatchingStoredImageGenerationLease(lease)) {
    return {
      ok: false,
      reason: 'claim_conflict',
      blockingLease: getActiveImageGenerationLease(),
      activeCount: getActiveImageGenerationLeases().length,
    };
  }

  const verifiedRegistry = readStoredImageGenerationLeaseRegistry();
  const verifiedBlock = getImageGenerationLeaseClaimBlock(lease, verifiedRegistry, force);
  if (verifiedBlock) {
    clearImageGenerationLease({
      tabSessionId: lease.tabSessionId,
      localTaskId: lease.localTaskId,
    });
    return verifiedBlock;
  }

  return { ok: true, lease };
}

type NavigatorWithLocks = Navigator & {
  locks?: {
    request<T>(
      name: string,
      options: { mode: 'exclusive' },
      callback: () => T | Promise<T>,
    ): Promise<T>;
  };
};

export async function claimImageGenerationLease(
  lease: ImageGenerationLease,
  options: { force?: boolean } = {},
): Promise<ImageGenerationLeaseClaimResult> {
  if (typeof navigator !== 'undefined') {
    const locks = (navigator as NavigatorWithLocks).locks;
    if (locks?.request) {
      return await locks.request(IMAGE_GENERATION_LEASE_LOCK_NAME, { mode: 'exclusive' }, () =>
        claimImageGenerationLeaseWithoutLock(lease, options),
      );
    }
  }

  return claimImageGenerationLeaseWithoutLock(lease, options);
}

export function subscribeImageGenerationLease(
  onLeaseChange: (leases: ImageGenerationLease[]) => void,
) {
  if (typeof BroadcastChannel === 'undefined') {
    return () => undefined;
  }

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(IMAGE_GENERATION_LEASE_CHANNEL_NAME);
  } catch {
    return () => undefined;
  }

  channel.onmessage = (event: MessageEvent<ImageGenerationLeaseMessage>) => {
    const message = event.data;
    if (message?.type === IMAGE_GENERATION_LEASE_UPDATED_MESSAGE) {
      const lease = normalizeImageGenerationLease(message.lease);
      const activeLeases = getActiveImageGenerationLeases();
      const fallbackLeases = lease && lease.leaseExpiresAt > Date.now() ? [lease] : [];
      onLeaseChange(activeLeases.length > 0 ? activeLeases : fallbackLeases);
      return;
    }
    if (message?.type === IMAGE_GENERATION_LEASE_CLEARED_MESSAGE) {
      onLeaseChange(getActiveImageGenerationLeases());
    }
  };

  return () => {
    channel?.close();
  };
}

export async function withImageGenerationClientWait<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    hardTimeoutMs?: number;
    softTimeoutMs?: number;
    timeoutMs?: number;
    onSoftTimeout?: () => void;
    getLastStatusReceivedAt?: () => number | undefined;
    signal?: AbortSignal;
  } = {},
) {
  const hardTimeoutMs =
    options.hardTimeoutMs ??
    options.timeoutMs ??
    IMAGE_GENERATION_CLIENT_WAIT_CONFIG.default.hardTimeoutMs;
  const softTimeoutMs = options.softTimeoutMs;
  const controller = new AbortController();
  let hardTimeoutId: number | null = null;
  let softTimeoutId: number | null = null;
  let settled = false;

  return await new Promise<T>((resolve, reject) => {
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (hardTimeoutId !== null) {
        window.clearTimeout(hardTimeoutId);
      }
      if (softTimeoutId !== null) {
        window.clearTimeout(softTimeoutId);
      }
      options.signal?.removeEventListener('abort', handleLocalAbort);
      callback();
    };

    const handleLocalAbort = () => {
      controller.abort();
      settle(() => reject(new ImageGenerationClientWaitError('cancelled_local')));
    };

    if (options.signal?.aborted) {
      handleLocalAbort();
      return;
    }

    options.signal?.addEventListener('abort', handleLocalAbort, { once: true });

    if (softTimeoutMs && softTimeoutMs > 0 && softTimeoutMs < hardTimeoutMs) {
      softTimeoutId = window.setTimeout(() => {
        if (!settled) {
          options.onSoftTimeout?.();
        }
      }, softTimeoutMs);
    }

    const checkTimeout = () => {
      const lastStatusAt = options.getLastStatusReceivedAt?.();
      const remaining = lastStatusAt == null ? 0 : hardTimeoutMs - (Date.now() - lastStatusAt);
      if (remaining > 0) {
        hardTimeoutId = window.setTimeout(checkTimeout, remaining);
        return;
      }
      controller.abort();
      settle(() => reject(new ImageGenerationClientWaitError('client_timeout')));
    };
    hardTimeoutId = window.setTimeout(checkTimeout, hardTimeoutMs);

    operation(controller.signal).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
