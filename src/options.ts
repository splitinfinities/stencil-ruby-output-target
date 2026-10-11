import { namespacePath, pascal, snake } from './naming.ts';

export interface ModelBinding {
  /** Property that holds the element's value, e.g. `value` or `checked`. */
  prop: string;
  /** DOM event that announces a new value, e.g. `update`. */
  event: string;
}

export interface SlotOverride {
  /** Ruby slot name, when the snake_cased slot name reads badly. */
  rubyName?: string;
  /**
   * Render as `renders_many`. `true` keeps a plain wrapper per item; a tag name
   * (e.g. `my-tab`) makes each item that element's generated component.
   */
  many?: boolean | string;
}

export interface GemOptions {
  /** RubyGems name. Bundler requires it with its dashes as slashes: `my-elements` is `my/elements`. */
  name: string;
  summary?: string;
  /** The gemspec's description (a few lines of plain text). */
  description?: string;
  authors?: string[];
  homepage?: string;
  license?: string;
  /** The gem's directory in the repository, for the gemspec's source_code_uri (`ruby/my-elements`). */
  sourcePath?: string;
  changelogUri?: string;
  requiredRubyVersion?: string;
  /** Hand-written files at the gem's root that it ships (README.md, LICENSE, …). */
  extraFiles?: string[];
}

/** Names the gem had before, still accepted for a release. */
export interface LegacyOptions {
  /** The old gem name, for the deprecation messages. */
  gemName?: string;
  /** The old require path (`old/elements`): a file that warns and requires the gem. */
  require?: string;
  /** The old constant (`Old::Elements`), a deprecated alias of the namespace. */
  constant?: string;
}

export interface AssetOptions {
  /** The Stencil lazy build (`dist/<fsNamespace>`), relative to the Stencil package. Derived from the `dist` output target unless given. */
  lazyDir?: string;
  /** The loader's file name in the lazy build. Default `<fsNamespace>.esm.js`. */
  loader?: string;
  /** The global stylesheet's file name, or `false` for none. Default `<fsNamespace>.css` when the build has one. */
  stylesheet?: string | false;
  /**
   * Where the head helper loads the lazy build from when the app doesn't say (`config.assets.bundle_url`,
   * or `config.assets.source`): `cdn` (`cdnUrl`) or `local` (`localPath`, files the app serves itself).
   * Default `cdn`.
   */
  source?: AssetSource;
  /** The CDN's URL for the lazy build; `%<version>s` is the npm version. Any CDN or host works. Default jsDelivr at the package's version. */
  cdnUrl?: string;
  /**
   * The URL (usually a path on the app's own host) the app serves the lazy build at: a copy of the
   * npm package's lazy directory (`node_modules/<package>/dist/<namespace>`). `%<version>s` is
   * the npm version. Default `/<configKey>`.
   */
  localPath?: string;
}

/** Where the elements' files come from: a CDN, or the app's own host. */
export type AssetSource = 'cdn' | 'local';

/** The Ruby framework a target's gem is for. Each output target instance generates one. */
export type Framework = 'rails' | 'sinatra' | 'bridgetown';

export const FRAMEWORKS: readonly Framework[] = ['rails', 'sinatra', 'bridgetown'];

/** A component that renders a Rails FormBuilder method, with props. */
export interface FormBuilderField {
  tag: string;
  props?: Record<string, string | number | boolean>;
}

export interface FormBuilderOptions {
  /** Rails method → component, over the components' own `@formBuilder` tags. `false` leaves Rails' method alone. */
  fields?: Record<string, FormBuilderField | false>;
  /** The element `f.errors_summary` renders the object's errors in, with props (a banner with state "error", say). Without it, there is no errors_summary. */
  errorsSummary?: FormBuilderField;
}

