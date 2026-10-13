const { validateEnvelope } = require('./contract');
const { createUsageDeliveryWorker, anonymousEnvelope } = require('./worker');

function createUsageDeliveryService({
  journal,
  persist,
  sealExpired,
  resolvePricing,
  resolveSubject,
  now = Date.now,
  onEvent = () => {},
}) {
  const subjects = new Map();
  let stopped = false;
  let draining;
  function withSubject(subject, fn) {
    const previous = subjects.get(subject) || Promise.resolve();
    const work = previous.then(fn);
    const tail = work.then(
      () => {},
      () => {},
    );
    subjects.set(subject, tail);
    void tail.then(() => {
      if (subjects.get(subject) === tail) subjects.delete(subject);
    });
    return work;
  }
  const worker = createUsageDeliveryWorker({ journal, persist, now, onEvent, withSubject });
  async function capture(envelope, reservationId) {
    if (stopped) return { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable' };
    const result = await journal.append(envelope, reservationId);
    if (!result.durableAccepted) onEvent('failure', result.reason);
    return result;
  }
  async function withDeletedSubject(subject, anonymize) {
    return withSubject(subject, async () => {
      await journal.tombstone(subject);
      let cursor = null;
      do {
        const page = await journal.listSubjectEnvelopes(subject, cursor, 100);
        for (const envelope of page.items) {
          const checked = validateEnvelope(envelope);
          if (!checked.ok)
            throw Object.assign(new Error('Usage deletion requires review'), {
              code: 'USAGE_INVALID',
            });
          if (Date.parse(envelope.expiresAt) <= now()) {
            if (!sealExpired)
              throw Object.assign(new Error('Identity sealing unavailable'), {
                code: 'USAGE_UNCONFIRMED',
              });
            await sealExpired(anonymousEnvelope(envelope));
            continue;
          }
          // Seal the key before anonymization, including a delayed old writer's first insert.
          const result = await persist(anonymousEnvelope(envelope), checked.digest);
          if (result?.persisted !== true)
            throw Object.assign(new Error('Usage unconfirmed'), { code: 'USAGE_UNCONFIRMED' });
        }
        cursor = page.cursor;
      } while (cursor);
      return anonymize();
    });
  }
  function stop() {
    stopped = true;
    worker.stop();
  }
  function drain() {
    if (!draining)
      draining = (async () => {
        stop();
        // Leave the remaining five seconds for journal RPC close within the eight-second budget.
        await worker.drain(3000);
        await journal.close();
      })();
    return draining;
  }
  return {
    capture,
    withDeletedSubject,
    resolvePricing,
    resolveSubject,
    reserve: (input) => {
      if (stopped)
        return Promise.reject(
          Object.assign(new Error('Usage admission stopped'), {
            code: 'USAGE_JOURNAL_UNAVAILABLE',
          }),
        );
      return journal.reserve(input);
    },
    release: (id) => journal.release(id),
    stats: () => journal.stats(),
    runOnce: worker.runOnce,
    start: worker.start,
    stop,
    drain,
    waitForIdle: drain,
  };
}
module.exports = { createUsageDeliveryService };
