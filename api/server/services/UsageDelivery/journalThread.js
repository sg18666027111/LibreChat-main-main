const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData: config } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { validateEnvelope } = require('./contract');

const LEASE_MS = 30000;
const ACK_RETENTION_MS = 86400000;
let db;
let fence;
let storageFull = false;
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function sql(statement, ...args) {
  return db.prepare(statement).run(...args);
}
function one(statement, ...args) {
  return db.prepare(statement).get(...args);
}
function all(statement, ...args) {
  return db.prepare(statement).all(...args);
}
function reasonCode(error) {
  if (typeof error.code === 'string' && error.code.startsWith('USAGE_')) return error.code;
  if (error.code === 'ENOSPC' || /database or disk is full/.test(error.message || ''))
    return 'USAGE_FULL';
  return 'USAGE_JOURNAL_UNAVAILABLE';
}
function transaction(fn, time, checkFence = true, allowExpiredLease = false) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (checkFence) {
      const writer = one('SELECT * FROM writer WHERE singleton=1');
      if (
        !writer ||
        writer.owner !== config.ownerId ||
        writer.fence !== fence ||
        (!allowExpiredLease && writer.lease_until <= time)
      )
        fail('USAGE_WRITER_FENCED');
    }
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    // SQLITE_FULL may already roll back; preserve its original classification.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Transaction was already aborted. */
    }
    throw error;
  }
}
function totals() {
  return {
    pending: one("SELECT COALESCE(SUM(bytes),0) AS n FROM delivery WHERE state!='acked'").n,
    reserved: one('SELECT COALESCE(SUM(bytes),0) AS n FROM reservation').n,
  };
}
function requireSpace(extra = 0) {
  const free = fs.statfsSync(config.directory);
  if (free.bavail * free.bsize < Math.max(1024 * 1024, extra * 4)) fail('USAGE_FULL');
}
function availablePhysicalBytes() {
  return (
    (one('PRAGMA max_page_count').max_page_count -
      one('PRAGMA page_count').page_count +
      one('PRAGMA freelist_count').freelist_count) *
    one('PRAGMA page_size').page_size
  );
}
function privateDirectory() {
  if (!path.isAbsolute(config.directory) || config.directory.split(path.sep).includes('public'))
    fail('USAGE_PRIVATE_PATH_REQUIRED');
  fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(config.directory);
  if (dir.isSymbolicLink() || !dir.isDirectory()) fail('USAGE_PRIVATE_PATH_REQUIRED');
  if (!(dir.mode & 0o200)) fail('USAGE_JOURNAL_UNAVAILABLE');
  const resolved = fs.realpathSync(config.directory);
  if (resolved.split(path.sep).includes('public')) fail('USAGE_PRIVATE_PATH_REQUIRED');
  fs.chmodSync(config.directory, 0o700);
  return path.join(config.directory, 'usage.sqlite');
}
function initialize() {
  for (const name of ['maxPendingBytes', 'maxEventBytes', 'maxFileBytes']) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) fail('USAGE_INVALID');
  }
  if (
    config.maxEventBytes > 32768 ||
    config.maxPendingBytes > 268435456 ||
    config.maxFileBytes > 536870912
  )
    fail('USAGE_INVALID');
  const file = privateDirectory();
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('USAGE_PRIVATE_PATH_REQUIRED');
    if (!(stat.mode & 0o200)) fail('USAGE_JOURNAL_UNAVAILABLE');
  } else {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  }
  fs.chmodSync(file, 0o600);
  db = new DatabaseSync(file);
  db.exec(
    'PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
  );
  if (one('PRAGMA quick_check').quick_check !== 'ok') fail('USAGE_JOURNAL_UNAVAILABLE');
  const version = one('PRAGMA user_version').user_version;
  if (version > 2) fail('USAGE_SCHEMA_UNSUPPORTED');
  if (version === 0) {
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    transaction(
      () => {
        db.exec(`
        CREATE TABLE delivery (
          event_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
          envelope TEXT NOT NULL, subject_id TEXT NOT NULL, bytes INTEGER NOT NULL,
          state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL, claim_token TEXT, claim_until INTEGER,
          accepted_at INTEGER NOT NULL, acked_at INTEGER, reason TEXT,
          PRIMARY KEY(event_id,revision));
        CREATE INDEX delivery_due ON delivery(state,next_attempt_at);
        CREATE INDEX delivery_subject ON delivery(subject_id,event_id,revision);
        CREATE TABLE reservation (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, fence INTEGER NOT NULL, lease_until INTEGER NOT NULL);
        CREATE TABLE deleted_subject (subject_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
        PRAGMA user_version=1;
      `);
      },
      config.time,
      false,
    );
  }
  if (version < 2) {
    transaction(
      () => {
        db.exec(
          "ALTER TABLE reservation ADD COLUMN scope TEXT NOT NULL DEFAULT 'source'; ALTER TABLE reservation ADD COLUMN owner_fence INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=2;",
        );
      },
      config.time,
      false,
    );
  }
  const pageSize = one('PRAGMA page_size').page_size;
  db.exec(`PRAGMA max_page_count=${Math.floor(config.maxFileBytes / pageSize)}`);
  transaction(
    () => {
      const existing = one('SELECT * FROM writer WHERE singleton=1');
      if (existing && existing.lease_until > config.time) fail('USAGE_WRITER_BUSY');
      fence = (existing?.fence ?? 0) + 1;
      sql(
        'INSERT INTO writer VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,lease_until=excluded.lease_until',
        config.ownerId,
        fence,
        config.time + LEASE_MS,
      );
      // Request callbacks cannot resume on a replacement writer; captured rows are independent.
      sql("DELETE FROM reservation WHERE scope='request' AND owner_fence!=?", fence);
    },
    config.time,
    false,
  );
  transaction(
    () =>
      sql(
        "DELETE FROM delivery WHERE state='acked' AND acked_at<?",
        config.time - ACK_RETENTION_MS,
      ),
    config.time,
  );
  db.exec('PRAGMA incremental_vacuum(32)');
  const dir = fs.openSync(config.directory, 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function changeClaim(claim, fields, params, time) {
  const result = sql(
    `UPDATE delivery SET ${fields} WHERE event_id=? AND revision=? AND state='claimed' AND claim_token=? AND claim_until>?`,
    ...params,
    claim.envelope.event.usageEventId,
    claim.envelope.revision,
    claim.token,
    time,
  );
  if (result.changes !== 1) fail('USAGE_CLAIM_LOST');
}
function perform(op, args, time) {
  if (op === 'renew') {
    sql(
      'UPDATE writer SET lease_until=? WHERE singleton=1 AND owner=? AND fence=?',
      time + LEASE_MS,
      config.ownerId,
      fence,
    );
    sql("DELETE FROM delivery WHERE state='acked' AND acked_at<?", time - ACK_RETENTION_MS);
    return true;
  }
  if (op === 'reserve') {
    const { key, bytes, expiresAt, scope = 'source' } = args[0];
    if (
      !['source', 'request'].includes(scope) ||
      typeof key !== 'string' ||
      !key ||
      key.length > 256 ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      !Number.isFinite(Date.parse(expiresAt))
    )
      fail('USAGE_INVALID');
    const { pending, reserved } = totals();
    if (
      storageFull ||
      availablePhysicalBytes() < Math.max(config.maxEventBytes * 2, reserved + bytes)
    )
      fail('USAGE_FULL');
    requireSpace(bytes);
    const existing = one('SELECT * FROM reservation WHERE id=?', key);
    if (existing)
      return {
        id: key,
        remainingBytes: existing.bytes,
        expiresAt: new Date(existing.expires_at).toISOString(),
      };
    if (pending + reserved + bytes > config.maxPendingBytes) fail('USAGE_FULL');
    sql(
      'INSERT INTO reservation(id,bytes,expires_at,scope,owner_fence) VALUES(?,?,?,?,?)',
      key,
      bytes,
      Date.parse(expiresAt),
      scope,
      fence,
    );
    return { id: key, remainingBytes: bytes, expiresAt };
  }
  if (op === 'listReservations') {
    const [cursor, limit] = args;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('USAGE_INVALID');
    const rows = all(
      "SELECT id FROM reservation WHERE scope='source' AND owner_fence!=? AND id>? ORDER BY id LIMIT ?",
      fence,
      cursor || '',
      limit,
    );
    return { items: rows, cursor: rows.length === limit ? rows.at(-1).id : null };
  }
  if (op === 'release') {
    sql('DELETE FROM reservation WHERE id=?', args[0]);
    return;
  }
  if (op === 'append') {
    const checked = validateEnvelope(args[0]);
    const rejected = (reason) => ({ durableAccepted: false, ledgerPersisted: false, reason });
    if (!checked.ok) return rejected(checked.reason);
    if (checked.bytes > config.maxEventBytes) return rejected('oversize');
    const { envelope, digest, bytes } = checked;
    const eventId = envelope.event.usageEventId;
    const existing = one(
      'SELECT digest,state FROM delivery WHERE event_id=? AND revision=?',
      eventId,
      envelope.revision,
    );
    if (existing) {
      if (existing.digest !== digest) return rejected('conflict');
      return {
        durableAccepted: true,
        ledgerPersisted: existing.state === 'acked',
        eventId,
        revision: envelope.revision,
      };
    }
    const reservation = args[1] ? one('SELECT * FROM reservation WHERE id=?', args[1]) : null;
    if (args[1] && (!reservation || reservation.bytes < bytes)) return rejected('full');
    const { pending, reserved } = totals();
    if (pending + reserved + (reservation ? 0 : bytes) > config.maxPendingBytes)
      return rejected('full');
    requireSpace(bytes);
    sql(
      "INSERT INTO delivery(event_id,revision,digest,envelope,subject_id,bytes,state,next_attempt_at,accepted_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
      eventId,
      envelope.revision,
      digest,
      JSON.stringify(envelope),
      envelope.reportingSubjectId,
      bytes,
      time,
      time,
    );
    if (reservation) sql('UPDATE reservation SET bytes=bytes-? WHERE id=?', bytes, reservation.id);
    return { durableAccepted: true, ledgerPersisted: false, eventId, revision: envelope.revision };
  }
  if (op === 'claim') {
    const limit = Math.min(20, Math.max(0, Number.isSafeInteger(args[0]) ? args[0] : 0));
    const rows = all(
      "SELECT * FROM delivery WHERE (state='pending' AND next_attempt_at<=?) OR (state='claimed' AND claim_until<=?) ORDER BY next_attempt_at,event_id,revision LIMIT ?",
      time,
      time,
      limit,
    );
    const claims = [];
    for (const row of rows) {
      let envelope;
      try {
        envelope = JSON.parse(row.envelope);
        const checked = validateEnvelope(envelope);
        if (
          !checked.ok ||
          checked.digest !== row.digest ||
          envelope.event.usageEventId !== row.event_id ||
          envelope.revision !== row.revision ||
          envelope.reportingSubjectId !== row.subject_id
        )
          throw new Error('Invalid stored envelope');
      } catch {
        sql(
          "UPDATE delivery SET state='quarantined',reason='invalid' WHERE event_id=? AND revision=?",
          row.event_id,
          row.revision,
        );
        continue;
      }
      const token = randomUUID();
      sql(
        "UPDATE delivery SET state='claimed',claim_token=?,claim_until=?,attempts=attempts+1 WHERE event_id=? AND revision=?",
        token,
        time + LEASE_MS,
        row.event_id,
        row.revision,
      );
      claims.push({ envelope, digest: row.digest, token, attempts: row.attempts + 1 });
    }
    return claims;
  }
  if (op === 'ack') {
    changeClaim(
      args[0],
      "state='acked',acked_at=?,claim_token=NULL,claim_until=NULL",
      [time],
      time,
    );
    return;
  }
  if (op === 'retry') {
    if (!Number.isFinite(args[1]) || args[1] < time || args[1] > time + 360000)
      fail('USAGE_INVALID');
    changeClaim(
      args[0],
      "state='pending',next_attempt_at=?,reason=?,claim_token=NULL,claim_until=NULL",
      [args[1], 'unavailable'],
      time,
    );
    return;
  }
  if (op === 'quarantine') {
    const reason = ['invalid', 'expired', 'conflict', 'legacy', 'identity', 'pricing'].includes(
      args[1],
    )
      ? args[1]
      : 'invalid';
    changeClaim(
      args[0],
      "state='quarantined',reason=?,claim_token=NULL,claim_until=NULL",
      [reason],
      time,
    );
    return;
  }
  if (op === 'tombstone') {
    if (typeof args[0] !== 'string' || args[0].length > 256 || !args[0]) fail('USAGE_INVALID');
    sql(
      'INSERT INTO deleted_subject VALUES(?,?) ON CONFLICT(subject_id) DO NOTHING',
      args[0],
      time,
    );
    return;
  }
  if (op === 'isDeletedSubject')
    return !!one('SELECT subject_id FROM deleted_subject WHERE subject_id=?', args[0]);
  if (op === 'listSubjectEnvelopes') {
    const [subject, cursor, limit] = args;
    const rows = all(
      "SELECT rowid,envelope FROM delivery WHERE subject_id=? AND state!='acked' AND rowid>? ORDER BY rowid LIMIT ?",
      subject,
      Number(cursor || 0),
      Math.min(100, Math.max(1, limit)),
    );
    return {
      items: rows.map((row) => JSON.parse(row.envelope)),
      cursor: rows.length ? String(rows[rows.length - 1].rowid) : null,
    };
  }
  if (op === 'stats') {
    const row = one(
      "SELECT COUNT(*) AS n,COALESCE(MIN(accepted_at),0) AS oldest,SUM(CASE WHEN state='quarantined' THEN 1 ELSE 0 END) AS quarantined FROM delivery WHERE state!='acked'",
    );
    const { pending, reserved } = totals();
    const availablePages =
      one('PRAGMA max_page_count').max_page_count -
      one('PRAGMA page_count').page_count +
      one('PRAGMA freelist_count').freelist_count;
    const availableBytes = availablePages * one('PRAGMA page_size').page_size;
    let writable =
      !storageFull &&
      pending + reserved < config.maxPendingBytes &&
      availableBytes >= config.maxEventBytes * 2;
    try {
      requireSpace();
    } catch {
      writable = false;
    }
    return {
      pendingCount: row.n,
      pendingBytes: pending,
      reservedBytes: reserved,
      oldestPendingSeconds: row.n ? Math.max(0, (time - row.oldest) / 1000) : 0,
      quarantinedCount: row.quarantined || 0,
      writable,
    };
  }
  fail('USAGE_INVALID');
}
try {
  initialize();
  parentPort.postMessage({ ready: true });
  parentPort.on('message', ({ id, op, args, time }) => {
    try {
      if (op === 'close') {
        transaction(
          () =>
            sql(
              'UPDATE writer SET lease_until=0 WHERE singleton=1 AND owner=? AND fence=?',
              config.ownerId,
              fence,
            ),
          time,
          false,
        );
        db.close();
        parentPort.postMessage({ id, value: true });
        parentPort.close();
        return;
      }
      // BEGIN IMMEDIATE serializes renewal with takeover. Only the unchanged owner/fence
      // may renew an expired lease; every business operation still requires a live lease.
      const value = transaction(() => perform(op, args, time), time, true, op === 'renew');
      if (op === 'renew') {
        db.exec('PRAGMA incremental_vacuum(32)');
        const availablePages =
          one('PRAGMA max_page_count').max_page_count -
          one('PRAGMA page_count').page_count +
          one('PRAGMA freelist_count').freelist_count;
        if (availablePages * one('PRAGMA page_size').page_size >= config.maxEventBytes * 2)
          storageFull = false;
      }
      parentPort.postMessage({ id, value });
    } catch (error) {
      const code = reasonCode(error);
      if (code === 'USAGE_FULL') storageFull = true;
      parentPort.postMessage({ id, code });
    }
  });
} catch (error) {
  try {
    db?.close();
  } catch {
    /* Initialization failed; never replace the file. */
  }
  parentPort.postMessage({ ready: false, code: reasonCode(error) });
  parentPort.close();
}
