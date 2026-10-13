require('module-alias/register');
require('dotenv').config({ path: '/app/.env' });
require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { buildWhiteBackgroundScenePrompt } = require('../prompt');
const { maskKey, getAPIMartConfig } = require('../adapters/apimart/common');
const { APIMART_IMAGE_MODELS, generateAPIMartImage } = require('../adapters/apimart');
const { RESULT_LOG_PATH, recordImageGenerationResult } = require('../resultRecorder');

const DEBUG_DIR = process.env.IMAGE_GENERATION_DEBUG_DIR || '/tmp/jingjicang-image-debug';
const SAVE_DEBUG_IMAGES = process.env.IMAGE_GENERATION_SAVE_DEBUG === 'true';

function toImageMetadataLog(metadata) {
  return {
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
    channels: metadata.channels,
  };
}

async function createTransparentProductImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">
      <rect width="900" height="900" fill="transparent"/>
      <rect x="280" y="150" width="340" height="590" rx="42" fill="#fbf7ef" stroke="#2b2b2b" stroke-width="10"/>
      <rect x="325" y="235" width="250" height="155" rx="22" fill="#d83b35"/>
      <text x="450" y="325" text-anchor="middle" font-size="54" font-family="Arial" fill="#ffffff" font-weight="700">商品</text>
      <rect x="335" y="455" width="230" height="120" rx="18" fill="#ffffff" stroke="#dddddd" stroke-width="4"/>
      <circle cx="390" cy="515" r="28" fill="#f2c66d"/>
      <circle cx="450" cy="515" r="28" fill="#c97338"/>
      <circle cx="510" cy="515" r="28" fill="#7f4b2a"/>
      <text x="450" y="655" text-anchor="middle" font-size="42" font-family="Arial" fill="#333333">白底图</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function prepareImageInput(buffer, fileName) {
  const originalMetadata = await sharp(buffer).metadata();
  const hasAlpha = Boolean(originalMetadata.hasAlpha);
  const pipeline = sharp(buffer).rotate();
  const sentBuffer = hasAlpha
    ? await pipeline.flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer()
    : await pipeline.png().toBuffer();
  const sentMetadata = await sharp(sentBuffer).metadata();
  let debugPath = null;

  if (SAVE_DEBUG_IMAGES) {
    debugPath = path.join(DEBUG_DIR, fileName);
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(debugPath, sentBuffer);
  }

  return {
    dataURL: `data:image/png;base64,${sentBuffer.toString('base64')}`,
    debugPath,
    originalImage: toImageMetadataLog(originalMetadata),
    sentImage: toImageMetadataLog(sentMetadata),
    alphaFlattened: hasAlpha,
  };
}

function summarizeError(error) {
  return {
    message: error.message,
    statusCode: error.statusCode || null,
    lastError: error.lastError || null,
  };
}

async function runCase({ model, taskType, imageInputs = [] }) {
  const startedAt = Date.now();
  const platform = '小红书';
  const imageType = taskType === 'text-to-image' ? '通用营销图' : '种草图';
  const prompt =
    taskType === 'text-to-image'
      ? '一款坚果零食包装，放在自然光木质桌面上，干净高级，适合电商营销图。'
      : '把这张白底商品图做成自然光厨房桌面种草图，背景干净，有生活方式感，商品主体完整清晰。';
  const finalPrompt =
    taskType === 'text-to-image'
      ? prompt
      : buildWhiteBackgroundScenePrompt({ prompt, platform, imageType, aspectRatio: '3:4' });

  const baseRecord = {
    model,
    taskType,
    platform,
    imageType,
    inputImageCount: imageInputs.length,
    provider: 'apimart',
    durationMs: null,
    status: 'failed',
    userId: 'local-apimart-verify',
  };

  try {
    const result = await generateAPIMartImage({
      model,
      taskType,
      prompt: finalPrompt,
      imageInputs,
      size: taskType === 'text-to-image' ? '1024x1024' : '768x1024',
      count: 1,
    });
    const durationMs = Date.now() - startedAt;
    await recordImageGenerationResult({
      ...baseRecord,
      durationMs,
      status: 'success',
    });

    return {
      model,
      taskType,
      ok: true,
      taskIdReturned: Boolean(result.taskId),
      resultUrlReturned: Boolean(result.resultUrl),
      pollPath: result.pollPath || null,
      durationMs,
      payloadKeys: Object.keys(result.payload || {}),
      responseKeys: result.responseKeys || [],
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await recordImageGenerationResult({
      ...baseRecord,
      durationMs,
      errorCode: error.code || error.statusCode || 'APIMART_VERIFY_FAILED',
    });

    return {
      model,
      taskType,
      ok: false,
      taskIdReturned: Boolean(error.providerTaskId),
      durationMs,
      submitResponseKeys: error.submitResponseKeys || [],
      error: summarizeError(error),
    };
  }
}

async function main() {
  const config = getAPIMartConfig();
  const productBuffer = await createTransparentProductImage();
  const preparedImage = await prepareImageInput(productBuffer, 'apimart-single-image-input.png');
  const results = [];

  console.log(
    JSON.stringify(
      {
        apimartKeyMasked: maskKey(config.apiKey),
        baseURL: config.baseURL,
        models: APIMART_IMAGE_MODELS,
        pollIntervalMs: 3000,
        pollTimeoutMs: 90000,
        debugImageSaved: Boolean(preparedImage.debugPath),
        originalImage: preparedImage.originalImage,
        sentImage: preparedImage.sentImage,
        alphaFlattened: preparedImage.alphaFlattened,
        resultLogPath: RESULT_LOG_PATH,
      },
      null,
      2,
    ),
  );

  for (const model of APIMART_IMAGE_MODELS) {
    results.push(await runCase({ model, taskType: 'text-to-image' }));
    results.push(
      await runCase({
        model,
        taskType: 'single-image-edit',
        imageInputs: [preparedImage.dataURL],
      }),
    );
  }

  console.log(JSON.stringify({ results }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: summarizeError(error) }, null, 2));
  process.exit(1);
});
