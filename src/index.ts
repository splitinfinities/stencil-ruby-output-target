import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonDocs, OutputTargetCustom, OutputTargetDistLazy } from '@stencil/core/internal';
import { buildModel, componentTags, type ComponentModel, type Warning } from './model.ts';
import { emitBaseComponent, emitComponentClass, emitHelpers } from './emit-ruby.ts';
import { emitFormBuilderClass, emitFormBuilderMethods, emitFormHelper } from './emit-form-builder.ts';
import { emitPartial, emitTemplate } from './emit-erb.ts';
import { emitManifest } from './emit-ts.ts';
import { emitBaseSignature, emitComponentSignature, emitHelpersSignature } from './emit-rbs.ts';
import { emitPreview } from './emit-previews.ts';
import { emitLib, libPaths } from './emit-lib.ts';
import { emitAssets } from './emit-assets.ts';
import { emitTests } from './emit-tests.ts';
import { emitBridgetown, emitBridgetownRequire, emitForeignContext, emitLoader, emitSinatra, emitViewContext } from './emit-adapters.ts';
import { buildManifest, emitConfiguration, manifestPath, tokenNames } from './emit-config.ts';
import { withPackageDefaults } from './package.ts';
import { readLazyBuild, type LazyBuild } from './assets.ts';
import { namespacePath } from './naming.ts';
import { resolveOptions, type ViewComponentOutputTargetOptions } from './options.ts';
import { validateTemplates, type TemplateError } from './validate.ts';

export type { Framework, ViewComponentOutputTargetOptions } from './options.ts';

export { withPackageDefaults, findLazyDir } from './package.ts';

export { resolveOptions, type ResolvedOptions } from './options.ts';

export type { ComponentModel, PropModel } from './model.ts';

export { namespacePath } from './naming.ts';

const RUNTIME_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'stencil-bridge.ts');

/** What every tag starts with, up to and including a dash: `my-` for `my-button` and `my-input`. Nothing for a single tag or mixed prefixes. */
export function commonTagPrefix(tags: string[]): string {
  if (tags.length < 2) return '';
  let prefix = tags[0];

  for (const tag of tags) {
    while (!tag.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }

  return prefix.slice(0, prefix.lastIndexOf('-') + 1);
}

export interface GenerateResult {
  /** Paths relative to `outDir`. */
  files: Map<string, string>;
  components: ComponentModel[];
  warnings: Warning[];
}

/** Pure: docs in, files out. The output target and the preview CLI both call this. */
export function generate(
  docs: JsonDocs,
  userOptions: ViewComponentOutputTargetOptions,
  readSource: (filePath: string) => string | undefined = () => undefined,
  build?: LazyBuild,
): GenerateResult {
  // The prefix every tag shares (`my-`), unless the caller named one.
  const options = resolveOptions({ ...userOptions, tagPrefix: userOptions.tagPrefix ?? commonTagPrefix(docs.components.map((c) => c.tag)) });
  const warnings: Warning[] = [];


  const components = docs.components
    .filter((c) => !options.excludeComponents.includes(c.tag) && !componentTags(c).ignore)
    .map((c) => buildModel(c, options, readSource, (message) => warnings.push({ tag: c.tag, message })))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  const ns = namespacePath(options.rubyNamespace);
  const files = new Map<string, string>();
  files.set(`app/components/${ns}/base_component.rb`, emitBaseComponent(options));

  files.set(`sig/${ns}/base_component.rbs`, emitBaseSignature(options));

  // Lookbook previews, the ReActionView partials and their TS bridge are Rails-only.
  const rails = options.framework === 'rails';

  for (const component of components) {
    files.set(`app/components/${ns}/${component.fileBase}.rb`, emitComponentClass(component, options));
    files.set(`app/components/${ns}/${component.fileBase}.html.erb`, emitTemplate(component, options));
    files.set(`sig/${ns}/${component.fileBase}.rbs`, emitComponentSignature(component, options));

    if (!rails) continue;
    files.set(`previews/${ns}/${component.fileBase}_preview.rb`, emitPreview(component, options));
    files.set(`app/views/${ns}/_${component.key}.html.erb`, emitPartial(component, options));
  }

  files.set(`sig/${ns}/helpers.rbs`, emitHelpersSignature(components, options));

  files.set(`app/helpers/${ns}/helpers.rb`, emitHelpers(components, options));
  files.set(`app/helpers/${ns}/form_builder_methods.rb`, emitFormBuilderMethods(components, options));
  files.set(`app/helpers/${ns}/form_builder.rb`, emitFormBuilderClass(components, options, (warning) => warnings.push(warning)).content);
  files.set(`lib/${ns}/form_helper.rb`, emitFormHelper(options));

  if (!rails) {
    files.set(`lib/${ns}/loader.rb`, emitLoader(options));
    files.set(`lib/${ns}/view_context.rb`, emitViewContext(options));
    files.set(`lib/${ns}/foreign_context.rb`, emitForeignContext(options));
  }

  if (options.framework === 'sinatra') files.set(libPaths(options).sinatra, emitSinatra(options));

  if (options.framework === 'bridgetown') {
    files.set(libPaths(options).bridgetown, emitBridgetown(options));
    const [path, content] = emitBridgetownRequire(options);

    files.set(path, content);
  }

  if (rails) {
    files.set(`app/javascript/${ns}/manifest.ts`, emitManifest(components));
    files.set(`app/javascript/${ns}/stencil-bridge.ts`, readFileSync(RUNTIME_SOURCE, 'utf8'));
  }

  for (const [path, content] of emitLib(options)) files.set(path, content);

  const tokens = options.tokens.flatMap((file) => {
    const source = readSource(file);

    if (source === undefined) warnings.push({ tag: '*', message: `tokens: can't read ${file}` });

    return source === undefined ? [] : tokenNames(source, file);
  });

  files.set(`lib/${ns}/configuration.rb`, emitConfiguration(options));
  files.set(`lib/${ns}/assets.rb`, emitAssets(options));

  if (!build) warnings.push({ tag: '*', message: 'no Stencil lazy build to read: the asset manifest lists no files (build the dist output target first)' });
  files.set(manifestPath(options), `${JSON.stringify(buildManifest(components, tokens, options, build), null, 2)}\n`);

  if (options.tests) {
    for (const [path, content] of emitTests(components, tokens, options)) files.set(path, content);
  }

  return { files, components, warnings };
}

export interface GenerateAndValidateResult extends GenerateResult {
  templateErrors: TemplateError[] | null;
}

export async function generateAndValidate(
  docs: JsonDocs,
  userOptions: ViewComponentOutputTargetOptions,
  readSource?: (filePath: string) => string | undefined,
  build?: LazyBuild,
): Promise<GenerateAndValidateResult> {
  const result = generate(docs, userOptions, readSource, build);
  const templateErrors = resolveOptions(userOptions).validateWithHerb ? await validateTemplates(result.files) : null;

  return { ...result, templateErrors };
}

/**
 * Removes the generated files a run didn't write. Every directory written to holds generated
 * files only, so a file there that this run didn't write belongs to a removed or renamed
 * component. The out dir's root is the exception: the generated gemspec sits next to the
 * hand-written README.md, LICENSE and lint configs. Returns the paths removed.
 */
export function removeStale(outDir: string, paths: Iterable<string>): string[] {
  const written = new Set([...paths].map((path) => join(outDir, path)));
  const root = resolve(outDir);

  const dirs = [...new Set([...written].map((path) => dirname(path)))].filter((dir) => resolve(dir) !== root);

  const removed = dirs.flatMap((dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isFile() && !written.has(join(dir, entry.name)) ? [join(dir, entry.name)] : []));
    } catch {
      return [];
    }
  });

  for (const stale of removed) rmSync(stale);

  return removed;
}

