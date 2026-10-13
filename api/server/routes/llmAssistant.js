const {
  usageRequestScope,
  admitModelRun,
  recordUsageForRequest,
  finishUsageRun,
} = require('~/server/services/UsageDelivery/request');
const express = require('express');
const { randomUUID } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const {
  DEFAULT_MODEL_KEY,
  getPublicLLMAssistantModels,
  resolveLLMAssistantModel,
} = require('~/server/services/LLMAssistant/models');
const { generateChatCompletion } = require('~/server/services/LLMAssistant/siliconflow');

const router = express.Router();

const MAX_PROMPT_LENGTH = 20000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_TOTAL_CONTENT_LENGTH = 40000;
const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);
const SYSTEM_PROMPT =
  '你是经济舱 AI 工作台接入的智能助手，请基于用户的问题用中文直接、专业地作答。' +
  '不要冒充或自称其他公司的产品或模型，也不要沿用对话历史中出现过的其它模型身份。';

function createRequestId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

function getSafeErrorSummary(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return message.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 200) || null;
}

function extractUsageTokens(usage) {
  return {
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokens ?? 0,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens ?? 0,
  };
}

async function recordLLMAssistantUsage({
  req,
  resolved,
  requestId,
  businessType,
  status,
  usage,
  metadata,
}) {
  if (!resolved) {
    return;
  }
  const { inputTokens, outputTokens } = extractUsageTokens(usage);
  try {
    await recordUsageForRequest(req, {
      usageEventId: `${businessType}:${requestId}`,
      userId: req.user?.id,
      businessType,
      provider: resolved.provider,
      model: resolved.model,
      modelKey: resolved.key,
      requestId,
      status,
      inputTokens,
      outputTokens,
      requestCount: 1,
      metadata,
    });
    await finishUsageRun(req, requestId);
  } catch (error) {
    logger.error('[LLMAssistant] failed to record usage event', {
      requestId,
      businessType,
      errorMessage: error?.message,
    });
  }
}

function resolveEnabledSiliconflowModel(modelKey) {
  const resolved = resolveLLMAssistantModel(modelKey || DEFAULT_MODEL_KEY);
  if (!resolved || !resolved.enabled || !resolved.model || resolved.provider !== 'siliconflow') {
    return null;
  }
  return resolved;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  const cleaned = messages
    .filter(
      (item) =>
        item &&
        ALLOWED_ROLES.has(item.role) &&
        typeof item.content === 'string' &&
        item.content.trim(),
    )
    .map((item) => ({ role: item.role, content: item.content.trim() }));

  const recent = cleaned.slice(-MAX_HISTORY_MESSAGES);
  let total = 0;
  for (const message of recent) {
    total += message.content.length;
  }
  if (total > MAX_TOTAL_CONTENT_LENGTH) {
    return recent.slice(-Math.max(2, Math.floor(MAX_HISTORY_MESSAGES / 2)));
  }
  return recent;
}

router.use(requireJwtAuth);

router.get('/config', (_req, res) => {
  return res.status(200).json({
    models: getPublicLLMAssistantModels(),
    defaultModelKey: DEFAULT_MODEL_KEY,
  });
});

