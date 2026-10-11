// The generator's own logic, without a Stencil build: the per-component JSDoc tags and the
// asset manifest read from a lazy build.
//   node --test packages/stencil-ruby-output-target/test/generator.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonDocs, JsonDocsComponent, JsonDocsProp } from '@stencil/core/internal';
import { commonTagPrefix, generate } from '../src/index.ts';
import { buildModel, type Warning } from '../src/model.ts';
import { resolveOptions } from '../src/options.ts';
import { assetFiles, parseRegistry, readLazyBuild, staticImports } from '../src/assets.ts';

const FORM_SOURCE = '@Component({ tag: "x-field", formAssociated: true })';

function prop(name: string, extra: Partial<JsonDocsProp> = {}): JsonDocsProp {
  return {
    name,
    attr: name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
    type: 'string',
    complexType: { original: 'string', resolved: 'string', references: {} },
    mutable: false,
    reflectToAttr: false,
    docs: '',
    docsTags: [],
    values: [{ type: 'string' }],
    optional: true,
    required: false,
    getter: false,
    setter: false,
    ...extra,
  };
}

function component(tag: string, extra: Partial<JsonDocsComponent> = {}): JsonDocsComponent {
  return {
    filePath: `src/${tag}.tsx`,
    encapsulation: 'shadow',
    tag,
    readme: '',
    docs: '',
    docsTags: [],
    usage: {},
    props: [],
    methods: [],
    events: [],
    listeners: [],
    styles: [],
    slots: [],
    parts: [],
    states: [],
    dependents: [],
    dependencies: [],
    dependencyGraph: {},
    ...extra,
  };
}

function model(c: JsonDocsComponent, source = FORM_SOURCE, options = {}) {
  const warnings: Warning[] = [];
  const built = buildModel(c, resolveOptions({ outDir: 'out', tagPrefix: 'x-', ...options }), () => source, (message) => warnings.push({ tag: c.tag, message }));

  return { built, warnings: warnings.map((w) => w.message) };
}

test('@formBuilder maps Rails methods to the component, with props', () => {
  const { built, warnings } = model(
    component('x-field', {
      docsTags: [
        { name: 'formBuilder', text: 'text_field' },
        { name: 'formBuilder', text: 'email_field {"type":"email"}' },
        { name: 'formBuilder', text: 'bad field' },
      ],
    }),
  );

  assert.deepEqual(built.formBuilder, [
    { method: 'text_field', props: {} },
    { method: 'email_field', props: { type: 'email' } },
  ]);
  assert.match(warnings.join('\n'), /@formBuilder bad field/);
});

test('@formValue, @formLabel and @formError name the form field props', () => {
  const props = [
    prop('current', { docsTags: [{ name: 'formValue' }] }),
    prop('caption', { docsTags: [{ name: 'formLabel' }] }),
    prop('problem', { docsTags: [{ name: 'formError' }] }),
    prop('label'),
  ];

  const { built } = model(component('x-field', { props }));

  assert.deepEqual(built.formField, { value: 'current', label: 'caption', error: 'problem' });
});

test('a boolean @formValue is the checked prop', () => {
  const props = [prop('on', { type: 'boolean', values: [{ type: 'boolean' }], docsTags: [{ name: 'formValue' }] }), prop('value')];
  const { built } = model(component('x-field', { props }));

  assert.deepEqual(built.formField, { checked: 'on', checkedValue: 'value' });
});

test('without tags, value, checked, label and error are found by name', () => {
  const { built } = model(component('x-field', { props: [prop('value'), prop('label'), prop('error')] }));

  assert.deepEqual(built.formField, { value: 'value', label: 'label', error: 'error' });
});

test('@reactive makes a prop follow server state; reactiveProps still wins', () => {
  const c = component('x-field', { props: [prop('hint', { docsTags: [{ name: 'reactive' }] })] });

  assert.equal(model(c).built.props[0].reactive, true);
  assert.equal(model(c, FORM_SOURCE, { reactiveProps: { 'x-field': [] } }).built.props[0].reactive, false);
});

