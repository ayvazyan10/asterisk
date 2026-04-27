// Bun bundler entry — produces dist/cli.mjs and dist/daemon.mjs.
// Reference: https://bun.sh/docs/bundler

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const outdir = resolve(root, 'dist');

await mkdir(outdir, { recursive: true });

const minify = process.argv.includes('--minify');

const result = await Bun.build({
  entrypoints: [
    resolve(root, 'src/entrypoints/cli.tsx'),
    resolve(root, 'src/entrypoints/daemon.ts'),
  ],
  outdir,
  target: 'bun',
  format: 'esm',
  minify,
  sourcemap: minify ? 'none' : 'external',
  external: [
    // Native deps stay external so Bun resolves them at runtime.
    'whatsapp-web.js',
    'better-sqlite3',
    // Ink optionally imports devtools when DEV is enabled — skip bundling.
    'react-devtools-core',
    // Pino's transports are loaded dynamically; let runtime resolve them.
    'pino-pretty',
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${result.outputs.length} file(s) into ${outdir}`);
