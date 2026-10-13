const { randomUUID } = require('crypto');
const db = require('~/models');
const {
  APIMART_IMG2_INPUT_FILE_TTL_MS,
  cleanupAPIMartImg2InputRefs,
  resolveAPIMartImg2JobPayload,
  stageAPIMartImg2ImageInputs,
} = require('./apimartImg2InputStorage');

const NONTERMINAL_STATUSES = new Set(['waiting', 'submitting', 'polling']);

async function stageImageEgressInputs({ req, requestId, taskType, imageInputs, metadata }) {
  const refs = await stageAPIMartImg2ImageInputs({
    req,
    requestId,
    taskType,
    imageInputs,
    metadata,
  });
  return { refs, stagingBatchId: randomUUID() };
}

async function resolveImageEgressInputRefs({ userId, tenantId, refs, payload, storageConfig }) {
  return resolveAPIMartImg2JobPayload({
    userId,
    tenantId,
    payload: { ...payload, imageInputRefs: refs },
    storageConfig,
  });
}

function getFileIds(refs) {
  return (Array.isArray(refs) ? refs : []).map((ref) => ref?.fileId).filter(Boolean);
}

async function promoteImageEgressInputRefsToJobOwnership({ internalTaskId, refs }) {
  const fileIds = getFileIds(refs);
  if (!fileIds.length) {
    return { promotedFileIds: [] };
  }
  const job = await db.getImageGenerationJob({ internalTaskId, includeSensitive: true });
  const ownedIds = new Set(getFileIds(job?.payload?.imageInputRefs));
  const ownsExactRefs =
    job?.asyncVersion === 3 &&
    job?.workerFamily === 'image-egress-v1' &&
    job?.workerEligible === false &&
    NONTERMINAL_STATUSES.has(job?.status) &&
    fileIds.length === ownedIds.size &&
    fileIds.every((fileId) => ownedIds.has(fileId));

  if (!ownsExactRefs) {
    const error = new Error('Image egress staged input ownership could not be verified');
    error.code = 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED';
    throw error;
  }

  const promotedFileIds = [];
  try {
    for (const fileId of fileIds) {
      const updated = await db.updateFile({ file_id: fileId, expiredAt: null });
      if (!updated) {
        const error = new Error('Image egress staged input retention promotion failed');
        error.code = 'IMAGE_EGRESS_INPUT_OWNERSHIP_FAILED';
        throw error;
      }
      promotedFileIds.push(fileId);
    }
  } catch (error) {
    const expiredAt = new Date(Date.now() + APIMART_IMG2_INPUT_FILE_TTL_MS);
    await Promise.allSettled(
      promotedFileIds.map((fileId) => db.updateFile({ file_id: fileId, expiredAt })),
    );
    throw error;
  }
  return { promotedFileIds };
}

async function cleanupImageEgressInputRefs({
  req,
  userId,
  tenantId,
  refs,
  payload,
  storageConfig,
  now = new Date(),
}) {
  const inputRefs = refs || payload?.imageInputRefs || [];
  const ownerId = userId || req?.user?.id;
  const ownerTenantId = tenantId || req?.user?.tenantId;
  for (const fileId of getFileIds(inputRefs)) {
    const updated = await db.updateFile({ file_id: fileId, expiredAt: now });
    if (!updated) {
      const existing = await db.findFileById(fileId, {
        user: ownerId,
        ...(ownerTenantId ? { tenantId: ownerTenantId } : { tenantId: null }),
      });
      if (existing) {
        const error = new Error('Image egress input cleanup retention could not be confirmed');
        error.code = 'IMAGE_EGRESS_INPUT_CLEANUP_NOT_DURABLE';
        throw error;
      }
    }
  }
  await cleanupAPIMartImg2InputRefs({
    req,
    userId,
    tenantId,
    refs: inputRefs,
    storageConfig,
  });
}

module.exports = {
  cleanupImageEgressInputRefs,
  promoteImageEgressInputRefsToJobOwnership,
  resolveImageEgressInputRefs,
  stageImageEgressInputs,
};
