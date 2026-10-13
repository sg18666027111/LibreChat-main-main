/* Isolated test fixture. Never loaded by application runtime. */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { openUsageJournal } = require('../journal');
const { createUsageDeliveryService } = require('../service');
const { createUsageSourceStore } = require('../sourceStore');
const { createSourceReconciler } = require('../sourceReconciler');
const { recoverReservations } = require('../reservationRecovery');
const { createMethods, createModels } = require('@librechat/data-schemas');
const mongoose = require('mongoose');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = net._normalizeArgs(args)[0];
  if (options.path || !['127.0.0.1', 'localhost', '::1'].includes(options.host || 'localhost'))
    throw new Error('Fixture forbids external network');
  return connect.apply(this, args);
};
mongoose.set('bufferCommands', false);
let journal, service, reconciler, methods, config, pause, clock;
const barrier = async (event) => {
  process.send({ event });
  if (pause === event) await new Promise(() => {});
};
const counters = () => path.join(config.directory, 'fixture-counters.json');
async function dispatch(message) {
  const { op, data = {} } = message;
  if (op === 'start') {
    config = data;
    const uri = new URL(data.mongoUri);
    if (
      uri.protocol !== 'mongodb:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname) ||
      !/^\/o03_process_[a-z0-9_]+$/.test(uri.pathname) ||
      uri.username ||
      uri.password
    )
      throw new Error('Unsafe fixture database');
    clock = data.time;
    await mongoose.connect(data.mongoUri, {
      serverSelectionTimeoutMS: 500,
      socketTimeoutMS: 1000,
      maxPoolSize: 2,
    });
    createModels(mongoose);
    methods = createMethods(mongoose);
    await methods.ensureAIUsageStorage();
    journal = await openUsageJournal({
      directory: data.directory,
      now: () => clock,
      maxFileBytes: data.maxFileBytes || 536870912,
    });
    const originalAck = journal.ack;
    journal.ack = async (claim) => {
      await originalAck(claim);
      await barrier('ack_committed');
    };
    service = createUsageDeliveryService({
      journal,
      now: () => clock,
      sealExpired: methods.sealExpiredUsageIdentity,
      persist: async (envelope, digest) => {
        await barrier('ledger_started');
        const result = await methods.persistUsageEnvelope(envelope, digest);
        await barrier('ledger_committed');
        return result;
      },
    });
    const store = createUsageSourceStore(mongoose.connection.db);
    let reservationCursor = null;
    reconciler = createSourceReconciler({
      store,
      recoverReservations: async () => {
        reservationCursor = await recoverReservations({ journal, store, after: reservationCursor });
      },
      capture: (envelope, source) => service.capture(envelope, source.reservationId),
      cutover: new Date(config.time - 86400000).toISOString(),
      now: () => clock,
    });
    const version = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    return { node: process.version, sqlite: process.versions.sqlite, mongo: version.version };
  }
  if (op === 'pauseAt') {
    pause = data.event;
    return true;
  }
  if (op === 'time') {
    clock = data.time;
    return true;
  }
  if (op === 'offline') {
    await mongoose.disconnect();
    return true;
  }
  if (op === 'capture') {
    const result = await service.capture(data.envelope);
    if (result.durableAccepted) await barrier('journal_committed');
    return result;
  }
  if (op === 'source') {
    if (!fs.existsSync(counters()))
      fs.writeFileSync(counters(), JSON.stringify({ provider: 1, balance: 1 }));
    await mongoose.connection.db.collection(data.collection || 'imagegenerationjobs').insertOne({
      status: data.status || 'succeeded',
      usageContext: data.reservationId ? { reservationId: data.reservationId } : undefined,
      createdAt: new Date(config.time),
      updatedAt: new Date(config.time),
      tokenType: 'prompt',
      usageEventId: data.envelope.event.usageEventId,
      usageDelivery: {
        state: 'pending',
        revision: data.envelope.revision,
        envelope: data.envelope,
      },
    });
    await barrier('source_committed');
    return true;
  }
  if (op === 'reconcile') {
    await reconciler.runOnce();
    return true;
  }
  if (op === 'runOnce') return service.runOnce();
  if (op === 'stats') return journal.stats();
  if (op === 'claim') return journal.claim(20);
  if (op === 'ack') {
    await journal.ack(data.claim);
    return true;
  }
  if (op === 'reserve') return service.reserve(data);
  if (op === 'delete') {
    await service.withDeletedSubject(data.subject, async () => {
      await mongoose.models.AIUsageEvent.updateMany(
        { reportingSubjectId: data.subject },
        { $set: { userId: null } },
      );
    });
    return true;
  }
  if (op === 'tombstone') {
    await journal.tombstone(data.subject);
    await barrier('deletion_tombstoned');
    return true;
  }
  if (op === 'exit') {
    reconciler.stop();
    await service.drain();
    await mongoose.disconnect();
    process.send({ id: message.id, result: true }, () => process.exit(0));
    return undefined;
  }
  throw new Error('Unknown fixture operation');
}
process.on('message', (message) => {
  void dispatch(message).then(
    (result) => {
      if (message.op !== 'exit') process.send({ id: message.id, result });
    },
    (error) => process.send({ id: message.id, error: error.code || error.name }),
  );
});
