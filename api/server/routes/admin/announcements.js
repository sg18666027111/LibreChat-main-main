const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const {
  createAnnouncement,
  listAnnouncements,
  setAnnouncementEnabled,
  updateAnnouncement,
} = require('~/server/services/AnnouncementService');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);

router.use(requireJwtAuth, requireAdminAccess);

function getCreatedBy(req) {
  return req.user?._id || req.user?.id || null;
}

function handleError(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    logger.error('[AnnouncementAdmin] request failed', {
      errorCode: error?.code || error?.name || null,
    });
  }
  return res.status(statusCode).json({ message: error?.message || '公告操作失败，请稍后重试。' });
}

router.get('/', async (_req, res) => {
  try {
    const announcements = await listAnnouncements();
    return res.json({ announcements });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const announcement = await createAnnouncement(req.body, getCreatedBy(req));
    logger.info('[AnnouncementAdmin] announcement saved', {
      announcementId: announcement.id,
      version: announcement.version,
      enabled: announcement.enabled,
      createdBy: announcement.createdBy,
    });
    return res.status(201).json({ announcement });
  } catch (error) {
    return handleError(res, error);
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const announcement = await updateAnnouncement(req.params.id, req.body);
    if (!announcement) {
      return res.status(404).json({ message: '公告不存在。' });
    }
    logger.info('[AnnouncementAdmin] announcement updated', {
      announcementId: announcement.id,
      version: announcement.version,
      enabled: announcement.enabled,
      createdBy: announcement.createdBy,
    });
    return res.json({ announcement });
  } catch (error) {
    return handleError(res, error);
  }
});

router.patch('/:id/enabled', async (req, res) => {
  try {
    const announcement = await setAnnouncementEnabled(req.params.id, req.body?.enabled === true);
    if (!announcement) {
      return res.status(404).json({ message: '公告不存在。' });
    }
    logger.info('[AnnouncementAdmin] announcement enabled changed', {
      announcementId: announcement.id,
      version: announcement.version,
      enabled: announcement.enabled,
      createdBy: announcement.createdBy,
    });
    return res.json({ announcement });
  } catch (error) {
    return handleError(res, error);
  }
});

module.exports = router;
