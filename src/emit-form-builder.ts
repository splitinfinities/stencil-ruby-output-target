import type { ComponentModel, Warning } from './model.ts';
import type { ResolvedOptions } from './options.ts';
import { HEADER, inNamespace, openModules } from './emit-lib.ts';
import { rubyString, snake } from './naming.ts';

/**
 * The FormBuilder: a module of `<prefix><key>` methods (one per form-associated element, the
 * one Rails' own builder includes), and a class, `<Namespace>::FormBuilder <
 * ActionView::Helpers::FormBuilder`, that includes it, keeps Rails' methods as `rails_<name>`,
 * and renders components for the Rails methods they claim (`@formBuilder`, or the
 * `formBuilder.fields` option).
 */

/** ActionView::Helpers::FormBuilder's public methods (8.1): a short name that would replace one isn't generated. */
export const RAILS_BUILDER_METHODS = new Set(
  `button check_box checkbox collection_check_boxes collection_checkboxes collection_radio_buttons collection_select
color_field date_field date_select datetime_field datetime_local_field datetime_select email_field emitted_hidden_id?
field_helpers field_id field_name fields fields_for file_field grouped_collection_select hidden_field id index label
month_field multipart number_field object object_name options password_field phone_field radio_button range_field
search_field select submit telephone_field text_area text_field textarea time_field time_select time_zone_select
to_model to_partial_path url_field week_field weekday_select errors_summary`.split(/\s+/),
);

/** The Rails field methods aliased as `rails_<name>`, whether or not a component claims them. */
const RAILS_FIELDS = [
  'text_field', 'email_field', 'password_field', 'number_field', 'search_field', 'url_field', 'telephone_field', 'phone_field',
  'date_field', 'time_field', 'datetime_field', 'datetime_local_field', 'month_field', 'week_field', 'color_field', 'range_field',
  'text_area', 'textarea', 'file_field', 'hidden_field', 'check_box', 'checkbox', 'radio_button', 'select', 'submit', 'button',
];

/** Rails' own aliases: taking over one takes over the other. */
export const RAILS_ALIASES = new Map([
  ['check_box', ['checkbox']],
  ['text_area', ['textarea']],
  ['telephone_field', ['phone_field']],
]);

export interface Claim {
  method: string;
  component: ComponentModel;
  props: Record<string, string | number | boolean>;
}

/** Rails method → the component that renders it: the option's map over the components' `@formBuilder` tags. */
export function formBuilderClaims(components: ComponentModel[], options: ResolvedOptions, warn: (warning: Warning) => void): Claim[] {
  const claims = new Map<string, Claim>();
  const byTag = new Map(components.map((c) => [c.tag, c]));

  for (const component of components) {
    for (const { method, props } of component.formBuilder) {
      const taken = claims.get(method);

      if (taken) warn({ tag: component.tag, message: `@formBuilder ${method} is already <${taken.component.tag}>'s; it stays there` });
      else claims.set(method, { method, component, props });
    }
  }

  for (const [method, field] of Object.entries(options.formBuilder.fields ?? {})) {
    if (field === false) {
      claims.delete(method);
      continue;
    }

    const component = byTag.get(field.tag);

    if (component) claims.set(method, { method, component, props: field.props ?? {} });
    else warn({ tag: field.tag, message: `formBuilder.fields.${method} names a component that isn't generated` });
  }

  return [...claims.values()].sort((a, b) => a.method.localeCompare(b.method));
}

/** A Ruby hash literal of props (`{type: "email"}`), keyed by their Ruby names. */
const propsHash = (props: Record<string, string | number | boolean>) =>
  `{${Object.entries(props)
    .map(([key, value]) => `${snake(key)}: ${JSON.stringify(value)}`)
    .join(', ')}}`;

const hasProp = (component: ComponentModel, key: string) => component.props.some((prop) => prop.key === key);

