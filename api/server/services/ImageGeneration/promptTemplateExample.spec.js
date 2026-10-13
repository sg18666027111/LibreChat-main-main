const sharp = require('sharp');
const { Readable } = require('stream');
const mockMethods = { getImagePromptTemplateById: jest.fn(), updateImagePromptTemplate: jest.fn() };
jest.mock('@librechat/data-schemas', () => ({
  createMethods: () => mockMethods,
  logger: { warn: jest.fn() },
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/models', () => ({ createFile: jest.fn() }));
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { createFile } = require('~/models');
const {
  saveExampleImage,
  removeExampleImage,
  readExampleImage,
} = require('./promptTemplateExample');
const original = {
  _id: 'template-id',
  key: 'template',
  name: 'Template',
  category: 'batch_packaging',
  prompt: 'Original prompt',
  formattedPrompt: 'Formatted prompt',
  activePromptSource: 'formatted',
  exampleImage: {
    id: 'old-image',
    source: 'local',
    filepath: '/images/uploader/example.png',
    type: 'image/png',
  },
  isEnabled: true,
};
let stored;
let req;
let strategy;
beforeEach(async () => {
  jest.clearAllMocks();
  stored = { ...original };
  req = {
    user: { id: 'editor', tenantId: 'tenant-1' },
    config: { fileStrategy: 'local' },
    file: {
      buffer: await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#eee' } })
        .png()
        .toBuffer(),
    },
  };
  mockMethods.getImagePromptTemplateById.mockImplementation(async () => stored);
  mockMethods.updateImagePromptTemplate.mockImplementation(async ({ updates }) => {
    stored = { ...stored, ...updates };
    return stored;
  });
  strategy = {
    deleteFile: jest.fn(),
    saveBuffer: jest.fn(async () => '/images/editor/new.png'),
    getDownloadStream: jest.fn(async () => Readable.from('image')),
  };
  getStrategyFunctions.mockReturnValue(strategy);
});

test('saves a single shared template image through the existing adapter without a deletable personal File', async () => {
  const result = await saveExampleImage(req, 'template-id');
  expect(strategy.saveBuffer).toHaveBeenCalledWith({
    userId: 'editor',
    tenantId: 'tenant-1',
    fileName: expect.stringMatching(/-template-example.png$/),
    buffer: expect.any(Buffer),
  });
  const dimensions = await sharp(strategy.saveBuffer.mock.calls[0][0].buffer).metadata();
  expect(dimensions.width).toBe(1024);
  expect(dimensions.height).toBe(683);
  expect(stored).toMatchObject({
    prompt: original.prompt,
    formattedPrompt: original.formattedPrompt,
    activePromptSource: 'formatted',
  });
  expect(stored.exampleImage).toMatchObject({
    source: 'local',
    filepath: '/images/editor/new.png',
    type: 'image/png',
  });
  expect(result.exampleImageUrl).toBe(
    `/api/image-generation/prompt-templates/template-id/example-image?v=${stored.exampleImage.id}`,
  );
  expect(createFile).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('exampleImage');
});

test('honors configured image-specific storage', async () => {
  req.config.fileStrategies = { image: 'azure', default: 'local' };
  await saveExampleImage(req, 'template-id');
  expect(getStrategyFunctions).toHaveBeenCalledWith('azure');
  expect(stored.exampleImage.source).toBe('azure');
});

test('removal clears only this reference and preserves shared files and prompt selection', async () => {
  const result = await removeExampleImage(req, 'template-id');
  expect(stored).toMatchObject({ ...original, exampleImage: null });
  expect(result.exampleImageUrl).toBe('');
  expect(strategy.deleteFile).not.toHaveBeenCalled();
});

test('ordinary operators read another uploader image through the visible shared template', async () => {
  req.user.id = 'ordinary-operator';
  const result = await readExampleImage(req, 'template-id', false);
  expect(result.contentType).toBe('image/png');
  expect(strategy.getDownloadStream).toHaveBeenCalledWith(req, '/images/uploader/example.png');
});

test('uses durable storage keys rather than expired signed URLs', async () => {
  stored.exampleImage = {
    id: 's3-image',
    source: 's3',
    type: 'image/webp',
    filepath: 'https://expired.invalid/image',
    storageKey: 'images/u/example.webp',
  };
  await readExampleImage(req, 'template-id', false);
  expect(strategy.getDownloadStream).toHaveBeenCalledWith(req, 'images/u/example.webp');
});

test.each([
  ['missing template', null],
  ['other category', { ...original, category: 'single_generation' }],
])('rejects %s before storage', async (_label, template) => {
  stored = template;
  await expect(saveExampleImage(req, 'template-id')).rejects.toMatchObject({ statusCode: 404 });
  expect(strategy.saveBuffer).not.toHaveBeenCalled();
});

test.each([
  ['legacy template', { ...original, exampleImage: undefined }],
  ['disabled template', { ...original, isEnabled: false }],
])('returns a safe missing response for a %s', async (_label, template) => {
  stored = template;
  await expect(readExampleImage(req, 'template-id', false)).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(strategy.getDownloadStream).not.toHaveBeenCalled();
});

test('editors can preview disabled templates', async () => {
  stored.isEnabled = false;
  await expect(readExampleImage(req, 'template-id', true)).resolves.toHaveProperty('stream');
});

test('rejects invalid image bytes without changing the existing example', async () => {
  req.file.buffer = Buffer.from('not an image');
  await expect(saveExampleImage(req, 'template-id')).rejects.toMatchObject({ statusCode: 400 });
  expect(strategy.saveBuffer).not.toHaveBeenCalled();
  expect(stored.exampleImage.id).toBe('old-image');
});

test('storage failures preserve the old example', async () => {
  strategy.saveBuffer.mockRejectedValue(new Error('storage unavailable'));
  await expect(saveExampleImage(req, 'template-id')).rejects.toThrow('storage unavailable');
  expect(mockMethods.updateImagePromptTemplate).not.toHaveBeenCalled();
  expect(stored.exampleImage.id).toBe('old-image');
});

test('empty storage results never overwrite the existing example', async () => {
  strategy.saveBuffer.mockResolvedValue(null);
  await expect(saveExampleImage(req, 'template-id')).rejects.toThrow();
  expect(mockMethods.updateImagePromptTemplate).not.toHaveBeenCalled();
});

test('cleans an unattached upload if saving the template fails', async () => {
  mockMethods.updateImagePromptTemplate.mockRejectedValue(new Error('save failed'));
  await expect(saveExampleImage(req, 'template-id')).rejects.toThrow('save failed');
  expect(strategy.deleteFile).toHaveBeenCalledWith(
    req,
    expect.objectContaining({ filepath: '/images/editor/new.png' }),
  );
});
