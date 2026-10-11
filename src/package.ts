import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { AssetOptions, ViewComponentOutputTargetOptions } from './options.ts';

interface PackageJson {
  name?: string;
  version?: string;
}

function isPackageJson(value: unknown): value is PackageJson {
  return typeof value === 'object' && value !== null;
}

/** The Stencil package's name and version, from its package.json. */
export function readPackageJson(root: string): PackageJson {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

    return isPackageJson(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The lazy build on disk: `dist/<ns>/` holding `<ns>.esm.js`. */
export function findLazyDir(root: string): string | undefined {
  const dist = join(root, 'dist');

  try {
    return readdirSync(dist, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dist, entry.name, `${entry.name}.esm.js`)))
      .map((entry) => join(dist, entry.name))
      .sort()[0];
  } catch {
    return undefined;
  }
}

/**
 * The options a Stencil package supplies when the caller didn't: its npm name and version, and
 * the lazy build's loader, stylesheet and CDN path. `lazyDir` is absolute (Stencil's dist-lazy
 * esmDir, or one found on disk); `hasStylesheet` says whether the build has a global stylesheet.
 */
export function withPackageDefaults(
  options: ViewComponentOutputTargetOptions,
  root: string,
  lazyDir: string | undefined,
  hasStylesheet: (file: string) => boolean,
): ViewComponentOutputTargetOptions {
  const pkg = readPackageJson(root);
  const configured = options.assets?.lazyDir;
  const dir = configured ? (isAbsolute(configured) ? configured : resolve(root, configured)) : lazyDir;
  const npmPackage = options.npmPackage ?? pkg.name;
  const assets: AssetOptions = { ...options.assets };

  if (dir) {
    const ns = basename(dir);
    const path = relative(root, dir).split('\\').join('/');

    assets.lazyDir = dir;
    assets.loader ??= `${ns}.esm.js`;
    assets.stylesheet ??= hasStylesheet(join(dir, `${ns}.css`)) ? `${ns}.css` : false;

    if (npmPackage) assets.cdnUrl ??= `https://cdn.jsdelivr.net/npm/${npmPackage}@%<version>s/${path}`;
  }

  const tokens = [options.tokens ?? []].flat().map((file) => (isAbsolute(file) ? file : resolve(root, file)));

  return { ...options, npmPackage, version: options.version ?? pkg.version, assets, tokens };
}
