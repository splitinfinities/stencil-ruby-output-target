import type { ComponentModel } from './model.ts';
import type { ResolvedOptions } from './options.ts';
import { inNamespace } from './emit-lib.ts';
import { rubyString } from './naming.ts';
import { symbol, type Samples } from './emit-tests.ts';

/**
 * The test of each framework's adapter: the Rails engine's wiring, a request through the
 * Sinatra extension, a site built through the Bridgetown initializer. Each renders the same
 * page (a helper with a block, a slot, a form, the head) with whatever components the library has.
 */

const lines = (...items: (string | null | undefined | false)[]) => items.filter((item): item is string => typeof item === 'string').join('\n');

/** The tags the page below renders, in order, each once. */
function pageTags(samples: Samples) {
  return [...new Set([samples.any?.tag, samples.slotted?.component.tag, samples.field?.tag].filter((tag): tag is string => !!tag))];
}

/** The loader and the gem's own view, which the Sinatra and Bridgetown gems share. */
function sharedTests(options: ResolvedOptions) {
  const ns = options.rubyNamespace;

  return `
  def test_the_loader_loads_every_component
    ${ns}.eager_load!
    missing = ${ns}.manifest["components"].values.reject { |spec| ${ns}.const_defined?(spec["class"], false) }

    assert_empty missing
    assert_includes BaseComponent.ancestors, ForeignContext
  end

  def test_a_component_renders_in_the_gems_own_view_from_any_caller
    assert_kind_of ViewContext, ViewContext.for(Object.new)
    assert_same ViewContext.template_class, ViewContext.template_class
    refute_predicate ViewContext.build, :protect_against_forgery?
  end`;
}

function rails(components: ComponentModel[], options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const key = options.configKey;
  const any = samples.any;
  const field = samples.field;
  const withEnum = samples.enum;
  const helpers = [any ? symbol(any.helper) : null, `:${key}_tags`, `:${key}_form_with`, `:${key}_form_for`].filter(Boolean);
  const legacy = options.legacy;

  const body = `
# The engine's wiring, in the app test_helper.rb boots: its config.${key} settings copied
# into the config, the helpers in every view, the form builder, the partials and the previews.
class EngineTest < TestCase
  TOKEN = ${rubyString(samples.token)}

  def test_the_apps_settings_are_copied_into_the_config
    assert_equal ["/elements/", :local, :default, "html"], [BOOT_CONFIG.assets.bundle_url, BOOT_CONFIG.assets.source, BOOT_CONFIG.form_builder, BOOT_CONFIG.token_selector]
    assert_equal [true, ${any ? `[${symbol(any.key)}]` : '[]'}], [BOOT_CONFIG.assets.async, BOOT_CONFIG.assets.always]
    assert_equal({TOKEN => "1px"}, BOOT_CONFIG.tokens.to_h)
${lines(withEnum && `    assert_equal({${withEnum.prop.key}: ${rubyString(withEnum.prop.values?.find(Boolean) ?? '')}}, BOOT_CONFIG.defaults[${symbol(withEnum.component.key)}])`)}
  end

  def test_the_config_takes_the_apps_environment_and_logger
    assert_equal Rails.env.to_s, BOOT_CONFIG.environment
    assert_same Rails.logger, BOOT_CONFIG.logger
  end

  def test_every_view_has_the_helpers
    assert_empty([${helpers.join(', ')}].reject { |name| view.respond_to?(name) })
  end

  def test_every_form_builder_has_the_elements_methods_and_ours_is_the_default
    view

    assert_includes ActionView::Helpers::FormBuilder.ancestors, FormBuilderMethods
    assert_equal FormBuilder, ActionView::Base.default_form_builder
${lines(field && `    assert_equal ${rubyString(field.tag)}, parse(builder(record, ActionView::Helpers::FormBuilder).${field.helper}(:title)).element_children.first.name`)}
  end

  def test_each_request_starts_with_an_empty_registry
    Assets.current.record("x-before")
    Rails.application.executor.wrap do
      assert_empty Assets.current.tags
      Assets.current.record("x-during")
    end

    assert_empty Assets.current.tags
  end

  def test_the_partials_and_previews_are_on_the_apps_paths
    assert_includes Rails.application.config.paths["app/views"].to_a, Engine.root.join("app/views").to_s
    assert_includes Rails.application.config.view_component.previews.paths, Engine.root.join("previews").to_s
  end

  def test_every_component_has_a_preview_that_loads
    previews = Dir[Engine.root.join("previews/**/*_preview.rb").to_s]
    previews.each { |file| require file }

    assert_equal ${components.length}, previews.size
    assert_empty(previews.reject { |file| ${ns}.const_defined?(File.basename(file, ".rb").camelize, false) })
  end
${lines(
  legacy?.require &&
    `
  def test_the_old_require_path_still_works_and_warns
    assert_output(nil, /is deprecated/) { require ${rubyString(legacy.require)} }
  end`,
  legacy?.constant &&
    `
  def test_the_old_constant_still_names_the_module
    old = nil
    capture_io { old = Object.const_get(${rubyString(legacy.constant)}) }

    assert_same ${ns}, old
  end`,
)}
end
`;

  return inNamespace(ns, body.replace(/\n{3,}/g, '\n\n').replace(/\n\n(\s*)end\n/g, '\n$1end\n'), 'require "test_helper"');
}

