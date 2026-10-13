const path = require('path');
const jestPackage = require.resolve('jest/package.json');
const sequencerEntry = path.join(
  path.dirname(jestPackage),
  'node_modules/@jest/test-sequencer/build/index.js',
);
const Sequencer = require(sequencerEntry).default;

class ServerLifecycleSequencer extends Sequencer {
  sort(tests) {
    const requestedOrder = (process.env.SERVER_LIFECYCLE_TEST_ORDER ?? '')
      .split(',')
      .filter(Boolean);
    if (requestedOrder.length === 0) {
      return super.sort(tests);
    }

    const order = new Map(requestedOrder.map((filename, index) => [filename, index]));
    return [...tests].sort((left, right) => {
      const leftOrder = order.get(path.basename(left.path)) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(path.basename(right.path)) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  }
}

module.exports = ServerLifecycleSequencer;
