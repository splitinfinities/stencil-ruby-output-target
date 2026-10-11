import type { ComponentModel } from './model.ts';
import type { ResolvedOptions } from './options.ts';
import { inNamespace } from './emit-lib.ts';
import { rubyString } from './naming.ts';
import { symbol, type Samples } from './emit-tests.ts';

/**
 * The tests of what every generated gem has whatever its components are: BaseComponent (on a
 * component the test declares), the config object, the asset registry and the head helper. They
 * name a component of the library only where one is needed (`Samples`).
 */

const REQUIRE = 'require "test_helper"';

const lines = (...items: (string | null | undefined | false)[]) => items.filter((item): item is string => typeof item === 'string').join('\n');

/** `test/base_component_test.rb`: the DSL and the rendering rules, on fixture components. */
export function emitBaseComponentTest(options: ResolvedOptions) {
  const ns = options.rubyNamespace;

  const body = String.raw`
# BaseComponent's own rules, on components declared here: what a prop renders, the host's
# attributes, the bindings, the slot marker, and how a form field takes its options from a form.
class BaseComponentTest < TestCase
  # A form control with a value model and one prop of each kind.
  class FixtureComponent < BaseComponent
    self.element_tag = "${options.tagPrefix}fixture"
    self.model = {prop: "value", event: "update"}.freeze
    self.form_field = {value: :value, checked: :checked, checked_value: :value, label: :label, error: :error}.freeze

    prop :value, type: :string, js: "value", attribute: "value", default: "", strategy: :value
    prop :checked, type: :boolean, js: "checked", attribute: "checked", default: false, strategy: :optional
    prop :type, type: :string, js: "type", attribute: "type", strategy: :optional
    prop :label, type: :string, js: "label", attribute: "label", strategy: :optional, reactive: true
    prop :error, type: :string, js: "error", attribute: "error", strategy: :optional
    prop :required, type: :boolean, js: "required", attribute: "required", default: false, strategy: :optional, reactive: true
    prop :unchecked_value, type: :string, js: "uncheckedValue", attribute: "unchecked-value", strategy: :optional
    prop :size, type: :enum, js: "size", attribute: "size", values: %w[small medium].freeze, default: "medium", strategy: :optional, reactive: true
    prop :open, type: :boolean, js: "open", attribute: "open", default: true, strategy: :optional, reader: :open_value
    prop :items, type: :json, js: "items", strategy: :property
    prop :names, type: :string, js: "names", attribute: "names", strategy: :optional, list: true

    event :value_changed, dom: "valueChanged"
  end

  # A control that is always checkable (no type prop), whose model is its checked state.
  class SwitchFixtureComponent < BaseComponent
    self.element_tag = "${options.tagPrefix}switch-fixture"
    self.model = {prop: "checked", event: "change"}.freeze
    self.form_field = {checked: :checked, checked_value: :value}.freeze

    prop :checked, type: :boolean, js: "checked", attribute: "checked", default: false, strategy: :optional
    prop :value, type: :string, js: "value", attribute: "value", default: "yes", strategy: :optional
    prop :as, type: :enum, js: "as", attribute: "as", values: %w[checkbox radio].freeze, default: "checkbox", strategy: :optional
  end

  # Not a form control, and no model.
  class PlainFixtureComponent < BaseComponent
    self.element_tag = "${options.tagPrefix}plain-fixture"
  end

  def test_a_prop_is_declared_with_its_spec_and_default
    spec = FixtureComponent.props.fetch(:size)

    assert_equal [:enum, "size", %w[small medium], "medium", :optional], spec.values_at(:type, :attribute, :values, :default, :strategy)
    assert_equal "medium", FixtureComponent.new.size
    assert_equal({value_changed: "valueChanged"}, FixtureComponent.events)
  end

  def test_a_reader_that_would_replace_a_view_component_method_is_rejected
    error = assert_raises(ArgumentError) do
      Class.new(BaseComponent) { prop :content, type: :string, js: "content", attribute: "content", strategy: :optional }
    end

    assert_includes error.message, "reader :content would replace"
  end

  def test_a_renamed_reader_keeps_the_keyword
    component = FixtureComponent.new(open: false)

    assert_same false, component.open_value
    assert component.attribute?(:open)
    assert_equal "false", component.attribute_value(:open)
  end

  def test_a_required_prop_must_be_given
    klass = Class.new(BaseComponent) do
      prop :heading, type: :string, js: "heading", attribute: "heading", strategy: :optional, required: true
      prop :tag, type: :string, js: "tag", attribute: "tag", strategy: :optional, reader: :tag_value, required: true
    end

    assert_raises(ArgumentError) { klass.new(heading: "h") }
    assert_raises(ArgumentError) { klass.new(tag: "t") }
    assert_equal %w[h t], [klass.new(heading: "h", tag: "t").heading, klass.new(heading: "h", tag: "t").tag_value]
  end

  def test_an_optional_attribute_renders_only_when_given
    assert FixtureComponent.new.attribute?(:value), "a value prop always renders"
    refute FixtureComponent.new.attribute?(:size)
    refute FixtureComponent.new.attribute?(:type)
    assert FixtureComponent.new(size: "medium").attribute?(:size), "given, even as its default"
    assert_equal "small", FixtureComponent.new(size: :small).attribute_value(:size)
  end

  def test_a_boolean_renders_present_or_absent
    assert_equal "", FixtureComponent.new(checked: true).attribute_value(:checked)
    refute FixtureComponent.new(checked: false).attribute?(:checked)
    refute FixtureComponent.new.attribute?(:open), "its default"
    assert_equal "", FixtureComponent.new(open: true).attribute_value(:open)
  end

  def test_a_reactive_value_is_the_default_while_unset
    assert_equal "medium", FixtureComponent.new.reactive_value(:size)
    assert_equal "", FixtureComponent.new.reactive_value(:label)
    assert_equal "Name", FixtureComponent.new(label: "Name").reactive_value(:label)
  end

  def test_an_unknown_enum_value_raises_and_in_production_falls_back_to_the_default
    assert_raises(ArgumentError) { FixtureComponent.new(size: "huge") }
    production!

    assert_equal "medium", FixtureComponent.new(size: "huge").size
    assert_includes log.string, "huge"
  end

  def test_configured_defaults_apply_under_the_callers_props
    config.defaults[FixtureComponent] = {size: "small"}

    assert_equal "small", FixtureComponent.new.size
    assert_equal "medium", FixtureComponent.new(size: "medium").size
    assert FixtureComponent.new.attribute?(:size)
  end

  def test_host_attributes_are_the_callers_with_the_bindings
    component = FixtureComponent.new(id: "a", data: {x: 1}, bind: :query, state: :draft)

    assert_equal({id: "a", data: {x: 1, stencil_set: "update->query", herb_set: "update->draft=$value"}}, component.host_attributes)
    assert_equal ["update->query", "update->draft=$value", ""], [component.server_binding, component.herb_set, component.client_binding]
  end

  def test_a_model_that_isnt_the_value_binds_through_the_bridge
    component = SwitchFixtureComponent.new(bind: :on, state: :draft)

    assert_equal({data: {stencil_set: "change->on", stencil_state: "change->draft"}}, component.host_attributes)
    assert_equal ["change->on", "", "change->draft"], [component.server_binding, component.herb_set, component.client_binding]
  end

  def test_without_a_model_nothing_binds
    component = PlainFixtureComponent.new(bind: :query, state: :draft, title: "T")

    assert_equal({title: "T", data: {}}, component.host_attributes)
    assert_equal ["", "", ""], [component.server_binding, component.herb_set, component.client_binding]
  end

  def test_the_partials_id_and_class
    assert_equal ["", ""], [FixtureComponent.new.host_id, FixtureComponent.new.host_class]
    assert_equal "a", FixtureComponent.new(id: :a).host_id
    assert_equal "a b", FixtureComponent.new(class: "a b").host_class
    assert_equal "a b", FixtureComponent.new(class: ["a", ["b", nil]]).host_class
    assert_equal "a", FixtureComponent.new(class: {a: true, b: false}).host_class
  end

  def test_the_partials_attribute_payload
    component = FixtureComponent.new(
      id: "a", class: "b", title: "T", hidden: true, inert: false, lang: nil, required: true,
      data: {user_id: 1, name: "n", kind: :k, skip: nil}, aria: {label: "L"}
    )
    expected = {"title" => "T", "hidden" => "", "data-user-id" => "1", "data-name" => "n", "data-kind" => "k", "aria-label" => "L", "required" => ""}

    assert_equal expected, JSON.parse(component.host_attribute_payload)
    assert_equal "{}", FixtureComponent.new.host_attribute_payload
  end

  def test_properties_and_lists_go_out_as_json
    component = FixtureComponent.new(items: [{"a" => 1}], names: %w[a b])

    assert_equal({"names" => %w[a b], "items" => [{"a" => 1}]}, JSON.parse(component.property_payload))
    assert_equal %(["a","b"]), component.attribute_value(:names)
    assert_equal "{}", FixtureComponent.new(names: "a").property_payload
  end

  def test_slotted_marks_each_top_level_node
    html = FixtureComponent.new.slotted("icon", "<i>a</i> text <b>c</b>\n")
    nodes = parse(html).children

    assert_predicate html, :html_safe?
    assert_equal %w[i span b], nodes.map(&:name)
    assert_equal %w[icon icon icon], nodes.pluck("slot")
    assert_equal " text ", nodes[1].text
  end

  def test_form_options_come_from_the_form_and_its_object
    options = FixtureComponent.form_options(builder, :title)

    assert_equal({name: "record[title]", id: "record_title", label: "Title", required: true, value: "Hello"}, options)
    assert_equal "Hello", FixtureComponent.new(form: builder, attribute: :title).value
  end

  def test_form_options_carry_the_attributes_first_error
    invalid = record(title: "").tap(&:validate)

    assert_equal "Title can't be blank", FixtureComponent.form_options(builder(invalid), :title)[:error]
  end

  def test_the_callers_form_options_win
    given = {name: "n", id: "i", label: "L", required: false, error: "E", value: "V"}

    assert_equal given, FixtureComponent.form_options(builder(record(title: "").tap(&:validate)), :title, given)
  end

  def test_form_options_without_a_form_or_a_matching_attribute
    assert_equal({name: "title", id: "title", label: "Title"}, FixtureComponent.form_options(nil, :title))
    assert_equal({name: "record[missing]", id: "record_missing", label: "Missing"}, FixtureComponent.form_options(builder, :missing))
  end

  def test_form_options_for_an_object_that_isnt_a_model
    plain = Struct.new(:title).new("Plain")

    assert_equal({name: "record[title]", id: "record_title", label: "Title", value: "Plain"}, FixtureComponent.form_options(builder(plain), :title))
  end

  def test_a_checkbox_is_checked_from_the_objects_value
    options = FixtureComponent.form_options(builder, :accepted, type: "checkbox")

    assert_equal [true, "0"], options.values_at(:checked, :unchecked_value)
    refute options.key?(:value)
    assert_same false, FixtureComponent.form_options(builder(record(accepted: false)), :accepted, type: "checkbox")[:checked]
  end

  def test_a_radio_is_checked_when_its_value_is_the_objects
    chosen = FixtureComponent.form_options(builder, :choice, type: "radio", value: "a")
    other = FixtureComponent.form_options(builder, :choice, type: "radio", value: "b")

    assert_equal [true, false], [chosen[:checked], other[:checked]]
    refute chosen.key?(:unchecked_value)
  end

  def test_a_control_without_a_type_is_always_checkable
    assert_equal({name: "record[accepted]", id: "record_accepted", checked: true}, SwitchFixtureComponent.form_options(builder, :accepted))
    assert_same false, SwitchFixtureComponent.form_options(builder, :choice, as: "radio")[:checked]
    assert_same true, SwitchFixtureComponent.form_options(builder(record(choice: "yes")), :choice, as: "radio")[:checked]
  end

  def test_checked_follows_rails_check_box
    checked = ->(raw) { FixtureComponent.checked_value?(raw, "1", false) }

    assert_equal [true, false, false], [checked.call(true), checked.call(false), checked.call(nil)]
    assert_equal [true, false], [checked.call("1"), checked.call("0")]
    assert_equal [true, false], [checked.call([1, 2]), checked.call([2])]
    assert_equal [true, false], [checked.call(1), checked.call(0)]
  end

  def test_a_form_value_is_a_plain_value
    value = ->(raw, kind = "text") { FixtureComponent.form_value(raw, kind) }

    assert_equal ["a", 1, true, "sym"], [value.call("a"), value.call(1), value.call(true), value.call(:sym)]
    assert_equal ["a", {b: 1}], value.call([:a, {b: 1}])
    assert_nil value.call(Object.new)
  end

  def test_a_date_or_time_is_written_as_its_field_writes_it
    date = Date.new(2024, 1, 2)
    time = Time.utc(2024, 1, 2, 3, 4)
    value = ->(raw, kind) { FixtureComponent.form_value(raw, kind) }

    assert_equal %w[2024-01-02 2024-01 2024-W01], [value.call(date, "date"), value.call(date, "month"), value.call(date, "week")]
    assert_equal %w[03:04 2024-01-02T03:04], [value.call(time, "time"), value.call(time, "datetime-local")]
    assert_equal date.iso8601, value.call(date, "text")
    assert_equal "03:04", value.call(time.in_time_zone("UTC"), "time")
  end

  def test_only_a_form_control_takes_a_form
    error = assert_raises(ArgumentError) { PlainFixtureComponent.form_options(nil, :title) }

    assert_includes error.message, "is not a form control"
    assert_equal({attribute: :title, data: {}}, PlainFixtureComponent.new(attribute: :title).host_attributes)
  end
end
`;

  return inNamespace(ns, body, REQUIRE);
}

