import type { ContentBlock, Message } from '../types/messages.ts';

const COMPACTION_THRESHOLD = 80000;
const COMPACTED_KEEP_RECENT = 6;

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_result') chars += block.content.length;
      else if (block.type === 'tool_use')
        chars += JSON.stringify(block.input).length + block.name.length;
    }
  }
  return Math.ceil(chars / 4);
}

export function compactHistory(messages: Message[]): Message[] {
  const estimated = estimateTokens(messages);
  if (estimated < COMPACTION_THRESHOLD || messages.length <= COMPACTED_KEEP_RECENT) {
    return messages;
  }

  const keepCount = COMPACTED_KEEP_RECENT;
  const toCompact = messages.slice(0, messages.length - keepCount);
  const kept = messages.slice(messages.length - keepCount);

  const compacted: Message[] = toCompact.map((msg) => {
    const newContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type === 'tool_result' && block.content.length > 200) {
        const firstLine = block.content.split('\n')[0] ?? '';
        return {
          ...block,
          content: `[compacted] ${firstLine.slice(0, 150)}… (${block.content.length} chars original)`,
        };
      }
      if (block.type === 'text' && block.text.length > 500) {
        return {
          ...block,
          text: block.text.slice(0, 400) + `… [compacted from ${block.text.length} chars]`,
        };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });

  return [...compacted, ...kept];
}
