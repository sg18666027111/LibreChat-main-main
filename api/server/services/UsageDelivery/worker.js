const { validateEnvelope } = require('./contract');
const QUARANTINE = {
  USAGE_INVALID: 'invalid',
  USAGE_EXPIRED: 'expired',
  USAGE_REVISION_CONFLICT: 'conflict',
  USAGE_LEGACY_CONFLICT: 'legacy',
  USAGE_IDENTITY_CONFLICT: 'identity',
};
function anonymousEnvelope(envelope) {
  return { ...envelope, event: { ...envelope.event, userId: null } };
}

/** Dependencies intentionally exclude provider APIs, transactions and balances. */
function createUsageDeliveryWorker({
  journal,
  persist,
  now = Date.now,
  random = Math.random,
  withSubject = (_subject, fn) => fn(),
  onEvent = () => {},
}) {
  let running;
  let timer;
  let stopped = false;
  async function deliver(claim) {
    try {
      await withSubject(claim.envelope.reportingSubjectId, async () => {
        const checked = validateEnvelope(claim.envelope);
        if (!checked.ok || checked.digest !== claim.digest) {
          await journal.quarantine(claim, 'invalid');
          onEvent('quarantined', 'invalid');
          return;
        }
        if (Date.parse(claim.envelope.expiresAt) <= now()) {
          await journal.quarantine(claim, 'expired');
          onEvent('quarantined', 'expired');
          return;
        }
        const deleted = await journal.isDeletedSubject(claim.envelope.reportingSubjectId);
        const envelope = deleted ? anonymousEnvelope(claim.envelope) : claim.envelope;
        const result = await persist(envelope, claim.digest);
        if (result?.persisted !== true)
          throw Object.assign(new Error('Usage unconfirmed'), { code: 'USAGE_UNCONFIRMED' });
        if (envelope.pricing.kind === 'missing') {
          await journal.quarantine(claim, 'pricing');
          onEvent('quarantined', 'pricing');
          return;
        }
        await journal.ack(claim);
        onEvent('recovered');
      });
    } catch (error) {
      const reason = QUARANTINE[error.code];
      try {
        if (reason) {
          await journal.quarantine(claim, reason);
          onEvent('quarantined', reason);
        } else {
          const delay =
            Math.min(300000, 1000 * 2 ** Math.min(20, Math.max(0, claim.attempts - 1))) *
            (0.8 + 0.4 * random());
          await journal.retry(claim, now() + Math.round(delay), 'unavailable');
          onEvent('failure', 'unavailable');
        }
      } catch {
        onEvent('failure', 'journal'); /* An unacknowledged lease is recovered on the next start. */
      }
    }
  }
  function runOnce() {
    if (stopped) return Promise.resolve(0);
    if (running) return running;
    running = (async () => {
      const claims = await journal.claim(20);
      let next = 0;
      await Promise.all(
        [0, 1].map(async () => {
          while (next < claims.length && !stopped) {
            const claim = claims[next++];
            await deliver(claim);
          }
        }),
      );
      return claims.length;
    })()
      .catch(() => {
        onEvent('failure', 'journal');
        return 0;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }
  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void runOnce();
    }, 5000);
    timer.unref();
    void runOnce();
  }
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  async function drain(timeoutMs = 8000) {
    stop();
    if (!running) return;
    let timeout;
    try {
      await Promise.race([
        running,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
  return { runOnce, start, stop, drain };
}
module.exports = { createUsageDeliveryWorker, anonymousEnvelope };