test('@rubyKey renames the Ruby side; the aliases option wins', () => {
  const c = component('x-tag', { docsTags: [{ name: 'rubyKey', text: 'badge' }] });

  assert.equal(model(c).built.className, 'BadgeComponent');
  assert.equal(model(c, '', { aliases: { 'x-tag': 'chip' } }).built.className, 'ChipComponent');
});

test('@assetWith and dependencies are kept for the asset manifest', () => {
  const c = component('x-tabs', { docsTags: [{ name: 'assetWith', text: 'x-tab x-tab-panel' }], dependencies: ['x-icon', 'x-button'] });
  const { built } = model(c, '');

  assert.deepEqual(built.assetWith, ['x-tab', 'x-tab-panel']);
  assert.deepEqual(built.dependencies, ['x-button', 'x-icon']);
});

test('an unknown @form… or @ruby… tag warns', () => {
  const c = component('x-field', { docsTags: [{ name: 'formBuildr', text: 'text_field' }], props: [prop('value', { docsTags: [{ name: 'rubyKey' }] })] });
  const { warnings } = model(c);

  assert.match(warnings.join('\n'), /unknown JSDoc tag @formBuildr on <x-field>/);
  assert.match(warnings.join('\n'), /unknown JSDoc tag @rubyKey on prop `value`/);
});

test('@rubyIgnore leaves the component out', () => {
  const docs: JsonDocs = { timestamp: '', compiler: { name: '', version: '', typescriptVersion: '' }, components: [component('x-a'), component('x-b', { docsTags: [{ name: 'rubyIgnore' }] })] };
  const { components } = generate(docs, { outDir: 'out', tagPrefix: 'x-' });

  assert.deepEqual(
    components.map((c) => c.tag),
    ['x-a'],
  );
});

test('the loader registry maps each tag to its entry chunk', () => {
  const loader = `import{p as e,b as a}from"./p-Core.js";export{s as setNonce}from"./p-Core.js";a(JSON.parse('[["p-aa11",[[257,"x-tabs",{}],[1,"x-tab",{"label":[1]}]]],["p-bb22",[[0,"x-it\\'s",{}]]]]'))`;

  assert.deepEqual(parseRegistry(loader), { 'x-tabs': 'p-aa11.entry.js', 'x-tab': 'p-aa11.entry.js', "x-it's": 'p-bb22.entry.js' });
  assert.deepEqual(staticImports(loader), ['p-Core.js']);
});

test('static imports in each form, and no dynamic ones', () => {
  const source = 'import{r as s}from"./p-A.js";import"./p-B.js";import*as m from"./p-C.js";export{x}from"./p-D.js";const l=()=>import("./p-E.js");';

  assert.deepEqual(staticImports(source), ['p-A.js', 'p-B.js', 'p-C.js', 'p-D.js']);
});

test('a tag needs its entry, its imports and its dependencies, without the loader files', async () => {
  const files = new Map(Object.entries({
    'x.esm.js': `import"./p-Core.js";a(JSON.parse('[["p-tabs",[[1,"x-tabs",{}]]],["p-tab",[[1,"x-tab",{}]]],["p-btn",[[1,"x-button",{}]]]]'))`,
    'p-Core.js': '',
    'p-tabs.entry.js': 'import"./p-Core.js";import"./p-Shared.js";',
    'p-tab.entry.js': 'import"./p-Shared.js";',
    'p-btn.entry.js': 'import"./p-Core.js";import"./p-Icon.js";',
    'p-Shared.js': 'import"./p-Util.js";',
    'p-Util.js': '',
    'p-Icon.js': '',
  }));

  const build = await readLazyBuild('x.esm.js', async (file) => files.get(file));

  assert.ok(build);

  const tabs = model(component('x-tabs', { dependencies: ['x-button'], docsTags: [{ name: 'assetWith', text: 'x-tab' }] }), '').built;
  const result = assetFiles([tabs, model(component('x-tab'), '').built, model(component('x-button'), '').built], build);

  assert.deepEqual(result['x-tabs'], ['p-tabs.entry.js', 'p-Shared.js', 'p-Util.js', 'p-btn.entry.js', 'p-Icon.js', 'p-tab.entry.js']);
  assert.deepEqual(result['x-tab'], ['p-tab.entry.js', 'p-Shared.js', 'p-Util.js']);
});

