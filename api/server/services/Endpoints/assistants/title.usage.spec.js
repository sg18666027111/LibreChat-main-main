const mockCreate = jest.fn(),
  mockAdmit = jest.fn(),
  mockRecord = jest.fn(),
  mockFinish = jest.fn();
jest.mock('./initalize', () => async () => ({
  openai: { chat: { completions: { create: mockCreate } } },
}));
jest.mock('~/models', () => ({ saveConvo: jest.fn() }));
jest.mock('~/cache/getLogStores', () => () => ({ set: jest.fn() }));
jest.mock('~/server/services/UsageDelivery/request', () => ({
  admitModelRun: (...args) => mockAdmit(...args),
  recordUsageForRequest: (...args) => mockRecord(...args),
  finishUsageRun: (...args) => mockFinish(...args),
}));
const addTitle = require('./title');
const req = { user: { id: 'fixture' }, body: {}, config: {} };
const params = { text: 'fixture', responseText: 'fixture', conversationId: 'fixture-conversation' };
beforeEach(() => {
  jest.clearAllMocks();
  mockAdmit.mockReset();
  mockAdmit.mockResolvedValue(jest.fn());
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: 'Fixture title' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  mockRecord.mockResolvedValue({ durableAccepted: true });
});
test('legacy assistant title is refused before provider when usage admission is unavailable', async () => {
  mockAdmit.mockRejectedValue(new Error('full'));
  await addTitle(req, params);
  expect(mockCreate).not.toHaveBeenCalled();
});
test('legacy assistant title captures its actual call exactly once and releases reservation', async () => {
  await addTitle(req, params);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect(mockFinish).toHaveBeenCalledTimes(1);
  expect(mockRecord.mock.calls[0][1]).toMatchObject({
    model: 'gpt-3.5-turbo',
    inputTokens: 3,
    outputTokens: 2,
  });
});
