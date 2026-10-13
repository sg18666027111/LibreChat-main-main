type RedisClients = typeof import('../../redisClients');

/** Close both clients from this module instance before jest.resetModules discards it. */
export async function closeRedisClients(clients: RedisClients): Promise<void> {
  const { ioredisClient, keyvRedisClient, keyvRedisClientReady } = clients;
  const ioClosed = new Promise<void>((resolve) => {
    if (!ioredisClient || ioredisClient.status === 'end') {
      resolve();
      return;
    }
    ioredisClient.once('end', resolve);
    ioredisClient.disconnect();
  });
  const keyvClosed = (async () => {
    try {
      await keyvRedisClientReady;
    } finally {
      if (keyvRedisClient?.isOpen) await keyvRedisClient.disconnect();
    }
  })();
  await Promise.all([ioClosed, keyvClosed]);
}
