import type { ResolvedOptions } from './options.ts';
import { inNamespace, libPaths } from './emit-lib.ts';
import { rubyString } from './naming.ts';

/**
 * What a gem outside Rails needs (framework `sinatra` or `bridgetown`): its own Zeitwerk loader
 * for app/components and app/helpers, a private ActionView view context to render in, and the
 * ForeignContext prepend on the generated BaseComponent, which renders through that view when
 * the caller's view isn't ActionView. Then each framework's adapter.
 */

/** lib/<ns>/loader.rb: ActionView without Rails, and the gem's autoloader. */
export function emitLoader(options: ResolvedOptions) {
  const ns = options.rubyNamespace;
  // lib/<ns>/loader.rb → the gem root, from __dir__.
  const up = libPaths(options).loader.split('/').length - 1;

  return inNamespace(
    ns,
    `
# The gem's own autoloader for app/components and app/helpers (Zeitwerk, as Rails would).
LOADER = Zeitwerk::Loader.new
LOADER.tag = ${rubyString(options.gem.name)}
LOADER.push_dir(File.expand_path(${rubyString(`${'../'.repeat(up)}app/components`)}, __dir__))
LOADER.push_dir(File.expand_path(${rubyString(`${'../'.repeat(up)}app/helpers`)}, __dir__))
LOADER.on_load("${ns}::BaseComponent") { |klass| klass.prepend(ForeignContext) }
LOADER.setup

# Loads every component now (for a production boot, or to list them).
def self.eager_load!
  LOADER.eager_load
end
`,
    `require "zeitwerk"

# ViewComponent 4 reads Rails::VERSION::MAJOR as it compiles a template, and without railties
# Rails has no VERSION (rails-html-sanitizer defines Rails::HTML, so the module exists). Use
# railties' own when the bundle has it, else ActionView's (the same release train).
unless defined?(::Rails::VERSION)
  begin
    require "rails/version"
  rescue LoadError
    module Rails
      VERSION = ActionView::VERSION
    end
  end
end

# Outside Rails, ActionView's form defaults are the pre-5.x ones: no remote forms, no utf8
# field, and ids on the fields form_with writes, as a Rails 8 app has.
ActionView::Helpers::FormHelper.form_with_generates_remote_forms = false
ActionView::Helpers::FormHelper.form_with_generates_ids = true
ActionView::Helpers::FormTagHelper.default_enforce_utf8 = false`,
  );
}

/** lib/<ns>/view_context.rb: the ActionView view components render in outside Rails. */
export function emitViewContext(options: ResolvedOptions) {
  const ns = options.rubyNamespace;
  const key = options.configKey;

  return inNamespace(
    ns,
    `
# An ActionView view of the gem's own, with no templates of its own: the components, the
# FormBuilder and the head helper run in it. Each adapter builds one per request (or render),
# with its app as the controller when there is one.
class ViewContext < ActionView::Base
  include ${ns}::Helpers
  include ${ns}::BundleHelper
  include ${ns}::FormHelper

  def self.build(controller = nil)
    template_class.new(ActionView::LookupContext.new([]), {}, controller)
  end

  # ActionView compiles templates into a class; one per view class, not per view.
  def self.template_class
    @template_class ||= with_empty_template_cache
  end

  # A view to render a component in for a caller's context: its own when the adapter gave it
  # one (${key}_view), else a fresh one.
  def self.for(context)
    context.respond_to?(:${key}_view) ? context.${key}_view : build
  end

  # Inside ActionView, rendering is ActionView's.
  def ${key}_render(component, &)
    render(component, &)
  end

  # No CSRF token unless the adapter's view knows the session (Sinatra's does).
  def protect_against_forgery?
    false
  end
end
`,
  );
}

