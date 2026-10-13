type JSONValue = string | number | boolean | null | ErrorFields | JSONValue[];

interface ErrorFields {
  code?: JSONValue;
  message?: JSONValue;
  error?: JSONValue;
  data?: JSONValue;
  result?: JSONValue;
}

function fields(value: unknown): ErrorFields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function sanitizeAPIMartErrorMessage(value: unknown, apiKey?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const text = apiKey ? value.split(apiKey).join('[redacted]') : value;
  return text
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[base64]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Basic|Bearer)\s+[^\s,;"']+|[^\s,;"']+)/gi,
      '$1=[redacted]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b(prompt|image_urls?|image_inputs?)["']?\s*[:=][\s\S]*/gi, '$1=[redacted]')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, 240);
}

function errorCode(value: JSONValue | undefined, apiKey?: string): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const code = String(value).trim();
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(code) || /^(?:0|2\d\d|ok|success)$/i.test(code)) {
    return null;
  }
  if ((apiKey && code.includes(apiKey)) || /^sk-/i.test(code)) {
    return null;
  }
  return code;
}

/** Extract diagnostics only from known error fields, never serialize a provider response. */
export function parseAPIMartTaskFailure(
  value: unknown,
  apiKey?: string,
): { code: string; message: string } {
  const root = fields(value);
  const data = fields(root.data);
  const result = fields(root.result);
  const candidates = [root.error, data.error, result.error, data, result, root];
  let code: string | null = null;
  let message: string | null = null;
  for (const candidate of candidates) {
    const detail = fields(candidate);
    code ??= errorCode(detail.code, apiKey);
    const text = sanitizeAPIMartErrorMessage(
      typeof candidate === 'string' ? candidate : detail.message,
      apiKey,
    );
    if (
      !message &&
      text &&
      !/^(?:success|ok|successful|succeeded|\[object Object\])$/i.test(text)
    ) {
      message = text;
    }
  }
  return { code: code || 'APIMART_TASK_FAILED', message: message || 'APIMart task failed' };
}
