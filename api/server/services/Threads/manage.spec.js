jest.mock('@librechat/api', () => ({
  countTokens: jest.fn(async () => 0),
}));

jest.mock('@librechat/data-schemas', () => ({
  escapeRegExp: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  Constants: { NO_PARENT: '00000000-0000-0000-0000-000000000000' },
  ContentTypes: {},
  AnnotationTypes: {},
  defaultOrderQuery: {},
}));

jest.mock('~/models', () => ({
  getMessages: jest.fn(),
  recordUsageEvent: jest.fn(async () => ({})),
  recordMessage: jest.fn(),
  saveConvo: jest.fn(),
  spendTokens: jest.fn(async () => {}),
}));

jest.mock('~/server/services/Files/process', () => ({
  retrieveAndProcessFile: jest.fn(),
}));

const { recordUsage } = require('./manage');
const { recordUsageEvent: recordAIUsageEvent, spendTokens } = require('~/models');

describe('Threads usage accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps legacy token spending while suppressing the transaction mirror when a stable usage event is written', async () => {
    await recordUsage({
      prompt_tokens: 100,
      completion_tokens: 25,
      model: 'gpt-5-mini',
      user: '64f000000000000000000001',
      conversationId: 'conversation-1',
      usageEventId: 'assistant-run-1',
      messageId: 'message-1',
      provider: 'openai',
      businessType: 'chat',
    });

    expect(spendTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        user: '64f000000000000000000001',
        model: 'gpt-5-mini',
        context: 'message',
        conversationId: 'conversation-1',
        skipUsageLedger: true,
      }),
      { promptTokens: 100, completionTokens: 25 },
    );
    expect(recordAIUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordAIUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        usageEventId: 'assistant-run-1',
        inputTokens: 100,
        outputTokens: 25,
        messageId: 'message-1',
      }),
    );
  });

  it('waits for capture and preserves its canonical envelope on both token transactions', async () => {
    let accept;
    recordAIUsageEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const pending = recordUsage({
      user: '64f000000000000000000001',
      model: 'fixture',
      usageEventId: 'vision:canonical',
      messageId: 'message',
      prompt_tokens: 10,
      completion_tokens: 2,
      businessType: 'vision_analysis',
    });
    expect(spendTokens).not.toHaveBeenCalled();
    const envelope = { revision: 3, event: { usageEventId: 'vision:canonical' } };
    accept({ durableAccepted: true, ledgerPersisted: false, envelope });
    await pending;
    expect(spendTokens).toHaveBeenCalledTimes(1);
    expect(spendTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        skipUsageLedger: true,
        usageEventId: 'vision:canonical',
        usageDelivery: { state: 'durable', revision: 3, envelope },
      }),
      { promptTokens: 10, completionTokens: 2 },
    );
  });

  it('continues to mirror legacy token transactions when no stable usage event is available', async () => {
    await recordUsage({
      prompt_tokens: 5,
      completion_tokens: 3,
      model: 'legacy-model',
      user: '64f000000000000000000002',
      conversationId: 'conversation-legacy',
    });

    expect(spendTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-legacy',
        skipUsageLedger: false,
      }),
      { promptTokens: 5, completionTokens: 3 },
    );
    expect(recordAIUsageEvent).not.toHaveBeenCalled();
  });
});
