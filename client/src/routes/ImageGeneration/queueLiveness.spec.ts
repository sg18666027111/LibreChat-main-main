import {
  IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT,
  IMAGE_GENERATION_LEASE_STORAGE_KEY,
  claimImageGenerationLease,
  clearImageGenerationLease,
  createImageGenerationJobFingerprint,
  createImageGenerationLease,
  getActiveImageGenerationLease,
  getActiveImageGenerationLeases,
  getImageGenerationClientWaitConfig,
  getImageGenerationLeaseId,
  readStoredImageGenerationLeaseRegistry,
  writeImageGenerationLease,
} from './queueLiveness';

describe('ImageGeneration queue liveness configuration', () => {
  test.each([{ modelKey: 'apimart_gpt_image_2_5_sunburst' }, { model: 'gpt-image-2.5-sunburst' }])(
    'keeps Sunburst multi-reference waits aligned with backend polling: %j',
    (selection) => {
      expect(
        getImageGenerationClientWaitConfig({ taskType: 'dual-product-replace', ...selection }),
      ).toMatchObject({ profile: 'apimart_multi_reference', hardTimeoutMs: 660000 });
    },
  );

  afterEach(() => {
    localStorage.removeItem(IMAGE_GENERATION_LEASE_STORAGE_KEY);
    jest.useRealTimers();
  });

  it('uses the 6 minute hard wait for normal single-image tasks', () => {
    const config = getImageGenerationClientWaitConfig({
      taskType: 'text-to-image',
      model: 'Qwen/Qwen-Image',
    });

    expect(config.profile).toBe('default');
    expect(config.softTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.hardTimeoutMs).toBe(6 * 60 * 1000);
  });

  it('uses the 11 minute hard wait for APIMart multi-reference tasks', () => {
    const config = getImageGenerationClientWaitConfig({
      taskType: 'dual-product-replace',
      modelKey: 'apimart_gpt_image_2',
      model: 'gpt-image-2',
    });

    expect(config.profile).toBe('apimart_multi_reference');
    expect(config.softTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.hardTimeoutMs).toBe(11 * 60 * 1000);
  });

  it('keeps an unexpired status_unknown lease active', () => {
    const startedAt = Date.now();
    localStorage.setItem(
      IMAGE_GENERATION_LEASE_STORAGE_KEY,
      JSON.stringify({
        tabSessionId: 'foreign-tab',
        localTaskId: 'foreign-task',
        taskType: 'text-to-image',
        startedAt,
        leaseExpiresAt: startedAt + 60_000,
        status: 'status_unknown',
      }),
    );

    expect(getActiveImageGenerationLease()).toEqual(
      expect.objectContaining({
        tabSessionId: 'foreign-tab',
        localTaskId: 'foreign-task',
        status: 'status_unknown',
      }),
    );
  });

  it('allows different active jobs to claim independent cross-tab slots under the limit', async () => {
    const startedAt = Date.now();
    const first = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'text-to-image',
      jobFingerprint: 'job-a',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt,
    });
    const second = createImageGenerationLease({
      tabSessionId: 'tab-b',
      localTaskId: 'task-b',
      taskType: 'text-to-image',
      jobFingerprint: 'job-b',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt: startedAt + 1,
    });

    expect(await claimImageGenerationLease(first)).toEqual(expect.objectContaining({ ok: true }));
    expect(await claimImageGenerationLease(second)).toEqual(expect.objectContaining({ ok: true }));

    const registry = readStoredImageGenerationLeaseRegistry();
    expect(Object.keys(registry.leases).sort()).toEqual(
      [getImageGenerationLeaseId(first), getImageGenerationLeaseId(second)].sort(),
    );
    expect(getActiveImageGenerationLeases().map(getImageGenerationLeaseId).sort()).toEqual(
      [getImageGenerationLeaseId(first), getImageGenerationLeaseId(second)].sort(),
    );
  });

  it('blocks an eighth active cross-tab lease even when duplicate risk is confirmed', async () => {
    const startedAt = Date.now();
    for (let index = 0; index < IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT; index += 1) {
      writeImageGenerationLease(
        createImageGenerationLease({
          tabSessionId: `tab-${index}`,
          localTaskId: `task-${index}`,
          taskType: 'text-to-image',
          jobFingerprint: `job-${index}`,
          hardTimeoutMs: 6 * 60 * 1000,
          status: index === 0 ? 'status_unknown' : 'running',
          startedAt: startedAt + index,
        }),
      );
    }

    const eighth = createImageGenerationLease({
      tabSessionId: 'tab-eight',
      localTaskId: 'task-eight',
      taskType: 'text-to-image',
      jobFingerprint: 'job-eight',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt: startedAt + 8,
    });

    await expect(claimImageGenerationLease(eighth, { force: true })).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'concurrency_limit',
        activeCount: IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT,
      }),
    );
    expect(getActiveImageGenerationLeases()).toHaveLength(
      IMAGE_GENERATION_CROSS_TAB_CONCURRENCY_LIMIT,
    );
    expect(
      readStoredImageGenerationLeaseRegistry().leases[getImageGenerationLeaseId(eighth)],
    ).toBeUndefined();
  });

  it('requires confirmation for the same job fingerprint but keeps the original lease when confirmed', async () => {
    const startedAt = Date.now();
    const first = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'text-to-image',
      jobFingerprint: 'same-job',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt,
    });
    const duplicate = createImageGenerationLease({
      tabSessionId: 'tab-b',
      localTaskId: 'task-b',
      taskType: 'text-to-image',
      jobFingerprint: 'same-job',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt: startedAt + 1,
    });

    expect(await claimImageGenerationLease(first)).toEqual(expect.objectContaining({ ok: true }));
    await expect(claimImageGenerationLease(duplicate)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'duplicate_fingerprint',
        blockingLease: first,
        activeCount: 1,
      }),
    );

    await expect(claimImageGenerationLease(duplicate, { force: true })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(getActiveImageGenerationLeases().map(getImageGenerationLeaseId).sort()).toEqual(
      [getImageGenerationLeaseId(first), getImageGenerationLeaseId(duplicate)].sort(),
    );
  });

  it('clears only the matching owner lease from the registry', () => {
    const startedAt = Date.now();
    const first = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'text-to-image',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'status_unknown',
      startedAt,
    });
    const second = createImageGenerationLease({
      tabSessionId: 'tab-b',
      localTaskId: 'task-b',
      taskType: 'text-to-image',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt,
    });

    writeImageGenerationLease(first);
    writeImageGenerationLease(second);

    expect(
      clearImageGenerationLease({
        tabSessionId: first.tabSessionId,
        localTaskId: first.localTaskId,
      }),
    ).toBe(true);

    expect(getActiveImageGenerationLeases()).toEqual([second]);
    expect(
      readStoredImageGenerationLeaseRegistry().leases[getImageGenerationLeaseId(first)],
    ).toBeUndefined();
    expect(
      readStoredImageGenerationLeaseRegistry().leases[getImageGenerationLeaseId(second)],
    ).toEqual(second);
  });

  it('keeps status_unknown protected after the running hard deadline has passed', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-28T00:00:00Z'));
    const runningStartedAt = Date.now() - 6 * 60 * 1000 - 1000;
    const unknownStartedAt = Date.now();
    const unknownLease = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'text-to-image',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'status_unknown',
      startedAt: unknownStartedAt,
    });
    expect(runningStartedAt + 6 * 60 * 1000).toBeLessThan(Date.now());

    writeImageGenerationLease(unknownLease);

    expect(getActiveImageGenerationLease()).toEqual(unknownLease);
    expect(unknownLease.leaseExpiresAt).toBe(unknownStartedAt + 6 * 60 * 1000);
  });

  it('allows only one same-fingerprint claim when two tabs try to start without confirmed risk', async () => {
    const startedAt = Date.now();
    const first = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'text-to-image',
      jobFingerprint: 'same-job',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt,
    });
    const second = createImageGenerationLease({
      tabSessionId: 'tab-b',
      localTaskId: 'task-b',
      taskType: 'text-to-image',
      jobFingerprint: 'same-job',
      hardTimeoutMs: 6 * 60 * 1000,
      status: 'running',
      startedAt,
    });

    const [firstClaim, secondClaim] = await Promise.all([
      claimImageGenerationLease(first),
      claimImageGenerationLease(second),
    ]);

    const claimResults = [firstClaim, secondClaim];
    expect(claimResults.filter((result) => result.ok)).toHaveLength(1);
    expect(claimResults.filter((result) => !result.ok)).toHaveLength(1);
    expect(getActiveImageGenerationLeases()).toHaveLength(1);
  });

  it('prunes only expired registry entries and keeps other active leases', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-28T00:00:00Z'));
    const expired = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'text-to-image',
      hardTimeoutMs: 1000,
      status: 'running',
      startedAt: Date.now() - 2000,
    });
    const active = createImageGenerationLease({
      tabSessionId: 'tab-b',
      localTaskId: 'task-b',
      taskType: 'dual-product-replace',
      hardTimeoutMs: 11 * 60 * 1000,
      status: 'status_unknown',
      startedAt: Date.now(),
    });
    writeImageGenerationLease(expired);
    writeImageGenerationLease(active);

    expect(getActiveImageGenerationLeases()).toEqual([active]);
    expect(
      readStoredImageGenerationLeaseRegistry().leases[getImageGenerationLeaseId(expired)],
    ).toBeUndefined();
    expect(
      readStoredImageGenerationLeaseRegistry().leases[getImageGenerationLeaseId(active)],
    ).toEqual(active);
  });

  it('creates a stable SHA-256 fingerprint from canonical generation inputs without storing raw content', async () => {
    const descriptor = {
      entry: 'standalone-image-generation',
      taskType: 'dual-product-replace',
      modelKey: 'apimart_gpt_image_2',
      model: 'gpt-image-2',
      platform: '通用',
      imageType: '通用营销图',
      prompt: '把商品放进厨房场景',
      aspectRatio: '4:5',
      outputQuality: 'high',
      count: 1,
      inputImages: [
        { role: '对标/参考图 1', name: 'ref.png', size: 123, type: 'image/png', lastModified: 1 },
        { role: '商品图', name: 'product.png', size: 456, type: 'image/png', lastModified: 2 },
      ],
      ignoredRuntimeFields: {
        tabSessionId: 'tab-a',
        localTaskId: 'task-a',
      },
    };

    const first = await createImageGenerationJobFingerprint(descriptor);
    const reorderedObjectKeys = await createImageGenerationJobFingerprint({
      count: 1,
      outputQuality: 'high',
      aspectRatio: '4:5',
      prompt: '把商品放进厨房场景',
      imageType: '通用营销图',
      platform: '通用',
      model: 'gpt-image-2',
      modelKey: 'apimart_gpt_image_2',
      taskType: 'dual-product-replace',
      entry: 'standalone-image-generation',
      inputImages: [
        { type: 'image/png', size: 123, name: 'ref.png', lastModified: 1, role: '对标/参考图 1' },
        { type: 'image/png', size: 456, name: 'product.png', lastModified: 2, role: '商品图' },
      ],
      ignoredRuntimeFields: {
        localTaskId: 'different-task',
        tabSessionId: 'different-tab',
      },
    });
    const changedModel = await createImageGenerationJobFingerprint({
      ...descriptor,
      model: 'gemini-3.1-flash-image-preview',
    });
    const changedPrompt = await createImageGenerationJobFingerprint({
      ...descriptor,
      prompt: '把商品放进浴室场景',
    });
    const changedRatio = await createImageGenerationJobFingerprint({
      ...descriptor,
      aspectRatio: '1:1',
    });
    const changedReferenceOrder = await createImageGenerationJobFingerprint({
      ...descriptor,
      inputImages: [...descriptor.inputImages].reverse(),
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reorderedObjectKeys).toBe(first);
    expect(changedModel).not.toBe(first);
    expect(changedPrompt).not.toBe(first);
    expect(changedRatio).not.toBe(first);
    expect(changedReferenceOrder).not.toBe(first);

    const lease = createImageGenerationLease({
      tabSessionId: 'tab-a',
      localTaskId: 'task-a',
      taskType: 'dual-product-replace',
      jobFingerprint: first,
      hardTimeoutMs: 11 * 60 * 1000,
      status: 'running',
    });
    writeImageGenerationLease(lease);

    const rawStorage = localStorage.getItem(IMAGE_GENERATION_LEASE_STORAGE_KEY) ?? '';
    expect(rawStorage).toContain(first);
    expect(rawStorage).not.toContain('把商品放进厨房场景');
    expect(rawStorage).not.toContain('product.png');
    expect(rawStorage).not.toContain('ref.png');
    expect(rawStorage).not.toContain('different-tab');
  });
});
