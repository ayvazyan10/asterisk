// Bun bundler entry — produces dist/{cli,daemon,control,configure,update,web,acp,eval}.js.
// Reference: https://bun.sh/docs/bundler

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');

await mkdir(outdir, { recursive: true });

const minify = process.argv.includes('--minify');

// Stub modules that ink/pino reference but Asterisk never executes (devtools
// only fires when process.env.DEV === 'true'; pino-pretty is opt-in). Stubbing
// at bundle time avoids the runtime "Cannot find package" errors that come
// from leaving them external when the package isn't installed.
const stubPlugin: import('bun').BunPlugin = {
  name: 'stub-optional-deps',
  setup(build) {
    const stubs: Record<string, string> = {
      'react-devtools-core': 'export default { connectToDevTools: () => {} };',
      'pino-pretty':
        'export default function pinoPretty() { throw new Error("pino-pretty is not bundled in Asterisk; install it manually if you need pretty logs"); }',
    };
    const filter = new RegExp(`^(${Object.keys(stubs).join('|')})$`);
    build.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: 'asterisk-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'asterisk-stub' }, (args) => ({
      contents: stubs[args.path] ?? 'export default {};',
      loader: 'js',
    }));
  },
};

const result = await Bun.build({
  entrypoints: [
    resolve(root, 'src/entrypoints/cli.tsx'),
    resolve(root, 'src/entrypoints/daemon.ts'),
    resolve(root, 'src/entrypoints/control.ts'),
    resolve(root, 'src/entrypoints/configure.tsx'),
    resolve(root, 'src/entrypoints/update.ts'),
    resolve(root, 'src/entrypoints/web.ts'),
    resolve(root, 'src/entrypoints/acp.ts'),
    resolve(root, 'src/entrypoints/eval.ts'),
  ],
  outdir,
  target: 'bun',
  format: 'esm',
  minify,
  sourcemap: minify ? 'none' : 'external',
  // Force the production cjs bundles for react / react-reconciler. The dev
  // bundles touch internals (ReactSharedInternals.ReactCurrentOwner) that
  // were removed in React 19, so loading them under React 19 throws at
  // module init.
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [stubPlugin],
  external: [
    // Native deps stay external so Bun resolves them at runtime; Asterisk's
    // installer ships them via `bun install` so they're always present.
    'whatsapp-web.js',
    'better-sqlite3',
    // Playwright pulls in browser drivers — keep external and let it lazy-
    // import the Chromium binary at runtime.
    'playwright',
    'playwright-core',
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${result.outputs.length} file(s) into ${outdir}`);
