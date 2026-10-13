const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const multer = require('multer');
const { storage } = require('./multer');

jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

it('keeps concurrent same-name multipart bytes independent through interleaved cleanup', async () => {
  const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'multer-concurrent-'));
  const upload = multer({ storage }).single('file');
  const uploadBytes = (contents) => {
    const boundary = 'concurrent-upload-boundary';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n${contents}\r\n--${boundary}--\r\n`,
    );
    const req = new PassThrough();
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    req.user = { id: 'same-user' };
    req.config = { paths: { uploads } };
    const completed = new Promise((resolve, reject) =>
      upload(req, {}, (error) => (error ? reject(error) : resolve(req.file))),
    );
    // Deliver real multipart bytes asynchronously after middleware is installed.
    setImmediate(() => req.end(body));
    return completed;
  };
  try {
    const [first, second] = await Promise.all([
      uploadBytes('first-image'),
      uploadBytes('second-image'),
    ]);
    expect(first.path).not.toBe(second.path);
    expect(first.originalname).toBe('image.png');
    expect(second.originalname).toBe('image.png');
    expect(await fs.readFile(first.path, 'utf8')).toBe('first-image');
    await fs.unlink(first.path);
    expect(await fs.readFile(second.path, 'utf8')).toBe('second-image');
    await fs.unlink(second.path);
    expect(await fs.readdir(path.dirname(second.path))).toEqual([]);
  } finally {
    await fs.rm(uploads, { recursive: true, force: true });
  }
});
