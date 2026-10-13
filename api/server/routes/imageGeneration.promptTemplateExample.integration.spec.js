const mockPaths = {};
jest.mock('~/config/paths', () => {
  Object.assign(mockPaths, jest.requireActual('~/config/paths'));
  return mockPaths;
});
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: jest.requireActual('~/server/middleware/requireJwtAuth'),
  configMiddleware: (req, _res, next) => {
    req.config = { fileStrategy: 'local', paths: mockPaths };
    next();
  },
}));

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const jwtLogin = require('~/strategies/jwtStrategy');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const imageRouter = require('./imageGeneration');
const filesRouter = require('./files/files');

// Real JWT authentication, MongoDB persistence, multipart parsing, image processing and local storage.
// Only environment configuration is substituted; no generator endpoint is invoked.
describe('batch template examples with MongoDB and local storage', () => {
  let mongo;
  let tempDir;
  let app;
  let editor;
  let operator;
  let admin;
  let red;
  let blue;
  const authorization = (user) =>
    `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '5m' })}`;
  const api = '/api/image-generation/prompt-templates';
  const makeApp = () => {
    const server = express();
    server.use(express.json());
    server.use(passport.initialize());
    server.use('/api/image-generation', imageRouter);
    server.use('/api/files', requireJwtAuth, configMiddleware, filesRouter);
    return server;
  };
  const createTemplate = async (role = 'packaging_style') => {
    const result = await request(app)
      .post(api)
      .set('Authorization', authorization(editor))
      .send({
        name: `Example ${role}`,
        prompt: 'Original {{title}} prompt',
        templateRole: role,
      })
      .expect(201);
    return result.body.template;
  };
  const upload = (template, user, buffer) =>
    request(app)
      .post(`${api}/${template.id}/example-image`)
      .set('Authorization', authorization(user))
      .attach('image', buffer, { filename: 'example.png', contentType: 'image/png' });
  const read = (url, user) => request(app).get(url).set('Authorization', authorization(user));

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-template-example-'));
    Object.assign(mockPaths, {
      publicPath: path.join(tempDir, 'public'),
      imageOutput: path.join(tempDir, 'public', 'images'),
      uploads: path.join(tempDir, 'uploads'),
    });
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'batch_template_example_acceptance' });
    createModels(mongoose);
    passport.use('jwt', jwtLogin());
    app = makeApp();
    red = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    blue = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#0000ff' } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await mongoose.models.User.deleteMany({});
    await mongoose.models.ImagePromptTemplate.deleteMany({ isSystem: false });
    [editor, operator, admin] = await mongoose.models.User.create([
      {
        email: 'editor@example.test',
        name: 'Editor',
        provider: 'local',
        role: 'USER',
        permissions: { imagePromptTemplates: { manage: true } },
      },
      { email: 'operator@example.test', name: 'Operator', provider: 'local', role: 'USER' },
      { email: 'admin@example.test', name: 'Admin', provider: 'local', role: 'ADMIN' },
    ]);
  });

  test('rejects unauthenticated image access and writes', async () => {
    const readResult = await request(app).get(`${api}/example/example-image`);
    const uploadResult = await request(app)
      .post(`${api}/example/example-image`)
      .attach('image', red, 'example.png');
    expect([readResult.status, uploadResult.status]).toEqual([401, 401]);
  });

  test.each(['global_business', 'packaging_style'])(
    'persists and shares a %s example across accounts and reloads',
    async (role) => {
      const template = await createTemplate(role);
      const saved = await upload(template, editor, red).expect(200);
      const url = saved.body.template.exampleImageUrl;
      const stored = await mongoose.models.ImagePromptTemplate.findById(template.id).lean();
      expect(stored.prompt).toBe('Original {{title}} prompt');
      expect(stored.exampleImage.type).toBe('image/png');
      expect(await mongoose.models.File.countDocuments({})).toBe(0);
      expect(
        await fs.readFile(path.join(mockPaths.publicPath, stored.exampleImage.filepath)),
      ).toBeInstanceOf(Buffer);
      app = makeApp();
      const list = await read(`${api}?category=batch_packaging`, operator).expect(200);
      expect(list.body.templates.find((item) => item.id === template.id).exampleImageUrl).toBe(url);
      const result = await read(url, operator).expect(200);
      expect(result.headers['content-type']).toMatch(/^image\/png/);
      expect(result.headers['cache-control']).toBe('private, max-age=86400, immutable');
      expect((await sharp(result.body).metadata()).width).toBe(1024);
      await upload(template, operator, blue).expect(403);
      await request(app)
        .delete(`${api}/${template.id}/example-image`)
        .set('Authorization', authorization(operator))
        .expect(403);
    },
  );

  test('admin replacement updates the shared image without changing the prompt', async () => {
    const template = await createTemplate();
    const first = await upload(template, editor, red).expect(200);
    const second = await upload(template, admin, blue).expect(200);
    expect(second.body.template.exampleImageUrl).not.toBe(first.body.template.exampleImageUrl);
    const image = await read(second.body.template.exampleImageUrl, operator).expect(200);
    const metadata = await sharp(image.body).metadata();
    expect(metadata.height).toBe(1024);
    expect(metadata.width).toBe(683);
    const record = await mongoose.models.ImagePromptTemplate.findById(template.id).lean();
    expect(record.prompt).toBe('Original {{title}} prompt');
    expect(record.activePromptSource).toBe('original');
  });

  test('revocation takes effect with the same JWT and ordinary file deletion cannot remove the example', async () => {
    const template = await createTemplate();
    const token = authorization(editor);
    const saved = await upload(template, editor, red).expect(200);
    await mongoose.models.User.updateOne(
      { _id: editor._id },
      { $set: { 'permissions.imagePromptTemplates.manage': false } },
    );
    await request(app)
      .post(`${api}/${template.id}/example-image`)
      .set('Authorization', token)
      .attach('image', blue, 'example.png')
      .expect(403);
    await request(app)
      .delete(`${api}/${template.id}/example-image`)
      .set('Authorization', token)
      .expect(403);
    await request(app)
      .get(saved.body.template.exampleImageUrl)
      .set('Authorization', token)
      .expect(200);
    const personal = await request(app).get('/api/files').set('Authorization', token).expect(200);
    expect(personal.body).toEqual([]);
    const record = await mongoose.models.ImagePromptTemplate.findById(template.id).lean();
    await request(app)
      .delete('/api/files')
      .set('Authorization', token)
      .send({
        files: [
          {
            file_id: record.exampleImage.id,
            filepath: record.exampleImage.filepath,
            source: record.exampleImage.source,
          },
        ],
      })
      .expect(200);
    await read(saved.body.template.exampleImageUrl, operator).expect(200);
  });

  test('clearing one reference preserves a copied template and legacy templates remain usable', async () => {
    const template = await createTemplate();
    expect(template.exampleImageUrl).toBe('');
    await read(`${api}/${template.id}/example-image`, operator).expect(404);
    await upload(template, editor, red).expect(200);
    const copy = await request(app)
      .post(`${api}/${template.id}/duplicate`)
      .set('Authorization', authorization(editor))
      .send({})
      .expect(201);
    const removed = await request(app)
      .delete(`${api}/${template.id}/example-image`)
      .set('Authorization', authorization(editor))
      .expect(200);
    expect(removed.body.template.exampleImageUrl).toBe('');
    await read(`${api}/${template.id}/example-image`, operator).expect(404);
    await read(copy.body.template.exampleImageUrl, operator).expect(200);
    await mongoose.models.ImagePromptTemplate.updateOne(
      { _id: copy.body.template.id },
      { $set: { isEnabled: false } },
    );
    await read(copy.body.template.exampleImageUrl, operator).expect(404);
    await read(copy.body.template.exampleImageUrl, editor).expect(200);
  });
});