/** lib/<ns>/foreign_context.rb: rendering from a view that isn't ActionView. */
export function emitForeignContext(options: ResolvedOptions) {
  const ns = options.rubyNamespace;

  return inNamespace(
    ns,
    `
# Prepended to BaseComponent (only the generated components, never ViewComponent::Base): a
# component rendered from a view that isn't ActionView (a Sinatra app, a Bridgetown page)
# renders in the gem's ViewContext instead. The caller's block, and each slot's block, is
# captured first in the caller's own template engine, so its escaping and helpers apply; the
# component gets the captured HTML.
#
# A slot block that takes arguments (renders_many with a lambda) can't be captured ahead like
# this; pass the slot's content as a string instead.
module ForeignContext
  def render_in(view_context, &block)
    return super if view_context.is_a?(ActionView::Base)

    @__foreign_context = view_context
    inner = block && view_context.capture(self, &block)
    @__foreign_context = nil
    # The caller's engine escaped what the block wrote; this is its output, as HTML.
    ViewContext.for(view_context).render(self) { inner.to_s.html_safe } # rubocop:disable Rails/OutputSafety -- see above
  end

  private

  # ViewComponent's (private) slot setter, while a foreign view's block runs: the slot's block
  # is captured there and then, or its content would be written outside the element.
  def __vc_set_slot(slot_name, slot_definition = nil, *args, **kwargs, &block)
    context = @__foreign_context
    return super unless block && context

    captured = context.capture(&block).to_s.html_safe # rubocop:disable Rails/OutputSafety -- the caller's engine escaped it
    super { captured }
  end
end
`,
  );
}

/** lib/<ns>/sinatra.rb: `register <Namespace>::Sinatra`. */
export function emitSinatra(options: ResolvedOptions) {
  const ns = options.rubyNamespace;
  const key = options.configKey;

  return inNamespace(
    ns,
    `
# The Sinatra extension:
#
#   require ${rubyString(libPaths(options).entry.slice('lib/'.length, -'.rb'.length))}
#
#   class App < Sinatra::Base
#     enable :sessions
#     use Rack::Protection::AuthenticityToken     # CSRF tokens for the forms
#     register ${ns}::Sinatra
#     set :${key}, {bundle_url: "/elements", assets: {async: true}}
#
#     get("/") { erb :index }
#   end
#
# It sets ERB to Erubi's CaptureBlockEngine (block helpers like ${options.helperPrefix}* do ... end
# and ${key}_form_with need it) with a buffer that leaves html_safe strings unescaped, adds the
# helpers (${options.helperPrefix}*, ${key}_tags, ${key}_form_with, render for components),
# renders components in a per-request ActionView view with the app as its controller, and
# resets the asset registry before each request.
module Sinatra
  # Escapes what a template writes, except html_safe strings (rendered components, forms), and
  # hands back its output as html_safe: it's escaped already, so a layout's <%= yield %> and a
  # captured block aren't escaped twice.
  class SafeBuffer < Erubi::CaptureBlockEngine::Buffer
    def |(other)
      concat(ERB::Util.html_escape(other))
    end

    def to_s
      super.html_safe # rubocop:disable Rails/OutputSafety -- see above
    end
  end

  # The request's ActionView view: forms carry Rack::Protection's CSRF token.
  class ViewContext < ${ns}::ViewContext
    def protect_against_forgery?
      controller.env.key?("rack.session")
    end

    def form_authenticity_token(**)
      Rack::Protection::AuthenticityToken.token(controller.session)
    end
  end

  # Helpers for the app's templates.
  module Helpers
    include ${ns}::Helpers

    def ${key}_view
      @${key}_view ||= ViewContext.build(self)
    end

    # ActionView asks the controller for the token's field name.
    def request_forgery_protection_token
      :authenticity_token
    end

    # A block's output, from Erubi's capture buffer (escaped as it was written).
    def capture(*, &)
      @_out_buf.capture(*, &).to_s
    end

    # render(component) for components; Sinatra's render otherwise.
    def render(engine, *, **, &block)
      return ${key}_render(engine, &block) if engine.respond_to?(:render_in)

      super
    end

    def ${key}_tags(**)
      ${key}_view.${key}_tags(**)
    end

    def ${key}_form_with(**options, &block)
      ${key}_view.${key}_form_with(**options) { |form| capture(form, &block) }
    end

    def ${key}_form_for(record, options = {}, &block)
      ${key}_view.${key}_form_for(record, options) { |form| capture(form, &block) }
    end
  end

  def self.registered(app)
    app.helpers Helpers
    app.set :erb, engine_class: Erubi::CaptureBlockEngine, bufval: "#{SafeBuffer}.new", escape: true
    app.set :${key}, {} unless app.respond_to?(:${key})
    ${ns}.config.environment = app.environment.to_s
    app.before do
      ${ns}::Assets.reset!
      ${ns}::Sinatra.apply(settings.${key})
    end
  end

  # set :${key}, {...}: the configure block's settings as a hash (Configuration#apply), applied
  # once per hash.
  def self.apply(settings)
    return if settings.nil? || settings.equal?(@applied)

    @applied = settings
    ${ns}.config.apply(settings)
  end
end
`,
    `require "sinatra/base"
require "rack/protection"
require "erubi/capture_block"`,
  );
}