const library = (): JsonDocs => ({
  timestamp: '',
  compiler: { name: '', version: '', typescriptVersion: '' },
  components: [
    component('x-badge', {
      props: [prop('size', { type: '"small" | "large"', values: [{ type: 'string', value: 'small' }, { type: 'string', value: 'large' }] }), prop('label', { required: true })],
      slots: [{ name: 'icon', docs: '' }],
    }),
    component('x-field', { props: [prop('value'), prop('label')], events: [], docsTags: [{ name: 'formBuilder', text: 'text_field' }] }),
  ],
});

test('a test suite is generated: one test per component, the library tests and the framework test', () => {
  const { files } = generate(library(), { outDir: 'out', tagPrefix: 'x-', rubyNamespace: 'Acme::Ui' }, () => FORM_SOURCE);
  const tests = [...files.keys()].filter((path) => path.startsWith('test/') || path === 'Rakefile').sort();

  assert.deepEqual(tests, [
    'Rakefile',
    'test/all.rb',
    'test/assets_test.rb',
    'test/base_component_test.rb',
    'test/components/acme/ui/badge_component_test.rb',
    'test/components/acme/ui/field_component_test.rb',
    'test/config_test.rb',
    'test/engine_test.rb',
    'test/form_builder_test.rb',
    'test/helpers_test.rb',
    'test/line_coverage.rb',
    'test/test_helper.rb',
  ]);
  assert.match(files.get('test/line_coverage.rb') ?? '', /THRESHOLD = 85\n/);
});

test('a component test checks each prop by its kind, with a value for each required prop', () => {
  const { files } = generate(library(), { outDir: 'out', tagPrefix: 'x-', rubyNamespace: 'Acme::Ui', slotWrapper: 'span' }, () => FORM_SOURCE);
  const badge = files.get('test/components/acme/ui/badge_component_test.rb') ?? '';

  assert.match(badge, /class BadgeComponentTest < ComponentTestCase/);
  assert.match(badge, /def required_props\n {8}\{label: "x"\}/);
  assert.match(badge, /assert_enum_prop :size, "size", %w\[small large\]/);
  assert.match(badge, /assert_string_prop :label, "label"/);
  assert.match(badge, /assert_slot :icon, "icon", wrapper: :span/);
  assert.match(badge, /assert_configured_default :size, "size", "small"/);
  // The partial flavor is Rails'.
  assert.match(badge, /def test_partial/);
});

test('each framework gets its own adapter test, and tests: false generates none', () => {
  const paths = (options: Partial<Parameters<typeof generate>[1]>) => [...generate(library(), { outDir: 'out', tagPrefix: 'x-', ...options }, () => FORM_SOURCE).files.keys()];

  assert.ok(paths({ framework: 'sinatra' }).includes('test/sinatra_test.rb'));
  assert.ok(paths({ framework: 'bridgetown' }).includes('test/bridgetown_test.rb'));
  assert.ok(!paths({ framework: 'sinatra' }).includes('test/engine_test.rb'));
  assert.deepEqual(
    paths({ tests: false }).filter((path) => path.startsWith('test/') || path === 'Rakefile'),
    [],
  );

  const sinatra = generate(library(), { outDir: 'out', tagPrefix: 'x-', framework: 'sinatra', coverageThreshold: 90 }, () => FORM_SOURCE).files;

  assert.match(sinatra.get('test/line_coverage.rb') ?? '', /THRESHOLD = 90\n/);
  assert.doesNotMatch(sinatra.get('test/components/elements/badge_component_test.rb') ?? '', /def test_partial/);
});

test("a gem named after its namespace and framework keeps its entry point: the adapter moves aside", () => {
  const { files } = generate(library(), { outDir: 'out', tagPrefix: 'x-', rubyNamespace: 'Acme::Ui', framework: 'sinatra', gem: { name: 'acme-ui-sinatra' } });

  assert.match(files.get('lib/acme/ui/sinatra.rb') ?? '', /require "acme\/ui\/sinatra_adapter"/);
  assert.match(files.get('lib/acme/ui/sinatra_adapter.rb') ?? '', /module Sinatra/);
});

