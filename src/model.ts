import type { JsonDocsComponent, JsonDocsEvent, JsonDocsProp } from '@stencil/core/internal';
import type { ModelBinding, ResolvedOptions } from './options.ts';
import { componentNames, safeReader, snake } from './naming.ts';

/**
 * How a prop reaches the element:
 * - `value`: always rendered as `attr="<%= reader %>"`. One attribute slot, so Herb's
 *   runtime can rewrite it in place. Only the model prop, which `bind:` writes.
 * - `optional`: rendered only when the caller passes a value (or one other than the
 *   default). Every other prop with an attribute: an attribute the caller didn't give
 *   isn't the same as its default (my-button-group sizes only the buttons without
 *   a `size`, as the gem's `kwargs[:size] ||= size` does), and `mutable` props are state
 *   the component owns after first render. An optional prop marked `reactive` is a value
 *   slot in the partial flavor anyway (`reactiveProps`), so it follows server state there.
 * - `property`: no attribute exists (objects, arrays). Delivered as JSON through
 *   `data-stencil-props` and assigned as properties by the TS runtime.
 */
export type PropStrategy = 'value' | 'optional' | 'property';

export type PropKind = 'string' | 'enum' | 'number' | 'boolean' | 'json';

export interface PropModel {
  jsName: string;
  key: string;
  reader: string;
  attribute?: string;
  kind: PropKind;
  values?: string[];
  rubyDefault: string | null;
  strategy: PropStrategy;
  required: boolean;
  /** A string attribute that also takes a list (`string | string[]`): an Array given from Ruby goes out as a property too. */
  list: boolean;
  docs: string;
  /** The `@deprecated` JSDoc text, when the prop is kept only for a release (`Use \`heading\`.`). */
  deprecated?: string;
  /**
   * Follows server state in the partial flavor: a value slot that's always rendered (strings,
   * enums, numbers), or an attribute the bridge adds and removes (booleans). See `defaultReactive`.
   */
  reactive: boolean;
}

/**
 * How a form-associated element takes a Rails form field (`f.my_element_input :email`):
 * the prop that carries the object's value, and the prop that carries checked state.
 * Read from the props the element has, not from a list of tags.
 */
export interface FormFieldModel {
  value?: string;
  checked?: string;
  /** The prop holding what a checked control submits (`value`, or a switch's `yesValue`). */
  checkedValue?: string;
  /** The prop the FormBuilder sets to the attribute's human name (`@formLabel`, else `label`). */
  label?: string;
  /** The prop the FormBuilder sets to the attribute's first error (`@formError`, else `error`). */
  error?: string;
}

/** `@formBuilder <rails_method> [props JSON]`: Rails' `f.<method>` renders this component with those props. */
export interface FormBuilderMapping {
  method: string;
  props: Record<string, string | number | boolean>;
}

export interface SlotModel {
  /** `''` for the default slot. */
  name: string;
  rubyName: string;
  many: boolean | string;
  docs: string;
}

export interface EventModel {
  dom: string;
  key: string;
  detail: string;
  docs: string;
}

export interface ComponentModel {
  tag: string;
  key: string;
  className: string;
  fileBase: string;
  helper: string;
  encapsulation: string;
  docs: string;
  props: PropModel[];
  slots: SlotModel[];
  events: EventModel[];
  methods: string[];
  model?: ModelBinding;
  /** Present on form-associated elements (`formAssociated: true`). */
  formField?: FormFieldModel;
  /** The Rails FormBuilder methods this component takes over (`@formBuilder`). */
  formBuilder: FormBuilderMapping[];
  /** Components it renders in its shadow root (docs-json `dependencies`). */
  dependencies: string[];
  /** Components preloaded with it, such as the children its slots expect (`@assetWith`). */
  assetWith: string[];
  /** The element a choice of this control is (`@formChoices my-item`): `select`'s choices render as these. */
  formChoices?: string;
}

/** The JSDoc tags the generator reads; any other `@form…` or `@ruby…` tag is likely a typo. */
const COMPONENT_TAGS = new Set(['formBuilder', 'formChoices', 'rubyKey', 'rubyIgnore', 'assetWith']);

const PROP_TAGS = new Set(['formValue', 'formError', 'formLabel', 'reactive']);

interface DocsTag {
  name: string;
  text?: string;
}

const tagged = (tags: DocsTag[] | undefined, name: string) => (tags ?? []).filter((tag) => tag.name === name);

