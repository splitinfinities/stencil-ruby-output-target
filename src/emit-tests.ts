import type { ComponentModel, PropModel } from './model.ts';
import type { ResolvedOptions } from './options.ts';
import { gemRequirePath, HEADER, inNamespace, openModules } from './emit-lib.ts';
import { namespacePath, rubyString } from './naming.ts';
import { emitBaseComponentTest, emitAssetsTest, emitConfigTest, emitHelpersTest } from './emit-tests-library.ts';
import { emitFormBuilderTest } from './emit-tests-forms.ts';
import { emitFrameworkTest } from './emit-tests-frameworks.ts';

/**
 * The gem's own test suite (`test/`, not shipped in the gem): Minitest, run in the gem's
 * framework bundle with `ruby -Itest test/all.rb`, which also measures line coverage of the
 * generated Ruby with Ruby's `Coverage` and fails below `coverageThreshold`.
 *
 * Every test is generated from the model, so it checks what each component should render (each
 * enum value, each boolean, each slot, …), not only that rendering doesn't raise.
 */

/** What the generic suites need from the library: a component of each kind, where it has one. */
export interface Samples {
  /** Any component (the first). */
  any?: ComponentModel;
  /** One with an enum prop a caller may leave out, and that prop. */
  enum?: { component: ComponentModel; prop: PropModel };
  /** One with a named slot that takes one item. */
  slotted?: { component: ComponentModel; slot: string; rubyName: string };
  /** A form-associated one whose value is a string. */
  field?: ComponentModel;
  /** A design token `config.tokens` accepts (any name does when the library lists none). */
  token: string;
  /** Whether the library lists its tokens, so an unknown name is rejected. */
  listsTokens: boolean;
}

/** A value for a prop a component requires, as Ruby. */
export function sampleValue(prop: PropModel): string {
  switch (prop.kind) {
    case 'enum':
      return rubyString(prop.values?.[0] ?? 'x');
    case 'number':
      return '1';
    case 'boolean':
      return 'true';
    case 'json':
      return '{}';
    default:
      return '"x"';
  }
}

/** `{name: "x"}`: a value for each prop the component requires. */
export function requiredProps(component: ComponentModel) {
  return component.props.filter((p) => p.required).map((p) => `${p.key}: ${sampleValue(p)}`);
}

/** Keywords `initialize` takes for itself on some components, so a prop of that name never gets them. */
function takenByInitialize(component: ComponentModel, prop: PropModel) {
  if (component.formField && (prop.key === 'attribute' || prop.key === 'form')) return true;

  return prop.key === 'client_state' && component.props.some((p) => p.key === 'state');
}

export function pickSamples(components: ComponentModel[], tokens: string[]): Samples {
  const optionalEnum = (c: ComponentModel) => c.props.find((p) => p.kind === 'enum' && !p.required && (p.values ?? []).some(Boolean) && !takenByInitialize(c, p));
  const withEnum = components.find((c) => optionalEnum(c) && requiredProps(c).length === 0);
  const prop = withEnum && optionalEnum(withEnum);
  const withSlot = components.find((c) => requiredProps(c).length === 0 && c.slots.some((s) => s.name !== '' && !s.many));
  const slot = withSlot?.slots.find((s) => s.name !== '' && !s.many);
  const stringValue = (c: ComponentModel) => c.formField?.value !== undefined && c.props.find((p) => p.jsName === c.formField?.value)?.kind === 'string';

  return {
    any: components.find((c) => requiredProps(c).length === 0) ?? components[0],
    enum: withEnum && prop ? { component: withEnum, prop } : undefined,
    slotted: withSlot && slot ? { component: withSlot, slot: slot.name, rubyName: slot.rubyName } : undefined,
    field: components.find((c) => stringValue(c) && requiredProps(c).length === 0),
    token: [...tokens].sort().find((token) => !token.includes('_')) ?? '--sample-token',
    listsTokens: tokens.length > 0,
  };
}

