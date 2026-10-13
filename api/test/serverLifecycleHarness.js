const request = require('supertest');

function runAfterStartupSettles(startup, teardown) {
  return Promise.resolve(startup).then(teardown);
}

async function assertServerReadiness(app) {
  const response = await request(app).get('/readyz');
  if (response.status !== 200 || response.text !== 'OK') {
    throw new Error(
      `Server readiness check failed: expected 200 OK, received ${response.status} ${response.text}`,
    );
  }
}

async function closeTestServer(app) {
  const server = app?.locals?.server;
  if (!server?.close) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function snapshotEnv(env, keys) {
  return new Map(
    keys.map((key) => [
      key,
      {
        present: Object.prototype.hasOwnProperty.call(env, key),
        value: env[key],
      },
    ]),
  );
}

function restoreEnv(env, snapshot) {
  for (const [key, original] of snapshot) {
    if (original.present) {
      env[key] = original.value;
    } else {
      delete env[key];
    }
  }
}

function snapshotProcessListeners(emitter, events) {
  return new Map(events.map((event) => [event, emitter.rawListeners(event)]));
}

function getListenerDifference(current, original) {
  const remainingOriginal = [...original];
  const added = [];

  for (const listener of current) {
    const originalIndex = remainingOriginal.indexOf(listener);
    if (originalIndex === -1) {
      added.push(listener);
      continue;
    }
    remainingOriginal.splice(originalIndex, 1);
  }

  return { added, missing: remainingOriginal };
}

function removeAddedProcessListeners(emitter, snapshot) {
  for (const [event, original] of snapshot) {
    const { added } = getListenerDifference(emitter.rawListeners(event), original);
    for (const listener of added) {
      emitter.removeListener(event, listener);
    }
  }
}

function getProcessListenerDelta(emitter, snapshot) {
  let delta = 0;
  for (const [event, original] of snapshot) {
    const { added, missing } = getListenerDifference(emitter.rawListeners(event), original);
    delta += added.length + missing.length;
  }
  return delta;
}

const SERVER_ENV_KEYS = ['MONGO_URI', 'PORT', 'METRICS_SECRET', 'FILE_RETENTION_SWEEP_INTERVAL_MS'];
const SERVER_PROCESS_EVENTS = [
  'exit',
  'uncaughtException',
  'unhandledRejection',
  'SIGINT',
  'SIGTERM',
  'SIGQUIT',
  'SIGHUP',
];

function isEnvRestored(env, snapshot) {
  for (const [key, original] of snapshot) {
    const present = Object.prototype.hasOwnProperty.call(env, key);
    if (present !== original.present || (present && env[key] !== original.value)) {
      return false;
    }
  }
  return true;
}

function createServerLifecycleHarness({
  createMongoServer,
  env = process.env,
  envOverrides = {},
  eventEmitter = process,
  express,
  globalObject = globalThis,
  jestObject,
  loadApi,
  loadServer,
  mongoose,
}) {
  const envKeys = [...new Set([...SERVER_ENV_KEYS, ...Object.keys(envOverrides)])];
  const envSnapshot = snapshotEnv(env, envKeys);
  const listenerSnapshot = snapshotProcessListeners(eventEmitter, SERVER_PROCESS_EVENTS);
  const mongooseCacheSnapshot = {
    present: Object.prototype.hasOwnProperty.call(globalObject, 'mongoose'),
    value: globalObject.mongoose,
  };

  let app;
  let listenSpy;
  let mongoServer;
  let ownedServer;
  let serverImportStarted = false;
  let startupState = 'pending';
  let connectPending = false;
  let startupResolve;
  let startupReject;
  let mongoPortClosedWhileConnectPending = false;
  let mongoUriSetBeforeServerImport = false;
  let startupSettledBeforeMongoTeardown = false;
  let listenerDelta = null;
  let envRestorationPass = false;
  let moduleStateRestorationPass = false;
  let testMongoUri;

  const startupSettled = new Promise((resolve, reject) => {
    startupResolve = resolve;
    startupReject = reject;
  });

  const installListenSpy = () => {
    listenSpy = jestObject.spyOn(express.application, 'listen').mockImplementation((...args) => {
      const callback = args.find((arg) => typeof arg === 'function');
      ownedServer = {
        listening: true,
        close: jestObject.fn((closeCallback) => {
          ownedServer.listening = false;
          closeCallback?.();
        }),
      };

      setImmediate(() => {
        Promise.resolve()
          .then(() => callback?.())
          .then(() => {
            startupState = 'fulfilled';
            startupResolve();
          })
          .catch((error) => {
            startupState = 'rejected';
            startupReject(error);
          });
      });

      return ownedServer;
    });
  };

  const start = async () => {
    mongoServer = await createMongoServer();
    testMongoUri = mongoServer.getUri();
    env.MONGO_URI = testMongoUri;
    env.PORT = '0';
    env.FILE_RETENTION_SWEEP_INTERVAL_MS = '0';
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }

    connectPending = true;
    try {
      await mongoose.connect(env.MONGO_URI, { bufferCommands: false });
    } finally {
      connectPending = false;
    }

    installListenSpy();
    mongoUriSetBeforeServerImport = env.MONGO_URI === testMongoUri;
    serverImportStarted = true;
    app = loadServer();
    await startupSettled;
    await assertServerReadiness(app);
    return app;
  };

  const stop = async () => {
    const cleanupErrors = [];
    let api;
    const cleanupStep = async (step) => {
      try {
        await step();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    try {
      if (serverImportStarted) {
        await cleanupStep(() => runAfterStartupSettles(startupSettled, async () => undefined));
        api = loadApi();
      }
      await cleanupStep(async () => api?.GenerationJobManager?.destroy?.());
      await cleanupStep(() => closeTestServer(app));
      await cleanupStep(() => mongoose.disconnect());
      await cleanupStep(async () => {
        startupSettledBeforeMongoTeardown = startupState !== 'pending';
        mongoPortClosedWhileConnectPending = connectPending || startupState === 'pending';
        await mongoServer?.stop();
      });
    } finally {
      await cleanupStep(async () => api?.__resetShutdownStateForTests?.());
      await cleanupStep(async () => {
        removeAddedProcessListeners(eventEmitter, listenerSnapshot);
        listenerDelta = getProcessListenerDelta(eventEmitter, listenerSnapshot);
      });
      await cleanupStep(async () => {
        if (mongooseCacheSnapshot.present) {
          globalObject.mongoose = mongooseCacheSnapshot.value;
        } else {
          delete globalObject.mongoose;
        }
        moduleStateRestorationPass =
          Object.prototype.hasOwnProperty.call(globalObject, 'mongoose') ===
            mongooseCacheSnapshot.present &&
          (!mongooseCacheSnapshot.present || globalObject.mongoose === mongooseCacheSnapshot.value);
      });
      await cleanupStep(async () => {
        restoreEnv(env, envSnapshot);
        envRestorationPass = isEnvRestored(env, envSnapshot);
      });
      await cleanupStep(async () => listenSpy?.mockRestore());
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Server lifecycle cleanup failed');
    }
  };

  const getReport = () => ({
    envRestorationPass,
    listenerDelta,
    moduleStateRestorationPass,
    mongoPortClosedWhileConnectPending,
    mongoUriSetBeforeServerImport,
    serverCloseCalled: ownedServer?.close?.mock?.calls?.length ?? 0,
    startupSettledBeforeMongoTeardown,
    startupSettledBeforeTestExecution: startupState === 'fulfilled',
    testMongoUri,
  });

  return { getReport, start, stop };
}

module.exports = {
  closeTestServer,
  createServerLifecycleHarness,
  getProcessListenerDelta,
  removeAddedProcessListeners,
  restoreEnv,
  runAfterStartupSettles,
  snapshotEnv,
  snapshotProcessListeners,
};