/** `test/config_test.rb`: the config object, its tokens, defaults, settings hash and the manifest. */
export function emitConfigTest(options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const any = samples.any;
  const withEnum = samples.enum;

  const framework = {
    rails: ['Rails.env.to_s', 'assert_same Rails.logger, config.logger'],
    bridgetown: ['::Bridgetown.env.to_s', 'assert_same ::Bridgetown.logger, config.logger'],
    sinatra: ['"test"', 'assert_kind_of Logger, config.logger'],
  }[options.framework];

  const tokenRule = samples.listsTokens
    ? `
  def test_a_token_the_library_doesnt_have_is_rejected
    assert_raises(ArgumentError) { config.tokens["--not-a-token-of-this-library"] = "1px" }
    production!
    config.tokens["--not-a-token-of-this-library"] = "1px"

    assert_empty config.tokens
    assert_includes log.string, "is not a design token"
  end`
    : `
  def test_any_token_name_goes_when_the_library_lists_none
    config.tokens["--any-name"] = "1px"

    assert_equal "1px", config.tokens["--any-name"]
  end`;

  const names = any && [symbol(any.key), rubyString(any.key), any.key.includes('_') ? rubyString(any.key.replace(/_/g, '-')) : null, rubyString(any.tag), rubyString(any.className), rubyString(`${ns}::${any.className}`), any.className];

  const componentTests = any
    ? `
  def test_the_manifest_lists_every_component
    manifest = ${ns}.manifest

    assert_predicate manifest, :frozen?
    assert_equal({"tag" => ${rubyString(any.tag)}, "class" => ${rubyString(any.className)}}, manifest.dig("components", ${rubyString(any.key)}).slice("tag", "class"))
    assert_equal ${rubyString(options.assets.loader)}, manifest.dig("assets", "loader")
  end

  def test_a_component_class_from_its_key_tag_name_or_class
    [${names?.filter(Boolean).join(', ')}].each do |component|
      assert_equal ${any.className}, ${ns}.component_class(component), component.inspect
    end
    assert_nil ${ns}.component_class(:not_a_component)
    assert_nil ${ns}.component_class(String)
  end

  def test_an_unknown_component_is_rejected
    assert_raises(ArgumentError) { config.defaults[:not_a_component] = {} }
    assert_raises(ArgumentError) { config.defaults[${symbol(any.key)}] = {not_a_prop: 1} }
    assert_empty config.defaults[:not_a_component]
    production!
    config.defaults[:not_a_component] = {}
    config.defaults[${symbol(any.key)}] = {not_a_prop: 1}

    assert_empty config.defaults[${symbol(any.key)}]
    assert_equal 2, log.string.lines.size
  end`
    : '';

  const enumTests = withEnum
    ? `
  def test_defaults_are_set_by_key_tag_or_class
    [${symbol(withEnum.component.key)}, ${rubyString(withEnum.component.tag)}, ${withEnum.component.className}].each do |component|
      config.defaults[${withEnum.component.className}] = {}
      config.defaults[component] = {${rubyString(withEnum.prop.key)} => ${rubyString(withEnum.prop.values?.find(Boolean) ?? '')}}

      assert_equal({${withEnum.prop.key}: ${rubyString(withEnum.prop.values?.find(Boolean) ?? '')}}, config.defaults[${withEnum.component.className}], component.inspect)
    end
  end

  def test_a_default_that_isnt_one_of_the_props_values_is_rejected
    assert_raises(ArgumentError) { config.defaults[${symbol(withEnum.component.key)}] = {${withEnum.prop.key}: "not-a-value"} }
    production!
    config.defaults[${symbol(withEnum.component.key)}] = {${withEnum.prop.key}: "not-a-value"}

    assert_empty config.defaults[${symbol(withEnum.component.key)}]
    assert_includes log.string, "not-a-value"
  end`
    : '';

  const body = `
# The config object: tokens, component defaults, asset settings, the settings hash the
# adapters take, and the manifest the gem reads its components from.
class ConfigTest < TestCase
  TOKEN = ${rubyString(samples.token)}

  def test_configure_yields_the_config
    yielded = nil
    returned = ${ns}.configure { |config| yielded = config }

    assert_same ${ns}.config, yielded
    assert_same yielded, returned
  end

  def test_reset_config_starts_over
    config.token_selector = "html"
    ${ns}.reset_config!

    refute_same config, ${ns}.config
    assert_equal ":root", ${ns}.config.token_selector
  end

  def test_what_a_fresh_config_holds
    fresh = Configuration.new

    assert_equal [":root", true], [fresh.token_selector, fresh.form_builder]
    assert_equal [false, nil, [], []], [fresh.assets.async, fresh.assets.bundle_url, fresh.assets.always, fresh.assets.preload]
    assert_equal :${options.assets.source}, fresh.assets.source
    assert_empty fresh.tokens
  end

  def test_the_environment_and_logger_come_from_the_framework
    config = Configuration.new

    assert_equal ${framework[0]}, config.environment
    ${framework[1]}
    assert_same config.logger, config.logger
    assert_predicate config, :strict?
  end

  def test_a_bad_setting_raises_in_development_and_test_and_is_logged_elsewhere
    %w[development test].each do |environment|
      config.environment = environment

      assert_raises(ArgumentError) { config.invalid!("bad") }
    end
    production!

    assert_nil config.invalid!("bad setting")
    assert_includes log.string, "bad setting"
  end

  def test_a_token_is_set_by_its_name
    config.tokens[TOKEN] = "1px"

    assert_equal "1px", config.tokens[TOKEN]
    assert_equal "1px", config.tokens[TOKEN.delete_prefix("--")]
    assert_equal({TOKEN => "1px"}, config.tokens.to_h)
    assert_equal [[TOKEN, "1px"]], config.tokens.to_a
  end

  def test_token_takes_a_symbol
    config.token TOKEN.delete_prefix("--").tr("-", "_").to_sym, 2

    assert_equal "2", config.tokens[TOKEN]
  end
${tokenRule}

  def test_a_token_value_that_could_leave_the_style_rule_is_rejected
    assert_raises(ArgumentError) { config.tokens[TOKEN] = "1px;} body{" }
    production!
    config.tokens[TOKEN] = "</style>"

    assert_empty config.tokens
    assert_includes log.string, "can't be a token value"
  end

  def test_asset_lists_take_one_component_or_several
    config.assets.always = :one
    config.assets.preload = %i[one two]

    assert_equal [[:one], %i[one two]], [config.assets.always, config.assets.preload]
  end

  def test_apply_takes_the_settings_as_a_hash
    returned = config.apply(
      "bundle_url" => "/elements", "form_builder" => false, "token_selector" => "html", "errors_summary_heading" => "Fix:",
      "assets" => {"async" => true, "preload" => [:one]}, "tokens" => {TOKEN => "1px"}${any ? `, "defaults" => {${rubyString(any.key)} => {}}` : ''}
    )

    assert_same config, returned
    assert_equal ["/elements", true, [:one]], [config.assets.bundle_url, config.assets.async, config.assets.preload]
    assert_equal [false, "html", "Fix:", "1px"], [config.form_builder, config.token_selector, config.errors_summary_heading, config.tokens[TOKEN]]
  end

  def test_the_errors_summary_heading_counts_the_objects_errors
    invalid = record(title: "").tap(&:validate)

    assert_equal "1 error prohibited this record from being saved:", config.errors_summary_heading_for(invalid)
    invalid.errors.add(:count, "is odd")

    assert_equal "2 errors prohibited this record from being saved:", config.errors_summary_heading_for(invalid)
    assert_equal "2 errors prohibited this form from being saved:", config.errors_summary_heading_for(Struct.new(:errors).new(invalid.errors))
  end

  def test_the_errors_summary_heading_can_be_a_proc
    config.errors_summary_heading = ->(object) { "#{object.errors.count} to fix" }

    assert_equal "1 to fix", config.errors_summary_heading_for(record(title: "").tap(&:validate))
  end
${componentTests}
${enumTests}
end
`;

  return inNamespace(ns, body.replace(/\n{3,}/g, '\n\n').replace(/\n\nend\n$/, '\nend\n'), REQUIRE);
}

