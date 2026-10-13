export function splitThinkingContent(text: string): {
  thinkingContent: string;
  regularContent: string;
} {
  if (!text) {
    return { thinkingContent: '', regularContent: '' };
  }

  const thinkingParts: string[] = [];
  let regularContent = text.replace(/:::thinking([\s\S]*?):::/gi, (_match, thinking) => {
    if (typeof thinking === 'string' && thinking.trim()) {
      thinkingParts.push(thinking.trim());
    }
    return '';
  });

  regularContent = regularContent.replace(/:::thinking([\s\S]*)$/gi, (_match, thinking) => {
    if (typeof thinking === 'string' && thinking.trim()) {
      thinkingParts.push(thinking.trim());
    }
    return '';
  });

  regularContent = regularContent.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, (_match, thinking) => {
    if (typeof thinking === 'string' && thinking.trim()) {
      thinkingParts.push(thinking.trim());
    }
    return '';
  });

  regularContent = regularContent.replace(/<think\b[^>]*>([\s\S]*)$/gi, (_match, thinking) => {
    if (typeof thinking === 'string' && thinking.trim()) {
      thinkingParts.push(thinking.trim());
    }
    return '';
  });

  regularContent = regularContent
    .replace(/:::thinking[\s\S]*?:::/gi, '')
    .replace(/:::thinking[\s\S]*$/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<(?:t|th|thi|thin|think)[^>]*$/gi, '')
    .trim();

  return {
    thinkingContent: thinkingParts.join('\n\n').trim(),
    regularContent,
  };
}

export function stripThinkingContent(text: string): string {
  return splitThinkingContent(text).regularContent;
}
