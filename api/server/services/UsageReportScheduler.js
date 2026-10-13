const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  cleanupOldReports,
  generateDailyUsageReport,
} = require('~/server/services/UsageReportService');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getNextShanghaiTen(now = new Date()) {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const candidateLocal = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 10, 0, 0, 0),
  );
  let candidateUtc = new Date(candidateLocal.getTime() - SHANGHAI_OFFSET_MS);
  if (candidateUtc <= now) {
    candidateUtc = new Date(candidateUtc.getTime() + DAY_MS);
  }
  return candidateUtc;
}

function startUsageReportScheduler() {
  let timer = null;

  const runAndReschedule = async () => {
    try {
      await runAsSystem(async () => {
        await generateDailyUsageReport({ now: new Date(), email: true });
        await cleanupOldReports();
      });
    } catch (error) {
      logger.error('[UsageReportScheduler] Daily usage report failed', error);
    } finally {
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    const next = getNextShanghaiTen();
    timer = setTimeout(runAndReschedule, Math.max(1000, next.getTime() - Date.now()));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    logger.info('[UsageReportScheduler] Next daily usage report scheduled', {
      at: next.toISOString(),
      timezone: 'Asia/Shanghai',
    });
  };

  runAsSystem(async () => {
    await generateDailyUsageReport({ now: new Date(), email: false });
  }).catch((error) => logger.warn('[UsageReportScheduler] Startup report catch-up failed', error));

  scheduleNext();
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  getNextShanghaiTen,
  startUsageReportScheduler,
};
