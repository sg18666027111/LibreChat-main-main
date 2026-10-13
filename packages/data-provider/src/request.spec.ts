import axios from 'axios';
import request from './request';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('request.post', () => {
  beforeEach(() => {
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });
  });

  it('keeps the existing two-argument JSON post behavior', async () => {
    await expect(request.post('/api/example', { name: 'desk' })).resolves.toEqual({ ok: true });

    expect(mockedAxios.post).toHaveBeenCalledWith('/api/example', JSON.stringify({ name: 'desk' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('passes AbortSignal through axios config without adding it to the request body', async () => {
    const controller = new AbortController();

    await expect(
      request.post('/api/example', { name: 'desk' }, { signal: controller.signal }),
    ).resolves.toEqual({ ok: true });

    expect(mockedAxios.post).toHaveBeenCalledWith('/api/example', JSON.stringify({ name: 'desk' }), {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