router.post('/analyze', usageRequestScope, async (req, res) => {
  const requestId = createRequestId();
  let stage = 'route_received';
  let resolved = null;
  const businessType = 'vision_analysis';

  try {
    const { modelKey, prompt } = req.body ?? {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ message: '请先填写需要分析的内容。', requestId });
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        message: '输入内容过长，请精简后重试。',
        errorCode: 'LLM_ASSISTANT_INPUT_TOO_LONG',
        requestId,
      });
    }

    resolved = resolveEnabledSiliconflowModel(modelKey);
    if (!resolved) {
      return res.status(400).json({
        message: '该模型暂未开放，请选择已上线的模型。',
        errorCode: 'MODEL_NOT_AVAILABLE',
        requestId,
      });
    }

    stage = 'provider_start';
    const startedAt = Date.now();
    logger.info('[LLMAssistant] analyze request', {
      requestId,
      stage,
      userId: req.user?.id,
      provider: resolved.provider,
      modelKey: resolved.key,
      promptLength: prompt.length,
    });

    await admitModelRun({
      req,
      key: requestId,
      source: 'assistant',
      models: [{ provider: resolved.provider, model: resolved.model, businessType }],
      maxCalls: 1,
    });
    const completion = await generateChatCompletion({
      model: resolved.model,
      messages: [{ role: 'user', content: prompt.trim() }],
      requestId,
    });
    const { text, usage } = completion;
    stage = 'response_sent';
    const durationMs = Date.now() - startedAt;
    await recordLLMAssistantUsage({
      req,
      resolved,
      requestId,
      businessType,
      status: 'succeeded',
      usage,
      metadata: {
        route: 'analyze',
        promptLength: prompt.trim().length,
        durationMs,
      },
    });

    logger.info('[LLMAssistant] analyze response', {
      requestId,
      stage,
      provider: resolved.provider,
      modelKey: resolved.key,
      durationMs,
      outputLength: text.length,
    });

    return res.status(200).json({ text, modelKey: resolved.key, requestId });
  } catch (error) {
    const errorCode = error.code || error.statusCode || 'LLM_ASSISTANT_FAILED';
    if (error.providerSubmitted) {
      await recordLLMAssistantUsage({
        req,
        resolved,
        requestId,
        businessType,
        status: error.code === 'LLM_ASSISTANT_TIMEOUT' ? 'status_unknown' : 'failed',
        usage: error.providerUsage,
        metadata: {
          route: 'analyze',
          errorCode,
        },
      });
    }
    logger.error('[LLMAssistant] analyze failed', {
      requestId,
      stage: stage === 'provider_start' ? 'provider_failed' : stage,
      statusCode: error?.statusCode || null,
      errorCode,
      errorName: error?.name || null,
      errorSummary: getSafeErrorSummary(error),
    });

    return res.status(error.statusCode || 500).json({
      message: error.message || '分析失败，请稍后重试。',
      errorCode,
      requestId,
    });
  }
});

router.post('/chat', usageRequestScope, async (req, res) => {
  const requestId = createRequestId();
  let stage = 'route_received';
  let resolved = null;
  const businessType = 'chat';

  try {
    const { modelKey, messages } = req.body ?? {};
    const sanitized = sanitizeMessages(messages);

    if (!sanitized.length || sanitized[sanitized.length - 1].role !== 'user') {
      return res.status(400).json({ message: '请先输入要发送的内容。', requestId });
    }

    resolved = resolveEnabledSiliconflowModel(modelKey);
    if (!resolved) {
      return res.status(400).json({
        message: '该模型暂未开放，请选择已上线的模型。',
        errorCode: 'MODEL_NOT_AVAILABLE',
        requestId,
      });
    }

    stage = 'provider_start';
    const startedAt = Date.now();
    logger.info('[LLMAssistant] chat request', {
      requestId,
      stage,
      userId: req.user?.id,
      modelKey: resolved.key,
      provider: resolved.provider,
      resolvedModel: resolved.model,
      messageCount: sanitized.length,
    });

    await admitModelRun({
      req,
      key: requestId,
      source: 'assistant',
      models: [{ provider: resolved.provider, model: resolved.model, businessType }],
      maxCalls: 1,
    });
    const completion = await generateChatCompletion({
      model: resolved.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...sanitized],
      requestId,
    });
    const { text, usage } = completion;
    stage = 'response_sent';
    const durationMs = Date.now() - startedAt;
    await recordLLMAssistantUsage({
      req,
      resolved,
      requestId,
      businessType,
      status: 'succeeded',
      usage,
      metadata: {
        route: 'chat',
        messageCount: sanitized.length,
        durationMs,
      },
    });

    logger.info('[LLMAssistant] chat response', {
      requestId,
      stage,
      provider: resolved.provider,
      modelKey: resolved.key,
      durationMs,
      outputLength: text.length,
    });

    return res.status(200).json({ text, modelKey: resolved.key, requestId });
  } catch (error) {
    const errorCode = error.code || error.statusCode || 'LLM_ASSISTANT_FAILED';
    if (error.providerSubmitted) {
      await recordLLMAssistantUsage({
        req,
        resolved,
        requestId,
        businessType,
        status: error.code === 'LLM_ASSISTANT_TIMEOUT' ? 'status_unknown' : 'failed',
        usage: error.providerUsage,
        metadata: {
          route: 'chat',
          errorCode,
        },
      });
    }
    logger.error('[LLMAssistant] chat failed', {
      requestId,
      stage: stage === 'provider_start' ? 'provider_failed' : stage,
      statusCode: error?.statusCode || null,
      errorCode,
      errorName: error?.name || null,
      errorSummary: getSafeErrorSummary(error),
    });

    return res.status(error.statusCode || 500).json({
      message: error.message || '分析失败，请稍后重试。',
      errorCode,
      requestId,
    });
  }
});

module.exports = router;
