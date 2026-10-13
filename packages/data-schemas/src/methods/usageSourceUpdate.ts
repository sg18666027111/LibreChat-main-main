import type { UsageDeliverySourceState } from '~/types/aiUsage';
/** Suspend document TTL until a durable private copy exists; file retention is unchanged. */
export function usageSourceUpdate<
  T extends { usageDelivery?: UsageDeliverySourceState; expiresAt?: Date },
>(updates: T, unsetFields: Array<string | number | symbol> = []) {
  const next = { ...updates };
  const unset = new Set(unsetFields);
  if (next.usageDelivery?.envelope && next.usageDelivery.state === 'pending') {
    next.usageDelivery = {
      ...next.usageDelivery,
      ...(next.expiresAt ? { cleanupAfter: new Date(next.expiresAt).toISOString() } : {}),
    };
    delete next.expiresAt;
    unset.add('expiresAt');
  }
  return {
    $set: next,
    ...(unset.size ? { $unset: Object.fromEntries([...unset].map((field) => [field, 1])) } : {}),
  };
}
export function usageSourceAcknowledgement(state: 'pending' | 'durable' | 'persisted' | 'review') {
  const updates = { 'usageDelivery.state': state, usageRecorded: state === 'persisted' };
  if (state === 'pending') return { $set: updates };
  return [
    {
      $set: {
        ...updates,
        expiresAt: {
          $cond: [
            { $ne: [{ $ifNull: ['$usageDelivery.cleanupAfter', null] }, null] },
            { $toDate: '$usageDelivery.cleanupAfter' },
            '$expiresAt',
          ],
        },
      },
    },
  ];
}
