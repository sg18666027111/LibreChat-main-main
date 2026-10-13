const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');

function failure(code = 'USAGE_JOURNAL_UNAVAILABLE') {
  return Object.assign(new Error(code), { code });
}

/** Async facade: all SQLite, file locking and fsync stay off the request thread. */
async function openUsageJournal({
  directory,
  maxPendingBytes = 256 * 1024 * 1024,
  maxEventBytes = 32768,
  maxFileBytes = 512 * 1024 * 1024,
  ownerId = randomUUID(),
  now = Date.now,
}) {
  const worker = new Worker(path.join(__dirname, 'journalThread.js'), {
    workerData: { directory, maxPendingBytes, maxEventBytes, maxFileBytes, ownerId, time: now() },
  });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let closing;
  let heartbeat;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const initTimer = setTimeout(() => readyReject(failure()), 5000);
  function rejectPending() {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(failure());
    }
    pending.clear();
  }
  worker.on('message', (message) => {
    if (message.ready !== undefined) {
      clearTimeout(initTimer);
      if (message.ready) readyResolve();
      else readyReject(failure(message.code));
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.code) call.reject(failure(message.code));
    else call.resolve(message.value);
  });
  worker.on('error', () => {
    readyReject(failure());
    rejectPending();
  });
  worker.on('exit', () => {
    closed = true;
    clearInterval(heartbeat);
    rejectPending();
  });
  try {
    await ready;
  } catch (error) {
    clearTimeout(initTimer);
    await worker.terminate();
    throw error;
  }
  function rpc(op, args = []) {
    if (closed || pending.size >= 64) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(failure());
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, op, args, time: now() });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(failure());
      }
    });
  }
  heartbeat = setInterval(() => {
    rpc('renew').catch(() => {});
  }, 5000);
  heartbeat.unref();
  return {
    reserve: (input) => rpc('reserve', [input]),
    listReservations: (cursor, limit) => rpc('listReservations', [cursor, limit]),
    release: (id) => rpc('release', [id]),
    append: async (envelope, reservationId) => {
      try {
        return await rpc('append', [envelope, reservationId]);
      } catch (error) {
        return {
          durableAccepted: false,
          ledgerPersisted: false,
          reason: error.code === 'USAGE_FULL' ? 'full' : 'unavailable',
        };
      }
    },
    claim: (limit) => rpc('claim', [limit]),
    ack: (claim) => rpc('ack', [claim]),
    retry: (claim, nextAttemptAt, reason) => rpc('retry', [claim, nextAttemptAt, reason]),
    quarantine: (claim, reason) => rpc('quarantine', [claim, reason]),
    tombstone: (subjectId) => rpc('tombstone', [subjectId]),
    isDeletedSubject: (subjectId) => rpc('isDeletedSubject', [subjectId]),
    listSubjectEnvelopes: (subjectId, cursor, limit) =>
      rpc('listSubjectEnvelopes', [subjectId, cursor, limit]),
    stats: () => rpc('stats'),
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        clearInterval(heartbeat);
        if (!closed) {
          try {
            await rpc('close');
          } finally {
            closed = true;
            await worker.terminate();
          }
        }
      })();
      return closing;
    },
  };
}
module.exports = { openUsageJournal };