/** The page every adapter's test renders: escaped text, a helper with a block, a slot, a form. */
function page(options: ResolvedOptions, samples: Samples, form: string) {
  const ns = options.rubyNamespace;
  const { any, slotted, field } = samples;
  const key = options.configKey;

  return [
    '<p id="text"><%= "<escaped>" %></p>',
    any ? `<%= ${any.helper}(id: "helper") do %><b>in <%= "<block>" %></b><% end %>` : null,
    slotted
      ? `<%= render(${ns}::${slotted.component.className}.new(id: "slotted")) do |component| %><% component.with_${slotted.rubyName} do %><i>slot</i> <%= "<text>" %><% end %>content<% end %>`
      : null,
    `<%= ${key}_form_with(${form}) do |form| %>${field ? `<%= form.${field.helper} :title %>` : ''}<% end %>`,
  ].filter((line): line is string => line !== null);
}

/** What the page's test asserts, whatever the framework; `doc` and `html` are the page. */
function pageTests(options: ResolvedOptions, samples: Samples) {
  const { any, slotted } = samples;
  const slotCheck = options.slotWrapper === 'attribute' ? `element.at_css("[slot=${slotted?.slot}]")&.name` : 'element.at_css("i")&.name';

  return lines(
    `
  def test_the_pages_text_is_escaped_once
    assert_includes html, %(<p id="text">&lt;escaped&gt;</p>)
  end`,
    any &&
      `
  def test_a_helpers_block_renders_inside_its_element
    element = doc.at_css("body > ${any.tag}#helper")

    assert_equal "in <block>", element.at_css("b").text
    assert_includes html, "<b>in &lt;block&gt;</b>"
  end`,
    slotted &&
      `
  def test_slot_content_stays_inside_the_element
    element = doc.at_css("body > ${slotted.component.tag}#slotted")

    assert_equal "i", ${slotCheck}
    assert_includes element.text, "<text>"
    assert_includes element.text, "content"
    assert_empty doc.css("body > i"), "slot content leaked outside the element"
  end`,
  );
}

