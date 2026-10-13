const { startVisionCompletion } = require('./vision');
test.each([0, 1, 3])(
  'one paid vision completion is accounted once with %i tool reads',
  async (reads) => {
    const completion = {
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      choices: [{ message: { content: 'fixture' } }],
    };
    const create = jest.fn(async () => completion),
      record = jest.fn(),
      finish = jest.fn();
    const promise = startVisionCompletion({
      req: { user: { id: 'fixture' } },
      model: 'vision-model',
      conversationId: 'conversation',
      messageId: 'message',
      create,
      record,
      finish,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Even zero consumers must capture the paid result; repeated reads do not repeat accounting.
    expect(record).toHaveBeenCalledTimes(1);
    for (let index = 0; index < reads; index++) expect(await promise).toBe(completion);
    expect(create).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].usageEventId).toBe('vision_analysis:conversation:message');
  },
);
test('failed provider releases its reservation without inventing usage', async () => {
  const record = jest.fn(),
    finish = jest.fn();
  await expect(
    startVisionCompletion({
      req: {},
      messageId: 'm',
      create: async () => {
        throw new Error('provider');
      },
      record,
      finish,
    }),
  ).rejects.toThrow('provider');
  expect(record).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledTimes(1);
});
