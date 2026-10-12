// Builds what the package ships (dist/): the output target as ESM and as CommonJS (Stencil's
// config loader requires it), the CLI, and the type declarations.
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const shared = { absWorkingDir: ROOT, bundle: true, platform: 'node', target: 'node22', packages: 'external', logLevel: 'warning' };

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });

await build({ ...shared, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/index.js' });

// CommonJS has no import.meta.url, which the target uses to find runtime/.
await build({
  ...shared,
  entryPoints: ['src/index.ts'],
  format: 'cjs',
  outfile: 'dist/index.cjs',
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});

await build({ ...shared, entryPoints: ['src/cli.ts'], format: 'esm', outfile: 'dist/cli.js', banner: { js: '#!/usr/bin/env node' } });
chmodSync(join(ROOT, 'dist/cli.js'), 0o755);

execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'inherit' });

// The sources import each other with .ts extensions (Node runs them as they are); a declaration
// file names its neighbours as .js, which resolves to their .d.ts for every consumer.
for (const file of readdirSync(join(ROOT, 'dist/types'))) {
  const path = join(ROOT, 'dist/types', file);

  writeFileSync(path, readFileSync(path, 'utf8').replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}
