const { performance } = require('node:perf_hooks');

/** Shared, bounded, read-only check of the application's existing Mongo connection. */
function createReadinessCheck({ connection, isStarted }) {
  const timeoutMs = 1000;
  const cacheMs = 2000;
  const events = ['connected', 'connecting', 'disconnected', 'disconnecting'];
  let stopped = false;
  let epoch = 0;
  let cached;
  let pending;

  const eligible = () => !stopped && isStarted() && connection.readyState === 1 && !!connection.db;

  function invalidate() {
    epoch++;
    cached = undefined;
    if (pending) {
      pending.finish(false);
      pending.controller.abort();
    }
  }
  for (const event of events) connection.on(event, invalidate);

  function isReady() {
    if (!eligible()) {
      invalidate();
      return Promise.resolve(false);
    }
    // Keep ownership until the driver settles, even after our response deadline.
    // A stalled driver must not spawn an unbounded number of background probes.
    if (pending) return pending.response;
    if (cached && performance.now() < cached.until) return Promise.resolve(cached.ready);

    const generation = epoch;
    const controller = new AbortController();
    let resolveResponse;
    let finished = false;
    let timer;
    const entry = {
      controller,
      response: new Promise((resolve) => {
        resolveResponse = resolve;
      }),
      finish(ready) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const valid = generation === epoch && eligible();
        const result = valid && ready;
        if (valid) cached = { ready: result, until: performance.now() + cacheMs };
        resolveResponse(result);
      },
    };
    pending = entry;
    timer = setTimeout(() => {
      entry.finish(false);
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return { ok: 0 };
        return connection.db.command(
          { ping: 1 },
          { timeoutMS: timeoutMs, readPreference: 'primary', signal: controller.signal },
        );
      })
      .then(
        (result) => entry.finish(result?.ok === 1),
        () => entry.finish(false),
      )
      .finally(() => {
        if (pending === entry) pending = undefined;
      });
    return entry.response;
  }

  return {
    isReady,
    stop() {
      stopped = true;
      invalidate();
      for (const event of events) connection.off(event, invalidate);
    },
    async waitForIdle() {
      await pending?.response;
    },
  };
}

module.exports = { createReadinessCheck };
