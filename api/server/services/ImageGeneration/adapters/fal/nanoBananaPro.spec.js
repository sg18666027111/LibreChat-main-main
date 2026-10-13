jest.mock('./common', () => ({
  pollFalResult: jest.fn(),
  submitFalTask: jest.fn(),
}));

const common = require('./common');
const { buildPayload, generateImage } = require('./nanoBananaPro');

describe('Fal Nano Banana Pro adapter', () => {
  it('builds the current text payload and keeps synchronous submit/poll behavior', async () => {
    common.submitFalTask.mockResolvedValue({ request_id: 'nano-request-1' });
    common.pollFalResult.mockResolvedValue({ taskId: 'nano-request-1', status: 'success' });

    expect(buildPayload({ prompt: 'new', count: 2, aspectRatio: '16:9' })).toEqual({
      prompt: 'new',
      num_images: 2,
      aspect_ratio: '16:9',
      resolution: '1K',
    });
    await expect(generateImage({ prompt: 'new' })).resolves.toMatchObject({
      provider: 'fal',
      taskId: 'nano-request-1',
    });
    expect(common.submitFalTask).toHaveBeenCalledTimes(1);
    expect(common.pollFalResult).toHaveBeenCalledTimes(1);
  });
});
