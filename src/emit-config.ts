import type { ComponentModel } from './model.ts';
import { assetFiles, type LazyBuild } from './assets.ts';
import type { ResolvedOptions } from './options.ts';
import { inNamespace } from './emit-lib.ts';
import { namespacePath, rubyString } from './naming.ts';

/**
 * The config object (`<Namespace>.configure`) and the data it validates against: the generated
 * manifest (lib/<ns>/manifest.json) names every component by key, class and tag, and lists the
 * library's design tokens. The same in every framework; only where the environment and logger
 * come from differs.
 */

/** Custom property names declared in a stylesheet (`--name:`), or listed in JSON (an array, or an object's keys). */
export function tokenNames(source: string, file: string): string[] {
  if (file.endsWith('.json')) {
    const parsed: unknown = JSON.parse(source);
    const names = Array.isArray(parsed) ? parsed : Object.keys(parsed ?? {});

    return names.filter((name): name is string => `${name}`.startsWith('--'));
  }

  return [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
}

export interface ManifestComponent {
  tag: string;
  class: string;
  /** The lazy build's files this element needs, in load order (see assets.ts). */
  files: string[];
}

export interface Manifest {
  /**
   * The lazy build's loader and global stylesheet (null: none), file names in bundle_url, and a
   * hash of the two (null without a build): the cache key in their URLs, since their names have none.
   */
  assets: { loader: string; stylesheet: string | null; digest: string | null };
  components: Record<string, ManifestComponent>;
  tokens: string[];
}

/** The manifest: assets, components (with the files each needs) and tokens. */
export function buildManifest(components: ComponentModel[], tokens: string[], options: ResolvedOptions, build: LazyBuild | undefined): Manifest {
  const files = build ? assetFiles(components, build) : {};

  return {
    assets: { loader: options.assets.loader, stylesheet: options.assets.stylesheet || null, digest: build?.digest ?? null },
    components: Object.fromEntries(components.map((c) => [c.key, { tag: c.tag, class: c.className, files: files[c.tag] ?? [] }])),
    tokens: [...new Set(tokens)].sort(),
  };
}

export const manifestPath = (options: ResolvedOptions) => `lib/${namespacePath(options.rubyNamespace)}/manifest.json`;

/** Where each framework's environment and logger come from, when the config doesn't set them. */
/** Ruby expressions for the framework's environment and logger, when it has them. */
interface FrameworkDefaults {
  env?: string;
  logger?: string;
}

function frameworkDefaults(options: ResolvedOptions): FrameworkDefaults {
  switch (options.framework) {
    case 'rails':
      return { env: '::Rails.env.to_s if defined?(::Rails.env)', logger: '::Rails.logger if defined?(::Rails.logger)' };
    case 'bridgetown':
      return { env: '::Bridgetown.env.to_s if defined?(::Bridgetown.env)', logger: '::Bridgetown.logger if defined?(::Bridgetown.logger)' };
    default:
      return { env: undefined, logger: undefined };
  }
}

export function emitConfiguration(options: ResolvedOptions) {
  const ns = options.rubyNamespace;
  const defaults = frameworkDefaults(options);
  const manifest = manifestPath(options).split('/').at(-1) ?? 'manifest.json';

  const body = String.raw`
# The library's settings, set once at boot:
#
#   ${ns}.configure do |config|
#     config.tokens["--radius-md"] = "6px"            # design tokens, emitted by ${options.configKey}_tags
#     config.token :radius_md, "6px"                  # the same, from a symbol
#     config.token_selector = ":root"
#     config.defaults[:button] = {size: "small"}      # props a component takes when the caller doesn't pass them
#     config.assets.async = true                      # preload the rendered components' JavaScript
#     config.assets.source = :${options.assets.source}${options.assets.source === 'cdn' ? '  ' : ''}                    # :cdn (the npm package's version on the CDN) or :local (your own copy)
#     config.assets.bundle_url = nil                  # any other URL the elements' files are served from
#     config.assets.always = %i[button]               # preloaded on every page
#     config.assets.preload = %i[dialog]              # prefetched for later pages
#     config.form_builder = true                      # f.<element> on every Rails builder; :default: ours is the default
#     config.errors_summary_heading = "Please fix:"   # f.errors_summary's heading
#   end
#
# Unknown tokens, components, props and enum values raise in development and test, and log and
# are ignored otherwise, as an invalid prop does when a component renders.
class Configuration
  # What a token's value can't hold: it goes into a <style> element as is.
  UNSAFE_TOKEN_VALUE = /[;{}<>\r\n]/

  attr_reader :tokens, :defaults, :assets
  attr_accessor :token_selector, :form_builder, :errors_summary_heading
  attr_writer :environment, :logger

  def initialize
    @tokens = Tokens.new(self)
    @defaults = Defaults.new(self)
    @assets = Assets.new
    @token_selector = ":root"
    @form_builder = true
    # f.errors_summary's heading: a format string (%{count}, %{errors}, %{model}) or a proc of the object.
    @errors_summary_heading = "%{count} %{errors} prohibited this %{model} from being saved:"
    @environment = nil
    @logger = nil
  end

  def errors_summary_heading_for(object)
    heading = errors_summary_heading
    return heading.call(object) if heading.respond_to?(:call)

    count = object.errors.count
    model = object.class.respond_to?(:model_name) ? object.class.model_name.human.downcase : "form"
    format(heading.to_s, count:, errors: (count == 1) ? "error" : "errors", model:)
  end

  # Settings as a hash (Sinatra's set :<key>, Bridgetown's init): bundle_url:, form_builder:,
  # token_selector:, errors_summary_heading:, tokens: {name => value},
  # defaults: {component => props}, assets: {source:, async:, always:, preload:}.
  def apply(settings)
    settings = settings.to_h.transform_keys(&:to_sym)
    assets.bundle_url = settings[:bundle_url] if settings.key?(:bundle_url)
    %i[form_builder token_selector errors_summary_heading].each { |name| public_send(:"#{name}=", settings[name]) if settings.key?(name) }
    settings.fetch(:assets, {}).each { |name, value| assets.public_send(:"#{name}=", value) }
    settings.fetch(:tokens, {}).each { |name, value| tokens[name] = value }
    settings.fetch(:defaults, {}).each { |component, props| defaults[component] = props }
    self
  end

  # config.token :radius_md, "6px" sets --radius-md.
  def token(name, value)
    tokens[name] = value
  end

  def environment
    (@environment || ${defaults.env ? `(${defaults.env}) || ` : ''}ENV["RACK_ENV"] || ENV["APP_ENV"] || "development").to_s
  end

  def logger
    @logger || ${defaults.logger ? `(${defaults.logger}) || ` : ''}(@default_logger ||= Logger.new($stderr))
  end

  # Development and test raise on a bad setting or prop; anything else logs it.
  def strict?
    %w[development test].include?(environment)
  end

  # Raises (development, test) or logs (otherwise) a configuration or prop error.
  def invalid!(message)
    raise ArgumentError, message if strict?

    logger.warn(message)
    nil
  end

  # Design tokens: CSS custom properties, validated against the library's own list.
  class Tokens
    include Enumerable

    def initialize(config)
      @config = config
      @values = {}
    end

    # --radius-md, "radius-md" or :radius_md.
    def self.normalize(name)
      name = name.to_s.tr("_", "-") if name.is_a?(Symbol)
      name = name.to_s
      name.start_with?("--") ? name : "--#{name}"
    end

    def []=(name, value)
      name = Tokens.normalize(name)
      known = ${ns}.manifest.fetch("tokens", [])
      if known.any? && known.exclude?(name)
        @config.invalid!("#{name} is not a design token")
      elsif value.to_s.match?(UNSAFE_TOKEN_VALUE)
        @config.invalid!("#{name}: #{value.inspect} can't be a token value")
      else
        @values[name] = value.to_s
      end
    end

    def [](name)
      @values[Tokens.normalize(name)]
    end

    delegate :each, :empty?, to: :@values

    def to_h
      @values.dup
    end
  end

  # Default props per component, keyed by component (:button, "${options.tagPrefix}button" or its class).
  class Defaults
    def initialize(config)
      @config = config
      @values = {}
    end

    def []=(component, props)
      klass = ${ns}.component_class(component)
      if klass
        @values[klass.name] = validate(klass, props.to_h.transform_keys(&:to_sym)).freeze
      else
        @config.invalid!("#{component.inspect} is not a component")
      end
    end

    def [](component)
      klass = ${ns}.component_class(component)
      klass ? for_class(klass) : {}
    end

    # The defaults a component class takes (its own, not a parent's).
    def for_class(klass)
      @values.fetch(klass.name, {})
    end

    private

    def validate(klass, props)
      props.select do |key, value|
        spec = klass.props[key]
        if spec.nil?
          @config.invalid!("#{klass.name} has no prop #{key.inspect}")
          next false
        end
        next true if value.nil? || spec[:values].nil? || spec[:values].include?(value.to_s)

        @config.invalid!("#{klass.name} #{key}: #{value.inspect} is not one of #{spec[:values].join(", ")}")
        false
      end
    end
  end

  # Where the elements load from, and what the head preloads.
  class Assets
    SOURCES = %i[cdn local].freeze

    attr_accessor :async, :bundle_url
    attr_reader :always, :preload, :source

    def initialize
      @source = :${options.assets.source}
      @async = false
      @bundle_url = nil
      @always = []
      @preload = []
    end

    # :cdn loads the npm package at the gem's version from the CDN; :local loads the copy the app
    # serves itself (BundleHelper::LOCAL_URL). bundle_url, when set, is used instead of either.
    def source=(source)
      source = source.to_s.to_sym
      raise ArgumentError, "assets.source is :cdn or :local, not #{source.inspect}" unless SOURCES.include?(source)

      @source = source
    end

    # Components, by key (:button), tag ("${options.tagPrefix}button") or class.
    def always=(components)
      @always = Array(components)
    end

    def preload=(components)
      @preload = Array(components)
    end
  end
end

class << self
  def config
    @config ||= Configuration.new
  end

  def configure
    yield config
    config
  end

  def reset_config!
    @config = Configuration.new
  end

  # The generated manifest: every component's key, tag and class, the design tokens, and the
  # JavaScript files each element needs (assets).
  def manifest
    @manifest ||= JSON.parse(File.read(File.join(__dir__, ${rubyString(manifest)}))).freeze
  end

  # A component class from its key (:button), tag ("${options.tagPrefix}button"), class name or class.
  def component_class(component)
    return component if component.is_a?(Class) && component < BaseComponent

    name = component.to_s
    entry = manifest["components"][name] || manifest["components"][name.tr("-", "_")]
    entry ||= manifest["components"].values.find { |spec| spec["tag"] == name || spec["class"] == name.split("::").last }
    entry && const_get(entry["class"])
  end
end
`;

  return inNamespace(ns, body, 'require "json"\nrequire "logger"');
}
