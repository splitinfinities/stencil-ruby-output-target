import type { ComponentModel } from './model.ts';
import type { ResolvedOptions } from './options.ts';
import { inNamespace } from './emit-lib.ts';
import { formBuilderClaims, formBuilderShortNames, RAILS_ALIASES, type Claim } from './emit-form-builder.ts';
import { rubyString, snake } from './naming.ts';
import { requiredProps, type Samples } from './emit-tests.ts';

/**
 * `test/form_builder_test.rb`: every method the generated FormBuilder has. Each form-associated
 * element's own method (and its short name), each Rails method a component claims, Rails' own
 * methods under `rails_<name>`, the errors summary and the form helpers.
 */

const attribute = (component: ComponentModel, key: string) => component.props.find((p) => p.key === key)?.attribute;

const humanize = (name: string) => name[0].toUpperCase() + name.slice(1);

/** The record attribute a control's own method is tested with, and what it should render from it. */
function fieldCase(component: ComponentModel) {
  const field = component.formField ?? {};
  const byJs = (name: string | undefined) => component.props.find((p) => p.jsName === name);
  const checked = byJs(field.checked);
  const value = byJs(field.value);

  // Checkable whatever its type (a switch, a toggle): checked from a boolean attribute.
  if (checked?.attribute && !component.props.some((p) => p.key === 'type')) return { name: 'accepted', checks: [`assert rendered.key?(${rubyString(checked.attribute)})`] };

  if (value?.attribute && value.strategy !== 'property' && value.kind === 'string') return { name: 'title', checks: [`assert_equal "Hello", rendered[${rubyString(value.attribute)}]`] };

  if (value?.attribute && value.kind === 'number') return { name: 'count', checks: [`assert_equal "3", rendered[${rubyString(value.attribute)}]`] };

  return { name: 'blank', checks: [] };
}

function fieldTest(component: ComponentModel, short: boolean): string[] {
  const { name, checks } = fieldCase(component);
  const required = requiredProps(component);
  const args = [`:${name}`, ...required].join(', ');
  const label = attribute(component, snake(component.formField?.label ?? ''));
  const requiredFlag = component.props.find((p) => p.key === 'required' && p.kind === 'boolean')?.attribute;

  return [
    `def test_${component.helper}`,
    `  rendered = field(builder.${component.helper}(${args}))`,
    '',
    `  assert_equal [${rubyString(component.tag)}, "record[${name}]", "record_${name}"], [rendered.name, rendered["name"], rendered["id"]]`,
    ...checks.map((check) => `  ${check}`),
    label ? `  assert_equal ${rubyString(humanize(name))}, rendered[${rubyString(label)}]` : null,
    requiredFlag && name === 'title' ? `  assert rendered.key?(${rubyString(requiredFlag)}), "the title is validated for presence"` : null,
    short ? `  assert_equal ${rubyString(component.tag)}, field(builder.${component.key}(${args})).name` : null,
    'end',
  ].filter((line): line is string => line !== null);
}

/** `assert_equal "email", rendered["type"]` for each prop the claim sets. */
function claimChecks({ component, props }: Claim) {
  return Object.entries(props).flatMap(([key, value]) => {
    const name = attribute(component, snake(key));

    if (!name || value === false) return [];

    return [`  assert_equal ${rubyString(value === true ? '' : String(value))}, rendered[${rubyString(name)}]`];
  });
}