/** A Ruby symbol literal; quoted when the name isn't a plain identifier. */
export const symbol = (name: string) => (/^[a-z_][a-z0-9_]*[?!]?$/i.test(name) ? `:${name}` : `:${rubyString(name)}`);

const words = (values: string[]) => `%w[${values.join(' ')}]`;

function coverage(options: ResolvedOptions) {
  const body = String.raw`
# Line coverage of the gem's generated Ruby, measured by Ruby's own Coverage library (nothing to
# install): every .rb file under app/ and lib/, loaded by a test or not, and how many of the
# templates a test rendered. test/all.rb enforces THRESHOLD; one test file on its own only measures.
module TestCoverage
  ROOT = File.realpath(File.expand_path("..", __dir__))
  # The lowest line coverage (%) a full run may end with, overall and for app/components.
  THRESHOLD = ${options.coverageThreshold}
  GROUPS = %w[app/components app/helpers lib].freeze
  REPORT = File.join(ROOT, "coverage/coverage.json")

  class << self
    attr_accessor :enforced

    def start
      return if Coverage.running?

      # A file Ruby loaded before now (the gemspec requires version.rb) can't be measured.
      @preloaded = $LOADED_FEATURES.filter_map { |path| real(path) }.select { |path| path.start_with?("#{ROOT}/app/", "#{ROOT}/lib/") }
      Coverage.start(lines: true, eval: true)
    end

    # Writes coverage/coverage.json, prints the summary and, for a full run, fails below THRESHOLD.
    def finish
      data = report
      File.write(REPORT.tap { |path| FileUtils.mkdir_p(File.dirname(path)) }, "#{JSON.pretty_generate(data)}\n")
      print_summary(data)
      low = ["total", "app/components"].select { |name| percent(data, name) < THRESHOLD }
      abort "Line coverage is below #{THRESHOLD}%: #{low.join(", ")}" if enforced && low.any?
    end

    def report
      result = Coverage.result.each_with_object({}) { |(path, counts), out| out[real(path) || path] = counts[:lines] }
      files = measured.to_h { |path| [relative(path), tally(result[path] || Coverage.line_stub(path))] }
      templates = Dir[File.join(ROOT, "app/**/*.erb")]
      {
        "threshold" => THRESHOLD,
        "total" => summary(files),
        # rubocop:disable Rails/IndexWith -- plain Ruby: this file runs before anything else is loaded
        "groups" => GROUPS.to_h { |group| [group, summary(files.select { |path, _| path.start_with?("#{group}/") })] },
        # rubocop:enable Rails/IndexWith
        "templates" => {"files" => templates.size, "rendered" => templates.count { |path| result[path]&.any? { |count| count.to_i.positive? } }},
        "unmeasured" => @preloaded.map { |path| relative(path) }.sort,
        "files" => files
      }
    end

    private

    def measured
      Dir[File.join(ROOT, "{app,lib}/**/*.rb")].sort - @preloaded
    end

    def real(path)
      File.realpath(path) if File.exist?(path)
    end

    def relative(path)
      path.delete_prefix("#{ROOT}/")
    end

    def tally(lines)
      executable = lines.compact
      {"lines" => executable.size, "covered" => executable.count(&:positive?)}
    end

    def summary(files)
      lines = files.values.sum { |file| file["lines"] }
      covered = files.values.sum { |file| file["covered"] }
      {"lines" => lines, "covered" => covered, "percent" => lines.zero? ? 100.0 : (covered * 100.0 / lines).round(2)}
    end

    def percent(data, name)
      (data[name] || data.dig("groups", name)).fetch("percent")
    end

    def print_summary(data)
      rows = data["groups"].merge("total" => data["total"])
      puts "", "Line coverage of the generated Ruby (#{relative(REPORT)})"
      rows.each { |name, row| puts format("  %-16<name>s %6.2<percent>f%%  %<covered>d/%<lines>d lines", name:, percent: row["percent"], covered: row["covered"], lines: row["lines"]) }
      puts format("  %-16<name>s %<rendered>d/%<files>d rendered", name: "templates", rendered: data.dig("templates", "rendered"), files: data.dig("templates", "files"))
    end
  end
end
`;

  return inNamespace(options.rubyNamespace, body, 'require "coverage"\nrequire "fileutils"\nrequire "json"');
}

