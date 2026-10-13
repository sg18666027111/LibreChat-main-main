const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Exercise the actual shell-form RUN instruction. Only npm is replaced: a real
// install/build would require network access and obscure the exit-code contract.
const dockerfile = readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
const buildLayers = dockerfile
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')
  .replace(/\\\n/g, '')
  .split('\n')
  .filter((line) => /^RUN\s/.test(line) && /npm run frontend(?:\s|[;&]|$)/.test(line));
assert.equal(buildLayers.length, 1, 'Expected one shell-form frontend build layer');
const buildCommand = buildLayers[0].replace(/^RUN\s+/, '');

const npmStub = `#!/bin/sh
printf '%s\\n' "$*" >> "$BUILD_GATE_LOG"
case "$*" in
  'run frontend') exit "$FRONTEND_EXIT" ;;
  'prune --production') exit "$PRUNE_EXIT" ;;
  'cache clean --force') exit "$CACHE_EXIT" ;;
  *) exit 99 ;;
esac
`;

const scenarios = [
  {
    name: 'frontend failure fails the layer before dependency pruning or cleanup',
    exits: [37, 0, 0],
    status: 37,
    commands: ['run frontend'],
  },
  {
    name: 'prune failure fails the layer before cleanup',
    exits: [0, 38, 0],
    status: 38,
    commands: ['run frontend', 'prune --production'],
  },
  {
    name: 'cleanup failure fails the layer',
    exits: [0, 0, 39],
    status: 39,
    commands: ['run frontend', 'prune --production', 'cache clean --force'],
  },
  {
    name: 'successful build prunes dependencies and clears cache in order',
    exits: [0, 0, 0],
    status: 0,
    commands: ['run frontend', 'prune --production', 'cache clean --force'],
  },
];

for (const scenario of scenarios) {
  test(scenario.name, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'docker-build-gate-'));
    try {
      const logFile = path.join(directory, 'commands.log');
      writeFileSync(path.join(directory, 'npm'), npmStub, { mode: 0o700 });
      const result = spawnSync('/bin/sh', ['-c', buildCommand], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 5000,
        // Do not pass app credentials, npm configuration or production env.
        env: {
          PATH: `${directory}:/usr/bin:/bin`,
          NODE_MAX_OLD_SPACE_SIZE: '6144',
          BUILD_GATE_LOG: logFile,
          FRONTEND_EXIT: String(scenario.exits[0]),
          PRUNE_EXIT: String(scenario.exits[1]),
          CACHE_EXIT: String(scenario.exits[2]),
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, scenario.status, result.stderr);
      assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n'), scenario.commands);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
