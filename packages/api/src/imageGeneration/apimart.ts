import type { APIMartImageTiming } from './timing';
import { MAX_STAGED_IMAGE_BYTES } from './inputs';
import { optimizePNGInput } from './apimart/png';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 180_000;

class APIMartInputUploadError extends Error {
  readonly submittedToProvider = false;

  constructor(
    public code: string,
    public statusCode = 502,
  ) {
    let message = '参考图上传未完成，尚未提交生成任务。可以重试。';
    if (code === 'APIMART_INPUT_UPLOAD_TOO_LARGE') {
      message = 'APIMart 每张参考图上限为 20 MiB，请压缩或更换图片后重新提交。';
    } else if (code === 'APIMART_INPUT_UPLOAD_INVALID_IMAGE') {
      message = '参考图格式或数据无效，请重新上传图片。';
    }
    super(message);
  }
}

function imageURL(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    /* Do not include provider URLs in errors. */
  }
  throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_INVALID_RESPONSE');
}

function parseInput(value: string) {
  if (value.startsWith('https://')) {
    return { url: imageURL(value) };
  }
  const comma = value.indexOf(',');
  const header = value.slice(0, comma);
  const mime = /^data:(image\/(?:png|jpeg|webp|gif));base64$/.exec(header)?.[1];
  const encoded = value.slice(comma + 1);
  if (!mime || !encoded.length) {
    throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_INVALID_IMAGE', 400);
  }
  if (encoded.length > Math.ceil(MAX_STAGED_IMAGE_BYTES / 3) * 4) {
    throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_TOO_LARGE', 413);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_STAGED_IMAGE_BYTES) {
    throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_TOO_LARGE', 413);
  }
  if (!bytes.length || bytes.toString('base64') !== encoded) {
    throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_INVALID_IMAGE', 400);
  }
  return { bytes, mime };
}

export async function uploadAPIMartImages({
  imageInputs,
  apiKey,
  baseURL,
  signal,
  timing,
}: {
  imageInputs: string[];
  apiKey: string;
  baseURL: string;
  signal?: AbortSignal;
  timing?: APIMartImageTiming;
}): Promise<string[]> {
  const inputs = imageInputs.map(parseInput);
  const controller = new AbortController();
  const abortHandler = () => controller.abort();
  signal?.addEventListener('abort', abortHandler, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPLOAD_TIMEOUT_MS);
  const uploadSignal = controller.signal;
  const urls: string[] = [];
  try {
    // Finish validation/optimization of the whole batch before the first upload.
    for (const input of inputs) {
      uploadSignal.throwIfAborted();
      if (!input.bytes || input.bytes.length <= MAX_IMAGE_BYTES) {
        continue;
      }
      let optimized: Buffer | null = null;
      if (input.mime === 'image/png') {
        try {
          optimized = await optimizePNGInput(input.bytes, MAX_IMAGE_BYTES, uploadSignal);
        } catch {
          uploadSignal.throwIfAborted();
          throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_INVALID_IMAGE', 400);
        }
      }
      uploadSignal.throwIfAborted();
      if (!optimized) {
        throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_TOO_LARGE', 413);
      }
      input.bytes = optimized;
    }
    for (const [imageIndex, input] of inputs.entries()) {
      uploadSignal.throwIfAborted();
      if (input.url) {
        urls.push(input.url);
        continue;
      }
      const upload = async () => {
        const form = new FormData();
        form.append(
          'file',
          new Blob([new Uint8Array(input.bytes!)], { type: input.mime }),
          `reference.${input.mime!.split('/')[1]}`,
        );
        const response = await fetch(`${baseURL.replace(/\/$/, '')}/uploads/images`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: uploadSignal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 413) {
            throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_TOO_LARGE', 413);
          }
          throw new APIMartInputUploadError('APIMART_INPUT_UPLOAD_HTTP_ERROR', response.status);
        }
        const result: { url?: string } = await response.json();
        uploadSignal.throwIfAborted();
        return imageURL(result?.url || '');
      };
      urls.push(
        timing
          ? await timing.measure('upload', upload, {
              imageIndex,
              imageCount: inputs.length,
              bytes: input.bytes?.length,
            })
          : await upload(),
      );
    }
    return urls;
  } catch (error) {
    if (error instanceof APIMartInputUploadError) {
      throw error;
    }
    let code = 'APIMART_INPUT_UPLOAD_NETWORK_ERROR';
    if (timedOut) {
      code = 'APIMART_INPUT_UPLOAD_TIMEOUT';
    }
    if (signal?.aborted) {
      code = 'APIMART_INPUT_UPLOAD_ABORTED';
    }
    throw new APIMartInputUploadError(code);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortHandler);
  }
}