/** How each framework's tests load the gem and get a view to render in. */
function boot(options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const entry = gemRequirePath(options.gem.name);
  const key = options.configKey;

  if (options.framework === 'sinatra') {
    return { requires: `require "active_support/time"\nrequire ${rubyString(entry)}`, setup: '', toplevel: '', view: `${ns}::ViewContext.build` };
  }

  if (options.framework === 'bridgetown') {
    return {
      requires: 'require "fileutils"\nrequire "tmpdir"\nrequire "active_support/time"\nrequire "bridgetown-core"',
      setup: `
# What the site's config/initializers.rb passes to init.
SITE_SETTINGS = {bundle_url: "/elements", assets: {async: true}, tokens: {${rubyString(samples.token)} => "1px"}}.freeze

# Bridgetown loads the gem as it runs a site's initializers, so the tests boot a site first: its
# config and initializer here, its pages in bridgetown_test.rb.
SITE_ROOT = File.realpath(Dir.mktmpdir("generated-tests"))
Minitest.after_run { FileUtils.remove_entry(SITE_ROOT) }
FileUtils.mkdir_p(File.join(SITE_ROOT, "config"))
File.write(File.join(SITE_ROOT, "bridgetown.config.yml"), "template_engine: erb\\n")
File.write(File.join(SITE_ROOT, "config/initializers.rb"), <<~RUBY)
  Bridgetown.configure { |_config| init :${rubyString(options.gem.name)}, **${ns}::SITE_SETTINGS }
RUBY
SITE_CONFIG = Dir.chdir(SITE_ROOT) do
  ::Bridgetown.configuration("root_dir" => SITE_ROOT, "quiet" => true).tap { |config| config.run_initializers!(context: :static) }
end

# The config as the initializer left it; every test starts from a fresh one.
BOOT_CONFIG = config
`,
      toplevel: '',
      view: `${ns}::ViewContext.build`,
    };
  }

  const settings = [
    `config.${key}.bundle_url = "/elements/"`,
    `config.${key}.source = :local`,
    `config.${key}.form_builder = :default`,
    `config.${key}.async = true`,
    samples.any ? `config.${key}.always = [${symbol(samples.any.key)}]` : null,
    `config.${key}.token_selector = "html"`,
    `config.${key}.tokens = {${rubyString(samples.token)} => "1px"}`,
    samples.enum ? `config.${key}.defaults = {${samples.enum.component.key}: {${samples.enum.prop.key}: ${rubyString(samples.enum.prop.values?.find(Boolean) ?? '')}}}` : null,
  ].filter((line): line is string => line !== null);

  return {
    requires: `require "rails"\nrequire "action_controller/railtie"\nrequire "view_component"\nrequire ${rubyString(entry)}`,
    setup: `
# A minimal Rails app. Its config.${key} settings are what engine_test.rb expects the engine
# to have copied into the config.
class TestApp < Rails::Application
  config.eager_load = false
  config.logger = Logger.new(nil)
  config.secret_key_base = "test"
  config.hosts.clear
  config.action_controller.allow_forgery_protection = false
  ${settings.join('\n  ')}
end
TestApp.initialize!

# The config as the engine left it at boot; every test starts from a fresh one.
BOOT_CONFIG = config
`,
    toplevel: '\n# The controller whose view the components render in.\nclass ApplicationController < ActionController::Base; end\n',
    view: 'ApplicationController.new.view_context',
  };
}