/** One overriding method per Rails signature. */
function claimMethod({ method, component, props }: Claim): string[] {
  const klass = component.className;
  const given = propsHash(props);
  const checkedValue = snake(component.formField?.checkedValue ?? 'value');

  switch (method) {
    case 'check_box': {
      const unchecked = hasProp(component, 'unchecked_value');

      return [
        `def check_box(attribute, options = {}, checked_value = "1", ${unchecked ? '' : '_'}unchecked_value = "0")`,
        `  __form_field(${klass}, attribute, ${given}, {${checkedValue}: checked_value${unchecked ? ', unchecked_value:' : ''}}.merge(options))`,
        'end',
      ];
    }

    case 'radio_button':
      return ['def radio_button(attribute, tag_value, options = {})', `  __form_field(${klass}, attribute, ${given}, {${checkedValue}: tag_value}.merge(options))`, 'end'];

    case 'select':
      return [
        'def select(attribute, choices = nil, options = {}, html_options = {}, &block)',
        `  __form_field(${klass}, attribute, ${given}, options.merge(html_options), choices:, choice_tag: ${component.formChoices ? rubyString(component.formChoices) : 'nil'}, &block)`,
        'end',
      ];

    case 'submit':
    case 'button':
      return [
        `def ${method}(value = nil, options = {}, &block)`,
        '  value, options = nil, value if value.is_a?(Hash)',
        method === 'submit' ? '  value ||= submit_default_value' : null,
        `  __form_button(${klass}, ${given}, value, options, &block)`,
        'end',
      ].filter((line): line is string => line !== null);

    default:
      return [`def ${method}(attribute, options = {}, &block)`, `  __form_field(${klass}, attribute, ${given}, options, &block)`, 'end'];
  }
}

/** The form-associated components that also get `f.<key>`: those whose key isn't a Rails builder method or a claimed one. */
export function formBuilderShortNames(components: ComponentModel[], claims: Claim[]) {
  const claimed = new Set(claims.map((claim) => claim.method));

  return components.filter((c) => c.formField && !RAILS_BUILDER_METHODS.has(c.key) && !claimed.has(c.key));
}

export function emitFormBuilderMethods(components: ComponentModel[], options: ResolvedOptions) {
  const { open, close, indent } = openModules(options.rubyNamespace);

  const methods = components
    .flatMap((c) =>
      c.formField
        ? [
            `${indent}  # <${c.tag}> for the object's attribute.\n` +
              `${indent}  def ${c.helper}(attribute, **options, &block)\n` +
              `${indent}    @template.render(${c.className}.new(form: self, attribute:, **options), &block)\n` +
              `${indent}  end`,
          ]
        : [],
    )
    .join('\n\n');

  return `${HEADER}
${open}
${indent}# FormBuilder methods for the form-associated elements. Name, id, value (or checked),
${indent}# error, label and required come from the form and its object, the Rails way:
${indent}#
${indent}#   <%= form_with model: @user do |f| %>
${indent}#     <%= f.${components.find((c) => c.formField)?.helper ?? 'element'} :email %>
${indent}#   <% end %>
${indent}#
${indent}# ${options.rubyNamespace}::FormBuilder includes it; so does every Rails builder while
${indent}# config.form_builder is on (the default).
${indent}module FormBuilderMethods
${methods}
${indent}end
${close}
`;
}

