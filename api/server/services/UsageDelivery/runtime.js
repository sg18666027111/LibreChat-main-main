const { logger } = require('@librechat/data-schemas');
const { recoverReservations } = require('./reservationRecovery');
const { openUsageJournal } = require('./journal');
const { createSourceReconciler } = require('./sourceReconciler');
const { createUsageDeliveryService } = require('./service');

const JOURNAL_ERROR_CODES = new Set([
  'USAGE_WRITER_FENCED',
  'USAGE_WRITER_BUSY',
  'USAGE_FULL',
  'USAGE_INVALID',
  'USAGE_PRIVATE_PATH_REQUIRED',
  'USAGE_SCHEMA_UNSUPPORTED',
  'USAGE_JOURNAL_UNAVAILABLE',
]);
function logJournalFailure(error, phase) {
  const code = JOURNAL_ERROR_CODES.has(error?.code) ? error.code : 'USAGE_JOURNAL_UNAVAILABLE';
  logger.warn(`[UsageDelivery] Journal unavailable phase=${phase} code=${code}`);
}

function unavailable() {
  return Object.assign(new Error('Usage capture unavailable'), {
    code: 'USAGE_JOURNAL_UNAVAILABLE',
  });
}
/** Composition state only; constructing it opens no files and starts no workers. */
function createUsageDeliveryRuntime({
  env = process.env,
  persist,
  sealExpired,
  resolvePricing,
  resolveSubject,
  onEvent = () => {},
  onStats = () => {},
  createSourceStore,
  drainTimeoutMs = 8000,
}) {
  let service;
  let initializing;
  const enabled = () => Boolean(env.USAGE_DELIVERY_MODE && env.USAGE_DELIVERY_MODE !== 'off');
  const get = () => {
    if (!service) throw unavailable();
    return service;
  };
  async function initialize() {
    if (!enabled()) return null;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        if (env.USAGE_DELIVERY_MODE !== 'journal') throw unavailable();
        const cutover = env.USAGE_DELIVERY_CUTOVER_AT;
        if (
          !cutover ||
          !Number.isFinite(Date.parse(cutover)) ||
          new Date(cutover).toISOString() !== cutover
        )
          throw unavailable();
        const journal = await openUsageJournal({
          directory: env.USAGE_DELIVERY_DIR || '/app/var/usage-delivery',
          maxPendingBytes: Number(env.USAGE_DELIVERY_MAX_PENDING_BYTES ?? 268435456),
          maxEventBytes: Number(env.USAGE_DELIVERY_MAX_EVENT_BYTES ?? 32768),
        });
        service = createUsageDeliveryService({
          journal,
          persist,
          sealExpired,
          resolvePricing,
          resolveSubject,
          onEvent,
        });
        const sourceStore = createSourceStore?.();
        let reservationCursor = null;
        const sourceReconciler = sourceStore
          ? createSourceReconciler({
              store: sourceStore,
              recoverReservations: async () => {
                reservationCursor = await recoverReservations({
                  journal,
                  store: sourceStore,
                  after: reservationCursor,
                });
              },
              cutover,
              onEvent,
              capture: async (envelope, source) => {
                let result = await service.capture(envelope, source.reservationId);
                if (!result.durableAccepted && result.reason === 'full' && source.reservationId)
                  result = await service.capture(envelope);
                if (
                  result.durableAccepted &&
                  source.reservationId &&
                  envelope.event.status !== 'submitted'
                )
                  await service.release(source.reservationId);
                return result;
              },
            })
          : null;
        let sampling;
        let journalUnavailable = false;
        const sample = () => {
          if (sampling) return sampling;
          sampling = service
            .stats()
            .then((stats) => {
              onStats(stats);
              if (journalUnavailable && stats.writable) {
                logger.info('[UsageDelivery] Journal writable again');
                journalUnavailable = false;
              }
            })
            .catch((error) => {
              journalUnavailable = true;
              logJournalFailure(error, 'sample');
              onStats({ writable: false });
              onEvent('failure', 'journal');
            })
            .finally(() => {
              sampling = null;
            });
          return sampling;
        };
        const timer = setInterval(() => {
          void sample();
        }, 30000);
        timer.unref();
        const stopService = service.stop,
          drainService = service.drain;
        service.stop = () => {
          clearInterval(timer);
          sourceReconciler?.stop();
          stopService();
        };
        let draining;
        service.drain = () => {
          if (draining) return draining;
          service.stop();
          draining = (async () => {
            let timeout;
            try {
              await Promise.race([
                Promise.all([sourceReconciler?.drain(), sampling, drainService()]),
                new Promise((resolve) => {
                  timeout = setTimeout(resolve, drainTimeoutMs);
                }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
          })();
          return draining;
        };
        service.waitForIdle = service.drain;
        service.reconcileSourcesOnce = () => sourceReconciler?.runOnce();
        service.start();
        await sample();
        sourceReconciler?.start();
        return service;
      } catch (error) {
        logJournalFailure(error, 'initialize');
        if (service) {
          await service.drain();
          service = undefined;
        }
        onStats({ writable: false });
        onEvent('failure', 'journal');
        return null;
      }
    })();
    return initializing;
  }
  return {
    enabled,
    initialize,
    get,
    capture: async (envelope, reservationId) => {
      if (!service)
        return { durableAccepted: false, ledgerPersisted: false, reason: 'unavailable' };
      return service.capture(envelope, reservationId);
    },
    withDeletedSubject: async (subject, anonymize) =>
      enabled() ? get().withDeletedSubject(subject, anonymize) : anonymize(),
    stop: () => service?.stop(),
    drain: async () => {
      if (service) await service.drain();
    },
  };
}
module.exports = { createUsageDeliveryRuntime };