test('assets.source and assets.localPath set where the head helper loads from by default', () => {
  const files = (assets: Parameters<typeof generate>[1]['assets']) => generate(library(), { outDir: 'out', tagPrefix: 'x-', configKey: 'x_elements', assets }).files;
  const helper = (assets: Parameters<typeof generate>[1]['assets']) => files(assets).get('lib/elements/bundle_helper.rb') ?? '';
  const config = (assets: Parameters<typeof generate>[1]['assets']) => files(assets).get('lib/elements/configuration.rb') ?? '';

  assert.match(helper({}), /LOCAL_URL = "\/x_elements"/);
  assert.match(config({}), /@source = :cdn/);
  assert.match(config({ source: 'local' }), /@source = :local/);
  assert.match(helper({ source: 'local', localPath: '/vendor/x/%<version>s', cdnUrl: 'https://cdn.example/x' }), /CDN_URL = "https:\/\/cdn\.example\/x"\n\s+LOCAL_URL = "\/vendor\/x\/%<version>s"/);
});

test('only the Rails gem tracks its assets for Turbo', () => {
  const helper = (framework: 'rails' | 'sinatra') => generate(library(), { outDir: 'out', tagPrefix: 'x-', framework }).files.get('lib/elements/bundle_helper.rb') ?? '';

  assert.match(helper('rails'), /defined\?\(::Turbo\) \? \{"data-turbo-track": "reload"\}/);
  assert.doesNotMatch(helper('sinatra'), /turbo/i);
});

test("the build's digest covers the loader and the stylesheet, and goes into the manifest", async () => {
  const read = (css: string) => async (file: string) => ({ 'x.esm.js': `a(JSON.parse('[["p-a",[[1,"x-badge",{}]]]]'))`, 'p-a.entry.js': '', 'x.css': css })[file];
  const one = await readLazyBuild('x.esm.js', read('a{}'), 'x.css');
  const two = await readLazyBuild('x.esm.js', read('b{}'), 'x.css');

  assert.match(one?.digest ?? '', /^[0-9a-f]{12}$/);
  assert.notEqual(one?.digest, two?.digest);
  assert.equal(one?.digest, (await readLazyBuild('x.esm.js', read('a{}'), 'x.css'))?.digest);

  const manifest = generate(library(), { outDir: 'out', tagPrefix: 'x-' }, undefined, one).files.get('lib/elements/manifest.json') ?? '';

  assert.equal(JSON.parse(manifest).assets.digest, one?.digest);
});

test('names come from the library when the options leave them out', () => {
  assert.equal(commonTagPrefix(['my-button', 'my-input', 'my-icon-set']), 'my-');
  assert.equal(commonTagPrefix(['my-button', 'your-input']), '');
  assert.equal(commonTagPrefix(['my-button']), '');

  const scoped = resolveOptions({ outDir: 'out', npmPackage: '@my/elements', tagPrefix: 'my-' });

  assert.deepEqual([scoped.rubyNamespace, scoped.helperPrefix, scoped.configKey, scoped.gem.name], ['My::Elements', 'my_', 'my_elements', 'my-elements']);

  const bare = resolveOptions({ outDir: 'out' });

  assert.deepEqual([bare.rubyNamespace, bare.helperPrefix, bare.configKey, bare.tagPrefix], ['Elements', 'elements_', 'elements', '']);

  // generate() finds the prefix the tags share.
  const { components } = generate(library(), { outDir: 'out' });

  assert.deepEqual(components.map((c) => [c.className, c.helper]), [['BadgeComponent', 'x_badge'], ['FieldComponent', 'x_field']]);
});

test('nothing generated names another library', () => {
  const { files } = generate(library(), { outDir: 'out', npmPackage: '@my/elements' }, () => FORM_SOURCE);

  for (const [path, content] of files) assert.doesNotMatch(`${path}\n${content}`, /midwest/i, path);
  assert.match(files.get('app/components/my/elements/base_component.rb') ?? '', /# Generated by stencil-ruby-output-target\. Do not edit\./);
  assert.ok(files.has('app/javascript/my/elements/stencil-bridge.ts'));
});