function claimTest(claim: Claim): string[] {
  const { method, component } = claim;
  const tag = rubyString(component.tag);
  const required = requiredProps(component);
  const options = required.length ? `, {${required.join(', ')}}` : '';
  const checked = attribute(component, snake(component.formField?.checked ?? ''));
  const name = `def test_rails_${method}`;

  switch (method) {
    case 'check_box':
      return [
        name,
        `  rendered = field(builder.check_box(:accepted${options}))`,
        '',
        `  assert_equal [${tag}, "record[accepted]"], [rendered.name, rendered["name"]]`,
        ...claimChecks(claim),
        checked ? `  assert rendered.key?(${rubyString(checked)})` : null,
        checked ? `  refute field(builder(record(accepted: false)).check_box(:accepted${options})).key?(${rubyString(checked)})` : null,
        'end',
      ].filter((line): line is string => line !== null);

    case 'radio_button':
      return [
        name,
        `  rendered = field(builder.radio_button(:choice, "a"${options}))`,
        '',
        `  assert_equal [${tag}, "record[choice]"], [rendered.name, rendered["name"]]`,
        ...claimChecks(claim),
        checked ? `  assert rendered.key?(${rubyString(checked)})` : null,
        checked ? `  refute field(builder.radio_button(:choice, "b"${options})).key?(${rubyString(checked)})` : null,
        'end',
      ].filter((line): line is string => line !== null);

    case 'select': {
      const choice = component.formChoices;
      const field = fieldCase(component).name;

      return [
        name,
        `  rendered = field(builder.select(:${field}, [%w[One 1], "two"]${options}))`,
        '',
        `  assert_equal [${tag}, "record[${field}]"], [rendered.name, rendered["name"]]`,
        ...claimChecks(claim),
        choice ? `  assert_equal [%w[One 1], %w[two two]], rendered.css(${rubyString(choice)}).map { |item| [item.text, item["value"]] }` : null,
        choice ? `  assert_equal %w[1], field(builder.select(:${field}, {"One" => 1}${options})).css(${rubyString(choice)}).pluck("value")` : null,
        `  assert_equal "chosen", field(builder.select(:${field}, nil${options}) { "chosen" }).text`,
        'end',
      ].filter((line): line is string => line !== null);
    }

    case 'submit':
    case 'button':
      return [
        name,
        `  rendered = field(builder.${method}("Go"${options}))`,
        '',
        `  assert_equal [${tag}, "Go"], [rendered.name, rendered.text]`,
        ...claimChecks(claim),
        required.length ? null : `  assert_equal "go", field(builder.${method}(id: "go"))["id"]`,
        `  assert_equal "Block", field(builder.${method}${required.length ? `(nil${options})` : ''} { "Block" }).text`,
        method === 'submit' && !required.length ? '  assert_equal "Create Record", field(builder.submit).text' : null,
        'end',
      ].filter((line): line is string => line !== null);

    default: {
      const field = fieldCase(component).name;

      return [name, `  rendered = field(builder.${method}(:${field}${options}))`, '', `  assert_equal [${tag}, "record[${field}]"], [rendered.name, rendered["name"]]`, ...claimChecks(claim), 'end'];
    }
  }
}

