import type { ComponentModel } from './model.ts';
import type { ResolvedOptions } from './options.ts';

/**
 * The template is written for Herb's slot compiler as much as for ERB:
 * - Every reactive prop is its own `attr="<%= reader %>"`: one expression for the whole
 *   value, so Herb marks it as an attribute slot it can rewrite in place (a word inside
 *   a larger attribute value would be a `partial-attribute` it refuses to write).
 * - No ERB output in attribute position: Herb's security validator rejects `<%= … %>` where an
 *   attribute name goes (an error, so a test environment raises), except `tag.attributes(…)`.
 *   A prop that renders only sometimes is `<% if attribute?(:x) %> x="<%= attribute_value(:x) %>"<% end %>`:
 *   a static name, with a value slot Herb rewrites while the attribute is there. Herb can't add
 *   or remove the attribute itself (spike S2): the branch is render-once.
 * - In the partial flavor, a `reactive` prop (`reactiveProps`) is always present instead:
 *   `x="<%= component.reactive_value(:x) %>"`, its default or "" when unset, which follows
 *   server state. A reactive boolean keeps its conditional and is also listed in
 *   `data-stencil-attributes`, which the bridge applies, adding and removing the attribute.
 * - Booleans render the HTML way, present or absent (`attribute?`), never "false": a
 *   form-associated element reads any value as true, as a native control does, and
 *   `:host([x])` selectors match it.
 * - Named slot content gets `slot="…"` on each of its top-level elements (`slotted`), so a
 *   component that reads its assigned elements (my-tabs' panels) gets the caller's. The
 *   `if` only decides whether the slot renders; what's inside stays a plain content slot.
 * - No whitespace between the host's tags and its children: a component that checks for
 *   content (a default label, a slot fallback) would take a newline for some.
 */
interface Flavor {
  /** What the helpers are called on: the component itself, or the partial's `component` local. */
  receiver: string;
  /** Ruby for a named slot's content and whether it was given, and for the default slot. */
  slot: (rubyName: string) => { given: string; content: string; items: string };
  content: string;
  /** The partial flavor: reactive value slots, host attributes as JSON, span-wrapped light-DOM slots. */
  partial: boolean;
}

const COMPONENT: Flavor = {
  partial: false,
  receiver: '',
  slot: (name) => ({ given: `${name}?`, content: name, items: name }),
  content: 'content',
};

const PARTIAL: Flavor = {
  partial: true,
  receiver: 'component.',
  slot: (name) => ({ given: `slots[:${name}].present?`, content: `slots[:${name}]`, items: `Array(slots[:${name}])` }),
  content: 'yield',
};

function conditionalAttribute(flavor: Flavor, key: string, attribute: string | undefined) {
  const r = flavor.receiver;

  // The space inside the branch separates the attribute from the tag's previous one (erb_lint's SpaceInHtmlTag).
  return `<% if ${r}attribute?(:${key}) %> ${attribute}="<%= ${r}attribute_value(:${key}) %>"<% end %>`;
}

