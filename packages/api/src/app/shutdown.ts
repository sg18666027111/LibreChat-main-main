import { logger } from '@librechat/data-schemas';
import type { Server } from 'http';

const SHUTDOWN_TIMEOUT_MS = 60_000;
const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'];

type ShutdownTask = {
  name: string;
  fn: () => void | Promise<void>;
};

type ShutdownDrain = {
  /** Must synchronously prevent new work before returning. */
  stop: () => void;
  /** Called after all producers have been stopped. Includes final persistence. */
  waitForIdle: () => Promise<void>;
};

const tasks: ShutdownTask[] = [];
const drains: (ShutdownDrain & { name: string })[] = [];
let isShuttingDown = false;
let httpServer: Server | null = null;
let shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS;

/** Register a background producer during startup, before shutdown can begin. */
export function registerShutdownDrain(name: string, drain: ShutdownDrain): void {
  drains.push({ name, ...drain });
}

/**
 * Register a cleanup task to run after HTTP and background work have drained.
 * Tasks run in registration order; if one throws, subsequent tasks
 * and the final exit are not blocked. Use this instead of attaching
 * `process.on('SIGTERM', ...)` handlers directly — multiple competing
 * signal handlers race with the HTTP drain because Node dispatches
 * listeners in registration order and any one of them can call
 * `process.exit` before the HTTP server has finished closing.
 */
export function registerShutdownTask(name: string, fn: () => void | Promise<void>): void {
  tasks.push({ name, fn });
}

/**
 * Wires SIGTERM, SIGINT, SIGQUIT, and SIGHUP to a graceful shutdown
 * sequence: stop background producers, drain HTTP and in-flight background
 * work concurrently, run `registerShutdownTask` cleanup, then exit. One total
 * deadline covers all phases (default SHUTDOWN_TIMEOUT_MS); on expiry the
 * process is force-exited with code 1 — a
 * safety net for long-lived connections such as SSE streams that may
 * not finish in time.
 */
export function setupGracefulShutdown(
  server: Server,
  { timeoutMs = SHUTDOWN_TIMEOUT_MS }: { timeoutMs?: number } = {},
): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Shutdown timeout must be a positive 32-bit timer duration');
  }
  httpServer = server;
  shutdownTimeoutMs = timeoutMs;
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

/**
 * @internal Reset module state for tests. Not part of the public API.
 */
export function __resetShutdownStateForTests(): void {
  tasks.length = 0;
  drains.length = 0;
  isShuttingDown = false;
  httpServer = null;
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS;
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  logger.info(`Received ${signal}, stopping producers and draining HTTP/background work...`);

  const pending = new Set<string>();
  let forced = false;
  const forceExit = setTimeout(() => {
    forced = true;
    logger.warn(`Graceful shutdown exceeded ${shutdownTimeoutMs}ms, forcing exit`, {
      pending: Array.from(pending),
    });
    process.exit(1);
  }, shutdownTimeoutMs);
  // Keep the deadline referenced: pending promises alone do not keep Node alive.

  let exitCode = 0;

  for (const drain of drains) {
    try {
      drain.stop();
    } catch (err) {
      logger.error(`Shutdown stop "${drain.name}" failed:`, err);
      exitCode = 1;
    }
  }

  async function wait(name: string, fn: () => Promise<void>): Promise<void> {
    pending.add(name);
    try {
      await fn();
    } catch (err) {
      logger.error(`Shutdown drain "${name}" failed:`, err);
      exitCode = 1;
    } finally {
      pending.delete(name);
    }
  }

  await Promise.all([
    wait('HTTP', closeHttpServer),
    ...drains.map((drain) => wait(drain.name, drain.waitForIdle)),
  ]);

  for (const task of tasks) {
    if (forced) {
      return;
    }
    pending.add(task.name);
    try {
      logger.info(`Running shutdown task: ${task.name}`);
      await task.fn();
    } catch (err) {
      logger.error(`Shutdown task "${task.name}" failed:`, err);
    } finally {
      pending.delete(task.name);
    }
  }

  clearTimeout(forceExit);
  if (forced) {
    return;
  }
  logger.info('Graceful shutdown complete, exiting');
  process.exit(exitCode);
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!httpServer || !httpServer.listening) {
      // SIGTERM can arrive during startup before the listen socket is open,
      // in which case there is nothing to drain. Node also surfaces this as
      // an ERR_SERVER_NOT_RUNNING error in the close callback — treated
      // below as a successful close so a routine shutdown doesn't trip
      // orchestrator restart/backoff with exit code 1.
      resolve();
      return;
    }
    httpServer.close((err) => {
      if (!err || (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(err);
    });
  });
}
