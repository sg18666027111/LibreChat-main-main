const { validateEnvelope } = require('./contract');
const { makeEnvelope } = require('./test/fixtures');

describe('private durable usage envelope', () => {
  test('accepts an isolated minimal bill and freezes a detached copy', () => {
    const input = makeEnvelope();
    const result = validateEnvelope(input);
    expect(result.ok).toBe(true);
    expect(result.envelope.event.imageCount).toBe(1);
    input.event.imageCount = 9;
    expect(result.envelope.event.imageCount).toBe(1);
  });
  test.each(['prompt', 'authorization', 'imageUrl', 'cookie', '__proto__'])(
    'rejects metadata key %s without echoing its content',
    (key) => {
      const input = makeEnvelope();
      input.event.metadata = Object.fromEntries([[key, 'must-not-persist']]);
      expect(validateEnvelope(input)).toEqual({ ok: false, reason: 'invalid' });
    },
  );
  test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid image count %s',
    (value) => {
      const input = makeEnvelope();
      input.event.imageCount = value;
      expect(validateEnvelope(input).ok).toBe(false);
    },
  );
  test.each([
    { occurredAt: 'yesterday' },
    { expiresAt: '2026-11-01T00:00:00.000Z' },
    { expiresAt: '2026-09-19T00:00:00.000Z' },
    { revision: -1 },
    { revision: 0.5 },
    { schemaVersion: 2 },
    { source: 'secret' },
    { reportingSubjectId: '' },
  ])('rejects invalid boundary %j', (override) => {
    expect(validateEnvelope(makeEnvelope(override)).ok).toBe(false);
  });
  test('rejects missing event ID and arbitrary event keys', () => {
    const input = makeEnvelope();
    delete input.event.usageEventId;
    expect(validateEnvelope(input).ok).toBe(false);
    input.event.usageEventId = 'one';
    input.event.prompt = 'private';
    expect(validateEnvelope(input).ok).toBe(false);
  });
  test('canonical digest ignores property order but detects changed accounting', () => {
    const a = makeEnvelope();
    const b = { ...a, event: Object.fromEntries(Object.entries(a.event).reverse()) };
    expect(validateEnvelope(b).digest).toBe(validateEnvelope(a).digest);
    b.event.imageCount = 2;
    expect(validateEnvelope(b).digest).not.toBe(validateEnvelope(a).digest);
  });
  test('uses UTF8 bytes rather than characters for oversized input', () => {
    const input = makeEnvelope({ sourceKey: '图'.repeat(11000) });
    expect(validateEnvelope(input)).toEqual({ ok: false, reason: 'oversize' });
  });
  test('rejects cyclic objects and accessor payloads without evaluating them', () => {
    const input = makeEnvelope();
    input.event.metadata = input;
    expect(validateEnvelope(input).ok).toBe(false);
    let evaluated = false;
    Object.defineProperty(input, 'event', {
      get() {
        evaluated = true;
        return {};
      },
    });
    expect(validateEnvelope(input).ok).toBe(false);
    expect(evaluated).toBe(false);
  });
  test('validates frozen pricing without accepting arbitrary nested content', () => {
    const input = makeEnvelope({
      pricing: { kind: 'snapshot', snapshot: { currency: 'CNY', imagePriceCny: 0.25 } },
    });
    expect(validateEnvelope(input).ok).toBe(true);
    input.pricing.snapshot.prompt = 'secret';
    expect(validateEnvelope(input).ok).toBe(false);
  });
  test('rejects signed URLs disguised as metadata IDs', () => {
    const input = makeEnvelope();
    input.event.metadata = { providerTaskId: 'https://host/image?token=secret' };
    expect(validateEnvelope(input).ok).toBe(false);
  });
});

test('accepts plain JSON objects from another runtime realm', () => {
  const vm = require('node:vm');
  const foreign = vm.runInNewContext('JSON.parse(input)', {
    input: JSON.stringify(makeEnvelope()),
  });
  expect(validateEnvelope(foreign).ok).toBe(true);
});
