export const isHttpDownloadTarget = (target?: string | null): boolean =>
  /^https?:\/\//i.test(target ?? '');

const DEFAULT_IMAGE_DOWNLOAD_ERROR = '下载失败：服务器返回的不是图片文件。';
const IMAGE_METADATA_CONTENT_TYPES = new Set(['application/json']);
const IMAGE_METADATA_URL_KEYS = [
  'url',
  'imageUrl',
  'image_url',
  'downloadUrl',
  'download_url',
  'proxiedUrl',
  'proxied_url',
  'src',
  'href',
];
const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

type HeaderLike = Headers | Record<string, string | string[] | undefined> | undefined;

export type ImageBlobResponse = {
  data: Blob;
  headers?: HeaderLike;
  status?: number;
};

export type ImageBlobResponseLoader = (source: string) => Promise<ImageBlobResponse>;

type ResolvedImageBlob = {
  blob: Blob;
  contentType: string;
  filename?: string | null;
};

export class ImageDownloadError extends Error {
  userMessage: string;
  status?: number;

  constructor(message: string, options: { userMessage?: string; status?: number } = {}) {
    super(message);
    this.name = 'ImageDownloadError';
    this.userMessage = options.userMessage ?? DEFAULT_IMAGE_DOWNLOAD_ERROR;
    this.status = options.status;
  }
}

export function triggerDownload(target: string, filename: string): void {
  const isBlob = target.startsWith('blob:');
  const link = document.createElement('a');
  link.href = target;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (isBlob) {
    setTimeout(() => URL.revokeObjectURL(target), 1000);
  }
}

function normalizeContentType(value?: string | null) {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

function getHeaderValue(headers: HeaderLike, name: string) {
  if (!headers) {
    return null;
  }
  if (typeof (headers as { get?: (name: string) => string | null }).get === 'function') {
    return (headers as { get: (name: string) => string | null }).get(name);
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }

  const lowerName = name.toLowerCase();
  const record = headers as Record<string, string | string[] | undefined>;
  const entry = Object.entries(record).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  if (Array.isArray(entry)) {
    return entry[0] ?? null;
  }
  return entry ?? null;
}

function getImageMimeFromBytes(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }

  return null;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

function readBlobAsText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.readAsText(blob);
  });
}

async function sniffImageMimeType(blob: Blob) {
  const bytes = new Uint8Array(await readBlobAsArrayBuffer(blob.slice(0, 16)));
  return getImageMimeFromBytes(bytes);
}

function getImageExtensionFromMime(contentType: string) {
  if (contentType === 'image/jpeg') {
    return 'jpg';
  }
  if (contentType === 'image/webp') {
    return 'webp';
  }
  if (contentType === 'image/gif') {
    return 'gif';
  }
  return 'png';
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseContentDispositionFilename(contentDisposition?: string | null) {
  if (!contentDisposition) {
    return null;
  }

  const encodedMatch = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(stripQuotes(encodedMatch[1]));
    } catch {
      return stripQuotes(encodedMatch[1]);
    }
  }

  const filenameMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  return filenameMatch?.[1] ? stripQuotes(filenameMatch[1]) : null;
}

