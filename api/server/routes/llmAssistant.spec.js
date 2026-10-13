const express = require('express');
const request = require('supertest');

const mockGenerateChatCompletion = jest.fn();
const mockRecordAIUsageEvent = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1', email: 'user@example.com' };
    next();
  },
}));

jest.mock('~/server/services/LLMAssistant/siliconflow', () => ({
  generateChatCompletion: (...args) => mockGenerateChatCompletion(...args),
}));

jest.mock('~/models', () => ({
  recordUsageEvent: (...args) => mockRecordAIUsageEvent(...args),
  withUsageRequest: (_identity, work) => work({}),
  withUsageScope: (_scope, work) => work(),
  admitUsageRun: jest.fn(),
  finishUsageRun: jest.fn(),
}));

const llmAssistantRoutes = require('./llmAssistant');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/llm-assistant', llmAssistantRoutes);
  return app;
}

describe('llmAssistant usage ledger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordAIUsageEvent.mockResolvedValue({});
  });

  it.each(
    ['chat', 'analyze'].flatMap((route) =>
      ['glm_5_1', 'kimi_k2_6'].map((modelKey) => [route, modelKey]),
    ),
  )(
    'rejects retired model on /%s (%s) without submitting to SiliconFlow',
    async (route, modelKey) => {
      mockGenerateChatCompletion.mockResolvedValue({ text: 'ok', usage: {} });
      const response = await request(createApp())
        .post(`/api/llm-assistant/${route}`)
        .send({
          modelKey,
          prompt: 'analyze this text',
          messages: [{ role: 'user', content: 'hello' }],
        });

      expect(response.status).toBe(400);
      expect(response.body.errorCode).toBe('MODEL_NOT_AVAILABLE');
      expect(mockGenerateChatCompletion).not.toHaveBeenCalled();
      expect(mockRecordAIUsageEvent).not.toHaveBeenCalled();
    },
  );

  it('offers GLM for new assistant conversations without the retired Kimi option', async () => {
    const response = await request(createApp()).get('/api/llm-assistant/config');
    expect(response.status).toBe(200);
    expect(response.body.defaultModelKey).toBe('deepseek_v4_pro');
    expect(response.body.models.find((m) => m.key === 'glm_5_3')).toEqual(
      expect.objectContaining({
        name: 'GLM 5.3',
        enabled: true,
        capabilities: ['text', 'reasoning', 'long-context'],
      }),
    );
    expect(response.body.models.some((m) => m.key === 'kimi_k2_6')).toBe(false);
  });

  it('uses GLM identity for new requests and their usage records', async () => {
    mockGenerateChatCompletion.mockResolvedValue({
      text: 'summary',
      usage: { prompt_tokens: 100, completion_tokens: 25 },
    });
    const response = await request(createApp())
      .post('/api/llm-assistant/chat')
      .send({
        modelKey: 'glm_5_3',
        messages: [{ role: 'user', content: 'summarize the synthetic plan' }],
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({ text: 'summary', modelKey: 'glm_5_3' }),
    );
    expect(mockGenerateChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'zai-org/GLM-5.3' }),
    );
    expect(mockRecordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'zai-org/GLM-5.3',
        modelKey: 'glm_5_3',
        provider: 'siliconflow',
        inputTokens: 100,
        outputTokens: 25,
      }),
    );
  });

  it('records chat usage without storing message content in metadata', async () => {
    mockGenerateChatCompletion.mockResolvedValue({
      text: 'ok',
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    });

    const response = await request(createApp())
      .post('/api/llm-assistant/chat')
      .send({
        modelKey: 'deepseek_v4_pro',
        messages: [{ role: 'user', content: 'secret customer plan' }],
      });

    expect(response.status).toBe(200);
    expect(mockRecordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        businessType: 'chat',
        provider: 'siliconflow',
        model: 'deepseek-ai/DeepSeek-V4-Pro',
        status: 'succeeded',
        inputTokens: 12,
        outputTokens: 7,
        requestCount: 1,
      }),
    );
    expect(JSON.stringify(mockRecordAIUsageEvent.mock.calls[0][0].metadata)).not.toContain(
      'secret customer plan',
    );
  });

  it('records analyze usage as vision_analysis', async () => {
    mockGenerateChatCompletion.mockResolvedValue({
      text: 'analysis',
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    });

    const response = await request(createApp())
      .post('/api/llm-assistant/analyze')
      .send({ modelKey: 'glm_5_3', prompt: 'describe image text' });

    expect(response.status).toBe(200);
    expect(mockRecordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessType: 'vision_analysis',
        model: 'zai-org/GLM-5.3',
        modelKey: 'glm_5_3',
        status: 'succeeded',
        inputTokens: 20,
        outputTokens: 8,
      }),
    );
  });

  it('records submitted timeouts as status_unknown', async () => {
    const error = new Error('timeout');
    error.code = 'LLM_ASSISTANT_TIMEOUT';
    error.statusCode = 504;
    error.providerSubmitted = true;
    mockGenerateChatCompletion.mockRejectedValue(error);

    const response = await request(createApp())
      .post('/api/llm-assistant/chat')
      .send({
        modelKey: 'deepseek_v4_pro',
        messages: [{ role: 'user', content: 'hello' }],
      });

    expect(response.status).toBe(504);
    expect(mockRecordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessType: 'chat',
        status: 'status_unknown',
        requestCount: 1,
      }),
    );
  });
});

describe('paid assistant admission', () => {
  let previous;
  beforeEach(() => {
    previous = process.env.USAGE_DELIVERY_MODE;
    process.env.USAGE_DELIVERY_MODE = 'journal';
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (previous == null) delete process.env.USAGE_DELIVERY_MODE;
    else process.env.USAGE_DELIVERY_MODE = previous;
  });
  it.each(['chat', 'analyze'])(
    'returns 503 without provider submission on /%s when capture is unavailable',
    async (route) => {
      require('~/models').admitUsageRun.mockRejectedValue(
        require('~/server/services/UsageDelivery/admission').admissionError(),
      );
      const response = await request(createApp())
        .post(`/api/llm-assistant/${route}`)
        .send({
          modelKey: 'glm_5_3',
          prompt: 'fixture',
          messages: [{ role: 'user', content: 'fixture' }],
        });
      expect(response.status).toBe(503);
      expect(mockGenerateChatCompletion).not.toHaveBeenCalled();
      expect((await request(createApp()).get('/api/llm-assistant/config')).status).toBe(200);
    },
  );
});
