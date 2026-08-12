import { listTools } from './registry.ts';
import type { Tool } from './types.ts';
import { err, ok } from './types.ts';

export const toolSearchTool: Tool = {
  name: 'ToolSearch',
  description:
    'Search for available tools by keyword. Returns matching tool names and descriptions. Use this when you need a tool that is not in your current list.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Keywords to search for (e.g. "file read", "browser", "search").',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results to return (default 5).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input) {
    const query = typeof input['query'] === 'string' ? input['query'].toLowerCase() : '';
    if (!query) return err('query is required');
    const max = typeof input['maxResults'] === 'number' ? Math.min(input['maxResults'], 20) : 5;

    const tools = listTools();
    const scored = tools.map((t) => {
      const haystack = `${t.name} ${t.description}`.toLowerCase();
      const terms = query.split(/\s+/).filter(Boolean);
      let score = 0;
      for (const term of terms) {
        if (t.name.toLowerCase() === term) score += 10;
        else if (t.name.toLowerCase().includes(term)) score += 5;
        else if (haystack.includes(term)) score += 2;
      }
      return { tool: t, score };
    });

    const matches = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);

    if (matches.length === 0) return ok('no tools matched the query');

    const lines = matches.map((m) => `${m.tool.name}: ${m.tool.description.split('\n')[0]}`);
    return ok(lines.join('\n'));
  },
};
