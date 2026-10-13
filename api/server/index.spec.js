const fs = require('fs');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { EventEmitter } = require('events');
const {
  closeTestServer: closeOwnedTestServer,
  createServerLifecycleHarness,
  getProcessListenerDelta,
  removeAddedProcessListeners,
  restoreEnv,
  runAfterStartupSettles,
  snapshotEnv,
  snapshotProcessListeners,
} = require('../test/serverLifecycleHarness');

const testPaths = {
  root: '/tmp',
  uploads: '/tmp/uploads',
  clientPath: '/tmp/client',
  dist: '/tmp/dist',
  publicPath: '/tmp/public',
  fonts: '/tmp/fonts',
  assets: '/tmp/assets',
  imageOutput: '/tmp/images',
  structuredTools: '/tmp/tools',
};
let mockMongoUriAtDbImport;

jest.mock('~/config/paths', () => testPaths);

jest.mock('~/server/services/Config', () => ({
  loadCustomConfig: jest.fn(() => Promise.resolve({})),
  getAppConfig: jest.fn().mockResolvedValue({
    paths: {
      uploads: '/tmp',
      dist: '/tmp/dist',
      fonts: '/tmp/fonts',
      assets: '/tmp/assets',
    },
    fileStrategy: 'local',
    imageOutputType: 'PNG',
  }),
  setCachedTools: jest.fn(),
}));

jest.mock('~/app/clients/tools', () => ({
  createOpenAIImageTools: jest.fn(() => []),
  createYouTubeTools: jest.fn(() => []),
  manifestToolMap: {},
  toolkits: [],
}));

