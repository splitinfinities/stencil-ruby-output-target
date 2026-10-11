import type { ResolvedOptions } from './options.ts';
import { inNamespace } from './emit-lib.ts';

/**
 * lib/<ns>/assets.rb: the per-request registry of rendered elements and the files the head
 * preloads for them, from the manifest's `files` (see assets.ts). Framework adapters reset it
 * per request; the head helper reads it.
 */
export function emitAssets(options: ResolvedOptions) {
  const ns = options.rubyNamespace;
  const helper = `${options.configKey}_tags`;

  const body = String.raw`
# Which elements a request rendered, so the head can preload their JavaScript
# (config.assets.async). Each generated component records its tag as it renders; ${helper}
# reads the list. Pages render their body before the layout's <head>, so by the time the head
# helper runs the list is complete. Correctness never depends on it: Stencil's loader fetches
# whatever wasn't preloaded.
#
# The registry is fiber-local and reset per request by the framework's adapter (or with
# ${ns}::Assets.reset!).
module Assets
  STORE = :__${options.configKey}_assets

  # The current request's registry.
  def self.current
    Thread.current[STORE] ||= Registry.new
  end

  def self.reset!
    Thread.current[STORE] = nil
  end

  # A component's tag, from its key (:button), tag ("${options.tagPrefix}button"), class name or class.
  def self.tag_for(component)
    klass = ${ns}.component_class(component)
    return klass.element_tag if klass

    ${ns}.config.invalid!("#{component.inspect} is not a component")
  end

  # The tags of config.assets.always (or preload), skipping (and reporting) unknown ones.
  def self.tags_for(components)
    components.filter_map { |component| tag_for(component) }
  end

  # The files the given tags need, in manifest order, each once.
  def self.files_for(tags)
    by_tag = ${ns}.manifest["components"].values.to_h { |spec| [spec["tag"], spec["files"]] }
    tags.flat_map { |tag| by_tag.fetch(tag, []) }.uniq
  end

  # Tags rendered in one request, in order, and whether the head was already written.
  class Registry
    attr_reader :tags

    def initialize
      @tags = []
      @emitted = false
      @warned = []
    end

    def record(tag)
      return if @tags.include?(tag)

      @tags << tag
      warn_late(tag) if @emitted
    end

    def emitted?
      @emitted
    end

    def emitted!
      @emitted = true
    end

    private

    # In development, a component that renders after the head was written missed its preload.
    def warn_late(tag)
      config = ${ns}.config
      return if config.environment != "development" || @warned.include?(tag)

      @warned << tag
      config.logger.warn("<#{tag}> rendered after ${helper} wrote the head, so it wasn't preloaded; add it to config.assets.always")
    end
  end
end
`;

  return inNamespace(ns, body);
}
