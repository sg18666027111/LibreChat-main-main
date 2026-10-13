#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { createUsageSourceStore } = require('../api/server/services/UsageDelivery/sourceStore');
const {
  reconcileUsageSources,
  SOURCES,
} = require('../api/server/services/UsageDelivery/sourceReconciler');
function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    if (arg === '--dry-run' && !options.dryRun) {
      options.dryRun = true;
      continue;
    }
    const match = /^--(since|until|limit|output)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('Invalid option');
    options[match[1]] = match[2];
  }
  options.limit = Number(options.limit ?? 100);
  if (
    !options.dryRun ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100 ||
    !path.isAbsolute(options.output || '')
  )
    throw new Error('Invalid dry-run options');
  for (const field of ['since', 'until'])
    if (
      !options[field] ||
      !Number.isFinite(Date.parse(options[field])) ||
      new Date(options[field]).toISOString() !== options[field]
    )
      throw new Error('Invalid date interval');
  if (Date.parse(options.since) >= Date.parse(options.until))
    throw new Error('Invalid date interval');
  return options;
}
async function runDryRun({ options, db, now = Date.now }) {
  const store = createUsageSourceStore(db);
  const report = {
    mode: 'dry-run',
    since: options.since,
    until: options.until,
    generatedAt: new Date(now()).toISOString(),
    pageLimitPerSource: options.limit,
    complete: true,
    sources: {},
  };
  for (const source of SOURCES) {
    const result = await reconcileUsageSources({
      mode: 'dry-run',
      limit: options.limit,
      now,
      readPage: ({ after, limit }) =>
        store.readPage({
          source,
          after,
          limit,
          mode: 'dry-run',
          since: options.since,
          until: options.until,
        }),
      readLedger: store.readLedger,
    });
    report.sources[source] = result;
    if (result.cursor) report.complete = false;
  }
  return report;
}
async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseOptions(args);
  } catch {
    process.stderr.write(
      'Usage: --dry-run --since=<UTC ISO> --until=<UTC ISO> --limit=1..100 --output=<new absolute path>\n',
    );
    return 2;
  }
  if (!process.env.MONGO_URI) {
    process.stderr.write('MONGO_URI is required; no default database is selected.\n');
    return 2;
  }
  // Native driver only: no application bootstrap, schemas, autoIndex, seed, or migrations.
  const client = new MongoClient(process.env.MONGO_URI, {
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
  let file;
  try {
    file = await fs.open(options.output, 'wx', 0o600);
    await client.connect();
    const report = await runDryRun({ options, db: client.db() });
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await file.sync();
    process.stdout.write(
      `Read-only report saved; complete=${report.complete}. No ledger records were changed.\n`,
    );
    return 0;
  } catch {
    process.stderr.write('Read-only report failed; database details were not logged.\n');
    return 1;
  } finally {
    await file?.close();
    await client.close();
  }
}
if (require.main === module)
  main().then((code) => {
    process.exitCode = code;
  });
module.exports = { parseOptions, runDryRun, main };
