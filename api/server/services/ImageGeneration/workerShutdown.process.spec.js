const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function runShutdown(mode) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'image-shutdown-'));
  const journal = path.join(scratch, 'events.jsonl');
  const child = fork(
    path.resolve(__dirname, '../../../test/fixtures/imageWorkerShutdown.cjs'),
    [mode, journal],
    {
      env: { PATH: process.env.PATH, NODE_ENV: 'test', LOG_TO_FILE: 'false' },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  let timer;
  let ready = false;
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    const outcome = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('message', (message) => {
          if (message.ready) {
            ready = true;
            child.kill('SIGTERM');
          }
        });
        exited.then((result) =>
          ready ? resolve(result) : reject(new Error(`Fixture exited before readiness: ${stderr}`)),
        );
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Shutdown test timeout: ${stderr}`)), 10_000);
      }),
    ]);
    return {
      ...outcome,
      events: fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('real SIGTERM waits for provider identity persistence and final lease release', async () => {
  const { code, signal, events } = await runShutdown('complete');
  expect({ code, signal }).toEqual({ code: 0, signal: null });
  const names = events.map(({ event }) => event);
  const persisted = events.findIndex(
    (event) => event.event === 'persist' && event.providerTaskId === 'accepted-before-shutdown',
  );
  expect(persisted).toBeGreaterThan(names.indexOf('signal'));
  expect(names.indexOf('release-slot')).toBeGreaterThan(persisted);
  expect(names.indexOf('cleanup')).toBeGreaterThan(names.indexOf('release-slot'));
  expect(names.filter((name) => name === 'claim')).toHaveLength(1);
  expect(names.filter((name) => name === 'submit')).toHaveLength(1);
  expect(events.find(({ event }) => event === 'restart-blocked')).toMatchObject({
    apimart: true,
    egress: true,
  });
});

test.each(['deadline', 'promises-only'])(
  'real SIGTERM bounds %s without premature success or cleanup',
  async (mode) => {
    const { code, signal, events } = await runShutdown(mode);
    expect({ code, signal }).toEqual({ code: 1, signal: null });
    const names = events.map(({ event }) => event);
    expect(names).not.toContain('cleanup');
    expect(names).not.toContain('release-slot');
    const exit = events.find(({ event }) => event === 'exit');
    expect(exit.at - events.find(({ event }) => event === 'signal').at).toBeGreaterThanOrEqual(300);
    expect(
      events.some(
        (event) => event.event === 'log' && event.args[1]?.pending?.includes('image-egress'),
      ),
    ).toBe(true);
    expect(exit.status).toBe(mode === 'deadline' ? 'submitting' : 'waiting');
    expect(names.filter((name) => name === 'submit')).toHaveLength(mode === 'deadline' ? 1 : 0);
  },
);
