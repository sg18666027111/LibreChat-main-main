import { parseAPIMartTaskFailure, sanitizeAPIMartErrorMessage } from './errors';

describe('APIMart failure diagnostics', () => {
  test.each([
    'Rejected authorization: Basic dXNlcjpzZWNyZXQ=',
    'Rejected api_key="private first private second"',
    "Rejected token='private first private second'",
  ])('redacts entire credential values in %s', (message) => {
    const result = parseAPIMartTaskFailure({ error: { code: 'AUTH', message } });
    expect(result.message).toContain('[redacted]');
    expect(result.message).not.toMatch(/dXNlcjpzZWNyZXQ|private|first|second/);
  });
  test('redacts quoted credentials and multiline echoed inputs before persistence', () => {
    const message =
      'Rejected "api_key":"secret-key" prompt: first private line\nsecond private line';
    const result = parseAPIMartTaskFailure({ data: { error: { code: 'REJECTED', message } } });
    expect(result.code).toBe('REJECTED');
    expect(result.message).toContain('Rejected');
    expect(result.message).not.toMatch(/secret-key|private line/);
  });

  test('does not expose the configured credential through either diagnostic field', () => {
    expect(
      parseAPIMartTaskFailure(
        { error: { code: 'private-key', message: 'Rejected private-key' } },
        'private-key',
      ),
    ).toEqual({ code: 'APIMART_TASK_FAILED', message: 'Rejected [redacted]' });
  });

  test.each([null, [], false, { error: { message: [], code: { private: true } } }])(
    'uses a scalar fallback for malformed responses %j',
    (body) => {
      expect(parseAPIMartTaskFailure(body)).toEqual({
        code: 'APIMART_TASK_FAILED',
        message: 'APIMart task failed',
      });
    },
  );

  test('retains a result-envelope reason while excluding unrelated payload fields', () => {
    const result = parseAPIMartTaskFailure({
      code: 200,
      message: 'success',
      result: {
        error: { code: 17419, message: 'No image returned', prompt: 'private prompt' },
        image: 'private image',
      },
    });
    expect(result).toEqual({ code: '17419', message: 'No image returned' });
  });

  test('bounds long diagnostics and prevents control characters from forging log lines', () => {
    const text = sanitizeAPIMartErrorMessage('Rejected\r\n\u001b' + 'x'.repeat(500));
    expect(text).toHaveLength(240);
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).not.toContain('\u001b');
  });
});
