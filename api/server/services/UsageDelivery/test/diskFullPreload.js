// Runs only under the fault-test subprocess; production never imports this file.
if (!require('node:worker_threads').isMainThread) {
  require('node:fs').statfsSync = () => {
    throw Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
  };
}