/** Warns about `@form…`/`@ruby…` tags the generator doesn't know, or that belong on the other level. */
function checkTags(tags: DocsTag[] | undefined, known: Set<string>, where: string, warn: (message: string) => void) {
  for (const { name } of tags ?? []) {
    if (/^(form|ruby)[A-Z]/.test(name) && !known.has(name)) warn(`unknown JSDoc tag @${name} on ${where}; the Ruby target reads ${[...known].map((n) => `@${n}`).join(', ')} there`);
  }
}

type Scalar = string | number | boolean;

function isScalar(item: unknown): item is Scalar {
  return typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
}

function isScalarRecord(value: unknown): value is Record<string, Scalar> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  return Object.values(value).every(isScalar);
}

/** A tag's JSON props (untyped JSON in, a checked record out), or undefined if they aren't JSON of scalars. */
function parseProps(json: string): Record<string, Scalar> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);

    return isScalarRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `@formBuilder email_field {"type":"email"}` → `{ method: 'email_field', props: { type: 'email' } }`. */
function parseFormBuilder(text: string, warn: (message: string) => void): FormBuilderMapping | undefined {
  const match = text.trim().match(/^([a-z_][a-z0-9_]*[?!]?)\s*(\{.*\})?$/s);

  if (!match) {
    warn(`@formBuilder ${text}: expected a Rails method name, then optional props as JSON`);

    return undefined;
  }

  const props = match[2] ? parseProps(match[2]) : {};

  if (!props) {
    warn(`@formBuilder ${match[1]}: props must be a JSON object of strings, numbers and booleans`);

    return undefined;
  }

  return { method: match[1], props };
}

/** The tag's own Ruby settings: `@rubyKey`, `@rubyIgnore` (for the caller to filter). */
export function componentTags(component: JsonDocsComponent) {
  const key = tagged(component.docsTags, 'rubyKey')[0]?.text?.trim();

  return { key: key || undefined, ignore: tagged(component.docsTags, 'rubyIgnore').length > 0 };
}

export interface Warning {
  tag: string;
  message: string;
}

const NON_VALUE_TYPES = new Set(['undefined', 'null', 'void']);

const SECRET_NAME = /(api[-_]?key|apikey|secret|token|password|credential)/i;

interface PropClassification {
  kind: PropKind;
  values?: string[];
}

function classify(prop: JsonDocsProp): PropClassification {
  const values = (prop.values ?? []).filter((v) => !NON_VALUE_TYPES.has(v.type));
  const types = new Set(values.map((v) => v.type));

  if (!prop.attr) return { kind: 'json' };

  if (types.size === 1 && types.has('boolean')) return { kind: 'boolean' };

  if (types.size === 1 && types.has('number')) return { kind: 'number' };

  if (values.length > 0 && values.every((v) => v.type === 'string' && v.value !== undefined)) {
    return { kind: 'enum', values: values.map((v) => v.value!) };
  }

  // `string | readonly string[]` and friends still arrive as a string attribute.
  return { kind: 'string' };
}

