const fs = require('fs');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { createServerLifecycleHarness } = require('../test/serverLifecycleHarness');

let mockMongoUriAtDbImport;

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

describe('Server metrics route', () => {
  jest.setTimeout(30_000);

  let app;
  let lifecycle;

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
    const fs = require('fs');
    const path = require('path');

    const dirs = ['/tmp/dist', '/tmp/fonts', '/tmp/assets'];
    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    fs.writeFileSync(
      path.join('/tmp/dist', 'index.html'),
      '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>',
    );

    lifecycle = createServerLifecycleHarness({
      createMongoServer: () => MongoMemoryServer.create(),
      envOverrides: { METRICS_SECRET: 'test-secret' },
      express,
      jestObject: jest,
      loadApi: () => require('@librechat/api'),
      loadServer: () => require('~/server'),
      mongoose,
    });
    app = await lifecycle.start();
  });

  afterEach(() => {
    process.env.METRICS_SECRET = 'test-secret';
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

  it('returns 401 at /metrics when METRICS_SECRET is unset', async () => {
    const response = await request(app).get('/metrics');
    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics when no token provided', async () => {
    process.env.METRICS_SECRET = 'test-secret';

    const response = await request(app).get('/metrics');

    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics when wrong token provided', async () => {
    process.env.METRICS_SECRET = 'test-secret';

    const response = await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token');

    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics when the bearer scheme is omitted', async () => {
    process.env.METRICS_SECRET = 'test-secret';

    const response = await request(app).get('/metrics').set('Authorization', 'test-secret');

    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics for non-bearer auth schemes', async () => {
    process.env.METRICS_SECRET = 'test-secret';

    const response = await request(app).get('/metrics').set('Authorization', 'Basic test-secret');

    expect(response.status).toBe(401);
  });

  it('exposes Prometheus metrics at /metrics with correct bearer token', async () => {
    process.env.METRICS_SECRET = 'test-secret';

    const response = await request(app).get('/metrics').set('Authorization', 'Bearer test-secret');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.text).toMatch(/^# HELP /m);
    expect(response.text).toMatch(/^# TYPE /m);
  });

  it('accepts lowercase bearer scheme at /metrics', async () => {
    process.env.METRICS_SECRET = 'test-secret';

    const response = await request(app).get('/metrics').set('Authorization', 'bearer test-secret');

    expect(response.status).toBe(200);
  });
});