export function emitFormBuilderTest(components: ComponentModel[], options: ResolvedOptions, samples: Samples): string | undefined {
  const fields = components.filter((c) => c.formField);
  const claims = formBuilderClaims(components, options, () => undefined);

  if (!fields.length && !claims.length) return undefined;

  const ns = options.rubyNamespace;
  const key = options.configKey;
  const short = new Set(formBuilderShortNames(components, claims).map((c) => c.key));
  const claimed = new Set(claims.map((claim) => claim.method));
  const summary = options.formBuilder.errorsSummary;
  const summaryComponent = summary && components.find((c) => c.tag === summary.tag);
  const sample = samples.field;
  const blocks: string[][] = [];

  blocks.push(
    ['# The element a builder method rendered.', 'def field(html)', '  parse(html).element_children.first', 'end'],
    [
      'def test_the_builder_is_a_rails_form_builder_with_the_elements_methods',
      '  assert_operator FormBuilder, :<, ActionView::Helpers::FormBuilder',
      '  assert_includes FormBuilder.ancestors, FormBuilderMethods',
      'end',
    ],
  );

  for (const component of fields) blocks.push(fieldTest(component, short.has(component.key)));

  for (const claim of claims) blocks.push(claimTest(claim));

  const aliases = claims.flatMap((claim) => (RAILS_ALIASES.get(claim.method) ?? []).filter((alias) => !claimed.has(alias)).map((alias) => [alias, claim.method]));

  if (aliases.length) {
    blocks.push([
      "# Rails' own aliases follow the method they name.",
      'def test_rails_aliases',
      ...aliases.map(([alias, method]) => `  assert_equal FormBuilder.instance_method(:${method}), FormBuilder.instance_method(:${alias})`),
      'end',
    ]);
  }

  const first = claims.find((claim) => !['check_box', 'radio_button', 'select', 'submit', 'button'].includes(claim.method) && requiredProps(claim.component).length === 0);

  if (first) {
    const name = fieldCase(first.component).name;

    blocks.push([
      "# Options arrive the Rails way, as a hash with string or symbol keys, and win over the form's.",
      'def test_the_callers_options_win',
      `  rendered = field(builder.${first.method}(:${name}, "id" => "custom", :name => "other"))`,
      '',
      '  assert_equal %w[custom other], [rendered["id"], rendered["name"]]',
      'end',
    ]);
  }

  blocks.push([
    "# Rails' own field methods stay, under rails_<name>.",
    'def test_rails_own_methods_are_kept',
    '  kept = FormBuilder::RAILS_METHODS.select { |name| ActionView::Helpers::FormBuilder.method_defined?(name) }',
    '',
    '  assert_empty(kept.reject { |name| FormBuilder.method_defined?(:"rails_#{name}") })',
    '  assert_equal "input", field(builder.rails_text_field(:title)).name',
    'end',
  ]);

  if (summaryComponent) {
    const props = Object.entries(summary?.props ?? {}).flatMap(([name, value]) => {
      const attr = attribute(summaryComponent, snake(name));

      return attr && value !== false ? [`  assert_equal ${rubyString(value === true ? '' : String(value))}, rendered[${rubyString(attr)}]`] : [];
    });

    blocks.push(
      [
        'def test_errors_summary_lists_the_objects_errors',
        '  rendered = field(builder(record(title: "").tap(&:validate)).errors_summary(id: "errors"))',
        '',
        `  assert_equal [${rubyString(summaryComponent.tag)}, "errors"], [rendered.name, rendered["id"]]`,
        ...props,
        '  assert_equal "1 error prohibited this record from being saved:", rendered.at_css("strong").text',
        '  assert_equal ["Title can\'t be blank"], rendered.css("li").map(&:text)',
        'end',
      ],
      ['def test_errors_summary_is_nothing_without_errors', '  assert_nil builder.errors_summary', '  assert_nil builder(Struct.new(:title).new("Plain")).errors_summary', 'end'],
    );
  }

  const inside = sample ? `form.${sample.helper}(:title)` : '""';

  blocks.push(
    [
      `def test_${key}_form_with_uses_the_builder`,
      '  seen = nil',
      `  html = view.${key}_form_with(model: record, url: "/records") do |form|`,
      '    seen = form',
      `    ${inside}`,
      '  end',
      '',
      '  assert_kind_of FormBuilder, seen',
      '  assert_equal "/records", parse(html).at_css("form")["action"]',
      sample ? `  assert_equal "record[title]", parse(html).at_css("form ${sample.tag}")["name"]` : null,
      'end',
    ].filter((line): line is string => line !== null),
    [
      `def test_${key}_form_for_uses_the_builder`,
      '  seen = nil',
      `  html = view.${key}_form_for(record, url: "/records") do |form|`,
      '    seen = form',
      '    ""',
      '  end',
      '',
      '  assert_kind_of FormBuilder, seen',
      '  assert_equal "/records", parse(html).at_css("form")["action"]',
      'end',
    ],
  );

  const body = `
# ${ns}::FormBuilder: each form control's own method, the Rails field methods the
# components render, Rails' own methods under rails_<name>, and the form helpers.
class FormBuilderTest < TestCase
${blocks.map((block) => block.map((line) => (line ? `  ${line}` : '')).join('\n')).join('\n\n')}
end
`;

  return inNamespace(ns, body, 'require "test_helper"');
}
