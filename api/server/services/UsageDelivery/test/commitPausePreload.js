/* Fault hook is injected only by recovery.process.spec.js, never application code. */
const { isMainThread, Worker, parentPort } = require('node:worker_threads');
if (isMainThread) {
  const emit = Worker.prototype.emit;
  Worker.prototype.emit = function (name, message, ...rest) {
    if (name === 'message' && message?.fixtureBoundary === 'sqlite_before_commit')
      process.send({ event: 'sqlite_before_commit' });
    return emit.call(this, name, message, ...rest);
  };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  let inserted = false;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (sql.startsWith('INSERT INTO delivery(')) {
      const run = statement.run;
      statement.run = function (...values) {
        const result = run.apply(this, values);
        inserted = true;
        return result;
      };
    }
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (sql === 'COMMIT' && inserted) {
      parentPort.postMessage({ fixtureBoundary: 'sqlite_before_commit' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return exec.call(this, sql, ...args);
  };
}