function element(component: ComponentModel, options: ResolvedOptions, flavor: Flavor) {
  const r = flavor.receiver;
  const attributes: string[] = [];

  for (const prop of component.props) {
    if (prop.strategy === 'value' && prop.kind === 'boolean') attributes.push(conditionalAttribute(flavor, prop.key, prop.attribute));
    else if (prop.strategy === 'value') attributes.push(`${prop.attribute}="<%= ${r}${prop.reader} %>"`);
  }

  for (const prop of component.props) {
    if (prop.strategy !== 'optional') continue;

    // A reactive prop in the partial flavor: always present, so Herb rewrites it on a reply. A
    // boolean keeps its conditional for the first paint; the bridge then owns it through
    // data-stencil-attributes, since Herb can't add or remove an attribute (spike S2).
    if (flavor.partial && prop.reactive && prop.kind !== 'boolean') attributes.push(`${prop.attribute}="<%= ${r}reactive_value(:${prop.key}) %>"`);
    else attributes.push(conditionalAttribute(flavor, prop.key, prop.attribute));
  }

  if (component.props.some((p) => p.strategy === 'property' || p.list)) {
    attributes.push(`data-stencil-props="<%= ${r}property_payload %>"`);
  }

  if (flavor.partial) {
    attributes.push('id="<%= component.host_id %>"', 'class="<%= component.host_class %>"');

    if (component.model) {
      attributes.push('data-stencil-set="<%= component.server_binding %>"');

      // Spike S6: Herb's data-herb-set reads a custom element's `.value`, so a value model's client binding needs no bridge.
      if (component.model.prop === 'value') attributes.push('data-herb-set="<%= component.herb_set %>"');
      else attributes.push('data-stencil-state="<%= component.client_binding %>"');
    }

    attributes.push('data-stencil-attributes="<%= component.host_attribute_payload %>"');
  } else {
    attributes.push('<%= tag.attributes(host_attributes) %>');
  }

  const children: string[] = [];

  for (const slot of component.slots) {
    if (slot.name === '') continue;

    // Spike S4: without shadow DOM, Stencil moves slotted children to where the component renders
    // each slot, away from the markers Herb wrote around them, and a reply is then lost or written
    // next to the old content. A static wrapper carrying slot="…" holds the markers and moves with
    // them, so the partial flavor (the reactive one) wraps those components' named slots.
    const wrapper = flavor.partial && component.encapsulation !== 'shadow' ? 'span' : options.slotWrapper;

    const wrap = (expression: string) => {
      if (wrapper === 'attribute') return `<%= ${r}slotted(${JSON.stringify(slot.name)}, ${expression}) %>`;

      return wrapper === 'span' ? `<span slot="${slot.name}" style="display: contents"><%= ${expression} %></span>` : `<%= ${expression} %>`;
    };

    const ruby = flavor.slot(slot.rubyName);

    if (slot.many) {
      children.push(`<% ${ruby.items}.each do |item| %>${wrap('item')}<% end %>`);
    } else {
      children.push(`<% if ${ruby.given} %>${wrap(ruby.content)}<% end %>`);
    }
  }

  children.push(`<%= ${flavor.content} %>`);

  return `<${component.tag}
  ${attributes.join('\n  ')}>${children.join('')}</${component.tag}>
`;
}

/** The ViewComponent's sidecar template. */
export function emitTemplate(component: ComponentModel, options: ResolvedOptions) {
  return `<%# Generated by stencil-ruby-output-target from <${component.tag}>. Do not edit. %>
${element(component, options, COMPONENT)}`;
}

/**
 * The partial flavor (`app/views/<namespace>/_<name>.html.erb`), for pages ReActionView keeps
 * reactive. Herb follows a value through a partial's locals into its slots, and a server reply
 * rewrites the element's attributes in place; through a ViewComponent's keyword arguments it
 * doesn't, and the reply replaces the whole element, which loses its state (spike S1).
 *
 * Same markup as the component's template, with the component built from the locals for its
 * validation, defaults and attribute rules. `**options` and no literal defaults: Herb 0.11
 * compiles a strict-locals default into the output when it parses strict locals (as the slot
 * compiler does), so `(size: "default")` would print "default". No ERB output in attribute
 * position either: Herb's client writes such an "element" slot as content in place of the
 * element, so the host's own attributes are value slots (`id`, `class`, the bindings) and JSON
 * the bridge sets (`data-stencil-attributes`, for `data:`, `aria:` and the rest). Named slots are locals
 * (`icon_slot: "<my-icon …>"`, a list for one that takes many); the default slot is the block, or
 * the `content:` local (`content_slot:` where a prop is `content`), which survives a reactive reply.
 *
 *   <%= render "my/elements/input", value: @query, bind: :query, label: "Search" %>
 */
export function emitPartial(component: ComponentModel, options: ResolvedOptions) {
  // The default slot's content as a local, for reactive pages: Herb 0.11 destroys a partial
  // rendered with a block on every reply (README, Spikes). `content_slot` where a prop is `content`.
  const contentLocal = component.props.some((prop) => prop.key === 'content') ? 'content_slot' : 'content';

  const locals = [...component.slots.filter((s) => s.name !== '').map((s) => `:${s.rubyName}`), `:${contentLocal}`];
  const constant = `${options.rubyNamespace}::${component.className}`;

  const setup = `<% slots = options.slice(${locals.join(', ')}) %>
<% component = ${constant}.new(**options.except(${locals.join(', ')})) %>`;

  const flavor: Flavor = { ...PARTIAL, content: `slots.key?(:${contentLocal}) ? slots[:${contentLocal}] : yield` };

  return `<%# Generated by stencil-ruby-output-target from <${component.tag}>: the partial flavor of ${constant}. Do not edit. %>
<%# locals: (**options) %>
${setup}
${element(component, options, flavor)}`;
}
