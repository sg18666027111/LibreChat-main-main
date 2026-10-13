const PLATFORM_ENHANCEMENTS = {
  淘宝:
    '货架电商视觉。商品主体要大、清楚、完整，背景干净不过度抢戏，卖点表达直接，适合搜索结果页和列表页快速点击。画面重点是让用户一眼识别商品和核心利益点。',
  京东:
    '品质型标准化电商视觉。画面要干净克制、可信赖、有品牌质感，适合标准化商品、数码家电、品牌商品和理性消费场景。避免过度花哨，强调专业、可靠和细节质感。',
  拼多多:
    '强转化促销视觉。画面要醒目、直接、有实惠感和数量感，适合爆款、促销、组合装、低价心智。可以更热闹、更高对比，但商品主体仍要清楚完整。',
  抖音:
    '内容电商信息流视觉。画面要有冲击力和停留感，像短视频封面或内容场景截图，情绪和场景更强，第一眼能抓住注意力。适合强场景、强光影、强动作感或故事感。',
  小红书:
    '种草型生活方式视觉。画面要自然、真实、有分享感，像用户笔记封面或生活方式照片。优先自然光、干净审美、柔和色调、真实使用场景，避免硬广感。',
  视频号:
    '稳重可信的私域传播视觉。画面要清楚易懂、信息表达明确，适合熟人社交和中老年用户阅读。风格要生活化、可靠、不过度夸张，核心信息醒目。',
  通用:
    '平衡型商业视觉。不绑定单一平台，兼顾商品清晰度、商业质感、场景表达和投放适配性，适合官网、海报、通用营销物料。',
};

const IMAGE_TYPE_ENHANCEMENTS = {
  商品主图:
    '商品主体要大、完整、边缘清晰，优先居中或稳定构图，背景简洁，不能让道具和环境抢主体。适合电商列表页，用户滑过时能快速看懂卖什么。',
  详情页配图:
    '强调使用场景、功能卖点、材质细节、尺寸关系和品质感。画面要能解释商品为什么值得买，适合详情页中段说明和卖点展开。',
  信息流图:
    '需要强视觉钩子和第一眼吸引力，构图更有冲击力，主体和核心信息更醒目，适合用户快速滑动浏览时停留。',
  种草图:
    '强调生活方式、真实分享感、自然审美和轻内容感。画面像用户主动分享的体验图，不像硬广告，环境和光线要自然可信。',
  直播封面:
    '大主体、强对比、主题明确，画面要有进入直播间的点击动机。核心商品或利益点必须醒目，适合小尺寸封面识别。',
  分镜图:
    '强调镜头感、叙事感和画面调度，像视频脚本中的一个明确镜头。要有主体动作、空间层次或故事信息，适合后续视频化。',
  通用营销图:
    '商业海报感，突出核心利益点和视觉记忆点。适合多渠道投放，画面要整洁、有质感、信息层级清楚。',
};

const DEFAULT_ASPECT_RATIOS = {
  商品主图: '1:1',
  详情页配图: '3:4',
  信息流图: '4:5',
  种草图: '3:4',
  直播封面: '16:9',
  分镜图: '16:9',
  通用营销图: '4:5',
};

const PLATFORM_TYPE_ASPECT_RATIOS = {
  '淘宝|商品主图': '1:1',
  '淘宝|详情页配图': '3:4',
  '京东|商品主图': '1:1',
  '拼多多|商品主图': '1:1',
  '抖音|信息流图': '9:16',
  '抖音|直播封面': '9:16',
  '抖音|分镜图': '16:9',
  '小红书|种草图': '3:4',
  '小红书|信息流图': '3:4',
  '视频号|直播封面': '16:9',
  '视频号|分镜图': '16:9',
};

const SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '3:4': '768x1024',
  '4:5': '832x1040',
  '16:9': '1344x768',
  '9:16': '768x1344',
};

const NEGATIVE_PROMPT =
  '低清晰度，模糊，畸形，比例错误，错误文字，乱码文字，错别字，过度拥挤，低质感，山寨感，夸张医疗功效，虚假承诺，侵权品牌，错误 logo，水印，二维码，联系方式，平台违规词';

function getDefaultAspectRatio(platform, imageType) {
  return (
    PLATFORM_TYPE_ASPECT_RATIOS[`${platform}|${imageType}`] ??
    DEFAULT_ASPECT_RATIOS[imageType] ??
    '1:1'
  );
}

function getImageSize(aspectRatio) {
  return SIZE_BY_ASPECT_RATIO[aspectRatio] ?? SIZE_BY_ASPECT_RATIO['1:1'];
}

function getPlatformRule(platform) {
  return PLATFORM_ENHANCEMENTS[platform] ?? PLATFORM_ENHANCEMENTS['通用'];
}

function getImageTypeRule(imageType) {
  return IMAGE_TYPE_ENHANCEMENTS[imageType] ?? IMAGE_TYPE_ENHANCEMENTS['通用营销图'];
}