jest.mock('~/config', () => ({
  createMCPServersRegistry: jest.fn(),
  createMCPManager: jest.fn().mockResolvedValue({
    getAppToolFunctions: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock('~/db', () => {
  mockMongoUriAtDbImport = process.env.MONGO_URI;
  return {
    ...jest.requireActual('~/db'),
    indexSync: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  getRoleByName: jest.fn().mockResolvedValue(null),
  seedDatabase: jest.fn().mockResolvedValue(undefined),
  sweepOrphanedPreviews: jest.fn().mockResolvedValue(0),
  updateAccessPermissions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  setupGracefulShutdown: jest.fn(jest.requireActual('@librechat/api').setupGracefulShutdown),
  registerShutdownDrain: jest.fn(jest.requireActual('@librechat/api').registerShutdownDrain),
  performStartupChecks: jest.fn().mockResolvedValue(undefined),
  updateInterfacePermissions: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./services/initializeMCPs', () => jest.fn().mockResolvedValue(undefined));
jest.mock('./services/initializeOAuthReconnectManager', () =>
  jest.fn().mockResolvedValue(undefined),
);
jest.mock('./services/start/migration', () => ({
  checkMigrations: jest.fn().mockResolvedValue(undefined),
}));

jest.mock(
  '@librechat/api/telemetry',
  () => ({
    initializeTelemetry: jest.fn(() => ({
      enabled: false,
      status: 'disabled',
      shutdown: jest.fn(),
    })),
    telemetryMiddleware: jest.fn((_req, _res, next) => next()),
    telemetryErrorMiddleware: jest.fn((err, _req, _res, next) => next(err)),
  }),
  { virtual: true },
);

describe('server lifecycle harness contracts', () => {
  it('waits for startup settlement before teardown begins', async () => {
    let settleStartup;
    const startup = new Promise((resolve) => {
      settleStartup = resolve;
    });
    const teardown = jest.fn();

    const teardownPromise = runAfterStartupSettles(startup, teardown);
    await Promise.resolve();

    expect(teardown).not.toHaveBeenCalled();
    settleStartup();
    await teardownPromise;
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('closes an owned server even when its listening flag is false', async () => {
    const server = {
      listening: false,
      close: jest.fn((callback) => callback()),
    };

    await closeOwnedTestServer({ locals: { server } });

    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('restores exact present env values and deletes originally absent values', () => {
    const env = { MONGO_URI: 'mongodb://original', PORT: '3080' };
    const snapshot = snapshotEnv(env, ['MONGO_URI', 'PORT', 'METRICS_SECRET']);
    env.MONGO_URI = 'mongodb://test';
    env.PORT = '0';
    env.METRICS_SECRET = 'test-secret';

    restoreEnv(env, snapshot);

    expect(env).toEqual({ MONGO_URI: 'mongodb://original', PORT: '3080' });
  });

  it('removes only process listeners added after the ownership snapshot', () => {
    const emitter = new EventEmitter();
    const existingListener = jest.fn();
    const ownedListener = jest.fn();
    emitter.on('SIGTERM', existingListener);
    const snapshot = snapshotProcessListeners(emitter, ['SIGTERM']);
    emitter.on('SIGTERM', ownedListener);
    emitter.on('SIGTERM', ownedListener);

    removeAddedProcessListeners(emitter, snapshot);

    expect(emitter.rawListeners('SIGTERM')).toEqual([existingListener]);
    expect(getProcessListenerDelta(emitter, snapshot)).toBe(0);
  });

  it('rejects startup when /readyz remains NOT_READY', async () => {
    const mongoServer = {
      getUri: () => 'mongodb://127.0.0.1:27017/not-ready',
      stop: jest.fn().mockResolvedValue(undefined),
    };
    const isolatedMongoose = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const lifecycle = createServerLifecycleHarness({
      createMongoServer: () => mongoServer,
      express,
      jestObject: jest,
      loadApi: () => ({}),
      loadServer: () => {
        const notReadyApp = express();
        notReadyApp.get('/readyz', (_req, res) => res.status(503).send('NOT_READY'));
        notReadyApp.locals.server = notReadyApp.listen(0, () => undefined);
        return notReadyApp;
      },
      mongoose: isolatedMongoose,
    });

    try {
      await expect(lifecycle.start()).rejects.toThrow('503 NOT_READY');
    } finally {
      await lifecycle.stop();
    }
  });
});

describe('Telemetry wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  it('loads telemetry before other server imports', () => {
    const firstStatement = source
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);

    expect(firstStatement).toBe("const telemetry = require('./telemetry');");
  });

  it('mounts telemetry middleware after static assets and before routes', () => {
    const telemetryMiddlewareIndex = source.indexOf('app.use(telemetry.telemetryMiddleware);');
    const staticAssetsIndex = source.indexOf('app.use(staticCache(appConfig.paths.assets));');
    const apiRoutesIndex = source.indexOf("app.use('/api/auth'");

    expect(telemetryMiddlewareIndex).toBeGreaterThan(-1);
    expect(staticAssetsIndex).toBeGreaterThan(-1);
    expect(apiRoutesIndex).toBeGreaterThan(-1);
    expect(staticAssetsIndex).toBeLessThan(telemetryMiddlewareIndex);
    expect(telemetryMiddlewareIndex).toBeLessThan(apiRoutesIndex);
  });

  it('mounts telemetry error middleware before ErrorController', () => {
    const telemetryErrorMiddlewareIndex = source.indexOf(
      'app.use(telemetry.telemetryErrorMiddleware);',
    );
    const errorControllerIndex = source.indexOf('app.use(ErrorController);');

    expect(telemetryErrorMiddlewareIndex).toBeGreaterThan(-1);
    expect(errorControllerIndex).toBeGreaterThan(-1);
    expect(telemetryErrorMiddlewareIndex).toBeLessThan(errorControllerIndex);
  });

  it('does not start the daily usage scheduler in Jest', () => {
    const testGuardIndex = source.indexOf("process.env.NODE_ENV !== 'test'");
    const jestGuardIndex = source.indexOf('!process.env.JEST_WORKER_ID');
    const schedulerStartIndex = source.indexOf('startUsageReportScheduler();');

    expect(testGuardIndex).toBeGreaterThan(-1);
    expect(jestGuardIndex).toBeGreaterThan(-1);
    expect(schedulerStartIndex).toBeGreaterThan(-1);
    expect(testGuardIndex).toBeLessThan(schedulerStartIndex);
    expect(jestGuardIndex).toBeLessThan(schedulerStartIndex);
  });
});

describe('Server Configuration', () => {
  // Increase the default timeout to allow for Mongo cleanup
  jest.setTimeout(30_000);

  let app;
  let lifecycle;
  let shutdownRegistrations;
  let shutdownSetup;

  /** Mocked fs.readFileSync for index.html */
  const originalReadFileSync = fs.readFileSync;
  beforeAll(() => {
    fs.readFileSync = function (filepath, options) {
      if (filepath.includes('index.html')) {
        return '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>';
      }
      return originalReadFileSync(filepath, options);
    };
  });

  beforeAll(async () => {
    // Create the required directories and files for the test
    const fs = require('fs');
    const path = require('path');

    const dirs = ['/tmp/dist', '/tmp/fonts', '/tmp/assets', '/tmp/images'];
    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    fs.writeFileSync(
      path.join('/tmp/dist', 'index.html'),
      '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>',
    );
    fs.writeFileSync(
      path.join('/tmp/images', 'existing.png'),
      Buffer.from('89504e470d0a1a0a', 'hex'),
    );

    lifecycle = createServerLifecycleHarness({
      createMongoServer: () => MongoMemoryServer.create(),
      express,
      jestObject: jest,
      loadApi: () => require('@librechat/api'),
      loadServer: () => require('~/server'),
      mongoose,
    });
    app = await lifecycle.start();
    const api = require('@librechat/api');
    shutdownRegistrations = api.registerShutdownDrain.mock.calls.slice();
    shutdownSetup = api.setupGracefulShutdown.mock.calls.slice();
  });

  afterAll(async () => {
    try {
      await lifecycle?.stop();
      const report = lifecycle?.getReport();
      assert.equal(report?.mongoUriSetBeforeServerImport, true);
      assert.equal(mockMongoUriAtDbImport, report?.testMongoUri);
      assert.equal(report?.startupSettledBeforeTestExecution, true);
      assert.equal(report?.startupSettledBeforeMongoTeardown, true);
      assert.equal(report?.mongoPortClosedWhileConnectPending, false);
      assert.equal(report?.serverCloseCalled, 1);
      assert.equal(report?.envRestorationPass, true);
      assert.equal(report?.listenerDelta, 0);
      assert.equal(report?.moduleStateRestorationPass, true);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });

  it('should return OK for /health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');
  });

  it('registers both image workers and a 25 second total shutdown budget', () => {
    const apimart = require('./services/ImageGeneration/apimartImg2Async');
    const egress = require('./services/ImageGeneration/imageEgressAsync');
    expect(shutdownRegistrations).toContainEqual([
      'apimart-img2',
      {
        stop: apimart.stopAPIMartImg2JobWorker,
        waitForIdle: apimart.waitForAPIMartImg2JobWorker,
      },
    ]);
    expect(shutdownRegistrations).toContainEqual([
      'image-egress',
      {
        stop: egress.stopImageEgressWorker,
        waitForIdle: egress.waitForImageEgressWorker,
      },
    ]);
    expect(shutdownSetup).toContainEqual([app.locals.server, { timeoutMs: 25_000 }]);
  });

  it('should return OK for /readyz after the startup fence settles', async () => {
    const response = await request(app).get('/readyz');
    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports Mongo disconnect after startup and recovers without restarting the app', async () => {
    const uri = lifecycle.getReport().testMongoUri;
    try {
      await mongoose.disconnect();
      const unavailable = await request(app).get('/readyz');
      expect(unavailable.status).toBe(503);
      expect(unavailable.text).toBe('NOT_READY');
      expect((await request(app).get('/livez')).status).toBe(200);
      expect((await request(app).get('/health')).status).toBe(200);
    } finally {
      await mongoose.connect(uri, { bufferCommands: false });
    }
    expect((await request(app).get('/readyz')).status).toBe(200);
  });

  it('should not cache index page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers['pragma']).toBe('no-cache');
    expect(response.headers['expires']).toBe('0');
  });

  it('should return 404 JSON for undefined API routes', async () => {
    const response = await request(app).get('/api/nonexistent');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for nested undefined API routes', async () => {
    const response = await request(app).get('/api/nonexistent/nested/path');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for non-GET methods on undefined API routes', async () => {
    const post = await request(app).post('/api/nonexistent');
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ message: 'Endpoint not found' });

    const del = await request(app).delete('/api/nonexistent');
    expect(del.status).toBe(404);
    expect(del.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for the /api root path', async () => {
    const response = await request(app).get('/api');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should serve SPA HTML for non-API unmatched routes', async () => {
    const response = await request(app).get('/this/does/not/exist');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/html/);
  });

  it('should serve existing /images files as images', async () => {
    const response = await request(app).get('/images/existing.png');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/image\/png/);
    expect(response.body.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('should return 404 for missing /images files instead of SPA HTML', async () => {
    const response = await request(app).get('/images/missing.png');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).not.toMatch(/html/);
    expect(response.text).not.toContain('<title>LibreChat</title>');
  });

  it('should return 500 for unknown errors via ErrorController', async () => {
    // Testing the error handling here on top of unit tests to ensure the middleware is correctly integrated

    // Mock MongoDB operations to fail
    const originalFindOne = mongoose.models.User.findOne;
    const mockError = new Error('MongoDB operation failed');
    mongoose.models.User.findOne = jest.fn().mockImplementation(() => {
      throw mockError;
    });

    try {
      const response = await request(app).post('/api/auth/login').send({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(500);
      expect(response.text).toBe('An unknown error occurred.');
    } finally {
      // Restore original function
      mongoose.models.User.findOne = originalFindOne;
    }
  });

  it('withdraws readiness when the existing shutdown drain starts', async () => {
    const readinessDrain = shutdownRegistrations.find(([name]) => name === 'readiness');
    expect(readinessDrain).toBeDefined();
    readinessDrain[1].stop();
    expect((await request(app).get('/readyz')).status).toBe(503);
    expect((await request(app).get('/livez')).status).toBe(200);
  });
});
