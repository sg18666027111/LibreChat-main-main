import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { addUsageModelGuard } from './usageGuard';
class FixtureModel extends BaseChatModel {
  calls = 0;
  _llmType() {
    return 'fixture';
  }

  async _generate() {
    this.calls++;
    return { generations: [{ text: 'ok', message: new AIMessage('ok') }] };
  }
}
test('the real LangChain model awaits admission and blocks provider execution on rejection even with callbacks cleared by a child', async () => {
  let reject!: (error: Error) => void;
  const options = addUsageModelGuard(
    {},
    { provider: 'fixture', model: 'fixture', businessType: 'chat' },
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const model = new FixtureModel(options);
  const pending = model.invoke([new HumanMessage('fixture')], { callbacks: [] });
  while (!reject) await Promise.resolve();
  expect(model.calls).toBe(0);
  reject(Object.assign(new Error('capacity'), { code: 'USAGE_CAPTURE_UNAVAILABLE' }));
  await expect(pending).rejects.toMatchObject({ code: 'USAGE_CAPTURE_UNAVAILABLE' });
  expect(model.calls).toBe(0);
});
test('fallback clients receive the same awaited admission with their own model identity', async () => {
  const before = jest.fn(async () => {});
  const options = addUsageModelGuard(
    { fallbacks: [{ provider: 'fallback', clientOptions: { model: 'fallback-model' } }] },
    { provider: 'primary', model: 'primary-model', businessType: 'chat' },
    before,
  );
  const model = new FixtureModel({ ...options.fallbacks[0].clientOptions, verbose: false });
  await model.invoke([new HumanMessage('fixture')]);
  expect(before).toHaveBeenCalledWith({
    provider: 'fallback',
    model: 'fallback-model',
    businessType: 'chat',
  });
  expect(model.calls).toBe(1);
});

test('the actual application Run rejects admission before its provider transport is called', async () => {
  const { createRun } = await import('./run');
  let requests = 0;
  const before = jest.fn(async () => {
    throw Object.assign(new Error('capacity'), { code: 'USAGE_CAPTURE_UNAVAILABLE' });
  });
  const run = await createRun({
    runId: 'usage-guard-run',
    signal: new AbortController().signal,
    agents: [
      {
        id: 'fixture-agent',
        provider: 'openAI',
        model: 'gpt-4o-mini',
        tools: [],
        model_parameters: {
          model: 'gpt-4o-mini',
          apiKey: 'fixture-not-a-secret',
          streaming: false,
          configuration: {
            fetch: async () => {
              requests++;
              throw new Error('transport forbidden');
            },
          },
        },
      } as never,
    ],
    beforeModelCall: before,
  });
  let failure;
  try {
    await run.processStream(
      { messages: [new HumanMessage('fixture')] },
      { version: 'v2', recursionLimit: 3 },
    );
  } catch (error) {
    failure = error;
  }
  expect(before).toHaveBeenCalled();
  expect(failure).toMatchObject({ code: 'USAGE_CAPTURE_UNAVAILABLE' });
  expect(requests).toBe(0);
});

test('summary and explicit child models retain admission when built by the real application run', async () => {
  const { Run } = await import('@librechat/agents');
  const { createRun } = await import('./run');
  const create = jest.spyOn(Run, 'create').mockResolvedValue({} as never);
  const before = jest.fn(async () => {
    throw new Error('capacity');
  });
  try {
    await createRun({
      runId: 'branch-guards',
      signal: new AbortController().signal,
      agents: [
        {
          id: 'parent',
          provider: 'openAI',
          model: 'gpt-4o-mini',
          tools: [],
          model_parameters: { model: 'gpt-4o-mini' },
          subagents: { enabled: true, allowSelf: false },
          subagentAgentConfigs: [
            {
              id: 'child',
              provider: 'openAI',
              model: 'gpt-4o',
              tools: [],
              model_parameters: { model: 'gpt-4o' },
            },
          ],
        } as never,
      ],
      beforeModelCall: before,
    });
    const agent = create.mock.calls[0][0].graphConfig.agents[0];
    const child = agent.subagentConfigs[0].agentInputs;
    const configs = [agent.summarizationConfig.parameters, child.clientOptions];
    for (const config of configs) {
      const model = new FixtureModel(config);
      await expect(model.invoke([new HumanMessage('fixture')], { callbacks: [] })).rejects.toThrow(
        'capacity',
      );
      expect(model.calls).toBe(0);
    }
    expect(before).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o', businessType: 'chat' }),
    );
    expect(before).toHaveBeenCalledWith(expect.objectContaining({ businessType: 'other' }));
  } finally {
    create.mockRestore();
  }
});