/** `test/assets_test.rb`: the per-request registry and the manifest lookups behind the preloads. */
export function emitAssetsTest(options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const any = samples.any;

  const lookups = any
    ? `

  def test_a_components_tag_from_its_key_tag_or_class
    assert_equal [${rubyString(any.tag)}] * 3, [${symbol(any.key)}, ${rubyString(any.tag)}, ${any.className}].map { |component| Assets.tag_for(component) }
    assert_raises(ArgumentError) { Assets.tag_for(:not_a_component) }
  end

  def test_unknown_components_are_skipped_and_logged_in_production
    production!

    assert_equal [${rubyString(any.tag)}], Assets.tags_for([${symbol(any.key)}, :not_a_component])
    assert_includes log.string, ":not_a_component is not a component"
  end

  def test_the_files_tags_need_each_once
    files = ${ns}.manifest.dig("components", ${rubyString(any.key)}, "files")

    assert_equal files, Assets.files_for([${rubyString(any.tag)}])
    assert_equal files, Assets.files_for([${rubyString(any.tag)}, "x-not-an-element", ${rubyString(any.tag)}])
    assert_empty Assets.files_for([])
  end`
    : '';

  const body = `
# The asset registry (what a request rendered) and the manifest lookups the head's preloads use.
class AssetsTest < TestCase
  def test_the_registry_lasts_until_it_is_reset
    registry = Assets.current

    assert_same registry, Assets.current
    Assets.reset!

    refute_same registry, Assets.current
  end

  def test_a_tag_is_recorded_once_in_order
    registry = Assets::Registry.new
    %w[b a b].each { |tag| registry.record(tag) }

    assert_equal %w[b a], registry.tags
  end

  def test_the_registry_knows_the_head_was_written
    registry = Assets::Registry.new

    refute_predicate registry, :emitted?
    registry.emitted!

    assert_predicate registry, :emitted?
  end

  def test_an_element_rendered_after_the_head_warns_in_development_only
    late = Assets::Registry.new.tap(&:emitted!)
    late.record("x-late")

    assert_empty log.string
    config.environment = "development"
    late.record("x-later")
    late.record("x-later")

    assert_equal 1, log.string.lines.size
    assert_includes log.string, "<x-later> rendered after"
  end${lookups}
end
`;

  return inNamespace(ns, body, REQUIRE);
}

