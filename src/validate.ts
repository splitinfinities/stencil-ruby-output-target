export interface TemplateError {
  file: string;
  message: string;
}

interface HerbParseResult {
  recursiveErrors(): Array<{ message: string }>;
}

interface HerbModule {
  Herb: { load(): Promise<void>; parse(source: string): HerbParseResult };
}

/**
 * Herb's WebAssembly build (no install script), then its native one. Each is optional;
 * a variable specifier keeps TypeScript from requiring them at build time.
 */
const HERB_PACKAGES = ['@herb-tools/node-wasm', '@herb-tools/node'];

async function loadHerb(): Promise<HerbModule | null> {
  for (const specifier of HERB_PACKAGES) {
    try {
      return await import(specifier);
    } catch {
      // Not installed, or (the native build) not compiled for this Node: try the next.
    }
  }

  return null;
}

/**
 * Parse every generated `.html.erb` with Herb, the same parser Rails 8.2 and
 * ReActionView compile with, so a template Herb would reject fails the build here.
 * Returns null when no Herb package loads.
 */
export async function validateTemplates(files: Map<string, string>): Promise<TemplateError[] | null> {
  const herb = await loadHerb();

  if (!herb) return null;

  await herb.Herb.load();
  const errors: TemplateError[] = [];

  for (const [file, source] of files) {
    if (!file.endsWith('.html.erb')) continue;

    for (const error of herb.Herb.parse(source).recursiveErrors()) errors.push({ file, message: error.message });
  }

  return errors;
}
