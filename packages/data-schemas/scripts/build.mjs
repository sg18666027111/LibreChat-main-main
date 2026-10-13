import { rollup } from 'rollup';
import config from '../rollup.config.js';

function closeLingeringWatchers() {
  if (typeof process._getActiveHandles !== 'function') {
    return 0;
  }

  let closed = 0;
  for (const handle of process._getActiveHandles()) {
    const handleType = handle?.constructor?.name;
    if (
      (handleType === 'FSWatcher' || handleType === 'StatWatcher') &&
      typeof handle.close === 'function'
    ) {
      handle.close();
      closed += 1;
    }
  }

  return closed;
}

async function build() {
  const buildConfig = {
    ...config,
    onwarn() {
      // Matches the previous Rollup CLI invocation with --silent.
    },
  };
  const bundle = await rollup(buildConfig);

  try {
    const outputs = Array.isArray(config.output) ? config.output : [config.output];
    for (const output of outputs) {
      await bundle.write(output);
    }
  } finally {
    await bundle.close();
  }

  await new Promise((resolve) => setImmediate(resolve));
  closeLingeringWatchers();
}

build()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
