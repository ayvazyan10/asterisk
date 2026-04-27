// Glob tool — uses tinyglobby for cross-runtime glob matching.
// Reference: https://github.com/SuperchupuDev/tinyglobby

import { glob } from 'tinyglobby';
import { type Tool, ok, err } from './types.ts';

export const globTool: Tool = {
  name: 'Glob',
  description:
    'List files matching a glob pattern relative to the cwd or a given root. Returns one path per line.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "src/**/*.ts".',
      },
      cwd: { type: 'string', description: 'Optional root directory (default process.cwd()).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input) {
    const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : '';
    if (!pattern) return err('pattern is required');
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();

    try {
      const found = await glob(pattern, {
        cwd,
        dot: false,
        onlyFiles: true,
        absolute: false,
      });
      const limited = found.slice(0, 1000);
      if (limited.length === 0) return ok('(no matches)');
      return ok(limited.join('\n'));
    } catch (e) {
      return err(`Glob failed: ${(e as Error).message}`);
    }
  },
};