function sinatra(options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const key = options.configKey;
  const { any, field } = samples;
  const tags = pageTags(samples);

  const body = `
# The gem in a modular Sinatra app, driven by rack-test: the extension's helpers in the app's
# own templates (escaping, blocks, slots), a form with a CSRF round trip, and the head's preloads.
class SinatraTest < TestCase
  include Rack::Test::Methods

  TOKEN = ${rubyString(samples.token)}
  SETTINGS = {bundle_url: "/elements", assets: {async: true}, tokens: {TOKEN => "1px"}}.freeze

  # The app under test.
  class App < ::Sinatra::Base
    set :environment, :test
    set :show_exceptions, false
    set :raise_errors, true
    set :host_authorization, {permitted_hosts: []}
    enable :sessions
    set :session_secret, "s" * 64
    use Rack::Protection::AuthenticityToken
    register ${ns}::Sinatra

    template(:layout) { %(<!doctype html><html><head><%= ${key}_tags %></head><body><%= yield %></body></html>) }

    template(:page) do
      <<~ERB
        ${page(options, samples, 'model: @record, url: "/records"').join('\n        ')}
        <%= ${key}_form_for(@record, url: "/other") do |form| %><% end %>
      ERB
    end

    template(:one) { %(${any ? `<%= ${any.helper} { "one" } %>` : ''}) }

    get "/" do
      @record = Record.new(title: "Hello")
      erb :page
    end

    get("/one") { erb :one }

    post("/records") { "saved" }
  end

  # The extension applies a settings hash once; a new one after each test's config reset.
  def setup
    super
    App.set :${key}, SETTINGS.dup
  end

  def app
    App
  end

  def html
    get "/"
    raise last_response.body unless last_response.ok?

    last_response.body
  end

  def doc
    Nokogiri::HTML5(html)
  end

  def preloads(body)
    Nokogiri::HTML5(body).css("link[rel=modulepreload]").map { |link| link["href"].delete_prefix("/elements/") }
  end
${pageTests(options, samples)}

  def test_a_form_carries_the_sessions_csrf_token
    form = doc.at_css("form[action='/records']")
    token = form.at_css("input[type=hidden][name=authenticity_token]")["value"]
${lines(field && `\n    assert_equal %w[record[title] Hello], [form.at_css("${field.tag}")["name"], form.at_css("${field.tag}")["${field.props.find((p) => p.jsName === field.formField?.value)?.attribute}"]]`)}
    post "/records", "authenticity_token" => token

    assert_equal [200, "saved"], [last_response.status, last_response.body]
    post "/records"

    assert_equal 403, last_response.status
  end

  def test_the_head_loads_the_bundle_and_preloads_what_the_page_rendered
    head = doc.at_css("head")

    assert_equal "/elements/${options.assets.loader}#{cache_key}", head.at_css("script[type=module]")["src"]
    assert_equal ":root{#{TOKEN}:1px}", head.at_css("style").text
    assert_equal Assets.files_for(%w[${tags.join(' ')}]), preloads(html)
  end

  def test_each_request_starts_with_an_empty_registry
    html
    get "/one"

    assert_equal Assets.files_for(%w[${any?.tag ?? ''}]), preloads(last_response.body)
  end

  def test_the_config_follows_the_app
    html

    assert_equal ["test", "/elements", true], [config.environment, config.assets.bundle_url, config.assets.async]
  end

  def test_settings_are_applied_once_per_hash
    settings = {token_selector: "html"}
    ${ns}::Sinatra.apply(settings)
    config.token_selector = "body"
    ${ns}::Sinatra.apply(settings)
    ${ns}::Sinatra.apply(nil)

    assert_equal "body", config.token_selector
  end
${sharedTests(options)}
end
`;

  return inNamespace(ns, body.replace(/\n{3,}/g, '\n\n'), 'require "test_helper"\nrequire "rack/test"');
}

