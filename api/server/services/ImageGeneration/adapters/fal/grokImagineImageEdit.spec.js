jest.mock('./common', () => ({
  pollFalResult: jest.fn(),
  submitFalTask: jest.fn(),
}));

const common = require('./common');
const { buildPayload, generateImage } = require('./grokImagineImageEdit');

describe('Fal Grok Image Edit adapter', () => {
  it('builds the current edit payload and keeps synchronous submit/poll behavior', async () => {
    common.submitFalTask.mockResolvedValue({ request_id: 'grok-request-1' });
    common.pollFalResult.mockResolvedValue({ taskId: 'grok-request-1', status: 'success' });

    expect(
      buildPayload({
        prompt: 'edit',
        imageInputs: ['data:image/png;base64,AAAA'],
        aspectRatio: '4:5',
      }),
    ).toMatchObject({ prompt: 'edit', num_images: 1, aspect_ratio: '4:5' });
    await expect(
      generateImage({
        prompt: 'edit',
        imageInputs: ['data:image/png;base64,AAAA'],
        aspectRatio: '4:5',
      }),
    ).resolves.toMatchObject({ provider: 'fal', taskId: 'grok-request-1' });
    expect(common.submitFalTask).toHaveBeenCalledTimes(1);
    expect(common.pollFalResult).toHaveBeenCalledTimes(1);
  });
});
