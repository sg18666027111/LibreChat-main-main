const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { logger } = require('@librechat/data-schemas');
const { getActiveAnnouncement } = require('~/server/services/AnnouncementService');

const router = express.Router();

const ANNOUNCEMENT_PATH = path.join(__dirname, '..', 'config', 'announcement.json');

function formatActiveAnnouncement(announcement) {
  if (!announcement) {
    return null;
  }

  return {
    enabled: true,
    id: announcement.id,
    _id: announcement._id,
    version: announcement.version,
    title: announcement.title || '更新公告',
    content: announcement.content || '',
    level: announcement.level || 'normal',
    publishedAt: announcement.publishedAt || null,
  };
}

async function loadConfigAnnouncement() {
  try {
    const raw = await fs.readFile(ANNOUNCEMENT_PATH, 'utf8');
    const announcement = JSON.parse(raw);

    if (!announcement || announcement.enabled !== true) {
      return null;
    }

    return {
      enabled: true,
      id: 'config-announcement',
      _id: 'config-announcement',
      version: announcement.version || null,
      title: announcement.title || '更新公告',
      content: announcement.content || '',
      level: announcement.level || 'normal',
      publishedAt: announcement.publishedAt || null,
      sections: Array.isArray(announcement.sections) ? announcement.sections : [],
    };
  } catch (error) {
    logger.warn('[Announcement] failed to load announcement config', {
      errorCode: error?.code || error?.name || null,
    });
    return null;
  }
}

async function getCurrentAnnouncement(_req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const activeAnnouncement = formatActiveAnnouncement(await getActiveAnnouncement());
    const announcement = activeAnnouncement || (await loadConfigAnnouncement());

    if (!announcement?.enabled) {
      return res.status(200).json({ enabled: false, announcement: null });
    }

    return res.status(200).json({
      ...announcement,
      announcement,
    });
  } catch (error) {
    logger.warn('[Announcement] failed to load active announcement', {
      errorCode: error?.code || error?.name || null,
    });
    return res.status(200).json({ enabled: false, announcement: null });
  }
}

router.get('/current', getCurrentAnnouncement);
router.get('/active', getCurrentAnnouncement);

module.exports = router;
