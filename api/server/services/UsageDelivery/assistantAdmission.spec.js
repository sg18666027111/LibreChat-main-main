jest.mock('./request', () => ({ admitModelRun: jest.fn() }));
jest.mock('~/server/services/Files/process', () => ({ retrieveAndProcessFile: jest.fn() }));
jest.mock('~/server/services/ToolService', () => ({ processRequiredActions: jest.fn() }));
jest.mock('~/server/services/Threads', () => ({ processMessages: jest.fn() }));
jest.mock('~/server/utils', () => ({ createOnProgress: jest.fn() }));
jest.mock('~/cache/getLogStores', () => jest.fn());
jest.mock('../Runs/RunManager', () => jest.fn());
const { admitModelRun } = require('./request');
const { admissionError } = require('./admission');
const { createRun } = require('../Runs/handle');
const StreamRunManager = require('../Runs/StreamRunManager');
test.each(['create', 'stream'])(
  'remote assistant %s awaits admission before contacting its provider',
  async (mode) => {
    let reject;
    admitModelRun.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const submit = jest.fn();
    const req = {
      user: { id: '507f1f77bcf86cd799439011' },
      body: { endpoint: 'assistants', model: 'gpt-4o' },
    };
    const openai = { beta: { threads: { runs: { create: submit, createAndStream: submit } } } };
    const body = { model: 'gpt-4o', assistant_id: 'fixture' };
    const pending =
      mode === 'create'
        ? createRun({ openai, thread_id: 'thread', body, req, usageKey: 'message' })
        : StreamRunManager.prototype.runAssistant.call(
            { openai, req, finalMessage: { messageId: 'message' } },
            { thread_id: 'thread', body },
          );
    expect(submit).not.toHaveBeenCalled();
    reject(admissionError());
    await expect(pending).rejects.toMatchObject({ statusCode: 503 });
    expect(submit).not.toHaveBeenCalled();
  },
);
