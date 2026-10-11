// Browser bridge between Stencil elements rendered by the generated ViewComponents
// and ReActionView / Herb's client runtime. Copied next to the generated manifest.
//
//   data-stencil-props='{"items":[…]}'   JSON for props that have no attribute; assigned as properties.
//   data-stencil-attributes='{"aria-label":"Close"}'   the partial flavor's other HTML attributes; set on the element.
//   data-stencil-set="update->query"     on `update`, write the element's model value to server state `query`.
//   data-stencil-state="update->draft"   same, into client-declared `herb:state` (no request).
//
// With Herb's runtime these are registered as behaviors, so they follow elements
// that slots and payloads add or remove, and re-apply when Herb rewrites the
// attribute. Without it, a MutationObserver does the same and bindings are
// re-dispatched as `stencil:bind` events for Stimulus or anything else.

import { STENCIL_ELEMENTS } from './manifest.ts';

/** JSON as it crosses the bridge: prop payloads in, bound values out. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

type StateValue = string | number | boolean | null;

/**
 * The slice of @herb-tools/client this bridge uses, typed structurally so the
 * dependency stays optional. `Runtime` from @herb-tools/client 0.11 satisfies it.
 */
export interface HerbRuntimeLike {
  /** Server state: values travel as request params, so they are strings. */
  state: { set(values: Record<string, string>): void };
  behaviors: {
    define(
      attribute: string,
      behavior: {
        connect?(element: Element, context: { state: { set(values: Record<string, StateValue>): void } }): void;
        valueChanged?(element: Element, value: string, context: { state: { set(values: Record<string, StateValue>): void } }): void;
        disconnect?(element: Element): void;
      },
    ): () => void;
  };
}

/** Event details and element properties are untyped; only JSON-shaped values cross the bridge. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;

  if (Array.isArray(value)) return value.every(isJsonValue);

  return typeof value === 'object' && Object.values(value).every(isJsonValue);
}

function isScalar(value: JsonValue): value is StateValue {
  return value === null || typeof value !== 'object';
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Request params are strings: arrays/objects go as JSON, null as empty. */
function serialize(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';

  return isScalar(value) ? String(value) : JSON.stringify(value);
}

/** Client state holds primitives only. */
function toStateValue(value: JsonValue | undefined): StateValue {
  if (value === undefined) return null;

  return isScalar(value) ? value : JSON.stringify(value);
}

export interface StencilBindDetail {
  state: string;
  value: JsonValue | undefined;
  scope: 'server' | 'client';
}

type Channel = 'set' | 'state' | 'standalone';

type Write = (state: string, value: JsonValue | undefined) => void;

// Per element and channel, so the `set` and `state` behaviors on one element don't
// remove each other's listeners.
const listeners = new WeakMap<Element, Map<Channel, Array<() => void>>>();

function applyProps(element: Element, json: string | null) {
  if (!json) return;

  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = undefined;
  }

  if (!isJsonValue(parsed) || !isJsonObject(parsed)) {
    console.warn(`[stencil-bridge] data-stencil-props on <${element.localName}> is not a JSON object`);

    return;
  }

  const allowed = STENCIL_ELEMENTS[element.localName]?.properties ?? [];

  for (const [name, value] of Object.entries(parsed)) {
    if (allowed.includes(name)) Object.assign(element, { [name]: value });
  }
}

// Attribute names the bridge set from data-stencil-attributes, so a rewrite can drop the ones it no longer lists.
const setAttributes = new WeakMap<Element, Set<string>>();

const ATTRIBUTE_NAME = /^[a-z][a-z0-9_.:-]*$/i;

/** The partial flavor's host attributes beyond id and class (Herb can't rewrite an ERB output in attribute position). */
function applyAttributes(element: Element, json: string | null) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    parsed = undefined;
  }

  if (!isJsonValue(parsed) || !isJsonObject(parsed)) {
    console.warn(`[stencil-bridge] data-stencil-attributes on <${element.localName}> is not a JSON object`);

    return;
  }

  const previous = setAttributes.get(element) ?? new Set<string>();
  const next = new Set<string>();

  for (const [name, value] of Object.entries(parsed)) {
    if (!ATTRIBUTE_NAME.test(name) || /^on/i.test(name)) continue;

    element.setAttribute(name, serialize(value));
    next.add(name);
  }

  for (const name of previous) {
    if (!next.has(name)) element.removeAttribute(name);
  }

  setAttributes.set(element, next);
}

/** Parse `event->state` pairs, space separated. */
function parseBindings(spec: string | null) {
  return (spec ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const [event, state] = pair.split('->');

      return { event, state };
    })
    .filter((b) => b.event && b.state);
}

