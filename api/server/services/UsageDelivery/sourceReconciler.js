const { validateEnvelope, RETENTION_MS } = require('./contract');
const SOURCES = ['image', 'batch', 'transaction'];
const finiteDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Only frozen usage evidence enters capture; no provider, balance, or price lookup dependencies. */
async function reconcileUsageSources({
  after = null,
  limit = 100,
  mode,
  cutover,
  readPage,
  readLedger,
  capture,
  acknowledge,
  pruneExpiredPayload,
  now = Date.now,
  onEvent = () => {},
  stopped = () => false,
}) {
  if (
    !['new', 'dry-run'].includes(mode) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (mode === 'new' && !finiteDate(cutover))
  )
    throw new Error('Invalid reconciliation options');
  const page = await readPage({ after, limit });
  if (!Array.isArray(page.items) || page.items.length > limit)
    throw new Error('Invalid source page');
  const ids = [
    ...new Set(
      page.items
        .map((item) => item.envelope?.event?.usageEventId || item.eventId)
        .filter((id) => typeof id === 'string' && id.length <= 512),
    ),
  ];
  const ledger = new Map(
    (ids.length ? await readLedger(ids) : []).map((row) => [row.usageEventId, row]),
  );
  const counts = { missing: 0, existing: 0, insufficient_evidence: 0, out_of_retention: 0 };
  const details = [];
  for (const item of page.items) {
    if (stopped()) break;
    const checked = validateEnvelope(item.envelope);
    const envelope = checked.ok ? checked.envelope : null;
    const existing = ledger.get(envelope?.event.usageEventId || item.eventId);
    const occurredAt = envelope?.occurredAt || item.createdAt;
    const expired = envelope
      ? Date.parse(envelope.expiresAt) <= now()
      : Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) <= now() - RETENTION_MS;
    const exact =
      checked.ok &&
      existing?.deliveryRevision === envelope.revision &&
      existing.deliveryDigest === checked.digest;
    const newer =
      checked.ok &&
      existing?.deliveryRevision > envelope.revision &&
      existing.reportingSubjectId === envelope.reportingSubjectId &&
      existing.provider === envelope.event.provider &&
      existing.model === envelope.event.model &&
      existing.businessType === envelope.event.businessType &&
      (existing.tenantId || null) === (envelope.event.tenantId || null);
    let category = 'missing';
    if (expired) category = 'out_of_retention';
    else if (existing && (mode === 'dry-run' || exact || newer)) category = 'existing';
    else if (!envelope || envelope.pricing.kind === 'missing') category = 'insufficient_evidence';
    counts[category]++;
    // Internal source IDs only; never output prompts, image URLs, credentials, or user identities.
    let reason = category === 'existing' ? 'ledger_exists' : 'ledger_missing';
    if (expired) reason = 'outside_retention';
    else if (!envelope) reason = 'original_evidence_missing';
    else if (envelope.pricing.kind === 'missing') reason = 'original_pricing_missing';
    const evidence = envelope?.event || item.knownCounts || {};
    const knownCounts = Object.fromEntries(
      ['inputTokens', 'outputTokens', 'imageCount']
        .filter((field) => Number.isSafeInteger(evidence[field]) && evidence[field] >= 0)
        .map((field) => [field, evidence[field]]),
    );
    details.push({ source: item.source, id: String(item.id), category, reason, knownCounts });
    if (mode === 'dry-run') continue;
    if (!envelope || Date.parse(envelope.occurredAt) < Date.parse(cutover)) {
      if (!envelope) onEvent('failure', 'invalid');
      continue;
    }
    try {
      await pruneExpiredPayload?.(item, now());
      const review = expired || envelope.pricing.kind === 'missing';
      if ((exact || newer) && !expired) {
        await acknowledge(item, review ? 'review' : 'persisted');
      } else {
        // Expired evidence is retained privately for review; worker never recreates expired ledger rows.
        const result = await capture(envelope, item);
        if (result?.durableAccepted === true) {
          let state = result.ledgerPersisted ? 'persisted' : 'durable';
          if (review) state = 'review';
          await acknowledge(item, state);
        } else onEvent('failure', result?.reason || 'unavailable');
      }
    } catch {
      onEvent('failure', 'unavailable');
    }
  }
  return { cursor: page.cursor, counts, details };
}

function createSourceReconciler({
  store,
  capture,
  cutover,
  recoverReservations,
  onEvent = () => {},
  now = Date.now,
}) {
  const cursors = new Map();
  let running,
    timer,
    stopped = false;
  function runOnce() {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      for (const source of SOURCES) {
        if (stopped) break;
        const result = await reconcileUsageSources({
          mode: 'new',
          cutover,
          after: cursors.get(source) || null,
          limit: 100,
          now,
          readPage: ({ after, limit }) =>
            store.readPage({ source, after, limit, mode: 'new', cutover }),
          readLedger: store.readLedger,
          capture,
          acknowledge: store.acknowledge,
          pruneExpiredPayload: store.pruneExpiredPayload,
          onEvent,
          stopped: () => stopped,
        });
        cursors.set(source, result.cursor);
      }
      if (!stopped) await recoverReservations?.();
    })()
      .catch(() => onEvent('failure', 'reconcile'))
      .finally(() => {
        running = null;
      });
    return running;
  }
  function start() {
    if (!timer && !stopped) {
      timer = setInterval(() => {
        void runOnce();
      }, 30000);
      timer.unref();
      void runOnce();
    }
  }
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  async function drain() {
    stop();
    if (running) await running;
  }
  return { start, stop, drain, runOnce };
}
module.exports = { reconcileUsageSources, createSourceReconciler, SOURCES };
