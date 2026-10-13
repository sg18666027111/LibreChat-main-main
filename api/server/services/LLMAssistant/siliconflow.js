const { logger } = require('@librechat/data-schemas');

const SILICONFLOW_CHAT_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 2400;

function getTimeoutMs() {
  const value = Number.parseInt(process.env.SILICONFLOW_CHAT_TIMEOUT_MS || '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function extractContent(json) {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

async function generateChatCompletion({
  model,
  messages,
  requestId,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    const error = new Error('SILICONFLOW_API_KEY is not configured');
    error.statusCode = 500;
    error.code = 'SILICONFLOW_API_KEY_MISSING';
    throw error;
  }

  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(SILICONFLOW_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
        ...(model === 'zai-org/GLM-5.3' ? { reasoning_effort: 'low' } : {}),
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!response.ok) {
      const message = json?.error?.message || json?.message || '大模型请求失败，请稍后重试。';
      const error = new Error(message);
      error.statusCode = response.status;
      if (response.status === 401 || response.status === 403) {
        error.code = 'SILICONFLOW_AUTH_FAILED';
      }
      throw error;
    }

    const content = extractContent(json);
    if (!content) {
      const error = new Error('大模型未返回有效内容，请稍后重试。');
      error.statusCode = 502;
      error.code = 'LLM_ASSISTANT_EMPTY_RESPONSE';
      error.providerUsage = json?.usage ?? null;
      throw error;
    }

    logger.info('[LLMAssistant] chat completion ok', {
      requestId,
      provider: 'siliconflow',
      outputLength: content.length,
    });

    return {
      text: content,
      usage: json?.usage ?? null,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('大模型响应超时，请稍后重试或更换模型。');
      timeoutError.statusCode = 504;
      timeoutError.code = 'LLM_ASSISTANT_TIMEOUT';
      timeoutError.providerSubmitted = true;
      throw timeoutError;
    }
    error.providerSubmitted = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  generateChatCompletion,
};
