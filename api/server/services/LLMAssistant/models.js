const LLM_ASSISTANT_MODELS = [
  {
    key: 'deepseek_v4_pro',
    name: 'DeepSeek V4 Pro',
    group: 'domestic',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V4-Pro',
    enabled: true,
    recommended: true,
    capabilities: ['text', 'reasoning'],
    recommendFor: '复杂分析 / 方案推理 / 电商策略',
    description: '中文理解强、推理强，适合运营方案和复杂问题拆解',
  },
  {
    key: 'glm_5_3',
    name: 'GLM 5.3',
    group: 'domestic',
    provider: 'siliconflow',
    model: 'zai-org/GLM-5.3',
    enabled: true,
    recommended: false,
    capabilities: ['text', 'reasoning', 'long-context'],
    recommendFor: '长资料总结 / 复杂分析 / 文本推理',
    description: '支持长上下文和推理，适合资料总结、SOP 与复杂文本分析',
  },
  {
    key: 'gemini_3_5_flash',
    name: 'Gemini 3.5 Flash',
    group: 'overseas',
    provider: 'apimart',
    // TODO: 确认 APIMart chat 端点与 Gemini 3.5 Flash 真实 model id（待核对）
    model: null,
    enabled: false,
    recommended: false,
    capabilities: ['text', 'vision', 'long-context'],
    recommendFor: '海外模型 / 多模态理解 / 长上下文',
    description: '适合复杂图文分析和海外模型兜底',
  },
  {
    key: 'gpt_5_4_nano',
    name: 'GPT-5.4 Nano',
    group: 'overseas',
    provider: 'apimart',
    // TODO: 确认 APIMart chat 端点与 GPT-5.4 Nano 真实 model id（待核对）
    model: null,
    enabled: false,
    recommended: false,
    capabilities: ['text', 'fast', 'low-cost'],
    recommendFor: '快速问答 / 分类 / 提取 / 批量轻任务',
    description: '速度快、成本低，适合轻量任务，不建议作为深度策略主力',
  },
];

const DEFAULT_MODEL_KEY = 'deepseek_v4_pro';

function getPublicLLMAssistantModels() {
  return LLM_ASSISTANT_MODELS.map((item) => ({
    key: item.key,
    name: item.name,
    group: item.group,
    enabled: item.enabled,
    recommended: item.recommended,
    capabilities: item.capabilities,
    recommendFor: item.recommendFor,
    description: item.description,
  }));
}

function resolveLLMAssistantModel(key) {
  return LLM_ASSISTANT_MODELS.find((item) => item.key === key) || null;
}

module.exports = {
  LLM_ASSISTANT_MODELS,
  DEFAULT_MODEL_KEY,
  getPublicLLMAssistantModels,
  resolveLLMAssistantModel,
};