/** Translate a Stencil default (TS source text) into a Ruby literal, or null if it isn't a literal. */
function rubyDefault(source: string | undefined, kind: PropKind): string | null {
  if (source === undefined) return kind === 'boolean' ? 'false' : null;
  const text = source.trim();
  const quoted = text.match(/^(['"`])(.*)\1$/s);

  if (quoted && !(quoted[1] === '`' && quoted[2].includes('${'))) return JSON.stringify(quoted[2]);

  if (text === 'true' || text === 'false') return text;

  if (/^-?\d+(\.\d+)?$/.test(text)) return text;

  if (text === '[]') return '[].freeze';

  if (text === '{}') return '{}.freeze';

  if (text === 'null' || text === 'undefined') return 'nil';

  return null;
}

const SLOT_IN_SOURCE = /<slot\b([^>]*)\/?>/g;

const SLOT_NAME = /\bname\s*=\s*["']([^"']+)["']/;

/** Stencil only reports slots documented with `@slot`; most of ours aren't, so read the render source as well. */
function scanSlots(source: string | undefined): string[] {
  if (!source) return [];
  const names = new Set<string>();

  for (const match of source.matchAll(SLOT_IN_SOURCE)) {
    names.add(match[1].match(SLOT_NAME)?.[1] ?? '');
  }

  return [...names];
}

const FORM_ASSOCIATED = /\bformAssociated\s*:\s*true\b/;

/**
 * Stencil's docs-json doesn't say which components are form-associated, so read the
 * `@Component` options in the source. The value and checked props come from the docs.
 */
function detectFormField(source: string | undefined, props: PropModel[], jsonProps: JsonDocsProp[]): FormFieldModel | undefined {
  if (!source || !FORM_ASSOCIATED.test(source)) return undefined;
  const has = (name: string) => props.some((p) => p.jsName === name && p.attribute);
  const taggedProp = (tag: string) => jsonProps.find((p) => tagged(p.docsTags, tag).length > 0 && has(p.name))?.name;
  const field: FormFieldModel = {};
  const value = taggedProp('formValue');

  if (value && props.find((p) => p.jsName === value)?.kind === 'boolean') {
    field.checked = value;
    field.checkedValue = has('yesValue') ? 'yesValue' : 'value';
  } else if (value) {
    field.value = value;
  } else {
    if (has('value')) field.value = 'value';

    if (has('checked')) {
      field.checked = 'checked';
      field.checkedValue = has('yesValue') ? 'yesValue' : 'value';
    }
  }

  const label = taggedProp('formLabel') ?? (has('label') ? 'label' : undefined);
  const error = taggedProp('formError') ?? (has('error') ? 'error' : undefined);

  if (label) field.label = label;

  if (error) field.error = error;

  return field;
}

/** Form-control props a server owns: what the field is called, says, and whether it takes input. */
const FORM_REACTIVE = new Set(['label', 'description', 'error', 'disabled', 'required', 'readonly']);

/** Status props: the color a badge, button or callout takes from server state. */
const STATUS_REACTIVE = new Set(['state', 'status']);

/**
 * Whether a prop follows server state in the partial flavor when the config doesn't say. Only
 * props for which always rendering the attribute changes nothing the component does:
 * - never the model prop (already a value slot), a property (already in `data-stencil-props`),
 *   a `mutable` prop (state the component owns once rendered; a reply would overwrite it, S5) or
 *   a deprecated one;
 * - `state`/`status` enums that Stencil reflects with a literal default: the slot writes the
 *   default when unset, which is what reflection writes anyway. Not `variant`, which parents
 *   (button-group, breadcrumbs, mobile-nav) fill in only on children that don't set one;
 * - on a form-associated element, `label`, `description` and `error` strings with no default (an
 *   empty attribute is the empty string, which the component treats as unset, unless its source
 *   tells them apart with `??` or a comparison with undefined), and `disabled`, `required` and
 *   `readonly` booleans that default to false.
 */
function defaultReactive(prop: JsonDocsProp, kind: PropKind, formAssociated: boolean, source: string | undefined) {
  if (!prop.attr || prop.mutable || prop.deprecation !== undefined) return false;

  if (STATUS_REACTIVE.has(prop.name)) return kind === 'enum' && prop.reflectToAttr && prop.default !== undefined;

  if (!formAssociated || !FORM_REACTIVE.has(prop.name)) return false;

  if (kind === 'boolean') return prop.default === undefined || prop.default === 'false';

  const tellsUnsetFromEmpty = new RegExp(`this\\.${prop.name}\\s*(\\?\\?|[!=]==?\\s*(undefined|null)\\b)`);

  return kind === 'string' && prop.default === undefined && !tellsUnsetFromEmpty.test(source ?? '');
}

function detectModel(component: JsonDocsComponent, configured: ModelBinding | false | undefined): ModelBinding | undefined {
  if (configured === false) return undefined;

  if (configured) return configured;
  const hasValue = component.props.some((p) => p.name === 'value' && p.attr);
  const event = component.events.find((e) => ['update', 'change', 'input', 'valueChange'].includes(e.event));

  return hasValue && event ? { prop: 'value', event: event.event } : undefined;
}

function eventModel(event: JsonDocsEvent): EventModel {
  return { dom: event.event, key: snake(event.event), detail: event.detail ?? 'unknown', docs: event.docs };
}

function formBuilderMappings(component: JsonDocsComponent, warn: (message: string) => void) {
  return tagged(component.docsTags, 'formBuilder').flatMap((tag) => parseFormBuilder(tag.text ?? '', warn) ?? []);
}

export function buildModel(
  component: JsonDocsComponent,
  options: ResolvedOptions,
  readSource: (filePath: string) => string | undefined,
  warn: (message: string) => void,
): ComponentModel {
  const names = componentNames(component.tag, options.tagPrefix, options.aliases[component.tag] ?? componentTags(component).key);

  checkTags(component.docsTags, COMPONENT_TAGS, `<${component.tag}>`, warn);

  for (const prop of component.props) checkTags(prop.docsTags, PROP_TAGS, `prop \`${prop.name}\``, warn);
  const model = detectModel(component, options.models[component.tag]);

  const source = component.filePath ? readSource(component.filePath) : undefined;
  const formAssociated = !!source && FORM_ASSOCIATED.test(source);
  const configuredReactive = options.reactiveProps[component.tag];
  const props: PropModel[] = [];

  for (const name of configuredReactive ?? []) {
    if (!component.props.some((p) => p.name === name)) warn(`reactiveProps names \`${name}\`, which isn't a prop`);
  }

  for (const prop of component.props) {
    if (prop.values?.some((v) => v.type === 'Function' || v.type === 'function') || /=>/.test(prop.type)) {
      warn(`prop \`${prop.name}\` is a function; it can't be serialized from Ruby and was skipped`);
      continue;
    }

    const { kind, values } = classify(prop);
    let defaultValue = rubyDefault(prop.default, kind);

    // Never copy a credential default into generated Ruby (a default API key, say).
    if (SECRET_NAME.test(prop.name) && defaultValue !== null && defaultValue !== 'nil' && defaultValue !== 'false') {
      warn(`prop \`${prop.name}\` looks like a credential; its default was not copied into Ruby`);
      defaultValue = null;
    }

    if (prop.default !== undefined && defaultValue === null) {
      warn(`prop \`${prop.name}\` default \`${prop.default}\` isn't a literal; Ruby default is nil`);
    }

    const isModel = model?.prop === prop.name;
    let strategy: PropStrategy;

    if (kind === 'json') strategy = 'property';
    else if (isModel) strategy = 'value';
    else strategy = 'optional';

    if (isModel && defaultValue === null) defaultValue = kind === 'boolean' ? 'false' : '""';

    const key = snake(prop.name);
    const taggedReactive = tagged(prop.docsTags, 'reactive').length > 0;

    const reactive =
      strategy === 'optional' && (configuredReactive ? configuredReactive.includes(prop.name) : taggedReactive || defaultReactive(prop, kind, formAssociated, source));

    if (reactive && configuredReactive && prop.mutable) {
      warn(`reactive prop \`${prop.name}\` is mutable: a server reply overwrites what the component set (spike S5)`);
    }

    if (reactive && kind === 'number' && defaultValue === null) {
      warn(`reactive prop \`${prop.name}\` is a number with no default: unset, it renders "", which Stencil reads as NaN`);
    }

    const entry: PropModel = {
      jsName: prop.name,
      key,
      reader: safeReader(key),
      attribute: prop.attr,
      kind,
      values,
      rubyDefault: defaultValue,
      strategy,
      required: prop.required,
      list: (kind === 'string' || kind === 'enum') && /\[\]|Array</.test(prop.type),
      docs: prop.docs,
      reactive,
    };

    if (prop.deprecation !== undefined) entry.deprecated = prop.deprecation;

    props.push(entry);
  }

  const overrides = options.slots[component.tag] ?? {};
  const readers = new Set(props.map((p) => p.reader));
  const slotNames = new Set([...component.slots.map((s) => s.name), ...scanSlots(source)]);

  const slots: SlotModel[] = [...slotNames]
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map((name) => {
      let rubyName = overrides[name]?.rubyName ?? (name === '' ? 'content' : safeReader(snake(name)));

      // A slot named like a prop (my-button has both `icon` prop and slot) would
      // replace the prop's reader with renders_one's.
      if (name !== '' && readers.has(rubyName)) {
        warn(`slot \`${name}\` shares a name with a prop; the Ruby slot is \`${rubyName}_slot\``);
        rubyName = `${rubyName}_slot`;
      }

      return {
        name,
        rubyName,
        many: overrides[name]?.many ?? false,
        docs: component.slots.find((s) => s.name === name)?.docs ?? '',
      };
    });

  if (component.encapsulation !== 'shadow' && slots.some((s) => s.name !== '')) {
    warn(`uses named slots without shadow DOM; Stencil relocates light-DOM children, so check Herb slot markers survive (spike S4)`);
  }

  return {
    tag: component.tag,
    key: names.key,
    className: names.className,
    fileBase: names.fileBase,
    helper: `${options.helperPrefix}${names.key}`,
    encapsulation: component.encapsulation,
    docs: component.docs,
    props,
    slots,
    events: component.events.map(eventModel),
    methods: component.methods.map((m) => m.name),
    model,
    formField: detectFormField(source, props, component.props),
    formBuilder: formBuilderMappings(component, warn),
    dependencies: [...(component.dependencies ?? [])].sort(),
    formChoices: tagged(component.docsTags, 'formChoices')[0]?.text?.trim() || undefined,
    assetWith: tagged(component.docsTags, 'assetWith')
      .flatMap((tag) => (tag.text ?? '').split(/[\s,]+/))
      .filter(Boolean),
  };
}
