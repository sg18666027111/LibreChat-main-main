const express = require('express');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

router.use(requireJwtAuth);
router.use((_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(410).json({
    code: 'FEATURE_RETIRED',
    message: '该功能已下线，请使用 AI 生图。',
  });
});

module.exports = router;
