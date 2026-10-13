const net = require('node:net');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createReadinessCheck } = require('./readiness');

describe('readiness with a real Mongo driver and an unresponsive network', () => {
  it('bounds a stalled ping and recovers through the same connection without a restart', async () => {
    const mongo = await MongoMemoryServer.create();
    const isolated = new mongoose.Mongoose();
    const target = new URL(mongo.getUri());
    const sockets = new Set();
    let blackhole = false;
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port), '127.0.0.1');
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
        socket.on('close', () => {
          sockets.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
      client.on('data', (chunk) => {
        if (!blackhole) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (!blackhole) client.write(chunk);
      });
    });
    let check;
    try {
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      await isolated.connect(`mongodb://127.0.0.1:${proxy.address().port}/readiness_test`, {
        directConnection: true,
        bufferCommands: false,
        serverSelectionTimeoutMS: 5000,
      });
      check = createReadinessCheck({ connection: isolated.connection, isStarted: () => true });
      expect(await check.isReady()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      blackhole = true;
      expect(isolated.connection.readyState).toBe(1);
      const start = performance.now();
      expect(await check.isReady()).toBe(false);
      expect(performance.now() - start).toBeLessThan(3000);
      blackhole = false;
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(await check.isReady()).toBe(true);
    } finally {
      check?.stop();
      await isolated.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      await mongo.stop();
    }
  }, 30_000);
});