function rawValueOf(element: Element, event: Event) {
  const model = STENCIL_ELEMENTS[element.localName]?.model;

  if (model && model.event === event.type) {
    // INVARIANT: model.prop comes from the generated manifest, which only lists props the element defines.
    return element[model.prop as keyof Element];
  }

  return event instanceof CustomEvent ? event.detail : undefined;
}

function valueOf(element: Element, event: Event): JsonValue | undefined {
  const raw = rawValueOf(element, event);

  return isJsonValue(raw) ? raw : undefined;
}

function listen(element: Element, channel: Channel, spec: string | null, write: Write) {
  unlisten(element, channel);

  const removers = parseBindings(spec).map(({ event, state }) => {
    const handler = (e: Event) => {
      if (e.target === element) write(state, valueOf(element, e));
    };

    element.addEventListener(event, handler);

    return () => element.removeEventListener(event, handler);
  });

  if (!listeners.has(element)) listeners.set(element, new Map());
  listeners.get(element)!.set(channel, removers);
}

function unlisten(element: Element, channel?: Channel) {
  const byChannel = listeners.get(element);

  if (!byChannel) return;

  for (const [name, removers] of byChannel) {
    if (channel && name !== channel) continue;
    removers.forEach((remove) => remove());
    byChannel.delete(name);
  }
}

function dispatchBind(element: Element, detail: StencilBindDetail) {
  element.dispatchEvent(new CustomEvent<StencilBindDetail>('stencil:bind', { bubbles: true, composed: true, detail }));
}

function startWithHerb(runtime: HerbRuntimeLike) {
  const undefines = [
    runtime.behaviors.define('data-stencil-props', {
      connect: (element) => applyProps(element, element.getAttribute('data-stencil-props')),
      valueChanged: (element, value) => applyProps(element, value),
    }),
    runtime.behaviors.define('data-stencil-set', {
      // Server state goes through the runtime's own state, which owns the transport.
      connect: (element) =>
        listen(element, 'set', element.getAttribute('data-stencil-set'), (state, value) => runtime.state.set({ [state]: serialize(value) })),
      valueChanged: (element, value) => listen(element, 'set', value, (state, v) => runtime.state.set({ [state]: serialize(v) })),
      disconnect: (element) => unlisten(element, 'set'),
    }),
    runtime.behaviors.define('data-stencil-state', {
      // Client-declared state is scoped: the context's state resolves to the enclosing keyed row.
      connect: (element, context) =>
        listen(element, 'state', element.getAttribute('data-stencil-state'), (state, value) => context.state.set({ [state]: toStateValue(value) })),
      valueChanged: (element, value, context) => listen(element, 'state', value, (state, v) => context.state.set({ [state]: toStateValue(v) })),
      disconnect: (element) => unlisten(element, 'state'),
    }),
    runtime.behaviors.define('data-stencil-attributes', {
      connect: (element) => applyAttributes(element, element.getAttribute('data-stencil-attributes')),
      valueChanged: (element, value) => applyAttributes(element, value),
    }),
  ];

  return () => undefines.forEach((undefine) => undefine());
}

function startStandalone(root: ParentNode & Node) {
  const ATTRS = ['data-stencil-props', 'data-stencil-attributes', 'data-stencil-set', 'data-stencil-state'];

  const wire = (element: Element) => {
    if (element.hasAttribute('data-stencil-props')) applyProps(element, element.getAttribute('data-stencil-props'));

    if (element.hasAttribute('data-stencil-attributes')) applyAttributes(element, element.getAttribute('data-stencil-attributes'));
    const set = element.getAttribute('data-stencil-set');
    const client = element.getAttribute('data-stencil-state');

    if (set || client) {
      listen(element, 'standalone', [set, client].filter(Boolean).join(' '), (state, value) =>
        dispatchBind(element, { state, value, scope: parseBindings(set).some((b) => b.state === state) ? 'server' : 'client' }),
      );
    }
  };

  const selector = ATTRS.map((a) => `[${a}]`).join(',');
  root.querySelectorAll(selector).forEach(wire);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) wire(record.target);
      record.removedNodes.forEach((node) => {
        if (node instanceof Element) [node, ...node.querySelectorAll(selector)].forEach((el) => unlisten(el));
      });
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) [node, ...node.querySelectorAll(selector)].filter((el) => el.matches(selector)).forEach(wire);
      });
    }
  });

  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRS });

  return () => observer.disconnect();
}

/**
 * Start the bridge. Pass Herb's runtime (`Runtime.start()` from `reactionview` or
 * `@herb-tools/client`) to bind into its state; omit it for plain Rails/Turbo pages.
 * Returns a function that stops it.
 */
export function startStencilBridge(options: { runtime?: HerbRuntimeLike; root?: ParentNode & Node } = {}) {
  return options.runtime ? startWithHerb(options.runtime) : startStandalone(options.root ?? document);
}
