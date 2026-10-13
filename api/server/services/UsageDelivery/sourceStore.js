const { ObjectId } = require('mongodb');
const COLLECTIONS = {
  image: 'imagegenerationjobs',
  batch: 'imagebatchtasks',
  transaction: 'transactions',
};
const PROJECTION = {
  _id: 1,
  updatedAt: 1,
  createdAt: 1,
  usageDelivery: 1,
  usageEventId: 1,
  'usageContext.eventId': 1,
  'usageContext.reservationId': 1,
  tokenType: 1,
  rawAmount: 1,
  inputTokens: 1,
  writeTokens: 1,
  readTokens: 1,
};
function parseCursor(value) {
  if (!value) return null;
  const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (
    !/^[a-f0-9]{24}$/.test(cursor.id) ||
    (cursor.time !== null && !Number.isFinite(Date.parse(cursor.time)))
  )
    throw new Error('Invalid usage cursor');
  return cursor;
}
function createUsageSourceStore(db) {
  async function readPage({ source, after, limit, mode, cutover, since, until }) {
    if (!COLLECTIONS[source] || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid source query');
    const clauses = [];
    if (source === 'transaction') clauses.push({ tokenType: { $in: ['prompt', 'completion'] } });
    if (mode === 'new')
      clauses.push({
        'usageDelivery.state': { $in: ['pending', 'durable'] },
        createdAt: { $gte: new Date(cutover) },
        updatedAt: { $gte: new Date(cutover) },
      });
    else if (mode === 'dry-run')
      clauses.push({ createdAt: { $gte: new Date(since), $lt: new Date(until) } });
    else throw new Error('Invalid source mode');
    const cursor = parseCursor(after);
    if (cursor)
      clauses.push({
        $or:
          cursor.time === null
            ? [
                { updatedAt: null, _id: { $gt: new ObjectId(cursor.id) } },
                { updatedAt: { $type: 'date' } },
              ]
            : [
                { updatedAt: { $gt: new Date(cursor.time) } },
                { updatedAt: new Date(cursor.time), _id: { $gt: new ObjectId(cursor.id) } },
              ],
      });
    const rows = await db
      .collection(COLLECTIONS[source])
      .find({ $and: clauses }, { projection: PROJECTION, maxTimeMS: 5000 })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        source,
        id: row._id.toString(),
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
        envelope: row.usageDelivery?.envelope,
        delivery: row.usageDelivery,
        reservationId: row.usageContext?.reservationId,
        knownCounts:
          source === 'transaction' &&
          (Number.isFinite(row.rawAmount) || Number.isFinite(row.inputTokens))
            ? {
                inputTokens:
                  row.tokenType === 'prompt'
                    ? Math.abs(row.inputTokens || 0) +
                        Math.abs(row.writeTokens || 0) +
                        Math.abs(row.readTokens || 0) || Math.abs(row.rawAmount || 0)
                    : 0,
                outputTokens: row.tokenType === 'completion' ? Math.abs(row.rawAmount || 0) : 0,
              }
            : undefined,
        eventId:
          row.usageEventId ||
          row.usageContext?.eventId ||
          (source === 'transaction' ? `transaction:${row._id}` : undefined),
      })),
      cursor:
        rows.length === limit && last
          ? Buffer.from(
              JSON.stringify({
                time: last.updatedAt?.toISOString() || null,
                id: last._id.toString(),
              }),
            ).toString('base64url')
          : null,
    };
  }
  async function readLedger(ids) {
    if (ids.length > 100) throw new Error('Unbounded ledger lookup');
    return db
      .collection('aiusageevents')
      .find(
        { usageEventId: { $in: ids } },
        {
          maxTimeMS: 5000,
          projection: {
            _id: 0,
            usageEventId: 1,
            deliveryRevision: 1,
            deliveryDigest: 1,
            reportingSubjectId: 1,
            provider: 1,
            model: 1,
            businessType: 1,
            tenantId: 1,
          },
        },
      )
      .toArray();
  }
  async function acknowledge(item, state) {
    if (
      !COLLECTIONS[item.source] ||
      !['durable', 'persisted', 'review'].includes(state) ||
      !item.envelope
    )
      throw new Error('Invalid acknowledgement');
    const updates = { 'usageDelivery.state': state, updatedAt: new Date() };
    if (item.source !== 'transaction') updates.usageRecorded = state === 'persisted';
    const cleanupAfter = item.delivery?.cleanupAfter;
    if (cleanupAfter && Number.isFinite(Date.parse(cleanupAfter)))
      updates.expiresAt = new Date(cleanupAfter);
    return db.collection(COLLECTIONS[item.source]).updateOne(
      {
        _id: new ObjectId(item.id),
        'usageDelivery.revision': item.envelope.revision,
        'usageDelivery.envelope': item.envelope,
        'usageDelivery.state': { $in: ['pending', 'durable'] },
      },
      { $set: updates },
      { maxTimeMS: 5000 },
    );
  }
  async function pruneExpiredPayload(item, timestamp = Date.now()) {
    const cleanupAfter = item.delivery?.cleanupAfter;
    if (
      item.source === 'transaction' ||
      !COLLECTIONS[item.source] ||
      typeof cleanupAfter !== 'string' ||
      !Number.isFinite(Date.parse(cleanupAfter)) ||
      Date.parse(cleanupAfter) > timestamp
    )
      return;
    await db.collection(COLLECTIONS[item.source]).updateOne(
      {
        _id: new ObjectId(item.id),
        status: { $in: ['succeeded', 'failed', 'cancelled', 'status_unknown'] },
        'usageDelivery.envelope': item.envelope,
        'usageDelivery.cleanupAfter': cleanupAfter,
        'usageDelivery.state': { $in: ['pending', 'durable'] },
        'usageDelivery.payloadPruned': { $ne: true },
      },
      {
        $set: { 'usageDelivery.payloadPruned': true },
        $unset: {
          payload: 1,
          result: 1,
          providerMetadata: 1,
          providerResult: 1,
          resultImage: 1,
          prompt: 1,
          title: 1,
          templateName: 1,
          error: 1,
        },
      },
      { maxTimeMS: 5000 },
    );
  }
  async function readReservationOwners(ids) {
    if (ids.length > 100) throw new Error('Unbounded reservation lookup');
    const owners = [];
    for (const name of [COLLECTIONS.image, COLLECTIONS.batch]) {
      const rows = await db
        .collection(name)
        .find(
          { 'usageContext.reservationId': { $in: ids } },
          {
            projection: {
              status: 1,
              'usageContext.reservationId': 1,
              'usageDelivery.state': 1,
              'usageDelivery.envelope.event.status': 1,
            },
            maxTimeMS: 5000,
          },
        )
        .limit(ids.length + 1)
        .toArray();
      if (rows.length > ids.length) throw new Error('Ambiguous reservation ownership');
      for (const row of rows)
        owners.push({
          reservationId: row.usageContext.reservationId,
          durableTerminal:
            ['succeeded', 'failed', 'cancelled', 'status_unknown'].includes(row.status) &&
            ['durable', 'persisted', 'review'].includes(row.usageDelivery?.state) &&
            row.usageDelivery?.envelope?.event?.status &&
            row.usageDelivery.envelope.event.status !== 'submitted',
        });
    }
    return owners;
  }
  return { readPage, readLedger, acknowledge, pruneExpiredPayload, readReservationOwners };
}
module.exports = { createUsageSourceStore, COLLECTIONS };
