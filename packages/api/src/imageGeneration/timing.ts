import { createHash } from 'crypto';

type Stage = 'reference_prepare' | 'reference_read' | 'upload' | 'submit' | 'recovery_wait';
type Outcome = 'success' | 'failure' | 'scheduled' | 'resumed';
type Stats = Partial<Record<'imageCount' | 'imageIndex' | 'bytes' | 'scheduledDelayMs', number>>;

const stages = new Set<Stage>([
  'reference_prepare',
  'reference_read',
  'upload',
  'submit',
  'recovery_wait',
]);
const outcomes = new Set<Outcome>(['success', 'failure', 'scheduled', 'resumed']);
const models = new Set(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
const numericFields = ['imageCount', 'imageIndex', 'bytes', 'scheduledDelayMs'] as const;

export function createAPIMartImageTiming({
  taskId,
  model = 'gpt-image-2',
  log,
}: {
  taskId?: string;
  model?: string;
  log: (message: string) => void;
}) {
  const taskHash =
    typeof taskId === 'string' && taskId.length
      ? createHash('sha256').update(taskId).digest('hex').slice(0, 24)
      : undefined;

  function record(stage: Stage, outcome: Outcome, durationMs: number, stats: Stats = {}): void {
    try {
      if (!stages.has(stage) || !outcomes.has(outcome) || !Number.isFinite(durationMs)) {
        return;
      }
      const safeStats: Stats = {};
      for (const key of numericFields) {
        const value = stats[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          safeStats[key] = value;
        }
      }
      log(
        '[ImageGeneration] APIMart timing ' +
          JSON.stringify({
            provider: 'apimart',
            model: models.has(model) ? model : undefined,
            taskHash,
            stage,
            outcome,
            durationMs: Math.max(0, Math.round(durationMs)),
            ...safeStats,
          }),
      );
    } catch {
      /* Observability must never change a paid task's outcome. */
    }
  }

  async function measure<T>(
    stage: Stage,
    operation: () => Promise<T>,
    stats: Stats = {},
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await operation();
      record(stage, 'success', performance.now() - startedAt, stats);
      return result;
    } catch (error) {
      record(stage, 'failure', performance.now() - startedAt, stats);
      throw error;
    }
  }

  return { record, measure };
}

export type APIMartImageTiming = ReturnType<typeof createAPIMartImageTiming>;