function buildCorePromptSections({
  prompt,
  platform,
  imageType,
  aspectRatio,
  taskRequirement,
  combinationRequirement,
  compositionRequirement,
  qualityRequirement,
}) {
  return [
    `用户原始需求：${prompt.trim()}`,
    taskRequirement,
    `平台风格要求：${getPlatformRule(platform)}`,
    `图片类型要求：${getImageTypeRule(imageType)}`,
    combinationRequirement ||
      `平台与图片类型组合要求：面向${platform}平台的${imageType}，画面目标明确，符合对应平台用户的浏览习惯和点击动机。`,
    `比例构图要求：${aspectRatio}。${
      compositionRequirement || '主体清晰，留白合理，构图稳定，适合移动端和电商页面展示。'
    }${
      aspectRatio === '1:1'
        ? ' 严格正方形构图，宽高完全相等，不得输出竖版或横版画布。'
        : ''
    }`,
    `质量要求：${
      qualityRequirement || '商品主体完整，画面清晰，质感高级，背景整洁，商业可用，光影自然。'
    }`,
    `负面约束：${NEGATIVE_PROMPT}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildPrompt({ prompt, platform, imageType, aspectRatio }) {
  return buildCorePromptSections({
    prompt,
    platform,
    imageType,
    aspectRatio,
    taskRequirement: '任务要求：根据用户原始需求生成一张新的电商营销图片，不需要参考上传图片。',
    qualityRequirement: '商品主体完整，画面清晰，质感高级，背景整洁，商业可用，光影自然，构图稳定。',
  });
}

function buildWhiteBackgroundScenePrompt({ prompt, platform, imageType, aspectRatio }) {
  return buildCorePromptSections({
    prompt,
    platform,
    imageType,
    aspectRatio,
    taskRequirement:
      '主体依据：以用户上传的白底商品图作为真实商品主体。尽量保留商品形态、包装轮廓、颜色关系、正面标签区域和关键识别特征。如果用户明确要求改变商品表现，以用户原始需求为准。',
    combinationRequirement:
      '单图改图要求：根据用户文字需求、平台和图片类型，把白底商品图扩展成适合投放的场景化商业图片。可以优化背景、光影、构图、道具、氛围、卖点表达和视觉质感。',
    compositionRequirement: '商品主体突出，构图稳定，背景和道具服务于商品，不遮挡、不扭曲主体。',
    qualityRequirement: '画面清晰，商品完整，背景干净或有合理场景，商业可用，光影自然，质感高级。',
  });
}

function buildDualReferencePrompt({ prompt, platform, imageType, aspectRatio }) {
  return buildCorePromptSections({
    prompt,
    platform,
    imageType,
    aspectRatio,
    taskRequirement:
      '输入图说明：第一张图是对标/参考图，只参考它的构图、场景、风格、版式、光影氛围和卖点表达方式。第二张图是白底商品图，必须作为最终画面的商品主体来源。如果有第三张图，第三张图是补充对标/参考图，用于辅助参考风格、场景、氛围或视觉表达。',
    combinationRequirement:
      '多图商品替换要求：最终结果必须优先保留第二张图商品的主体特征、包装轮廓、颜色关系、正面标签区域和关键识别特征。可以参考第一张和第三张图的画面结构、场景氛围、风格和商业表达，但不要复制参考图中的商品主体、品牌、logo、水印、二维码、联系方式或侵权元素。生成一张新的电商营销图，不是多张图的拼接图，也不是简单贴图。',
    compositionRequirement:
      '商品主体来自第二张图并保持清晰完整；构图、场景和版式参考第一张图；画面自然融合，适合移动端和电商页面展示。',
    qualityRequirement: '画面清晰，主体完整，背景和道具合理，光影自然，质感高级，适合实际投放。',
  });
}

function buildMultiReferencePrompt({ prompt, platform, imageType, aspectRatio, inputImageRoles = [] }) {
  const rolesText = inputImageRoles.length
    ? `参考图角色：${inputImageRoles.map((role, index) => `第 ${index + 1} 张图：${role}`).join('；')}。`
    : '参考图角色：按上传顺序理解参考图，优先综合商品、场景和风格信息。';

  return buildCorePromptSections({
    prompt,
    platform,
    imageType,
    aspectRatio,
    taskRequirement: `${rolesText}各输入图只作为参考依据，综合参考商品主体、场景氛围、构图方式、色彩风格和商业表达，不要直接拼接图片。`,
    combinationRequirement:
      '多图参考生成要求：生成一张新的电商营销图，而不是多图拼接、截图合集或样张集合。如果参考图之间存在冲突，以用户原始需求为最高优先级，其次参考商品主体，再参考场景和风格。',
    compositionRequirement: '主体清晰，构图稳定，视觉统一，适合移动端和电商页面展示。',
    qualityRequirement: '画面清晰，主体完整，视觉统一，光影自然，质感高级，商业可用。',
  });
}

module.exports = {
  NEGATIVE_PROMPT,
  buildPrompt,
  buildDualReferencePrompt,
  buildMultiReferencePrompt,
  buildWhiteBackgroundScenePrompt,
  getImageSize,
  getDefaultAspectRatio,
  DEFAULT_ASPECT_RATIOS,
  PLATFORM_TYPE_ASPECT_RATIOS,
  SIZE_BY_ASPECT_RATIO,
  PLATFORM_ENHANCEMENTS,
  IMAGE_TYPE_ENHANCEMENTS,
};
