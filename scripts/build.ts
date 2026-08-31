// Bun bundler entry — produces
// dist/{cli,daemon,control,configure,update,web,acp,eval,mcp-server,run}.js.
// Reference: https://bun.sh/docs/bundler

import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');

// Wipe before building. The entrypoints have fixed names and would simply be
// overwritten, but the shared chunks `splitting` emits are content-hashed:
// without this every rebuild would leave the previous build's chunks behind and
// `dist/` would grow without bound on any machine that runs `asterisk update`.
await rm(outdir, { recursive: true, force: true });
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
    resolve(root, 'src/entrypoints/mcp-server.ts'),
    resolve(root, 'src/entrypoints/run.ts'),
  ],
  outdir,
  // Pinned, not inferred. Bun derives the output root from the entrypoints,
  // and from the ninth one onwards (measured on 1.3.13) it stops flattening
  // and mirrors the source tree instead — dist/src/entrypoints/cli.js rather
  // than dist/cli.js, which is every path in bin/asterisk missing at once.
  // Naming it makes the layout a property of this file instead of a property
  // of how many entrypoints happen to be listed above. Still true with a
  // tenth entrypoint added here — this is exactly what `root` exists to pin
  // down regardless of count.
  root: resolve(root, 'src/entrypoints'),
  target: 'bun',
  format: 'esm',
  minify,
  // The entrypoints share nearly all of their graph — ink, React, the
  // tool registry, the MCP SDK — and without splitting each one inlined its
  // own copy: four bundles of ~5 MB that were mostly the same bytes. Shared
  // code moves into hashed chunks the entrypoints import, which took the
  // published `dist/` from 20 MB to 5.5 MB. The entrypoint filenames are
  // unchanged, so `bin/asterisk` still resolves dist/cli.js and friends.
  splitting: true,
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
