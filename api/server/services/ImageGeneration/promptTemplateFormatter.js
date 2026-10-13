const STRUCTURE_HEADINGS = [
  { title: '构图要求', patterns: ['构图', '视角', '角度', '画面', '主体', '居中', '背景'] },
  { title: '包装要求', patterns: ['包装', '盒', '袋', '罐', '礼盒', '腰封', '材质'] },
  { title: '食材展示要求', patterns: ['食材', '原料', '内部', '盛满', '开窗', '透明'] },
  { title: '包装文字要求', patterns: ['文字', '标题', 'slogan', '卖点', '承诺', '印刷'] },
  { title: '色彩要求', patterns: ['颜色', '色彩', '主色', '浅色', '深色', '低饱和'] },
];

const WARNING_RULES = [
  {
    pattern: /标题[:：]["“][^"”]{4,}["”]|商品标题[:：][^\n]{4,}/,
    warning: '检测到具体商品标题，建议确认是否应改为【商品标题】变量。',
  },
  {
    pattern: /功效|调理|治疗|治愈|改善|降血糖|降血压|补气血|祛湿|抗癌|消炎/,
    warning: '检测到“功效 / 调理 / 治疗”等词，食品类主图请注意合规风险。',
  },
  {
    pattern: /(?:45°|俯视|平视|正面|侧面|斜侧|低角度|微俯).*(?:45°|俯视|平视|正面|侧面|斜侧|低角度|微俯)/s,
    warning: '检测到多个视角描述，建议运营确认是否冲突。',
  },
  {
    pattern: /包装文字|主标题|slogan|品质承诺|腰封文字|印刷文字/,
    warning: '检测到包装文字要求较多，可能导致画面拥挤。',
  },
  {
    pattern: /100%|最强|全网第一|官方正品|永久|保证|第一名|销量冠军/,
    warning: '检测到“100% / 最强 / 全网第一 / 官方正品”等强承诺词，建议确认是否可用。',
  },
];

function normalizeLineBreaks(prompt) {
  return String(prompt || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPromptSegments(prompt) {
  return normalizeLineBreaks(prompt)
    .split(/\n{2,}|(?<=。|；|;)\s*\n?/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getHeadingForSegment(segment) {
  const matched = STRUCTURE_HEADINGS.find((item) =>
    item.patterns.some((pattern) => segment.includes(pattern)),
  );
  return matched?.title || '注意事项';
}

function formatListLikeSegment(segment) {
  const lines = segment.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.some((line) => /^[-*•]|^\d+[.、]/.test(line))) {
    return lines
      .map((line) => (line.startsWith('- ') ? line : `- ${line.replace(/^[-*•]\s*|^\d+[.、]\s*/, '')}`))
      .join('\n');
  }
  return segment;
}

function collectVariables(prompt) {
  return [...new Set([...prompt.matchAll(/【([^】]+)】/g)].map((match) => `【${match[1]}】`))];
}

function collectWarnings(prompt) {
  const warnings = WARNING_RULES.filter((rule) => rule.pattern.test(prompt)).map(
    (rule) => rule.warning,
  );
  if (prompt.length > 4000) {
    warnings.push('检测到提示词过长，建议运营人工确认是否需要拆成多个模板。');
  }
  return [...new Set(warnings)];
}

function formatPromptTemplateText(prompt) {
  const originalPrompt = String(prompt || '');
  const normalizedPrompt = normalizeLineBreaks(originalPrompt);
  const segments = splitPromptSegments(normalizedPrompt);
  const grouped = new Map();

  for (const segment of segments) {
    const heading = getHeadingForSegment(segment);
    if (!grouped.has(heading)) {
      grouped.set(heading, []);
    }
    grouped.get(heading).push(formatListLikeSegment(segment));
  }

  const sections = [];
  for (const [heading, items] of grouped.entries()) {
    sections.push(`## ${heading}\n${items.join('\n\n')}`);
  }

  const variables = collectVariables(normalizedPrompt);
  if (variables.length) {
    sections.push(`## 变量说明\n${variables.map((variable) => `- ${variable}`).join('\n')}`);
  }

  return {
    originalPrompt,
    formattedPrompt: sections.join('\n\n').trim(),
    warnings: collectWarnings(normalizedPrompt),
  };
}

module.exports = {
  formatPromptTemplateText,
};
