const mongoose = require('mongoose');

const ANNOUNCEMENT_MODEL_NAME = 'Announcement';
const TITLE_LIMIT = 80;
const CONTENT_LIMIT = 3000;
const LEVELS = new Set(['normal', 'important']);

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: TITLE_LIMIT },
    content: { type: String, required: true, maxlength: CONTENT_LIMIT },
    enabled: { type: Boolean, default: false, index: true },
    level: { type: String, enum: Array.from(LEVELS), default: 'normal' },
    version: { type: Number, required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

announcementSchema.index({ enabled: 1, publishedAt: -1, updatedAt: -1 });

const Announcement =
  mongoose.models[ANNOUNCEMENT_MODEL_NAME] ||
  mongoose.model(ANNOUNCEMENT_MODEL_NAME, announcementSchema);

function normalizeText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeAnnouncementPayload(payload = {}) {
  const title = normalizeText(payload.title, TITLE_LIMIT);
  const content = normalizeText(payload.content, CONTENT_LIMIT);
  const enabled = payload.enabled === true;
  const level = LEVELS.has(payload.level) ? payload.level : 'normal';

  if (!title) {
    const error = new Error('公告标题不能为空。');
    error.statusCode = 400;
    throw error;
  }

  if (!content) {
    const error = new Error('公告内容不能为空。');
    error.statusCode = 400;
    throw error;
  }

  return { title, content, enabled, level };
}

function nextVersion() {
  return Date.now();
}

function serializeAnnouncement(doc) {
  if (!doc) {
    return null;
  }

  return {
    id: doc._id?.toString?.() ?? doc._id,
    _id: doc._id?.toString?.() ?? doc._id,
    title: doc.title,
    content: doc.content,
    enabled: Boolean(doc.enabled),
    level: doc.level || 'normal',
    version: doc.version,
    createdBy: doc.createdBy?.toString?.() ?? doc.createdBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
  };
}

async function getActiveAnnouncement() {
  const doc = await Announcement.findOne({ enabled: true })
    .sort({ publishedAt: -1, updatedAt: -1, _id: -1 })
    .lean();
  return serializeAnnouncement(doc);
}

async function listAnnouncements() {
  const docs = await Announcement.find({}).sort({ updatedAt: -1, _id: -1 }).limit(50).lean();
  return docs.map(serializeAnnouncement);
}

async function createAnnouncement(payload, createdBy) {
  const data = normalizeAnnouncementPayload(payload);
  const now = new Date();
  const doc = await Announcement.create({
    ...data,
    version: nextVersion(),
    createdBy: createdBy || null,
    publishedAt: data.enabled ? now : null,
  });
  return serializeAnnouncement(doc);
}

async function updateAnnouncement(id, payload) {
  const data = normalizeAnnouncementPayload(payload);
  const doc = await Announcement.findById(id);
  if (!doc) {
    return null;
  }

  const wasEnabled = doc.enabled === true;
  doc.title = data.title;
  doc.content = data.content;
  doc.enabled = data.enabled;
  doc.level = data.level;
  doc.version = nextVersion();
  doc.publishedAt = data.enabled ? (wasEnabled ? doc.publishedAt || new Date() : new Date()) : null;
  await doc.save();
  return serializeAnnouncement(doc);
}

async function setAnnouncementEnabled(id, enabled) {
  const doc = await Announcement.findById(id);
  if (!doc) {
    return null;
  }

  doc.enabled = enabled === true;
  doc.version = nextVersion();
  doc.publishedAt = doc.enabled ? new Date() : null;
  await doc.save();
  return serializeAnnouncement(doc);
}

module.exports = {
  CONTENT_LIMIT,
  TITLE_LIMIT,
  createAnnouncement,
  getActiveAnnouncement,
  listAnnouncements,
  setAnnouncementEnabled,
  updateAnnouncement,
};