/** The lazy build the options point at (its loader and chunks), read through `readFile`. */
export async function readBuild(options: ViewComponentOutputTargetOptions, readFile: (path: string) => Promise<string>): Promise<LazyBuild | undefined> {
  const dir = options.assets?.lazyDir;
  const loader = options.assets?.loader;

  if (!dir || !loader) return undefined;

  return readLazyBuild(
    loader,
    async (file) => {
      try {
        return await readFile(join(dir, file));
      } catch {
        return undefined;
      }
    },
    options.assets?.stylesheet || undefined,
  );
}

/**
 * Stencil custom output target. Runs after docs are generated, so it sees the
 * same JsonDocs as `docs-json`.
 *
 *   outputTargets: [rubyOutputTarget({ outDir: '../ruby/my-elements', rubyNamespace: 'My::Elements', tagPrefix: 'my-' })]
 */
export function rubyOutputTarget(userOptions: ViewComponentOutputTargetOptions): OutputTargetCustom {
  return {
    type: 'custom',
    name: 'ruby',
    async generator(config, compilerCtx, buildCtx, docs) {
      const rootDir = config.rootDir ?? process.cwd();
      const outDir = isAbsolute(userOptions.outDir) ? userOptions.outDir : resolve(rootDir, userOptions.outDir);

      const readSource = (filePath: string) => {
        try {
          return readFileSync(isAbsolute(filePath) ? filePath : resolve(rootDir, filePath), 'utf8');
        } catch {
          return undefined;
        }
      };

      const lazyDir = config.outputTargets?.find((target): target is OutputTargetDistLazy => target.type === 'dist-lazy')?.esmDir;
      const options = withPackageDefaults(userOptions, rootDir, lazyDir, () => !!config.globalStyle);

      const build = await readBuild(options, (file) => compilerCtx.fs.readFile(file));
      const { files, warnings, templateErrors } = await generateAndValidate(docs, options, readSource, build);

      await Promise.all([...files].map(([path, content]) => compilerCtx.fs.writeFile(join(outDir, path), content)));

      for (const stale of removeStale(outDir, files.keys())) {
        buildCtx.diagnostics.push({ level: 'warn', type: 'build', header: 'ruby: removed a stale generated file', messageText: stale, lines: [] });
      }

      for (const { tag, message } of warnings) {
        buildCtx.diagnostics.push({ level: 'warn', type: 'build', header: `ruby: <${tag}>`, messageText: message, lines: [] });
      }

      for (const { file, message } of templateErrors ?? []) {
        buildCtx.diagnostics.push({ level: 'error', type: 'build', header: `ruby: Herb rejected ${file}`, messageText: message, lines: [] });
      }
    },
  };
}

/** @deprecated Renamed `rubyOutputTarget` (the package is now stencil-ruby-output-target). */
export const viewComponentOutputTarget = rubyOutputTarget;