function testHelper(options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const { open, close, indent } = openModules(ns);
  const framework = boot(options, samples);

  const body = String.raw`${framework.setup}
# A form's object: an ActiveModel with a required title, for the form builder's tests.
class Record
  include ActiveModel::Model
  include ActiveModel::Attributes

  attribute :title, :string
  attribute :count, :integer
  attribute :accepted, :boolean
  attribute :choice, :string
  attribute :blank

  validates :title, presence: true

  def self.model_name
    ActiveModel::Name.new(self, nil, "Record")
  end

  def persisted?
    false
  end
end

# Every test starts with a fresh config (the test environment, so a bad setting or prop
# raises), a log to read and an empty asset registry.
class TestCase < Minitest::Test
  # The test's config.
  attr_reader :config

  def setup
    @config = ${ns}.reset_config!
    config.environment = "test"
    config.logger = Logger.new(log)
    Assets.reset!
  end

  # What the head puts in the URL of a file with no hash in its name: ?v=<the build's digest>.
  def cache_key
    "?v=#{${ns}.manifest.dig("assets", "digest") || NPM_VERSION}"
  end

  # What the gem logged during the test.
  def log
    @log ||= StringIO.new
  end

  # Anywhere but development and test, a bad setting or prop is logged, not raised.
  def production!
    config.environment = "production"
  end

  def view
    @view ||= ${framework.view}
  end

  def parse(html)
    Nokogiri::HTML5.fragment(html.to_s)
  end

  # Renders a component in the view and returns its element.
  def render_element(component, &)
    parse(view.render(component, &)).element_children.first
  end

  def record(**attributes)
    Record.new(title: "Hello", count: 3, accepted: true, choice: "a", **attributes)
  end

  # A form builder for the record, as a form's block gets it.
  def builder(object = record, klass = FormBuilder)
    klass.new(:record, object, view, {})
  end
end

# What each component's test checks its props and slots with. A test names its component and,
# where the component requires props, a value for each.
class ComponentTestCase < TestCase
  # Text a template must escape exactly once.
  UNSAFE = %(a "b" <c> & d)

  def required_props
    {}
  end

  def build(**props)
    component_class.new(**required_props, **props)
  end

  # The component's element, rendered with the given props.
  def element(**props, &)
    render_element(build(**props), &)
  end

  # Each value renders as the attribute, from a string or a symbol, and any other value raises.
  def assert_enum_prop(key, attribute, values)
    values.each { |value| assert_equal value, element(key => value)[attribute], "#{key}: #{value.inspect}" }
    assert_equal values.first, element(key => values.first.to_sym)[attribute]
    assert_raises(ArgumentError) { build(key => "not-a-#{key}") }
  end

  # Present while on, never "false": absent while off, unless it defaults to on.
  def assert_boolean_prop(key, attribute, default: false)
    on = element(key => true)
    off = element(key => false)

    assert_equal "", on[attribute]
    if default
      assert_equal "false", off[attribute]
    else
      assert_nil off[attribute]
    end
  end

  def assert_string_prop(key, attribute)
    assert_equal UNSAFE, element(key => UNSAFE)[attribute]
  end

  def assert_number_prop(key, attribute)
    assert_equal "7", element(key => 7)[attribute]
  end

  # A list for a string attribute: JSON in the attribute, and the list itself as a property.
  def assert_list_prop(key, attribute, property)
    rendered = element(key => %w[a b])

    assert_equal %w[a b], JSON.parse(rendered[attribute])
    assert_equal %w[a b], JSON.parse(rendered["data-stencil-props"])[property]
  end

  # A prop with no attribute goes out as JSON, for the browser to assign as a property.
  def assert_property_prop(key, property)
    value = {"a" => [1, "<b>"]}

    assert_equal value, JSON.parse(element(key => value)["data-stencil-props"])[property]
  end

  # A named slot's content lands inside the element, marked the way the template marks it
  # (wrapper: the output target's slotWrapper).
  def assert_slot(ruby_name, name, many: false, wrapper: :attribute)
    setter = :"with_#{many ? ruby_name.to_s.singularize : ruby_name}"
    rendered = element do |component|
      component.public_send(setter) { view.tag.b("slotted") }
      nil
    end
    slotted = rendered.at_css("b")

    assert_equal "slotted", slotted&.text
    assert_equal name, slotted["slot"] if wrapper == :attribute
    assert_equal name, slotted.parent["slot"] if wrapper == :span
  end

  # The block is the default slot: escaped once, and markup stays markup.
  def assert_content
    assert_equal UNSAFE, element { UNSAFE }.text
    assert_equal "inside", element { view.tag.i("inside") }.at_css("i")&.text
  end

  # Anything that isn't a prop goes onto the element, data: and aria: one attribute per key.
  def assert_host_attributes
    given = {class: "a b", id: "host", data: {test_id: 1}, aria: {label: "L"}}.except(*component_class.props.keys)
    expected = {class: {"class" => "a b"}, id: {"id" => "host"}, data: {"data-test-id" => "1"}, aria: {"aria-label" => "L"}}
    rendered = element(**given)

    given.each_key { |key| expected[key].each { |name, value| assert_equal value, rendered[name], name } }
  end

  # config.defaults gives a prop its value when the caller doesn't.
  def assert_configured_default(key, attribute, value, expected = value.to_s)
    config.defaults[component_class] = {key => value}

    assert_equal expected, element[attribute]
  end

  # With config.assets.async, rendering records the element for the head's preloads.
  def assert_recorded(tag)
    element

    assert_empty Assets.current.tags
    config.assets.async = true
    element

    assert_equal [tag], Assets.current.tags
  end
end
`;

  const indented = body
    .trim()
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : ''))
    .join('\n');

  return `${HEADER}
# Loads the gem the way ${options.framework === 'rails' ? 'a Rails app' : options.framework === 'sinatra' ? 'a Sinatra app' : 'a Bridgetown site'} does, with line coverage running first, and gives the tests a
# view to render in. Run a file with ruby -Itest test/<file>, or everything with
# ruby -Itest test/all.rb, in a bundle with the gem's dependencies, minitest and activemodel${options.framework === 'rails' ? ' (and rails)' : options.framework === 'sinatra' ? ' (and rack-test)' : ''}.
ENV["RAILS_ENV"] = "test"
ENV["RACK_ENV"] = "test"
ENV["APP_ENV"] = "test"

require_relative "line_coverage"
${ns}::TestCoverage.start

require "json"
require "logger"
require "stringio"
require "minitest/autorun"
require "active_model"
require "nokogiri"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
${framework.requires}

Minitest.after_run { ${ns}::TestCoverage.finish }
${framework.toplevel}
${open}
${indented}
${close}
`;
}

