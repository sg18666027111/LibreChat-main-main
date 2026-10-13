const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');
const { addUsageModelGuard } = require('@librechat/api');
const { admitModelRun, recordUsageForRequest } = require('./request');
function guardMemoryUsage(options, { req, messageId, conversationId }) {
  if (!process.env.USAGE_DELIVERY_MODE || process.env.USAGE_DELIVERY_MODE === 'off') return options;
  const identity = { provider: options.provider, model: options.model, businessType: 'other' };
  const before = async (actual) => {
    const guard = await admitModelRun({
      req,
      key: `${messageId}:memory`,
      models: [actual],
      maxCalls: 6,
    });
    await guard(actual);
  };
  class MemoryUsageHandler extends BaseCallbackHandler {
    name = 'memory_usage_capture';
    constructor(actual) {
      super({ _awaitHandler: true });
      this.identity = actual;
    }
    async handleLLMEnd(output, runId) {
      const usage =
        output.generations?.[0]?.[0]?.message?.usage_metadata || output.llmOutput?.tokenUsage;
      if (!usage) return;
      await recordUsageForRequest(req, {
        usageEventId: `other:${conversationId}:${messageId}:memory:${runId}`,
        userId: req.user.id,
        conversationId,
        messageId,
        ...this.identity,
        status: 'succeeded',
        inputTokens: usage.input_tokens ?? usage.promptTokens ?? 0,
        outputTokens: usage.output_tokens ?? usage.completionTokens ?? 0,
        metadata: { usageContext: 'memory' },
      });
    }
  }
  const guarded = addUsageModelGuard(options, identity, before);
  function attachCapture(config, actual) {
    const handler = new MemoryUsageHandler(actual);
    if (Array.isArray(config.callbacks)) config.callbacks.push(handler);
    else config.callbacks.addHandler(handler, true);
    for (const fallback of config.fallbacks || []) {
      attachCapture(fallback.clientOptions, {
        provider: fallback.provider,
        model: fallback.clientOptions.model || fallback.clientOptions.modelName || actual.model,
        businessType: 'other',
      });
    }
    return config;
  }
  return attachCapture(guarded, identity);
}
module.exports = { guardMemoryUsage };
