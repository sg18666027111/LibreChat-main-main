const { Writable, PassThrough } = require('node:stream');
const { once } = require('node:events');

// Only external boundaries and unrelated upload services are replaced. The real
// router and processDeleteRequest are composed here; no database is connected.
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
  SystemCapabilities: {},
}));
jest.mock('@librechat/api', () => ({}));
jest.mock('~/server/services/Files/images', () => ({}));
jest.mock('~/server/controllers/assistants/v2', () => ({}));
jest.mock('~/server/controllers/assistants/helpers', () => ({ getOpenAIClient: jest.fn() }));
jest.mock('~/server/services/Tools/credentials', () => ({}));
jest.mock('~/server/utils/getFileStrategy', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/utils/queue', () => ({}));
jest.mock('~/server/utils', () => ({}));
jest.mock('~/server/services/Files/Audio/STTService', () => ({}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/middleware/accessResources/fileAccess', () => ({
  fileAccess: (_req, _res, next) => next(),
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: () => (_req, _res, next) => next(),
}));
jest.mock('~/server/services/PermissionService', () => ({}));
jest.mock('~/server/services/Files', () => ({ hasAccessToFilesViaAgent: jest.fn() }));
jest.mock('~/cache', () => ({}));
jest.mock('~/models', () => ({
  getFiles: jest.fn(),
  deleteFiles: jest.fn(),
  removeAgentResourceFiles: jest.fn(),
  removeAgentResourceFilesFromAllAgents: jest.fn(),
}));

const db = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { hasAccessToFilesViaAgent } = require('~/server/services/Files');
const router = require('./files');
const handler = (method, route) =>
  router.stack
    .find((layer) => layer.route?.path === route && layer.route.methods[method])
    .route.stack.at(-1).handle;
const files = [
  {
    file_id: 'a1111111-1111-4111-8111-111111111111',
    filepath: '/a',
    user: 'owner',
    source: 'local',
    filename: 'a.png',
  },
  {
    file_id: 'b2222222-2222-4222-8222-222222222222',
    filepath: '/b',
    user: 'owner',
    source: 'local',
    filename: 'b.png',
  },
];
const jsonResponse = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

class DownloadResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
    this.chunks = [];
  }
  _write(chunk, _encoding, done) {
    this.headersSent = true;
    this.chunks.push(chunk.toString());
    done();
  }
  setHeader(name, value) {
    this.headers[name] = value;
  }
  removeHeader(name) {
    delete this.headers[name];
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  send(body) {
    this.end(body);
    return this;
  }
}

beforeEach(() => jest.resetAllMocks());

