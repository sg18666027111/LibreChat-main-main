const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { Providers, Constants: AgentConstants } = require('@librechat/agents');
const { EModelEndpoint } = require('librechat-data-provider');
const api = require('@librechat/api');
const AgentClient = require('./client');

// Keep resolution, initialization, formatting and AgentClient real. Stop at
// the model/graph boundary; this suite never contacts a model provider.
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createRun: jest.fn(),
  // Tokenizer loading is unrelated to Skill content and uses dynamic ESM.
  createTokenCounter: () => () => 1,
}));
jest.mock('~/server/services/Config', () => ({ getMCPServerTools: jest.fn() }));
jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/models', () => ({}));
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({ formatInstructionsForContext: jest.fn() })),
}));

describe('global Skill resolution through AgentClient with empty private ACL', () => {
  let mongo;
  let methods;
  let user;
  let globalSkill;
  let privateSkill;
  let processStream;
  const body = 'GLOBAL_BODY_SENTINEL: use the company voice.';
  const secret = 'PRIVATE_BODY_SENTINEL: must never enter model context.';

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    methods = createMethods(mongoose);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it.each([true, false])(
    'reads the exact always-applied Skill reference despite a newer global collision (in catalog: %s)',
    async (inCatalog) => {
      const a = await mongoose.models.Skill.create({
        name: 'pinned-reference',
        description: 'Always applied',
        body: 'Read references/policy.md',
        author: user._id,
        authorName: 'Test owner',
        visibility: 'private',
        alwaysApply: true,
      });
      const b = await mongoose.models.Skill.create({
        name: a.name,
        description: 'Other author',
        body: 'B_BODY_SENTINEL',
        author: new mongoose.Types.ObjectId(),
        authorName: 'Other author',
        visibility: 'global',
        alwaysApply: false,
      });
      await mongoose.models.Skill.collection.updateOne(
        { _id: b._id },
        { $set: { updatedAt: new Date(Date.now() + 1000) } },
      );
      await mongoose.models.SkillFile.create({
        skillId: a._id,
        relativePath: 'references/policy.md',
        filename: 'policy.md',
        file_id: 'local-pinned-reference',
        author: user._id,
        filepath: '/local-test-only/policy.md',
        mimeType: 'text/markdown',
        bytes: 20,
        source: 'local',
        content: 'A_REFERENCE_SENTINEL',
        isBinary: false,
      });
      const primes = await api.resolveAlwaysApplySkills({
        listAlwaysApplySkills: methods.listAlwaysApplySkills,
        accessibleSkillIds: [a._id],
        userId: user._id.toString(),
        skillStates: {},
        defaultActiveOnShare: true,
      });
      expect(primes.map((s) => s._id.toString())).toContain(a._id.toString());
      expect(primes.map((s) => s._id.toString())).not.toContain(b._id.toString());
      const handler = api.createToolExecuteHandler({
        getSkillByName: methods.getSkillByName,
        getSkillFileByPath: methods.getSkillFileByPath,
        loadTools: async () => ({
          loadedTools: [],
          configurable: {
            accessibleSkillIds: [inCatalog ? a._id : b._id],
            activeSkillNames: new Set([a.name]),
            skillPrimedIdsByName: Object.fromEntries(primes.map((s) => [s.name, s._id.toString()])),
          },
        }),
      });
      const read = () =>
        new Promise((resolve, reject) =>
          handler.handle('on_tool_execute', {
            toolCalls: [
              {
                id: 'pinned-read',
                name: AgentConstants.READ_FILE,
                args: { file_path: `${a.name}/references/policy.md` },
              },
            ],
            resolve,
            reject,
          }),
        );
      const [result] = await read();
      expect(result.status).toBe('success');
      expect(result.content).toContain('A_REFERENCE_SENTINEL');
      expect(JSON.stringify(result)).not.toContain('B_BODY_SENTINEL');
      await mongoose.models.Skill.deleteOne({ _id: a._id });
      const [deleted] = await read();
      expect(deleted.status).toBe('error');
      expect(JSON.stringify(deleted)).not.toContain('B_BODY_SENTINEL');
    },
  );

  beforeEach(async () => {
    await mongoose.models.Skill.deleteMany({});
    await mongoose.models.User.deleteMany({});
    user = await mongoose.models.User.create({
      name: 'Skill test user',
      email: 'skill-injection@example.test',
    });
    const author = new mongoose.Types.ObjectId();
    globalSkill = await mongoose.models.Skill.create({
      name: 'company-global',
      description: 'Company writing rules',
      body,
      author,
      authorName: 'Company',
      visibility: 'global',
    });
    privateSkill = await mongoose.models.Skill.create({
      name: 'private-only',
      description: 'Private rules',
      body: secret,
      author,
      authorName: 'Other user',
      visibility: 'private',
    });
    processStream = jest.fn().mockResolvedValue(undefined);
    api.createRun.mockReset().mockResolvedValue({
      processStream,
      getCalibrationRatio: () => 0,
    });
  });

  async function initialize(manualSkills = []) {
    // This is the payload identity emitted by the frontend SkillsCommand.
    const req = {
      user: { id: user._id.toString() },
      body: { manualSkills },
      config: { endpoints: {} },
    };
    const states = await api.loadSkillStates({
      userId: req.user.id,
      appConfig: req.config,
      getUserById: methods.getUserById,
      accessibleSkillIds: [],
    });
    const agent = await api.initializeAgent(
      {
        req,
        res: {},
        agent: {
          id: 'skill-test-agent',
          provider: Providers.OPENAI,
          model: 'gpt-4o-mini',
          model_parameters: { model: 'gpt-4o-mini' },
          tools: [],
          skills_enabled: true,
        },
        endpointOption: { endpoint: EModelEndpoint.agents },
        allowedProviders: new Set([Providers.OPENAI]),
        isInitialAgent: true,
        skillsEnabled: true,
        accessibleSkillIds: [],
        manualSkills: api.extractManualSkills(req.body),
        ...states,
        loadTools: async () => ({ tools: [], toolDefinitions: [], toolRegistry: new Map() }),
      },
      {
        ...methods,
        getFiles: async () => [],
        getConvoFiles: async () => [],
        getToolFilesByIds: async () => [],
        updateFilesUsage: async () => [],
      },
    );
    const client = new AgentClient({
      req,
      res: {},
      agent,
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      primeInvokedSkills: (payload) =>
        api.primeInvokedSkills({
          req,
          payload,
          accessibleSkillIds: [],
          codeEnvAvailable: false,
          getSkillByName: methods.getSkillByName,
          ...states,
        }),
    });
    client.responseMessageId = 'skill-test-response';
    client.conversationId = 'skill-test-conversation';
    client.recordCollectedUsage = jest.fn();
    return { client, agent, req };
  }

  async function run(client, history = []) {
    await client.chatCompletion({
      payload: [...history, { role: 'user', content: 'Write a short introduction.' }],
    });
    expect(client.contentParts.some((p) => p.type === 'error')).toBe(false);
    expect(api.createRun).toHaveBeenCalledTimes(1);
    expect(processStream).toHaveBeenCalledTimes(1);
    const messages = api.createRun.mock.calls[0][0].messages;
    expect(processStream.mock.calls[0][0].messages).toEqual(messages);
    expect(JSON.stringify(messages)).not.toContain(secret);
    return messages;
  }

  it('injects frontend-selected manual global content into final model messages', async () => {
    const { client } = await initialize(['company-global', 'private-only']);
    const messages = await run(client);
    expect(messages.filter((m) => m.content === body)).toHaveLength(1);
  });

  it('injects always-apply global content into final model messages', async () => {
    await mongoose.models.Skill.updateOne({ _id: globalSkill._id }, { alwaysApply: true });
    const { client } = await initialize();
    expect((await run(client)).filter((m) => m.content === body)).toHaveLength(1);
  });

  it('loads model-invoked global content and reconstructs it in final history context', async () => {
    const { client, agent, req } = await initialize();
    expect(agent.activeSkillNames.has('company-global')).toBe(true);
    const handler = api.createToolExecuteHandler({
      getSkillByName: methods.getSkillByName,
      loadTools: async () =>
        api.enrichWithSkillConfigurable(
          { loadedTools: [] },
          req,
          agent.accessibleSkillIds,
          false,
          undefined,
          agent.activeSkillNames,
        ),
    });
    const [result] = await new Promise((resolve, reject) => {
      handler.handle('on_tool_execute', {
        toolCalls: [
          {
            id: 'global-call',
            name: AgentConstants.SKILL_TOOL,
            args: { skillName: 'company-global' },
          },
        ],
        resolve,
        reject,
      });
    });
    expect(result.status).toBe('success');
    expect(JSON.stringify(result.injectedMessages)).toContain(body);
    const messages = await run(client, [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'global-call',
              name: 'skill',
              args: JSON.stringify({ skillName: 'company-global' }),
              output: result.content,
              progress: 1,
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).toContain(body);
  });

  it('keeps a user-disabled global out of catalog and manual/always-apply context', async () => {
    await mongoose.models.Skill.updateOne({ _id: globalSkill._id }, { alwaysApply: true });
    await mongoose.models.User.updateOne(
      { _id: user._id },
      {
        $set: { [`skillStates.${globalSkill._id}`]: false },
      },
    );
    const { client, agent } = await initialize(['company-global']);
    expect(agent.skillCount).toBe(0);
    expect(JSON.stringify(await run(client))).not.toContain(body);
  });

  it('rejects a model invocation of a private name without ACL', async () => {
    const handler = api.createToolExecuteHandler({
      getSkillByName: methods.getSkillByName,
      loadTools: async () => ({ loadedTools: [], configurable: { accessibleSkillIds: [] } }),
    });
    const [result] = await new Promise((resolve, reject) => {
      handler.handle('on_tool_execute', {
        toolCalls: [
          {
            id: 'private-call',
            name: AgentConstants.SKILL_TOOL,
            args: { skillName: privateSkill.name },
          },
        ],
        resolve,
        reject,
      });
    });
    expect(result.status).toBe('error');
    expect(result.injectedMessages).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not restore a user-disabled global from previous skill calls', async () => {
    await mongoose.models.Skill.create({
      name: 'another-global',
      description: 'Another available skill keeps the skill tool enabled',
      body: 'Other company instructions',
      author: globalSkill.author,
      authorName: 'Company',
      visibility: 'global',
    });
    await mongoose.models.User.updateOne(
      { _id: user._id },
      { $set: { [`skillStates.${globalSkill._id}`]: false } },
    );
    const { client, agent } = await initialize();
    expect(agent.activeSkillNames.has('another-global')).toBe(true);
    const messages = await run(client, [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'previous-global-call',
              name: 'skill',
              args: JSON.stringify({ skillName: 'company-global' }),
              output: 'Skill loaded.',
              progress: 1,
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(body);
  });

  it.each(['skill', 'read_file'])(
    'does not load a disabled global through %s even when an active skill has the same name',
    async (toolName) => {
      await mongoose.models.Skill.create({
        name: globalSkill.name,
        description: 'An active same-name skill',
        body: 'Active alternative body',
        author: new mongoose.Types.ObjectId(),
        authorName: 'Company',
        visibility: 'global',
      });
      await mongoose.models.Skill.collection.updateOne(
        { _id: globalSkill._id },
        { $set: { updatedAt: new Date(Date.now() + 1000) } },
      );
      await mongoose.models.User.updateOne(
        { _id: user._id },
        { $set: { [`skillStates.${globalSkill._id}`]: false } },
      );
      const { agent, req } = await initialize();
      expect(agent.activeSkillNames.has(globalSkill.name)).toBe(true);
      expect(agent.accessibleSkillIds.map(String)).not.toContain(globalSkill._id.toString());
      const handler = api.createToolExecuteHandler({
        getSkillByName: methods.getSkillByName,
        loadTools: async () =>
          api.enrichWithSkillConfigurable(
            { loadedTools: [] },
            req,
            agent.accessibleSkillIds,
            false,
            undefined,
            agent.activeSkillNames,
          ),
      });
      const [result] = await new Promise((resolve, reject) => {
        handler.handle('on_tool_execute', {
          toolCalls: [
            {
              id: 'disabled-global-call',
              name: toolName,
              args:
                toolName === 'skill'
                  ? { skillName: globalSkill.name }
                  : { file_path: `${globalSkill.name}/SKILL.md` },
            },
          ],
          resolve,
          reject,
        });
      });
      expect(result.status).toBe('error');
      expect(JSON.stringify(result)).not.toContain(body);
    },
  );
});
