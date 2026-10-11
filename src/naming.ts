// Ruby identifiers that a generated reader must not shadow: Ruby keywords, Object/Kernel
// methods, the ViewComponent::Base API the template relies on, and OptStruct's.
const RESERVED = new Set([
  'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else', 'elsif', 'end', 'ensure',
  'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self',
  'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield',
  'method', 'send', 'display', 'freeze', 'hash', 'object_id', 'open', 'format', 'print', 'puts', 'system', 'test',
  'tag', 'content', 'render', 'helpers', 'controller', 'request', 'view_context', 'output_buffer', 'virtual_path',
  'html_attributes', 'element_tag', 'props', 'events', 'model', 'optional_attribute', 'property_payload', 'host_attributes',
  'form_field', 'form_options', 'attribute_value', 'slotted', 'host_id', 'host_class', 'server_binding', 'client_binding', 'herb_set', 'host_attribute_payload',
  // OptStruct's: the options hash every prop is read from, and its instance methods.
  'options', 'fetch', 'defaults',
]);

export const snake = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();

export const pascal = (value: string) =>
  snake(value)
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');

/** ActiveSupport::Inflector#underscore for a constant name without acronyms. */
export const underscore = (constant: string) =>
  constant
    .replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();

/** Name a generated reader can safely use; the keyword argument keeps the plain name. */
export const safeReader = (name: string) => (RESERVED.has(name) ? `${name}_value` : name);

export function componentNames(tag: string, tagPrefix: string, alias?: string) {
  let base = alias ?? (tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : tag);
  // Ruby constants can't start with a digit: my-360-image → Image360.
  const leadingDigits = base.match(/^(\d+)-(.*)$/);

  if (leadingDigits) base = `${leadingDigits[2]}-${leadingDigits[1]}`;
  const className = `${pascal(base)}Component`;
  // File names must match ActiveSupport's `underscore` of the class, which is how
  // ViewComponent finds the sidecar template: Video360Component → video360_component.
  const fileBase = underscore(className);

  return { key: fileBase.replace(/_component$/, ''), className, fileBase };
}

export const rubyString = (value: string) => JSON.stringify(value);

export function namespacePath(namespace: string) {
  return namespace.split('::').map(snake).join('/');
}
