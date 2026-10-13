const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const multer = require('multer');

require('module-alias').addAlias('~', path.resolve(__dirname, '../..'));
// Only replace config loading: the real storage callbacks, sanitizer, Multer,
// Busboy, HTTP transport and temporary disk writes all run in this child.
const configPath = require.resolve('../../server/services/Config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { getAppConfig: async () => ({ paths: { uploads: process.argv[2] } }) },
};
const { storage, importFileFilter } = require('../../server/routes/files/multer');

async function main() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'test-user' };
    req.config = { paths: { uploads: process.argv[2] } };
    next();
  });
  const upload = multer({ storage });
  const imported = multer({ storage, fileFilter: importFileFilter });
  function complete(req, res) {
    const contents = fs.readFileSync(req.file.path, 'utf8');
    fs.unlinkSync(req.file.path);
    res.json({ originalname: req.file.originalname, contents });
  }
  // These entry points share this storage in files/index.js and convos.js.
  app.post('/files', upload.single('file'), complete);
  app.post('/images', upload.single('file'), complete);
  app.post('/avatar', upload.single('file'), complete);
  app.post('/speech', upload.single('audio'), complete);
  app.post('/import', imported.single('file'), complete);
  app.get('/health', (_req, res) => res.send('OK'));
  app.use((error, _req, res, _next) => res.status(400).json({ error: error.stack }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', (error) =>
      error ? reject(error) : resolve(listener),
    );
    listener.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  server.on('checkContinue', (req, res) => {
    app(req, res);
    // Release the body only after Express has returned from installing Multer.
    // This exercises an asynchronous file event, not an already-buffered body.
    res.writeContinue();
  });
  async function post(route, field, name, expectedName) {
    const boundary = 'b03-filename-regression';
    // A literal multipart header is intentional: FormData helpers may encode %.
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}--\r\n`;
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        base + route,
        {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body),
            Expect: '100-continue',
          },
          signal: AbortSignal.timeout(3000),
        },
        (incoming) => {
          let text = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk) => {
            text += chunk;
          });
          incoming.on('error', reject);
          incoming.on('end', () => resolve({ status: incoming.statusCode, text }));
        },
      );
      request.on('error', reject);
      request.on('continue', () => request.end(body));
      request.flushHeaders();
    });
    assert.equal(response.status, 200, `${route} ${name}: ${response.text}`);
    assert.deepEqual(JSON.parse(response.text), { originalname: expectedName, contents: '{}' });
    const health = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) });
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'OK');
  }
  try {
    for (const [route, field] of [
      ['/files', 'file'],
      ['/images', 'file'],
      ['/avatar', 'file'],
      ['/speech', 'audio'],
      ['/import', 'file'],
    ]) {
      for (const name of ['100%.json', '%ZZ.json', '%E4%B8.json']) {
        await post(route, field, name, name);
      }
      await post(route, field, '%E5%95%86%E5%93%81%20%E5%9B%BE.json', '商品 图.json');
      await post(route, field, '100%25.json', '100%.json');
      await post(route, field, 'normal.json', 'normal.json');
    }
    assert.deepEqual(fs.readdirSync(path.join(process.argv[2], 'temp/test-user')), []);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  process.stdout.write('multipart uploads and subsequent health checks passed\n');
}

// No uncaughtException handler: a storage callback escape must kill this child
// so the parent test detects the production failure instead of masking it.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