/** The prop a component's `config.defaults` test sets: one a caller may leave out, with a value that shows. */
function defaultable(component: ComponentModel): { prop: PropModel; value: string; expected?: string } | undefined {
  const candidates = component.props.filter((p) => !p.required && p.attribute && p.strategy !== 'property' && !takenByInitialize(component, p));
  const withValues = candidates.find((p) => p.kind === 'enum' && (p.values ?? []).some(Boolean));

  if (withValues) {
    const values = (withValues.values ?? []).filter(Boolean);
    const value = values.find((v) => rubyString(v) !== withValues.rubyDefault) ?? values[0];

    return { prop: withValues, value: rubyString(value) };
  }

  const text = candidates.find((p) => p.kind === 'string');

  if (text) return { prop: text, value: '"configured"' };
  const number = candidates.find((p) => p.kind === 'number');

  if (number) return { prop: number, value: '5' };
  const flag = candidates.find((p) => p.kind === 'boolean');

  return flag ? { prop: flag, value: 'true', expected: '""' } : undefined;
}

function propTest(component: ComponentModel, prop: PropModel): string[] {
  const key = symbol(prop.key);
  const attribute = rubyString(prop.attribute ?? '');
  const name = `def test_prop_${prop.key}`;

  if (prop.strategy === 'property') return [name, `  assert_property_prop ${key}, ${rubyString(prop.jsName)}`, 'end'];

  switch (prop.kind) {
    case 'enum': {
      const values = (prop.values ?? []).filter(Boolean);

      return values.length ? [name, `  assert_enum_prop ${key}, ${attribute}, ${words(values)}`, 'end'] : [];
    }

    case 'boolean':
      return [name, `  assert_boolean_prop ${key}, ${attribute}${prop.rubyDefault === 'true' ? ', default: true' : ''}`, 'end'];
    case 'number':
      return [name, `  assert_number_prop ${key}, ${attribute}`, 'end'];
    default:
      return prop.list
        ? [name, `  assert_string_prop ${key}, ${attribute}`, `  assert_list_prop ${key}, ${attribute}, ${rubyString(prop.jsName)}`, 'end']
        : [name, `  assert_string_prop ${key}, ${attribute}`, 'end'];
  }
}