function sanitizeFilename(filename?: string | null) {
  const rawName = filename?.split(/[\\/]/).filter(Boolean).pop()?.trim() || 'generated-image';
  const sanitized = rawName
    .replace(/[\0-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  return sanitized || 'generated-image';
}

export function getImageDownloadFilename(filename: string | null | undefined, contentType: string) {
  const extension = getImageExtensionFromMime(contentType);
  const sanitized = sanitizeFilename(filename);
  const dotIndex = sanitized.lastIndexOf('.');
  if (dotIndex > 0) {
    const currentExtension = sanitized.slice(dotIndex + 1).toLowerCase();
    if (contentType === 'image/jpeg' && (currentExtension === 'jpg' || currentExtension === 'jpeg')) {
      return sanitized;
    }
    if (currentExtension === extension) {
      return sanitized;
    }
    if (SUPPORTED_IMAGE_EXTENSIONS.includes(currentExtension) || currentExtension === 'json') {
      return `${sanitized.slice(0, dotIndex)}.${extension}`;
    }
  }
  return `${sanitized}.${extension}`;
}

function isJsonContentType(contentType: string) {
  return IMAGE_METADATA_CONTENT_TYPES.has(contentType) || contentType.endsWith('+json');
}

function isSupportedImageContentType(contentType: string) {
  return SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType);
}

function shouldIncludeCredentials(source: string) {
  try {
    const url = new URL(source, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return source.startsWith('/');
  }
}

function getFetchCredentials(source: string): RequestCredentials {
  return shouldIncludeCredentials(source) ? 'include' : 'omit';
}

function isAllowedImageSource(value: string) {
  if (value.startsWith('/') || value.startsWith('data:') || value.startsWith('blob:')) {
    return true;
  }
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isBareBase64ImageSource(value: string) {
  const normalized = value.trim();
  return normalized.length > 32 && /^[A-Za-z0-9+/=\s]+$/.test(normalized);
}

function extractImageUrlFromJson(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of IMAGE_METADATA_URL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && isAllowedImageSource(candidate)) {
      return candidate;
    }
  }

  for (const key of ['image', 'data', 'result']) {
    const nested = extractImageUrlFromJson(record[key]);
    if (nested) {
      return nested;
    }
  }

  for (const key of ['images', 'results']) {
    const list = record[key];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      const nested = extractImageUrlFromJson(item);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function bytesFromBase64(value: string) {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function blobFromImageData(source: string) {
  if (!source.startsWith('data:')) {
    return new Blob([bytesFromBase64(source)], { type: 'image/png' });
  }

  const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match?.[3]) {
    throw new ImageDownloadError('Invalid image data URL');
  }

  const contentType = normalizeContentType(match[1] || 'image/png');
  const encodedBody = match[3];
  let bytes: Uint8Array;

  if (match[2]) {
    bytes = bytesFromBase64(encodedBody);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(encodedBody));
  }

  return new Blob([bytes], { type: contentType });
}

async function fetchImageBlobResponse(source: string): Promise<ImageBlobResponse> {
  const response = await fetch(source, {
    credentials: getFetchCredentials(source),
  });

  if (!response.ok) {
    throw new ImageDownloadError(`Image request failed: ${response.status}`, { status: response.status });
  }

  return {
    data: await response.blob(),
    headers: response.headers,
    status: response.status,
  };
}

async function resolveImageBlobFromResponse(
  source: string,
  response: ImageBlobResponse,
  options: { seen: Set<string>; depth: number },
): Promise<ResolvedImageBlob> {
  const declaredType = normalizeContentType(
    getHeaderValue(response.headers, 'content-type') || response.data.type,
  );
  const contentDispositionFilename = parseContentDispositionFilename(
    getHeaderValue(response.headers, 'content-disposition'),
  );

  if (response.data.size <= 0) {
    throw new ImageDownloadError('Image response was empty');
  }

  if (isJsonContentType(declaredType)) {
    if (options.depth >= 1) {
      throw new ImageDownloadError('Image metadata redirect limit exceeded');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBlobAsText(response.data));
    } catch {
      throw new ImageDownloadError('Image metadata was not valid JSON');
    }

    const nextSource = extractImageUrlFromJson(parsed);
    if (!nextSource) {
      throw new ImageDownloadError('Image metadata did not include a usable image URL');
    }
    if (options.seen.has(nextSource)) {
      throw new ImageDownloadError('Image metadata redirected to an already fetched URL');
    }

    options.seen.add(nextSource);
    return resolveImageBlobFromSource(nextSource, { seen: options.seen, depth: options.depth + 1 });
  }

  const sniffedType = await sniffImageMimeType(response.data);
  const contentType = sniffedType || declaredType;
  if (!sniffedType || !isSupportedImageContentType(contentType)) {
    throw new ImageDownloadError(`Unsupported image response content type: ${declaredType || 'unknown'}`);
  }

  const blob =
    response.data.type === contentType ? response.data : new Blob([response.data], { type: contentType });

  return {
    blob,
    contentType,
    filename: contentDispositionFilename,
  };
}

async function resolveImageBlobFromSource(
  source: string,
  options: {
    responseLoader?: ImageBlobResponseLoader;
    seen?: Set<string>;
    depth?: number;
  } = {},
): Promise<ResolvedImageBlob> {
  const seen = options.seen ?? new Set<string>([source]);
  const depth = options.depth ?? 0;

  if (source.startsWith('data:') || isBareBase64ImageSource(source)) {
    const blob = blobFromImageData(source);
    return resolveImageBlobFromResponse(
      source,
      { data: blob, headers: { 'content-type': blob.type } },
      { seen, depth },
    );
  }

  const response = options.responseLoader
    ? await options.responseLoader(source)
    : await fetchImageBlobResponse(source);
  return resolveImageBlobFromResponse(source, response, { seen, depth });
}

export async function downloadImageAsset({
  source,
  filename,
  responseLoader,
}: {
  source: string;
  filename?: string | null;
  responseLoader?: ImageBlobResponseLoader;
}) {
  const image = await resolveImageBlobFromSource(source, { responseLoader });
  const resolvedFilename = getImageDownloadFilename(image.filename || filename, image.contentType);
  const objectUrl = URL.createObjectURL(image.blob);
  triggerDownload(objectUrl, resolvedFilename);
  return {
    filename: resolvedFilename,
    contentType: image.contentType,
  };
}

export async function createImageObjectUrlFromSource(
  source: string,
  options: { responseLoader?: ImageBlobResponseLoader } = {},
) {
  const image = await resolveImageBlobFromSource(source, { responseLoader: options.responseLoader });
  return URL.createObjectURL(image.blob);
}

export async function imageSourceToFile({
  source,
  filename,
  responseLoader,
}: {
  source: string;
  filename: string;
  responseLoader?: ImageBlobResponseLoader;
}) {
  const image = await resolveImageBlobFromSource(source, { responseLoader });
  const fileName = getImageDownloadFilename(filename, image.contentType);
  return new File([image.blob], fileName, { type: image.contentType });
}
