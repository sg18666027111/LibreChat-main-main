const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

describe('upload filename process safety', () => {
  it('survives malformed multipart filenames and serves subsequent uploads and health requests', () => {
    const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'multer-process-'));
    try {
      const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, '../../../test/fixtures/multerMultipart.cjs'), uploads],
        {
          // Do not inherit application/provider credentials or load the application server.
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            LOG_TO_FILE: 'false',
            USE_REDIS: 'false',
          },
          encoding: 'utf8',
          timeout: 20000,
        },
      );
      expect({
        status: result.status,
        signal: result.signal,
        error: result.error,
        stderr: result.stderr,
      }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
      expect(result.stdout.trim()).toBe('multipart uploads and subsequent health checks passed');
    } finally {
      fs.rmSync(uploads, { recursive: true, force: true });
    }
  });
});
