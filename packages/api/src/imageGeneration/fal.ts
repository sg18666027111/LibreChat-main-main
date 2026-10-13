import { MAX_STAGED_IMAGE_BYTES } from './inputs';

const INITIATE_URL = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

class FalInputUploadError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
    message?: string,
  ) {
    super(
      message ??
        (code === 'FAL_INPUT_UPLOAD_TOO_LARGE'
          ? '参考图超过 25 MiB，请压缩后重试。'
          : 'Fal input image upload failed before generation submission.'),
    );
  }
}

export function getFalBalanceFailure(statusCode: number, detail?: string) {
  if (
    statusCode !== 403 ||
    typeof detail !== 'string' ||
    !/^User is locked\.\s*Reason:\s*Exhausted balance\.(?:\s|$)/i.test(detail.trim())
  ) {
    return null;
  }
  return {
    code: 'FAL_BALANCE_EXHAUSTED',
    message: '当前生图服务余额不足，请联系管理员充值后重试。',
  };
}

async function throwUploadHTTPError(response: Response, signal?: AbortSignal): Promise<never> {
  if (response.status === 403) {
    let body: { detail?: string } | null = null;
    try {
      body = await response.json();
    } catch {
      // Keep malformed upstream errors generic without exposing their response body.
    }
    signal?.throwIfAborted();
    const failure = getFalBalanceFailure(response.status, body?.detail);
    if (failure) {
      throw new FalInputUploadError(
        failure.code,
        response.status,
        `${failure.message}此任务尚未提交生成。`,
      );
    }
  }
  throw new FalInputUploadError('FAL_INPUT_UPLOAD_HTTP_ERROR', response.status);
}

function storageURL(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'))
    ) {
      return url.href;
    }
  } catch {
    /* Invalid provider response is reported without URL contents. */
  }
  throw new FalInputUploadError('FAL_INPUT_UPLOAD_INVALID_RESPONSE');
}

function parseInput(value: string) {
  if (value.startsWith('https://')) {
    return { url: value };
  }
  // Match only the short header; never run a regex over multi-megabyte image data.
  const header = value.slice(0, 64);
  const comma = header.indexOf(',');
  const match = /^data:(image\/(?:png|jpeg|webp));base64$/.exec(header.slice(0, comma));
  if (!match) {
    throw new FalInputUploadError('FAL_INPUT_UPLOAD_INVALID_IMAGE');
  }
  const encoded = value.slice(comma + 1);
  if (encoded.length > Math.ceil(MAX_STAGED_IMAGE_BYTES / 3) * 4) {
    throw new FalInputUploadError('FAL_INPUT_UPLOAD_TOO_LARGE', 413);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_STAGED_IMAGE_BYTES) {
    throw new FalInputUploadError('FAL_INPUT_UPLOAD_TOO_LARGE', 413);
  }
  if (!bytes.length || bytes.toString('base64') !== encoded) {
    throw new FalInputUploadError('FAL_INPUT_UPLOAD_INVALID_IMAGE');
  }
  return { bytes, contentType: match[1] };
}

export async function uploadFalImages({
  imageInputs,
  apiKey,
  signal,
  fetchImpl = fetch,
}: {
  imageInputs: string[];
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const inputs = imageInputs.map(parseInput);
  const urls: string[] = [];
  for (const input of inputs) {
    signal?.throwIfAborted();
    if (input.url) {
      urls.push(input.url);
      continue;
    }
    let response: Response;
    try {
      response = await fetchImpl(INITIATE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Key ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Fal-Object-Lifecycle': JSON.stringify({ expiration_duration_seconds: 86400 }),
        },
        body: JSON.stringify({ content_type: input.contentType, file_name: 'input.png' }),
        signal,
        redirect: 'error',
      });
    } catch {
      signal?.throwIfAborted();
      throw new FalInputUploadError('FAL_INPUT_UPLOAD_NETWORK_ERROR', 502);
    }
    if (!response.ok) {
      await throwUploadHTTPError(response, signal);
    }
    let result: { upload_url: string; file_url: string };
    try {
      result = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new FalInputUploadError('FAL_INPUT_UPLOAD_INVALID_RESPONSE');
    }
    const uploadURL = storageURL(result?.upload_url);
    const fileURL = storageURL(result?.file_url);
    signal?.throwIfAborted();
    try {
      response = await fetchImpl(uploadURL, {
        method: 'PUT',
        headers: { 'Content-Type': input.contentType! },
        body: new Uint8Array(input.bytes!),
        signal,
        redirect: 'error',
      });
    } catch {
      signal?.throwIfAborted();
      throw new FalInputUploadError('FAL_INPUT_UPLOAD_NETWORK_ERROR', 502);
    }
    if (!response.ok) {
      await throwUploadHTTPError(response, signal);
    }
    await response.body?.cancel();
    signal?.throwIfAborted();
    urls.push(fileURL);
  }
  return urls;
}
