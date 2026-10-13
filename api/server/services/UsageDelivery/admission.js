const { MAX_EVENT_BYTES, RETENTION_MS } = require('./contract');
function admissionError() {
  return Object.assign(new Error('暂时无法开始新任务，请稍后再试'), {
    code: 'USAGE_CAPTURE_UNAVAILABLE',
    statusCode: 503,
    status: 503,
  });
}
function createUsageAdmission({ isEnabled, getService, now = Date.now }) {
  async function admitUsage({ key, maxEvents, expiresAt, scope = 'source' }) {
    if (!isEnabled()) return null;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1024)
      throw admissionError();
    try {
      const reservation = await getService().reserve({
        key,
        scope,
        bytes: maxEvents * MAX_EVENT_BYTES,
        expiresAt,
      });
      if (reservation.remainingBytes < maxEvents * MAX_EVENT_BYTES) throw admissionError();
      return reservation;
    } catch {
      throw admissionError();
    }
  }
  async function prepareUsageContext({
    source,
    sourceKey,
    event,
    maxEvents,
    reservationScope = 'source',
  }) {
    if (!isEnabled()) return null;
    const startedAt = now();
    const occurredAt = new Date(startedAt).toISOString();
    const expiresAt = new Date(startedAt + RETENTION_MS).toISOString();
    try {
      const service = getService();
      const reportingSubjectId = await service.resolveSubject(event.userId);
      const pricing = await service.resolvePricing({ ...event, occurredAt: new Date(occurredAt) });
      const reservation = await admitUsage({
        key: event.usageEventId,
        maxEvents,
        expiresAt,
        scope: reservationScope,
      });
      return {
        source,
        sourceKey,
        eventId: event.usageEventId,
        occurredAt,
        expiresAt,
        reportingSubjectId,
        pricing,
        reservationId: reservation.id,
      };
    } catch {
      throw admissionError();
    }
  }
  async function checkUsageContext(context, maxEvents = 1) {
    if (!isEnabled()) return;
    if (!context || Date.parse(context.expiresAt) <= now()) throw admissionError();
    await admitUsage({ key: context.reservationId, maxEvents, expiresAt: context.expiresAt });
  }
  async function releaseUsage(context) {
    if (!context?.reservationId || !isEnabled()) return;
    try {
      await getService().release(context.reservationId);
    } catch {
      /* Recovery retains a visible reservation. */
    }
  }
  return { admitUsage, prepareUsageContext, checkUsageContext, releaseUsage };
}
module.exports = { createUsageAdmission, admissionError };