function bridgetown(options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const key = options.configKey;
  const { any, field } = samples;
  const tags = pageTags(samples);
  const front = '---\nlayout: default\n---\n';

  const files = {
    'src/_layouts/default.erb': '<!doctype html>\n<html><head><%= partial "head" %></head><body><%= yield %></body></html>\n',
    'src/_partials/_head.erb': `<%= ${key}_tags %>\n`,
    'src/index.erb': `${front}${page(options, samples, 'url: "/records", scope: :record').join('\n')}\n<%= ${key}_form_for(:record, url: "/other") do |form| %><% end %>\n`,
    'src/one.erb': `${front}${any ? `<%= ${any.helper} { "one" } %>` : ''}\n`,
  };

  const site = Object.entries(files)
    .map(([path, content]) => `    ${rubyString(path)} => ${rubyString(content)}`)
    .join(',\n');

  const body = `
# The gem in the Bridgetown site test_helper.rb booted, built through the initializer: the
# helpers in the site's own templates (escaping, blocks, slots), a form, and the head's preloads.
class BridgetownTest < TestCase
  TOKEN = ${rubyString(samples.token)}

  # The site's pages: a layout whose head has the tags, and two pages.
  PAGES = {
${site}
  }.freeze

  # Builds the site once, as bridgetown build does, with the settings init gave the config
  # (each test starts from a fresh one), and returns its output directory.
  def self.output
    @output ||= begin
      PAGES.each do |path, content|
        FileUtils.mkdir_p(File.dirname(File.join(SITE_ROOT, path)))
        File.write(File.join(SITE_ROOT, path), content)
      end
      ${ns}.config.apply(SITE_SETTINGS)
      Dir.chdir(SITE_ROOT) { ::Bridgetown::Site.new(SITE_CONFIG).process }
      File.join(SITE_ROOT, "output")
    end
  end

  def html(page = "index.html")
    File.read(File.join(self.class.output, page))
  end

  def doc
    Nokogiri::HTML5(html)
  end

  def preloads(body)
    Nokogiri::HTML5(body).css("link[rel=modulepreload]").map { |link| link["href"].delete_prefix("/elements/") }
  end
${pageTests(options, samples)}

  def test_a_form_is_written_without_a_csrf_token
    form = doc.at_css("form[action='/records']")

    assert_nil form.at_css("input[name=authenticity_token]"), "a static site has no session"
${lines(field && `    assert_equal "record[title]", form.at_css("${field.tag}")["name"]`)}
    assert doc.at_css("form[action='/other']")
  end

  def test_the_head_loads_the_bundle_and_preloads_what_the_page_rendered
    head = doc.at_css("head")

    assert_equal "/elements/${options.assets.loader}#{cache_key}", head.at_css("script[type=module]")["src"]
    assert_equal ":root{#{TOKEN}:1px}", head.at_css("style").text
    assert_equal Assets.files_for(%w[${tags.join(' ')}]), preloads(html)
  end

  def test_each_page_starts_with_an_empty_registry
    assert_equal Assets.files_for(%w[${any?.tag ?? ''}]), preloads(html("one/index.html"))
  end

  def test_the_initializer_adds_the_helpers_and_applies_its_settings
    assert_includes ::Bridgetown::TemplateView::Helpers.ancestors, ${ns}::Bridgetown::Helpers
    assert_equal ["/elements", true, "1px"], [BOOT_CONFIG.assets.bundle_url, BOOT_CONFIG.assets.async, BOOT_CONFIG.tokens[TOKEN]]
    assert_equal ::Bridgetown.env.to_s, BOOT_CONFIG.environment
  end
${sharedTests(options)}
end
`;

  return inNamespace(ns, body.replace(/\n{3,}/g, '\n\n'), 'require "test_helper"');
}

/** The framework's test file: its path in the gem and its content. */
export function emitFrameworkTest(components: ComponentModel[], options: ResolvedOptions, samples: Samples): [string, string] {
  switch (options.framework) {
    case 'sinatra':
      return ['test/sinatra_test.rb', sinatra(options, samples)];
    case 'bridgetown':
      return ['test/bridgetown_test.rb', bridgetown(options, samples)];
    default:
      return ['test/engine_test.rb', rails(components, options, samples)];
  }
}