function modelTest(component: ComponentModel): string[] {
  const model = component.model;

  if (!model) return [];
  const has = (key: string) => component.props.some((p) => p.key === key);
  const stateKey = has('state') ? 'client_state' : 'state';
  const value = model.prop === 'value';

  return [
    '# bind: writes a server state on the model event; state: a client one.',
    'def test_binds_its_model',
    `  assert_equal({prop: ${rubyString(model.prop)}, event: ${rubyString(model.event)}}, ${component.className}.model)`,
    has('bind') ? null : `  assert_equal ${rubyString(`${model.event}->query`)}, element(bind: :query)["data-stencil-set"]`,
    `  assert_equal ${rubyString(value ? `${model.event}->draft=$value` : `${model.event}->draft`)}, element(${stateKey}: :draft)[${value ? '"data-herb-set"' : '"data-stencil-state"'}]`,
    'end',
  ].filter((line): line is string => line !== null);
}

function partialTest(component: ComponentModel, options: ResolvedOptions): string[] {
  if (options.framework !== 'rails') return [];
  const has = (key: string) => component.props.some((p) => p.key === key);
  const contentLocal = has('content') ? 'content_slot' : 'content';
  const locals = [...requiredProps(component), has('id') ? null : 'id: "host"', has('class') ? null : 'class: "a b"', `${contentLocal}: "inside"`].filter(Boolean);
  const expected = [rubyString(component.tag), has('id') ? null : '"host"', has('class') ? null : '"a b"', '"inside"'].filter(Boolean);
  const actual = ['rendered.name', has('id') ? null : 'rendered["id"]', has('class') ? null : 'rendered["class"]', 'rendered.text'].filter(Boolean);

  return [
    "# The partial flavor (for reactive pages) renders the same element from the partial's locals.",
    'def test_partial',
    `  rendered = parse(view.render(${rubyString(`${namespacePath(options.rubyNamespace)}/${component.key}`)}, ${locals.join(', ')})).element_children.first`,
    '',
    `  assert_equal [${expected.join(', ')}], [${actual.join(', ')}]`,
    'end',
  ];
}

function formFieldTest(component: ComponentModel): string[] {
  const field = component.formField;

  if (!field || component.props.some((p) => p.required && (p.key === 'name' || p.key === 'id'))) return [];
  const label = field.label ? component.props.find((p) => p.jsName === field.label) : undefined;

  return [
    '# attribute: names the field; without a form, the name and id are the attribute itself.',
    'def test_form_field',
    '  rendered = element(attribute: :title)',
    '',
    '  assert_equal %w[title title], [rendered["name"], rendered["id"]]',
    label?.attribute ? `  assert_equal "Title", rendered[${rubyString(label.attribute)}]` : null,
    'end',
  ].filter((line): line is string => line !== null);
}

