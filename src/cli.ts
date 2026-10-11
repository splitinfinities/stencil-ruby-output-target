// Generate the Ruby/ERB/TS tree from built docs-json files, without a Stencil config.
//
// One package (a preview):
//   node src/cli.ts --docs <package>/docs/documentation.json --root <package> --out /tmp/my-elements
//
// Several packages into one tree. Each --package is a built Stencil package; its components
// keep reading their own sources.
//   node src/cli.ts --package <package> --package <another> --out ../../ruby/my-elements
//
// The targets a Stencil config declares (`pnpm build.ruby` at the repo root): --config names a
// module whose default export is the list of target options the package's stencil.config.ts
// passes to rubyOutputTarget(). Each target's outDir is relative to the (first) package, as in
// Stencil; with --out, each tree goes into <out>/<basename of its outDir> instead.
//   node src/cli.ts --package packages/core --config packages/core/ruby.config.ts [--framework rails]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { JsonDocs } from '@stencil/core/internal';
import { findLazyDir, generateAndValidate, readBuild, removeStale, withPackageDefaults, type ViewComponentOutputTargetOptions } from './index.ts';

const { values } = parseArgs({
  options: {
    docs: { type: 'string' },
    root: { type: 'string' },
    package: { type: 'string', multiple: true },
    out: { type: 'string' },
    exclude: { type: 'string', multiple: true },
    config: { type: 'string' },
    framework: { type: 'string' },
  },
});

if ((!values.docs && !values.package) || (!values.out && !values.config)) {
  console.error(
    'usage: node src/cli.ts (--docs <documentation.json> [--root <stencil package>] | --package <stencil package>...) (--out <dir> | --config <targets module> [--out <dir>]) [--exclude <tag>...]',
  );
  process.exit(2);
}

/** A package's docs-json, with each component's source path made absolute so readSource finds it from any package. */
function readDocs(docsFile: string, root: string): JsonDocs {
  const docs: JsonDocs = JSON.parse(readFileSync(docsFile, 'utf8'));

  return { ...docs, components: docs.components.map((component) => ({ ...component, filePath: component.filePath && resolve(root, component.filePath) })) };
}

function readSources(): JsonDocs[] {
  if (values.package) return values.package.map((dir) => readDocs(join(dir, 'docs', 'documentation.json'), resolve(dir)));

  const docsFile = values.docs ?? '';

  return [readDocs(docsFile, resolve(values.root ?? dirname(docsFile)))];
}

const sources = readSources();

const docs: JsonDocs = { ...sources[0], components: sources.flatMap((source) => source.components) };

const readSource = (filePath: string) => {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
};

function isOptionsList(value: unknown): value is ViewComponentOutputTargetOptions[] {
  return Array.isArray(value);
}

/** The targets to generate, each with its out dir resolved. */
async function targets(root: string): Promise<ViewComponentOutputTargetOptions[]> {
  const exclude = values.exclude ?? [];

  if (!values.config) return [{ outDir: resolve(values.out ?? ''), excludeComponents: exclude }];
  const loaded: { default?: unknown } = await import(pathToFileURL(resolve(values.config)).href);

  if (!isOptionsList(loaded.default)) throw new Error(`${values.config}: the default export must be a list of rubyOutputTarget options`);

  const chosen = loaded.default.filter((target) => !values.framework || (target.framework ?? 'rails') === values.framework);

  if (chosen.length === 0) throw new Error(`${values.config}: no target for framework ${values.framework}`);

  return chosen.map((target) => ({
    ...target,
    outDir: values.out ? join(resolve(values.out), basename(target.outDir)) : resolve(root, target.outDir),
    excludeComponents: [...(target.excludeComponents ?? []), ...exclude],
  }));
}

const root = resolve(values.package?.[0] ?? values.root ?? dirname(values.docs ?? ''));

let failed = false;

for (const target of await targets(root)) {
  const outDir = target.outDir;
  const options = withPackageDefaults(target, root, findLazyDir(root), (file) => existsSync(file));
  const build = await readBuild(options, (file) => readFile(file, 'utf8'));
  const result = await generateAndValidate(docs, options, readSource, build);

  for (const [path, content] of result.files) {
    const file = join(outDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  const removed = removeStale(outDir, result.files.keys());

  if (removed.length) console.log(`removed ${removed.length} stale generated file(s)`);

  console.log(`${result.components.length} components → ${result.files.size} files in ${outDir}`);

  for (const { tag, message } of result.warnings) console.log(`warn  <${tag}> ${message}`);

  if (result.templateErrors === null) console.log('Herb validation skipped (@herb-tools/node not installed).');
  else if (result.templateErrors.length === 0) console.log('Herb parsed every template without errors.');

  for (const { file, message } of result.templateErrors ?? []) console.log(`error ${file}: ${message}`);

  if (result.templateErrors?.length) failed = true;
}

process.exitCode = failed ? 1 : 0;