describe('DELETE route and storage service result contract', () => {
  it.each([false, true])(
    'reports partial failure and retains failed metadata (agent access: %s)',
    async (viaAgent) => {
      const records = new Map(
        files.map((file) => [
          file.file_id,
          { ...file, user: viaAgent ? 'another-owner' : 'owner' },
        ]),
      );
      db.getFiles.mockImplementation(async () => [...records.values()]);
      db.deleteFiles.mockImplementation(async (ids) => ids.forEach((id) => records.delete(id)));
      hasAccessToFilesViaAgent.mockResolvedValue(
        new Map(files.map((file) => [file.file_id, true])),
      );
      getStrategyFunctions.mockReturnValue({
        deleteFile: async (_req, file) => {
          if (file.file_id === files[1].file_id) {
            throw new Error('storage unavailable');
          }
        },
      });
      const res = jsonResponse();
      await handler('delete', '/')(
        {
          body: { files, ...(viaAgent ? { agent_id: 'agent' } : {}) },
          user: { id: 'owner' },
          config: {},
        },
        res,
      );
      expect(res.statusCode).toBe(207);
      expect(res.body).toMatchObject({
        deletedFileIds: [files[0].file_id],
        failedFileIds: [files[1].file_id],
      });
      expect([...records.keys()]).toEqual([files[1].file_id]);
    },
  );
  it('keeps failed files linked to their agent so they can be retried', async () => {
    const links = new Set(files.map((file) => file.file_id));
    db.getFiles.mockResolvedValue(files);
    db.removeAgentResourceFiles.mockImplementation(async ({ files: removed }) =>
      removed.forEach((file) => links.delete(file.file_id)),
    );
    db.removeAgentResourceFilesFromAllAgents.mockImplementation(async ({ file_ids }) =>
      file_ids.forEach((id) => links.delete(id)),
    );
    getStrategyFunctions.mockReturnValue({
      deleteFile: async (_req, file) => {
        if (file.file_id === files[1].file_id) {
          throw new Error('storage unavailable');
        }
      },
    });
    const res = jsonResponse();
    await handler('delete', '/')(
      {
        body: { files, agent_id: 'agent', tool_resource: 'file_search' },
        user: { id: 'owner' },
        config: {},
      },
      res,
    );
    expect([...links]).toEqual([files[1].file_id]);
  });
  it('acknowledges already deleted IDs when retrying after a lost success response', async () => {
    const records = new Map(files.map((file) => [file.file_id, file]));
    db.getFiles.mockImplementation(async () => [...records.values()]);
    db.deleteFiles.mockImplementation(async (ids) => ids.forEach((id) => records.delete(id)));
    getStrategyFunctions.mockReturnValue({ deleteFile: async () => {} });
    const req = { body: { files }, user: { id: 'owner' }, config: {} };
    await handler('delete', '/')(req, jsonResponse());
    const retry = jsonResponse();
    await handler('delete', '/')(req, retry);
    expect(retry.statusCode).toBe(200);
    expect(retry.body.deletedFileIds).toEqual(files.map((file) => file.file_id));
    expect(retry.body.failedFileIds).toEqual([]);
  });
  it('does not acknowledge missing IDs before denying access to an existing unowned file', async () => {
    db.getFiles.mockResolvedValue([{ ...files[0], user: 'another-owner' }]);
    const res = jsonResponse();
    await handler('delete', '/')({ body: { files }, user: { id: 'owner' }, config: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.unauthorizedFiles).toEqual([files[0].file_id]);
    expect(res.body.deletedFileIds).toBeUndefined();
  });
  it('returns a failure status when every storage deletion fails', async () => {
    db.getFiles.mockResolvedValue(files);
    getStrategyFunctions.mockReturnValue({
      deleteFile: async () => {
        throw new Error('storage unavailable');
      },
    });
    const res = jsonResponse();
    await handler('delete', '/')({ body: { files }, user: { id: 'owner' }, config: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({
      deletedFileIds: [],
      failedFileIds: files.map((file) => file.file_id),
    });
  });
});

describe('download stream lifecycle', () => {
  const download = handler('get', '/download/:userId/:file_id');
  const req = () => ({
    params: { userId: 'owner', file_id: files[0].file_id },
    fileAccess: { file: files[0] },
    query: {},
  });
  it('ends with HTTP 500 when a stream fails before headers are sent', async () => {
    const stream = new PassThrough();
    const res = new DownloadResponse();
    getStrategyFunctions.mockReturnValue({ getDownloadStream: async () => stream });
    await download(req(), res);
    stream.destroy(new Error('missing file'));
    await new Promise(setImmediate);
    expect(res.writableEnded).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.headers['Content-Disposition']).toBeUndefined();
    expect(res.chunks.join('')).toBe('Error downloading file');
    res.destroy();
  });
  it('destroys the response when a stream fails after partial bytes', async () => {
    const stream = new PassThrough();
    const res = new DownloadResponse();
    getStrategyFunctions.mockReturnValue({ getDownloadStream: async () => stream });
    await download(req(), res);
    stream.write('partial');
    stream.destroy(new Error('read failed'));
    await new Promise(setImmediate);
    expect(res.destroyed).toBe(true);
    expect(res.chunks.join('')).toBe('partial');
    res.destroy();
  });
  it('destroys the source when the client disconnects', async () => {
    const stream = new PassThrough();
    const res = new DownloadResponse();
    getStrategyFunctions.mockReturnValue({ getDownloadStream: async () => stream });
    await download(req(), res);
    res.destroy();
    await new Promise(setImmediate);
    expect(stream.destroyed).toBe(true);
    stream.destroy();
  });
  it('ends normally on a successful stream', async () => {
    const stream = new PassThrough();
    const res = new DownloadResponse();
    getStrategyFunctions.mockReturnValue({ getDownloadStream: async () => stream });
    await download(req(), res);
    const finished = once(res, 'finish');
    stream.end('complete file');
    await finished;
    expect(res.chunks.join('')).toBe('complete file');
    expect(res.statusCode).toBe(200);
  });
});