/** `test/components/<ns>/<component>_test.rb`: one test per prop and slot, and the component's own wiring. */
export function emitComponentTest(component: ComponentModel, options: ResolvedOptions) {
  const required = requiredProps(component);
  const blocks: string[][] = [[`def component_class`, `  ${component.className}`, 'end']];

  if (required.length) blocks.push(['def required_props', `  {${required.join(', ')}}`, 'end']);

  blocks.push([
    'def test_renders_its_element',
    `  assert_equal ${rubyString(component.tag)}, element.name`,
    `  assert_equal ${rubyString(component.tag)}, parse(view.${component.helper}(**required_props)).element_children.first.name`,
    `  assert_equal ${component.className}, ${options.rubyNamespace}.component_class(${symbol(component.key)})`,
    'end',
  ]);

  for (const prop of component.props) {
    if (!takenByInitialize(component, prop)) blocks.push(propTest(component, prop));
  }

  for (const slot of component.slots) {
    if (slot.name === '') continue;
    const args = [symbol(slot.rubyName), rubyString(slot.name), slot.many ? 'many: true' : null, options.slotWrapper === 'attribute' ? null : `wrapper: ${symbol(options.slotWrapper)}`];

    blocks.push([`def test_slot_${slot.rubyName}`, `  assert_slot ${args.filter(Boolean).join(', ')}`, 'end']);
  }

  blocks.push(['def test_content', '  assert_content', 'end'], ['def test_host_attributes', '  assert_host_attributes', 'end']);

  const configured = defaultable(component);

  if (configured) {
    const args = [symbol(configured.prop.key), rubyString(configured.prop.attribute ?? ''), configured.value, configured.expected].filter(Boolean);

    blocks.push(['def test_configured_default', `  assert_configured_default ${args.join(', ')}`, 'end']);
  }

  blocks.push(['def test_records_its_assets', `  assert_recorded ${rubyString(component.tag)}`, 'end']);

  if (component.events.length) {
    const events = component.events.map((e) => `${e.key}: ${rubyString(e.dom)}`).join(', ');

    blocks.push(['def test_events', `  assert_equal({${events}}, ${component.className}.events)`, 'end']);
  }

  blocks.push(modelTest(component), formFieldTest(component), partialTest(component, options));

  const body = `
# <${component.tag}>, rendered through ${component.className}: what each prop and slot puts on the element.
class ${component.className}Test < ComponentTestCase
${blocks.flatMap((block) => (block.length ? [block.map((line) => (line ? `  ${line}` : '')).join('\n')] : [])).join('\n\n')}
end
`;

  return inNamespace(options.rubyNamespace, body, 'require "test_helper"');
}

function allTests(options: ResolvedOptions) {
  return `${HEADER}
# Every generated test, with the coverage threshold enforced:
#   ruby -Itest test/all.rb
require_relative "test_helper"
${options.rubyNamespace}::TestCoverage.enforced = true

Dir[File.join(__dir__, "**/*_test.rb")].sort.each { |file| require file }
`;
}

function rakefile() {
  return `${HEADER}
desc "Run the generated tests, and fail below the coverage threshold"
task :test do # rubocop:disable Rails/RakeEnvironment -- a gem, not an app: there is no environment task
  ruby "-Itest", "test/all.rb"
end

task default: :test
`;
}

/** Every file of the gem's test suite, keyed by path relative to the out dir. */
export function emitTests(components: ComponentModel[], tokens: string[], options: ResolvedOptions): Map<string, string> {
  const ns = namespacePath(options.rubyNamespace);
  const samples = pickSamples(components, tokens);
  const files = new Map<string, string>();

  files.set('Rakefile', rakefile());
  files.set('test/all.rb', allTests(options));
  files.set('test/line_coverage.rb', coverage(options));
  files.set('test/test_helper.rb', testHelper(options, samples));
  files.set('test/base_component_test.rb', emitBaseComponentTest(options));
  files.set('test/assets_test.rb', emitAssetsTest(options, samples));
  files.set('test/config_test.rb', emitConfigTest(options, samples));
  files.set('test/helpers_test.rb', emitHelpersTest(components, options, samples));

  for (const component of components) files.set(`test/components/${ns}/${component.fileBase}_test.rb`, emitComponentTest(component, options));

  const forms = emitFormBuilderTest(components, options, samples);

  if (forms) files.set('test/form_builder_test.rb', forms);

  const [path, content] = emitFrameworkTest(components, options, samples);

  files.set(path, content);

  return files;
}