export function emitFormBuilderClass(components: ComponentModel[], options: ResolvedOptions, warn: (warning: Warning) => void) {
  const claims = formBuilderClaims(components, options, warn);
  const claimed = new Set(claims.map((claim) => claim.method));
  const summary = options.formBuilder.errorsSummary;
  const summaryComponent = summary && components.find((c) => c.tag === summary.tag);

  if (summary && !summaryComponent) warn({ tag: summary.tag, message: 'formBuilder.errorsSummary names a component that isn\'t generated' });

  const shortNames = formBuilderShortNames(components, claims);

  const lines: string[] = [
    `include FormBuilderMethods`,
    '',
    "# Rails' own methods, kept as rails_text_field, rails_select, …",
    `RAILS_METHODS = %i[${RAILS_FIELDS.join(' ')}].freeze`,
    'RAILS_METHODS.each { |name| alias_method :"rails_#{name}", name if method_defined?(name) }',
  ];

  for (const claim of claims) {
    lines.push('', `# <${claim.component.tag}>${Object.keys(claim.props).length ? ` ${propsHash(claim.props)}` : ''} for Rails' ${claim.method}.`, ...claimMethod(claim));

    for (const alias of RAILS_ALIASES.get(claim.method) ?? []) {
      if (!claimed.has(alias)) lines.push(`alias_method :${alias}, :${claim.method}`);
    }
  }

  for (const c of shortNames) {
    lines.push('', `# f.${c.key} :attribute, the same as f.${c.helper}.`, `def ${c.key}(attribute, **options, &block)`, `  ${c.helper}(attribute, **options, &block)`, 'end');
  }

  if (summaryComponent) {
    lines.push(
      '',
      `# The object's errors in a <${summaryComponent.tag}>: a heading (config.errors_summary_heading) and`,
      '# the full messages. Nothing when the object has none.',
      'def errors_summary(**options)',
      '  return if !object.respond_to?(:errors) || object.errors.empty?',
      '',
      `  heading = ${options.rubyNamespace}.config.errors_summary_heading_for(object)`,
      '  items = object.errors.full_messages.map { |message| @template.tag.li(message) }',
      `  props = ${propsHash(summary.props ?? {})}.merge(options)`,
      `  @template.render(${summaryComponent.className}.new(**props)) do`,
      '    @template.safe_join([@template.tag.strong(heading), @template.tag.ul(@template.safe_join(items))])',
      '  end',
      'end',
    );
  }

  lines.push(
    '',
    'private',
    '',
    "# A component for the attribute: the caller's options over the claim's props, rendered with",
    '# form: and attribute:, so BaseComponent.form_options fills in the rest.',
    'def __form_field(klass, attribute, props, options, choices: nil, choice_tag: nil, &block)',
    '  component = klass.new(form: self, attribute:, **props, **options.to_h.symbolize_keys)',
    '  return @template.render(component, &block) if block || choices.nil? || choice_tag.nil?',
    '',
    '  @template.render(component) { __form_choices(choices, choice_tag) }',
    'end',
    '',
    "# Rails' select choices (strings, [label, value] pairs or a hash) as the control's choice elements.",
    'def __form_choices(choices, choice_tag)',
    '  pairs = choices.is_a?(Hash) ? choices.to_a : Array(choices)',
    '  @template.safe_join(pairs.map do |choice|',
    '    label, value = choice.is_a?(Array) ? choice : [choice, choice]',
    '    @template.content_tag(choice_tag, label.to_s, value: value.to_s)',
    '  end)',
    'end',
    '',
    '# A button that submits (or not) the form: its text is the value, or the block.',
    'def __form_button(klass, props, value, options, &block)',
    '  @template.render(klass.new(**props, **options.to_h.symbolize_keys)) { block ? @template.capture(&block) : value }',
    'end',
  );

  const { indent } = openModules(options.rubyNamespace);

  const body = `
# A FormBuilder that renders the library's elements for Rails' field methods:
#
#   <%= ${options.configKey}_form_with model: @user do |f| %>
#     <%= f.text_field :name %>        <%# <${claims.find((c) => c.method === 'text_field')?.component.tag ?? 'element'}> %>
#     <%= f.rails_text_field :name %>  <%# Rails' own <input> %>
#   <% end %>
#
# Every form-associated element also has its own method (f.${components.find((c) => c.formField)?.helper ?? 'element'}). Rails'
# methods no component claims are Rails'.
class FormBuilder < ActionView::Helpers::FormBuilder
${lines.map((line) => (line ? `  ${line}` : '')).join('\n')}
end
`;

  return { content: inNamespace(options.rubyNamespace, body), claims, indent };
}

/** lib/<ns>/form_helper.rb: `<configKey>_form_with` and `_form_for`, with the generated builder. */
export function emitFormHelper(options: ResolvedOptions) {
  const key = options.configKey;
  const ns = options.rubyNamespace;

  return inNamespace(
    ns,
    `
# form_with and form_for with ${ns}::FormBuilder:
#
#   <%= ${key}_form_with model: @user do |f| %>
#     <%= f.text_field :email %>
#   <% end %>
module FormHelper
  def ${key}_form_with(**options, &)
    form_with(builder: ${ns}::FormBuilder, **options, &)
  end

  def ${key}_form_for(record, options = {}, &)
    form_for(record, options.merge(builder: ${ns}::FormBuilder), &)
  end
end
`,
  );
}
