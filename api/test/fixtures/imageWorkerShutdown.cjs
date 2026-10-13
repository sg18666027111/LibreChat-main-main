/* Isolated real-process shutdown fixture. No production config or network access. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createServer } = require('node:http');
const [mode, journal] = process.argv.slice(2);
assert.ok(['complete', 'deadline', 'promises-only'].includes(mode));
assert.equal(process.env.MONGO_URI, undefined);
const emit = (event, data = {}) =>
  fs.appendFileSync(journal, `${JSON.stringify({ event, at: Date.now(), ...data })}\n`);
const blocked = () => {
  throw new Error('External I/O is forbidden in shutdown fixture');
};
global.fetch = blocked;
for (const transport of ['node:http', 'node:https']) {
  require(transport).request = blocked;
  require(transport).get = blocked;
}
const apiRoot = path.resolve(__dirname, '../..');
const serviceRoot = path.join(apiRoot, 'server/services/ImageGeneration');
const replacements = new Map([
  ['~/models', {}],
  ['~/server/services/UsageLedgerService', { recordImageUsage: blocked }],
  [
    '@librechat/data-schemas',
    {
      logger: Object.fromEntries(
        ['info', 'warn', 'error', 'debug'].map((level) => [
          level,
          (...args) => emit('log', { level, args }),
        ]),
      ),
    },
  ],
]);
for (const name of [
  'adapters/fal',
  'adapters/apimart',
  'adapters/apimart/common',
  'resultProxy',
  'imageEgressInputStorage',
  'imageEgressOutputStorage',
  'apimartImg2InputStorage',
]) {
  replacements.set(path.join(serviceRoot, name), {});
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (replacements.has(request)) return replacements.get(request);
  let resolved = request;
  if (request.startsWith('~/')) {
    resolved = path.join(apiRoot, request.slice(2));
  } else if (request.startsWith('.')) {
    resolved = path.resolve(path.dirname(parent.filename), request);
  }
  if (replacements.has(resolved)) return replacements.get(resolved);
  return originalLoad.call(this, resolved, parent, isMain);
};

// Compile only the real coordinator source; avoid unrelated package startup timers.
const ts = require('typescript');
const sourcePath = path.resolve(apiRoot, '../packages/api/src/app/shutdown.ts');
const coordinator = new Module(sourcePath, module);
coordinator.filename = sourcePath;
coordinator.paths = module.paths;
coordinator._compile(
  ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  sourcePath,
);
const { registerShutdownDrain, registerShutdownTask, setupGracefulShutdown } = coordinator.exports;
const metricsSourcePath = path.resolve(apiRoot, '../packages/api/src/app/imageMetrics.ts');
const metricsModule = new Module(metricsSourcePath, module);
metricsModule.filename = metricsSourcePath;
metricsModule.paths = module.paths;
metricsModule._compile(
  ts.transpileModule(fs.readFileSync(metricsSourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  metricsSourcePath,
);
replacements.set('@librechat/api', metricsModule.exports);
const apimart = require(path.join(serviceRoot, 'apimartImg2Async'));
const egress = require(path.join(serviceRoot, 'imageEgressAsync'));
const { createImageEgressJobWorker } = require(path.join(serviceRoot, 'imageEgressJobWorker'));
let acceptProvider;
const providerResponse = new Promise((resolve) => {
  acceptProvider = resolve;
});
const never = new Promise(() => {});
let ready;
const started = new Promise((resolve) => {
  ready = resolve;
});
const state = {
  internalTaskId: 'shutdown-test',
  userId: 'test-user',
  provider: 'fal',
  model: 'openai/gpt-image-2',
  status: 'waiting',
  payload: {},
  rolloutMode: 'all',
};
const snapshot = () => ({ ...state });
const worker = createImageEgressJobWorker({
  workerId: 'isolated-shutdown-worker',
  rolloutModes: ['all'],
  jobStore: {
    claimNextJob: async () => {
      emit('claim');
      return snapshot();
    },
    getJob: async () => snapshot(),
    updateJob: async ({ updates }) => {
      Object.assign(state, updates);
      emit('persist', { status: state.status, providerTaskId: state.providerTaskId });
      return snapshot();
    },
    heartbeatJobClaim: async () => snapshot(),
    releaseJobClaim: async () => {
      emit('release-job');
    },
  },
  slotStore: {
    acquireSlot: async () => ({ leaseId: 'slot' }),
    heartbeatSlot: async () => ({ leaseId: 'slot' }),
    releaseSlot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      emit('release-slot');
    },
  },
  adapters: {
    'fal:openai/gpt-image-2': {
      submit: async () => {
        emit('submit');
        ready();
        return providerResponse;
      },
    },
  },
  inputStorage: { resolve: async () => ({}), cleanup: async () => {} },
  outputStorage: {},
  recordUsage: async () => {},
});
const controller = egress.startImageEgressWorker({
  env: { IMAGE_EGRESS_ASYNC_MODE: 'all' },
  intervalMs: 60_000,
  deps: {
    createWorker: () => worker,
    initializeStorage: () => {
      if (mode === 'promises-only') {
        ready();
        return never;
      }
    },
  },
});
registerShutdownDrain('apimart-img2', {
  stop: apimart.stopAPIMartImg2JobWorker,
  waitForIdle: apimart.waitForAPIMartImg2JobWorker,
});
registerShutdownDrain('image-egress', {
  stop: egress.stopImageEgressWorker,
  waitForIdle: egress.waitForImageEgressWorker,
});
registerShutdownTask('test-cleanup', () => emit('cleanup'));
setupGracefulShutdown(createServer(), { timeoutMs: mode === 'complete' ? 3000 : 350 });
const keepAlive = setInterval(() => {}, 10_000);
process.on('SIGTERM', () => {
  emit('signal');
  clearInterval(keepAlive);
  process.disconnect();
  egress.scheduleImageEgressJobRun({ IMAGE_EGRESS_ASYNC_MODE: 'all' });
  process.env.NODE_ENV = 'production';
  process.env.APIMART_IMG2_ASYNC_MODE = 'all';
  apimart.scheduleAPIMartImg2JobRun();
  emit('restart-blocked', {
    apimart: apimart.startAPIMartImg2JobWorker() === null,
    egress: egress.startImageEgressWorker({ env: { IMAGE_EGRESS_ASYNC_MODE: 'all' } }) === null,
  });
  if (mode === 'complete') {
    setTimeout(() => acceptProvider({ providerTaskId: 'accepted-before-shutdown' }), 100);
  }
});
process.on('exit', (code) => emit('exit', { code, status: state.status }));
void controller.runTick();
void started.then(() => process.send({ ready: true }));