/** `test/helpers_test.rb`: a helper per component, and the head helper's tags. */
export function emitHelpersTest(components: ComponentModel[], options: ResolvedOptions, samples: Samples) {
  const ns = options.rubyNamespace;
  const key = options.configKey;
  const any = samples.any;
  const stylesheet = options.assets.stylesheet;
  const tags = components.slice(0, 3).map((component) => component.tag);

  const versioned = options.assets.cdnUrl.includes('%<version>s');

  // The Rails gem tracks its assets for Turbo, when the app has it.
  const turboTest =
    options.framework === 'rails'
      ? `
  def test_with_turbo_the_stylesheet_and_the_loader_are_tracked
    tracked = -> { head.css("script[type=module], link[rel=stylesheet]").pluck("data-turbo-track") }
    stubbed = !defined?(::Turbo)

    assert_empty tracked.call.compact if stubbed
    Object.const_set(:Turbo, Module.new) if stubbed

    assert_equal ["reload"], tracked.call.uniq
    assert_equal "false", head("data-turbo-track": "false").at_css("script")["data-turbo-track"]
  ensure
    Object.send(:remove_const, :Turbo) if stubbed
  end
`
      : '';

  const preloads =
    tags.length === 3
      ? `

  def test_with_async_the_head_preloads_what_rendered_and_prefetches_what_comes_later
    rendered, always, later = ${tags.map((tag) => rubyString(tag)).join(', ')}
    config.assets.async = true
    config.assets.always = [always]
    config.assets.preload = [always, later]
    Assets.current.record(rendered)
    preloaded = Assets.files_for([rendered, always])
    doc = head

    assert_equal preloaded, hrefs(doc, "modulepreload")
    assert_equal Assets.files_for([later]) - preloaded, hrefs(doc, "prefetch")
    assert_predicate Assets.current, :emitted?
  end

  def test_without_async_nothing_is_preloaded
    config.assets.always = [${rubyString(tags[0])}]
    Assets.current.record(${rubyString(tags[0])})

    assert_empty hrefs(head, "modulepreload")
    assert_empty hrefs(head, "prefetch")
  end`
      : '';

  const body = `
# The view helpers: one per component, and ${key}_tags for the layout's head.
class HelpersTest < TestCase
  TOKEN = ${rubyString(samples.token)}

  def head(**)
    parse(view.${key}_tags(**))
  end

  # The files a kind of link names, relative to the bundle.
  def hrefs(doc, rel)
    doc.css("link[rel=#{rel}]").map { |link| link["href"].delete_prefix("#{BundleHelper.bundle_url}/") }
  end

  def test_every_component_has_a_helper
    missing = ${ns}.manifest["components"].keys.reject { |name| view.respond_to?(:"${options.helperPrefix}#{name}") }

    assert_equal ${components.length}, ${ns}.manifest["components"].size
    assert_empty missing
  end
${lines(
  any &&
    `
  def test_a_helper_renders_its_component_with_the_block
    rendered = parse(view.${any.helper}(id: "host") { "inside" }).element_children.first

    assert_equal [${rubyString(any.tag)}, "host", "inside"], [rendered.name, rendered["id"], rendered.text]
  end`,
)}

  def test_the_head_loads_the_bundle_from_the_cdn_at_the_gems_version
    config.assets.source = :cdn
    url = format(BundleHelper::CDN_URL, version: NPM_VERSION)

    assert_equal ${rubyString(options.assets.cdnUrl)}, BundleHelper::CDN_URL
    assert_equal url, BundleHelper.bundle_url
    assert_equal "#{url}/${options.assets.loader}${versioned ? '' : '#{cache_key}'}", head.at_css("script[type=module]")["src"]
    ${stylesheet ? `assert_equal "#{url}/${stylesheet}${versioned ? '' : '#{cache_key}'}", head.at_css("link[rel=stylesheet]")["href"]` : 'assert_nil head.at_css("link[rel=stylesheet]")'}
    assert_nil head.at_css("style")
  end

  def test_the_head_loads_the_apps_own_copy_of_the_bundle
    config.assets.source = :local

    assert_equal ${rubyString(options.assets.localPath)}, BundleHelper::LOCAL_URL
    assert_equal format(BundleHelper::LOCAL_URL, version: NPM_VERSION).chomp("/"), BundleHelper.bundle_url
    assert_equal BundleHelper.unhashed_url(${rubyString(options.assets.loader)}), head.at_css("script[type=module]")["src"]
  end

  def test_the_source_is_the_cdn_or_the_app
    assert_equal :${options.assets.source}, Configuration.new.assets.source
    config.assets.source = "local"

    assert_equal :local, config.assets.source
    assert_raises(ArgumentError) { config.assets.source = :elsewhere }
  end

  def test_the_bundle_can_be_served_from_any_url
    config.assets.bundle_url = "/elements/"

    assert_equal "/elements", BundleHelper.bundle_url
    assert_equal "/elements/${options.assets.loader}#{cache_key}", head.at_css("script")["src"]
  end

  # The loader and the stylesheet have no hash in their names: the build's digest is in their URLs.
  def test_a_file_without_a_hash_in_its_name_gets_the_builds_digest
    config.assets.bundle_url = "/elements"

    assert_match(/\\A\\?v=[0-9a-f.]+/, cache_key)
    assert_equal "/elements/any.js#{cache_key}", BundleHelper.unhashed_url("any.js")
    config.assets.bundle_url = "/elements/#{NPM_VERSION}"

    assert_equal "/elements/#{NPM_VERSION}/any.js", BundleHelper.unhashed_url("any.js")
  end
${turboTest}
  def test_options_go_onto_the_script
    config.tokens[TOKEN] = "1px"
    doc = head(nonce: "n", defer: true)

    assert_equal %w[n n], [doc.at_css("script")["nonce"], doc.at_css("style")["nonce"]]
    assert doc.at_css("script").key?("defer")
  end

  def test_the_configured_tokens_are_one_style_rule
    config.tokens[TOKEN] = "1px"
    config.token_selector = "html"

    assert_equal "html{#{TOKEN}:1px}", head.at_css("style").text
    assert_equal "html{#{TOKEN}:1px}", BundleHelper.token_css
  end

  def test_a_token_selector_that_could_leave_the_rule_is_rejected
    config.tokens[TOKEN] = "1px"
    config.token_selector = "a{}"

    assert_raises(ArgumentError) { head }
    production!

    assert_nil head.at_css("style")
    assert_includes log.string, "token_selector"
  end${preloads}
end
`;

  return inNamespace(ns, body.replace(/\n{3,}/g, '\n\n'), REQUIRE);
}
