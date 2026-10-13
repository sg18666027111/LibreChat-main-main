jest.mock('./request', () => ({ admitModelRun: jest.fn(), recordUsageForRequest: jest.fn() }));
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage, HumanMessage } = require('@langchain/core/messages');
const { guardMemoryUsage } = require('./memoryUsage');
const { admitModelRun, recordUsageForRequest } = require('./request');
class MemoryFixture extends BaseChatModel {
  calls = 0;
  _llmType() {
    return 'fixture';
  }
  async _generate() {
    this.calls++;
    return {
      generations: [
        {
          text: 'ok',
          message: new AIMessage({
            content: 'ok',
            usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          }),
        },
      ],
    };
  }
}
const req = { user: { id: '507f1f77bcf86cd799439011' } };
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
test('background memory is admitted before each call and completion waits for durable usage', async () => {
  const begin = jest.fn(async () => {});
  admitModelRun.mockResolvedValue(begin);
  let accept;
  recordUsageForRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  );
  const model = new MemoryFixture(
    guardMemoryUsage(
      { provider: 'fixture', model: 'memory-model' },
      { req, messageId: 'message', conversationId: 'conversation' },
    ),
  );
  let finished = false;
  const pending = model.invoke([new HumanMessage('private input')], { callbacks: [] }).then(() => {
    finished = true;
  });
  while (!accept) await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  expect(begin).toHaveBeenCalledWith({
    provider: 'fixture',
    model: 'memory-model',
    businessType: 'other',
  });
  expect(recordUsageForRequest).toHaveBeenCalledWith(
    req,
    expect.objectContaining({
      inputTokens: 10,
      outputTokens: 2,
      provider: 'fixture',
      model: 'memory-model',
      metadata: { usageContext: 'memory' },
    }),
  );
  expect(JSON.stringify(recordUsageForRequest.mock.calls)).not.toContain('private input');
  accept({ durableAccepted: true, ledgerPersisted: false });
  await pending;
  expect(model.calls).toBe(1);
});
test('unavailable journal rejects background memory without starting a model', async () => {
  admitModelRun.mockRejectedValue(
    Object.assign(new Error('unavailable'), { code: 'USAGE_CAPTURE_UNAVAILABLE' }),
  );
  const model = new MemoryFixture(
    guardMemoryUsage(
      { provider: 'fixture', model: 'memory-model' },
      { req, messageId: 'message', conversationId: 'conversation' },
    ),
  );
  await expect(model.invoke([new HumanMessage('fixture')])).rejects.toMatchObject({
    code: 'USAGE_CAPTURE_UNAVAILABLE',
  });
  expect(model.calls).toBe(0);
  expect(recordUsageForRequest).not.toHaveBeenCalled();
});
test('memory fallback captures the actual fallback provider and model', async () => {
  admitModelRun.mockResolvedValue(async () => {});
  recordUsageForRequest.mockResolvedValue({ durableAccepted: true, ledgerPersisted: false });
  const options = guardMemoryUsage(
    {
      provider: 'primary',
      model: 'primary-model',
      fallbacks: [{ provider: 'fallback', clientOptions: { model: 'fallback-model' } }],
    },
    { req, messageId: 'message', conversationId: 'conversation' },
  );
  const model = new MemoryFixture(options.fallbacks[0].clientOptions);
  await model.invoke([new HumanMessage('fixture')]);
  expect(recordUsageForRequest).toHaveBeenCalledWith(
    req,
    expect.objectContaining({ provider: 'fallback', model: 'fallback-model', inputTokens: 10 }),
  );
});
