import { createHash } from 'node:crypto';
import type { ComponentModel } from './model.ts';

/**
 * The asset manifest: which JavaScript files each element needs, read from the Stencil lazy
 * build (`dist/<fsNamespace>/`). The loader (`<ns>.esm.js`) holds the tag → entry-chunk
 * registry, `bootstrapLazy(JSON.parse('[["p-<id>",[[flags,"<tag>",…]]],…]'))`; bundle `<id>` is
 * `<id>.entry.js`, which holds every tag in that bundle and their CSS. Each file's static
 * imports (`import{…}from"./p-X.js"`, `import"./p-X.js"`, `export{…}from"./p-X.js"`) are what it
 * needs before it runs; dynamic `import()` loads on demand and isn't followed.
 */

export interface LazyBuild {
  loader: string;
  /** Files the loader imports (it loads them itself, so they're left out of each tag's list). */
  loaderFiles: string[];
  /** Entry chunk per tag. */
  entries: Record<string, string>;
  /** Static imports per file, in source order. */
  imports: Record<string, string[]>;
  /**
   * A short hash of the files whose names carry none (the loader, and the global stylesheet when
   * `digest()` is given it): the cache key the head helper puts in their URLs.
   */
  digest: string;
}

/** A short, stable hash of some files' contents. */
export function digest(...sources: string[]): string {
  const hash = createHash('sha256');

  for (const source of sources) hash.update(source).update('\0');

  return hash.digest('hex').slice(0, 12);
}

const REGISTRY = /JSON\.parse\('((?:[^'\\]|\\.)*)'\)/;

const STATIC_IMPORT = /(?:^|[;}\s)])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["'](\.\/[^"']+\.js)["']/g;

/** A JS single-quoted string literal's text. */
const unescape = (literal: string) => literal.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.length > 1 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' ? '\n' : c));

/** The `./p-X.js` files a module statically imports, in order, without duplicates. */
export function staticImports(source: string): string[] {
  return [...new Set([...source.matchAll(STATIC_IMPORT)].map((match) => match[1].slice(2)))];
}

type RegistryEntry = [string, [number, string, ...unknown[]][]];

function isBundle(bundle: unknown): bundle is RegistryEntry {
  return Array.isArray(bundle) && typeof bundle[0] === 'string' && Array.isArray(bundle[1]);
}

function isRegistry(value: unknown): value is RegistryEntry[] {
  return Array.isArray(value) && value.every(isBundle);
}

/** Tag → entry chunk, from the loader's source. */
export function parseRegistry(loader: string): Record<string, string> {
  const literal = loader.match(REGISTRY)?.[1];

  if (!literal) return {};
  const parsed: unknown = JSON.parse(unescape(literal));

  if (!isRegistry(parsed)) return {};

  return Object.fromEntries(parsed.flatMap(([id, components]) => components.map((component) => [component[1], `${id}.entry.js`])));
}

/**
 * Reads the lazy build through `read` (Stencil's in-memory fs, or the disk): the loader, every
 * entry chunk and what they import, transitively. Undefined when the loader isn't there.
 */
export async function readLazyBuild(loaderFile: string, read: (file: string) => Promise<string | undefined>, stylesheetFile?: string): Promise<LazyBuild | undefined> {
  const loader = await read(loaderFile);

  if (loader === undefined) return undefined;
  const entries = parseRegistry(loader);
  const imports: Record<string, string[]> = {};
  const queue = [...new Set(Object.values(entries))];

  imports[loaderFile] = staticImports(loader);
  queue.push(...imports[loaderFile]);

  while (queue.length) {
    const file = queue.shift() ?? '';

    if (file in imports) continue;
    const source = await read(file);

    imports[file] = source === undefined ? [] : staticImports(source);
    queue.push(...imports[file]);
  }

  const stylesheet = stylesheetFile ? await read(stylesheetFile) : undefined;

  return { loader: loaderFile, loaderFiles: closure([loaderFile], imports).slice(1), entries, imports: sortKeys(imports), digest: digest(loader, stylesheet ?? '') };
}

const sortKeys = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** Files in load order: each file, then what it imports, depth first, once each. */
function closure(start: string[], imports: Record<string, string[]>): string[] {
  const seen: string[] = [];

  const visit = (file: string) => {
    if (seen.includes(file)) return;
    seen.push(file);

    for (const next of imports[file] ?? []) visit(next);
  };

  for (const file of start) visit(file);

  return seen;
}

/**
 * Per tag, the files to preload when it renders: its entry chunk and that chunk's imports, then
 * the same for the components it renders (Stencil `dependencies`) and the ones it's used with
 * (`@assetWith`), transitively. The loader's own files are left out.
 */
export function assetFiles(components: ComponentModel[], build: LazyBuild): Record<string, string[]> {
  const byTag = new Map(components.map((c) => [c.tag, c]));
  const loaderFiles = new Set([build.loader, ...build.loaderFiles]);

  const tagsFor = (tag: string) => {
    const tags: string[] = [];

    const visit = (current: string) => {
      if (tags.includes(current)) return;
      tags.push(current);
      const component = byTag.get(current);

      for (const next of [...(component?.dependencies ?? []), ...(component?.assetWith ?? [])]) visit(next);
    };

    visit(tag);

    return tags;
  };

  return Object.fromEntries(
    components.map((c) => {
      const entries = tagsFor(c.tag).flatMap((tag) => build.entries[tag] ?? []);

      return [c.tag, closure(entries, build.imports).filter((file) => !loaderFiles.has(file))];
    }),
  );
}
