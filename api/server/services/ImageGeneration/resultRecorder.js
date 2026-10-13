const fs = require('fs/promises');
const path = require('path');

const RESULT_LOG_PATH =
  process.env.IMAGE_GENERATION_RESULT_LOG_PATH || '/tmp/jingjicang-image-generation-results.jsonl';

async function recordImageGenerationResult(record) {
  const userId = record.userId || record.createdBy || null;
  const safeRecord = {
    userId,
    requestId: record.requestId || null,
    taskType: record.taskType || null,
    modelKey: record.modelKey || null,
    model: record.model || null,
    provider: record.provider || null,
    status: record.status || null,
    errorCode: record.errorCode || null,
    durationMs: record.durationMs ?? null,
    outputCount: record.outputCount ?? null,
    resultHost: record.resultHost || null,
    createdAt: record.createdAt || new Date().toISOString(),
  };

  await fs.mkdir(path.dirname(RESULT_LOG_PATH), { recursive: true });
  await fs.appendFile(RESULT_LOG_PATH, `${JSON.stringify(safeRecord)}\n`);
  return safeRecord;
}

module.exports = {
  RESULT_LOG_PATH,
  recordImageGenerationResult,
};
