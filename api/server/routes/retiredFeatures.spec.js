const express = require('express');
const passport = require('passport');
const request = require('supertest');

jest.mock('~/server/services/AccountStateService', () => ({
  enforceAccountStatus: (_req, _res, next) => Promise.resolve(next()),
}));

const routes = require('./index');

const featurePaths = ['/api/canvas', '/api/video-assistant', '/api/audio'];
const authorization = 'Bearer test-token';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(passport.initialize());
  app.use('/api/canvas', routes.retiredFeatures);
  app.use('/api/video-assistant', routes.retiredFeatures);
  app.use('/api/audio', routes.retiredFeatures);
  app.use('/api/files/speech', (_req, res) => res.json({ active: true }));
  app.use('/api/canvas-extra', (_req, res) => res.json({ active: true }));
  app.use('/api/video-assistant-extra', (_req, res) => res.json({ active: true }));
  app.use('/api/audio-extra', (_req, res) => res.json({ active: true }));
  return app;
}

describe('retired feature API mounts', () => {
  beforeEach(() => {
    jest.spyOn(passport, 'authenticate').mockImplementation((_strategy, _options, callback) => {
      return (req, _res, _next) => {
        const user = req.headers.authorization === authorization ? { id: 'user-1' } : false;
        callback(null, user, user ? undefined : { message: 'Unauthorized' });
      };
    });
  });

  test.each(featurePaths)(
    '%s requires JWT and returns 410 for every method and child path',
    async (base) => {
      const app = makeApp();
      for (const path of [base, `${base}/`, `${base}/nested/item`]) {
        for (const method of ['get', 'post', 'patch', 'delete', 'head']) {
          const unauthenticated = await request(app)[method](path);
          expect(unauthenticated.status).toBe(401);

          const response = await request(app)[method](path).set('Authorization', authorization);
          expect(response.status).toBe(410);
          expect(response.headers['cache-control']).toBe('no-store');
          if (method !== 'head') {
            expect(response.body).toEqual({
              code: 'FEATURE_RETIRED',
              message: expect.stringMatching(/[\u4e00-\u9fff]/),
            });
          }
        }
      }
    },
  );

  test.each([
    '/api/files/speech/tts',
    '/api/canvas-extra',
    '/api/video-assistant-extra',
    '/api/audio-extra',
  ])('%s remains outside retirement mounts', async (path) => {
    const response = await request(makeApp()).get(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active: true });
  });
});