/** lib/<ns>/bridgetown.rb: `init :<gem name>` in config/initializers.rb. */
export function emitBridgetown(options: ResolvedOptions) {
  const ns = options.rubyNamespace;
  const key = options.configKey;
  const gem = options.gem.name;

  const body = `
# The Bridgetown plugin:
#
#   # config/initializers.rb
#   Bridgetown.configure do |config|
#     init :${JSON.stringify(gem)}, bundle_url: "/elements", assets: {async: true}
#   end
#
#   <%# src/_partials/_head.erb %>
#   <%= ${key}_tags %>
#
# It adds the helpers (${options.helperPrefix}*, ${key}_tags, ${key}_form_with) to every
# template, renders components (render ${ns}::ButtonComponent.new) in an ActionView view of the
# gem's own, and starts the asset registry afresh for each page it renders. Bridgetown renders a
# page's content before its layout, so the head knows what the page rendered.
module Bridgetown
  # Helpers for the site's templates (Bridgetown::TemplateView::Helpers includes it).
  module Helpers
    include ${ns}::Helpers

    def ${key}_view
      @${key}_view ||= ${ns}::ViewContext.build
    end

    def ${key}_tags(**)
      ${key}_view.${key}_tags(**)
    end

    # The form's block runs in the page's template, so its helpers and escaping apply.
    def ${key}_form_with(**options, &block)
      page = view
      ${key}_view.${key}_form_with(**options) { |form| page.capture(form, &block) }
    end

    def ${key}_form_for(record, options = {}, &block)
      page = view
      ${key}_view.${key}_form_for(record, options) { |form| page.capture(form, &block) }
    end
  end
end
`;

  const initializer = `
# init :${JSON.stringify(gem)}, **settings: the configure block's settings (Configuration#apply).
Bridgetown.initializer :${rubyString(gem)} do |_config, **settings|
  Bridgetown::TemplateView::Helpers.include(${ns}::Bridgetown::Helpers)
  ${ns}.config.environment = Bridgetown.env.to_s
  ${ns}.config.apply(settings)
  # Each page starts with an empty asset registry.
  Bridgetown::Hooks.register_one(:resources, :pre_render, reloadable: false) { ${ns}::Assets.reset! }
  Bridgetown::Hooks.register_one(:generated_pages, :pre_render, reloadable: false) { ${ns}::Assets.reset! }
end
`;

  return `${inNamespace(ns, body, 'require "bridgetown-core"')}${initializer}`;
}

/** lib/<gem name>.rb: what \`init :<gem name>\` requires. */
export function emitBridgetownRequire(options: ResolvedOptions) {
  return [
    `lib/${options.gem.name}.rb`,
    `# frozen_string_literal: true

# Generated by stencil-ruby-output-target. Do not edit.

# Bridgetown's init :${JSON.stringify(options.gem.name)} requires the gem by its name.
require ${rubyString(libPaths(options).entry.slice('lib/'.length, -'.rb'.length))}
`,
  ] as const;
}