export interface ViewComponentOutputTargetOptions {
  /** Root the Ruby/TS tree is written into, laid out like a gem or Rails engine (`app/…`). */
  outDir: string;
  /**
   * The framework this gem is for. The instance generates that framework's code only (no runtime
   * detection); a library that supports several adds one output target per framework, each with
   * its own outDir and gem name. Default `rails`.
   */
  framework?: Framework;
  /** The gem the tree is (its gemspec and lib/ are generated). Default: named after the namespace. */
  gem?: GemOptions;
  /** The npm package the elements come from. Default: the Stencil package's package.json name. */
  npmPackage?: string;
  /** The npm version; the gem has the same one. Default: the Stencil package's package.json version. */
  version?: string;
  /** Names `config.<key>` in Rails, `<key>_tags` and the other library-wide helpers. Default: the namespace, snake-cased (`my_elements` for `My::Elements`). */
  configKey?: string;
  /** The lazy build the head helper loads and the asset manifest is read from. */
  assets?: AssetOptions;
  /** The gem's former names, kept working (deprecated) for a release. */
  legacy?: LegacyOptions;
  /**
   * The library's design tokens, which `config.tokens` accepts (and rejects any other name):
   * stylesheets whose `--name:` declarations are the tokens, or JSON (an array of names, or an
   * object keyed by them). Paths are relative to the Stencil package. Without it, any name goes.
   */
  tokens?: string | string[];
  /** The generated FormBuilder class: Rails methods taken over by components, and the errors summary. */
  formBuilder?: FormBuilderOptions;
  /** Ruby module for generated classes. Default: from the npm package's name (`@my/elements` is `My::Elements`), else `Elements`. */
  rubyNamespace?: string;
  /** Prefix for generated view helpers: `my_element_` gives `my_element_button(...)`. Default: the tag prefix, snake-cased (`my_`), else the namespace's last part (`elements_`). */
  helperPrefix?: string;
  /** Tag prefix stripped before deriving class names (`my-`). Default: the prefix every tag shares, if there is one. */
  tagPrefix?: string;
  /** Rename a component's Ruby side, keyed by tag: `{ 'my-tag': 'badge' }`. */
  aliases?: Record<string, string>;
  /** Tags to skip. */
  excludeComponents?: string[];
  /** Two-way binding per tag. Without an entry, a `value` prop paired with an `update`/`change`/`input` event is used. */
  models?: Record<string, ModelBinding | false>;
  /**
   * Props that follow server state on a reactive page, per tag (JS prop names). In the partial
   * flavor a string, enum or number prop renders as an always-present value slot,
   * `x="<%= component.reactive_value(:x) %>"`, which Herb rewrites on a reply; a boolean also
   * goes into `data-stencil-attributes`, so the bridge adds or removes the attribute (Herb can't,
   * spike S2). An entry replaces the default set for its tag, and `[]` turns it off. Without an
   * entry, the default set comes from the component's metadata (see `defaultReactive` in model.ts).
   */
  reactiveProps?: Record<string, string[]>;
  /** Per-tag slot overrides keyed by slot name (`''` is the default slot). */
  slots?: Record<string, Record<string, SlotOverride>>;
  /**
   * How slot content gets `slot="name"`. `attribute` sets it on each top-level element of
   * the content (bare text gets a `<span slot="x" style="display: contents">`), so the element
   * is assigned what the caller wrote; `span` wraps all of it in one such span; `none` leaves
   * it to the caller.
   */
  slotWrapper?: 'attribute' | 'span' | 'none';
  /** Validate every generated template with Herb's parser when `@herb-tools/node` resolves. */
  validateWithHerb?: boolean;
  /**
   * Generate the gem's own test suite (`test/` and a Rakefile): Minitest, one test per component
   * and one per part of the library, run with `ruby -Itest test/all.rb` in a bundle that has the
   * gem's framework. Default `true`.
   */
  tests?: boolean;
  /** The line coverage (%) of the generated Ruby the generated tests must reach, or `test/all.rb` fails. Default 85. */
  coverageThreshold?: number;
}

export type ResolvedGem = Required<Omit<GemOptions, 'homepage' | 'sourcePath' | 'changelogUri'>> & Pick<GemOptions, 'homepage' | 'sourcePath' | 'changelogUri'>;

export interface ResolvedAssets {
  lazyDir?: string;
  loader: string;
  stylesheet: string | false;
  source: AssetSource;
  cdnUrl: string;
  localPath: string;
}

type Simple = Omit<ViewComponentOutputTargetOptions, 'outDir' | 'gem' | 'assets' | 'legacy' | 'tokens' | 'formBuilder'>;

export type ResolvedOptions = Required<Simple> & {
  outDir: string;
  gem: ResolvedGem;
  assets: ResolvedAssets;
  legacy?: LegacyOptions;
  tokens: string[];
  formBuilder: FormBuilderOptions;
};

const snakePath = (namespace: string) =>
  namespace
    .split('::')
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
    .join('-');

/** `@my/elements` is `My::Elements`; `elements` is `Elements`. */
function namespaceFor(npmPackage: string | undefined) {
  const parts = (npmPackage ?? '').replace(/^@/, '').split('/').map(pascal).filter(Boolean);

  return parts.length ? parts.join('::') : 'Elements';
}

export function resolveOptions(options: ViewComponentOutputTargetOptions): ResolvedOptions {
  const tagPrefix = options.tagPrefix ?? '';
  const rubyNamespace = options.rubyNamespace ?? namespaceFor(options.npmPackage);
  const helperPrefix = options.helperPrefix ?? (tagPrefix ? `${snake(tagPrefix).replace(/_+$/, '')}_` : `${snake(rubyNamespace.split('::').at(-1) ?? 'element')}_`);
  const npmPackage = options.npmPackage ?? 'unknown';
  const version = options.version ?? '0.0.0';
  const fsNamespace = npmPackage.split('/').at(-1) ?? npmPackage;
  const lazyDir = options.assets?.lazyDir;
  const gemName = options.gem?.name ?? snakePath(rubyNamespace);
  const configKey = options.configKey ?? namespacePath(rubyNamespace).replaceAll('/', '_');

  return {
    aliases: {},
    excludeComponents: [],
    models: {},
    reactiveProps: {},
    slots: {},
    slotWrapper: 'attribute',
    validateWithHerb: true,
    tests: true,
    coverageThreshold: 85,
    ...options,
    framework: options.framework ?? 'rails',
    tagPrefix,
    tokens: [options.tokens ?? []].flat(),
    formBuilder: options.formBuilder ?? {},
    rubyNamespace,
    helperPrefix,
    npmPackage,
    version,
    configKey,
    gem: {
      summary: `Server-rendered ${npmPackage} web components: one ViewComponent per Stencil element`,
      description: `${rubyNamespace} renders every ${npmPackage} web component from Ruby: a ViewComponent and an\nERB template per element and a helper for each. Generated from the Stencil components' metadata.`,
      authors: [],
      license: 'MIT',
      requiredRubyVersion: '>= 3.2',
      extraFiles: ['README.md', 'CHANGELOG.md', 'LICENSE'],
      ...options.gem,
      name: gemName,
    },
    assets: {
      loader: `${fsNamespace}.esm.js`,
      stylesheet: `${fsNamespace}.css`,
      source: 'cdn',
      localPath: `/${configKey}`,
      cdnUrl: `https://cdn.jsdelivr.net/npm/${npmPackage}@%<version>s/${lazyDir ?? `dist/${fsNamespace}`}`,
      ...options.assets,
    },
  };
}
