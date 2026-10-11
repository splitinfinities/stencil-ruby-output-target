# stencil-ruby-output-target

A [Stencil](https://stenciljs.com) output target that generates a Ruby gem from your web components: one **ViewComponent** per element, a view helper for each, a **FormBuilder** for your form controls, the head tags that load (and preload) the elements, RBS signatures, and a test suite for all of it. One gem per framework: **Rails**, **Sinatra** or **Bridgetown**.

The server renders `<my-button variant="outline">` with every attribute already set, and the element upgrades in the browser from your npm package. The Ruby side is generated from the components' own metadata, so it can't drift from them.

```erb
<%= my_element_button(variant: :outline, size: :small, href: "/users/new") { "New user" } %>

<%= my_elements_form_with model: @user do |f| %>
  <%= f.email_field :email %>   <%# <my-input type="email" name="user[email]" label="Email" …> %>
  <%= f.submit %>
<% end %>
```

The examples below use a library whose tags start with `my-`, generated into `My::Elements` with helpers named `my_element_*`. All of those names are options.

## Setup

```ts
// stencil.config.ts
import { rubyOutputTarget } from 'stencil-ruby-output-target';

export const config = {
  outputTargets: [
    { type: 'dist' },
    { type: 'docs-json', file: 'docs/documentation.json' },
    rubyOutputTarget({
      framework: 'rails',
      outDir: '../ruby/my-elements',
      gem: { name: 'my-elements', authors: ['You'] },
      rubyNamespace: 'My::Elements',
      helperPrefix: 'my_element_',
      tagPrefix: 'my-',
    }),
  ],
};
```

A library that supports several frameworks adds one `rubyOutputTarget()` per framework, each with its own `outDir` and gem name. The names are derived from your library when you leave them out (see [Options](#options)).

The target runs after Stencil's lazy build, in the same build. To generate without a Stencil build, from an existing `docs-json` file, use the CLI:

```sh
# One package:
node src/cli.ts --docs <package>/docs/documentation.json --root <package> --out /tmp/gem

# Several packages into one gem:
node src/cli.ts --package <package> --package <another> --out /tmp/gem

# The targets a config file declares (its default export is a list of options), all or one:
node src/cli.ts --package <package> --config <package>/ruby.config.ts [--framework sinatra] [--out /tmp/gems]
```

It needs Node 22.18 or newer. Templates are validated with [Herb](https://herb-tools.dev) when `@herb-tools/node-wasm` or `@herb-tools/node` is installed.

## What it generates

For the Rails target (Sinatra and Bridgetown leave out the engine, previews, partials and bridge, and add their adapter):

```
my-elements.gemspec                                   # from the gem options
Rakefile                                              # rake test
lib/my/elements.rb                                    # the entry point
lib/my/elements/{version,configuration,assets,bundle_helper,form_helper,engine}.rb
lib/my/elements/manifest.json                         # components, the files each needs, token names
app/components/my/elements/base_component.rb          # the prop and event DSL, validation, attribute rules
app/components/my/elements/button_component.rb        # one class per element
app/components/my/elements/button_component.html.erb
app/helpers/my/elements/helpers.rb                    # my_element_button(...)
app/helpers/my/elements/form_builder_methods.rb       # f.my_element_input(...), for any Rails builder
app/helpers/my/elements/form_builder.rb               # the FormBuilder class
app/views/my/elements/_button.html.erb                # the partial flavor, for reactive pages
app/javascript/my/elements/{manifest,stencil-bridge}.ts     # the reactive bridge and its manifest
sig/my/elements/*.rbs                                 # RBS for every component, helper and form builder method
previews/my/elements/button_component_preview.rb      # a ViewComponent preview with Lookbook controls
test/                                                 # the gem's own tests
```

Every directory the target writes to holds generated files only: a file there that a run didn't write is removed as stale. The gem's root is the exception, so a hand-written `README.md`, `LICENSE` and lint configs can sit beside the gemspec.

## Using the generated gem

```erb
<%# layout %>
<head><%= my_elements_tags %></head>

<%# a helper per element; props are keywords, anything else goes onto the element %>
<%= my_element_button(size: "small", class: "mt-2", data: {turbo: false}) do |button| %>
  <% button.with_icon_slot { my_element_icon(name: "add") } %>
  Save
<% end %>

<%# or the class %>
<%= render My::Elements::BadgeComponent.new(state: :success) { "Paid" } %>
```

- **Props** are keyword arguments in snake_case (`icon_only:` for `iconOnly`). Enums take strings or symbols.
- **An unknown enum value raises** in development and test, and logs and falls back to the default elsewhere.
- **Named slots** are `with_<slot>` blocks; the default slot is the block.
- **Anything that isn't a prop** (`class:`, `id:`, `data:`, `aria:`) is put on the host element.

## Mapping rules

Everything comes from Stencil's `JsonDocs` (what `docs-json` writes), plus a scan of each component's source for `<slot name>` and `formAssociated`, which the docs don't carry.

### Names

| Stencil | Ruby |
|---|---|
| `my-calendar-date` | `My::Elements::CalendarDateComponent`, `calendar_date_component.rb`, `my_element_calendar_date` |
| `my-360-image` | `Image360Component`: a constant can't start with a digit, and the file is `image360_component.rb` |
| prop `iconOnly` | keyword `icon_only:`, attribute `icon-only` |
| prop `tag`, `for`, `method`, `open`, `options`, … | The keyword is unchanged; the reader is `tag_value` and so on, so it doesn't replace a method the component needs. |
| a slot named like a prop (`icon`) | `renders_one :icon_slot`, with a build warning |

### Props

`BaseComponent` includes [opt_struct](https://github.com/carlzulauf/opt_struct), and each `prop` declares an option with its default. A prop reaches the element in one of three ways:

| Strategy | Which props | Template |
|---|---|---|
| `value` | the model prop (`value` on an input) | `value="<%= value %>"`, always rendered |
| `optional` | every other prop with an attribute | `<% if attribute?(:size) %> size="<%= attribute_value(:size) %>"<% end %>`, rendered only when the caller passes it |
| `property` | props with no attribute (objects, arrays) | JSON in `data-stencil-props`, which the bridge assigns as properties |

- **An attribute the caller didn't give isn't written**, even when the prop has a default. Components often treat "no attribute" differently from the default written out.
- **Booleans are present or absent**, never `"false"`: a form-associated element reads any value as true. A boolean that defaults to true is the exception, since `"false"` is the only way to turn it off.
- **A default that isn't a literal** (`new Date().toISOString()`) becomes `nil`, with a build warning.
- **A default on a credential-looking prop** (`apikey`, `token`, `secret`, …) is never copied into Ruby.
- **Function props are skipped**, with a build warning.
- **A list given to a `string | string[]` prop** goes into the attribute as JSON and into `data-stencil-props`.

### Slots

- The default slot is `content`.
- A named slot is `renders_one :name`. The template sets `slot="name"` on each top-level element of the caller's content, so the element is assigned what the caller wrote. Bare text gets a `<span slot="name" style="display: contents">`.
- `slotWrapper: 'span'` wraps all of a slot's content in one such span instead; `'none'` leaves the attribute to the caller.
- `slots: { 'my-tabs': { '': { many: true } } }` gives `renders_many`.

### Events and two-way binding

Every `@Event()` is recorded on the class (`event :confirmed, dom: "confirmed"`). A component with a `value` prop and an `update`, `change`, `input` or `valueChange` event has a model binding, which `models` can set or turn off per tag. See [Reactive pages](#reactive-pages) for what `bind:` and `state:` do with it.

## Options

| Option | Default | |
|---|---|---|
| `outDir` | required | The gem's directory. |
| `framework` | `'rails'` | `'rails'`, `'sinatra'` or `'bridgetown'`. |
| `gem` | named after the namespace | `name`, `summary`, `description`, `authors`, `homepage`, `license`, `sourcePath`, `changelogUri`, `requiredRubyVersion`, `extraFiles`. |
| `rubyNamespace` | from the npm package's name (`@my/elements` is `My::Elements`) | The module the classes live in. |
| `tagPrefix` | the prefix every tag shares (`my-`), if there is one | Stripped from a tag to name its class. |
| `helperPrefix` | the tag prefix, snake-cased (`my_`) | `my_element_` gives `my_element_button`. |
| `configKey` | the namespace, snake-cased (`my_elements`) | Names `config.<key>` (Rails), `set :<key>` (Sinatra), `<key>_tags`, `<key>_form_with`. |
| `npmPackage`, `version` | the Stencil package's `package.json` | The npm package the elements come from. The gem takes the same version. |
| `assets` | from the `dist` output target | Where the elements' files are; see [Loading the elements](#loading-the-elements). |
| `tokens` | none (any name goes) | The design tokens `config.tokens` accepts: stylesheets whose `--name:` declarations are the tokens, or JSON (an array of names, or an object keyed by them). |
| `formBuilder` | `{}` | `fields` and `errorsSummary`; see [Forms](#forms). |
| `aliases` | `{}` | Rename a component's Ruby side by tag: `{ 'my-tag': 'badge' }`. |
| `excludeComponents` | `[]` | Tags to skip. |
| `models` | detected | The two-way binding per tag, or `false`. |
| `reactiveProps` | detected | Props that follow server state on a reactive page, per tag. |
| `slots`, `slotWrapper` | `{}`, `'attribute'` | See [Slots](#slots). |
| `validateWithHerb` | `true` | Parse every template with Herb when it's installed. |
| `tests`, `coverageThreshold` | `true`, `85` | See [The generated tests](#the-generated-tests). |
| `legacy` | none | `{ gemName, require, constant }`: a deprecated entry point and alias constant, for a gem that was renamed. |

### Settings on the component

Where it can, configuration comes from the component. `formAssociated: true` in `@Component` gives a component its form field and FormBuilder method. The rest are JSDoc tags, which `docs-json` passes through. The options above win over them.

| Tag | On | Means |
|---|---|---|
| `@formBuilder <rails_method> [props JSON]` | component, repeatable | Rails' `f.<rails_method>` renders it with those props: `@formBuilder email_field {"type":"email"}`. |
| `@formChoices <tag>` | component | `f.select`'s choices render as these elements. |
| `@formValue`, `@formLabel`, `@formError` | prop | The prop holding the field's value (a boolean is the checked state), its label, its error. By default `value` or `checked`, `label` and `error`, by name. |
| `@reactive` | prop | Follows server state in the partial flavor, like `reactiveProps`. |
| `@rubyKey <key>` | component | Its Ruby key, class and helper, like `aliases`. |
| `@rubyIgnore` | component | Skip it, like `excludeComponents`. |
| `@assetWith <tag> …` | component | Preload these with it, such as the children its slots expect. |

A `@form…` or `@ruby…` tag the generator doesn't know is a build warning.

## Loading the elements

`<key>_tags` in the layout's `<head>` writes the global stylesheet, the lazy loader, the configured design tokens and, with `config.assets.async`, a preload for each file the page's elements need.

### Where the files come from

The `assets` option sets the default; an app can change it.

| `assets` option | Default | |
|---|---|---|
| `source` | `'cdn'` | `'cdn'` or `'local'`: what the gem loads from unless the app says otherwise. |
| `cdnUrl` | jsDelivr: `https://cdn.jsdelivr.net/npm/<package>@%<version>s/<lazy dir>` | Any CDN or host. `%<version>s` is the npm version. |
| `localPath` | `/<configKey>` | The URL the app serves its own copy at. `%<version>s` works here too. |
| `lazyDir`, `loader`, `stylesheet` | read from the build | The lazy build's directory and its two entry files. |

In the app:

```ruby
My::Elements.configure do |config|
  config.assets.source = :local          # or :cdn
  config.assets.bundle_url = "https://assets.example.com/my-elements"   # any other URL; wins over source
end
```

For `:local`, serve the npm package's lazy build at `localPath`. Install the package (from the registry, a tarball or a local folder) and copy or link its lazy directory into the app's public directory:

```sh
npm install @my/elements            # or: npm install ../path/to/the/package
ln -s ../node_modules/@my/elements/dist/elements public/my_elements
```

The files can't go through an asset pipeline that renames them: the chunks import each other by file name.

### Caching

Every chunk's name is a hash of its content. The loader and the global stylesheet have fixed names, so their URLs get the build's digest as a query (`elements.esm.js?v=3f9a…`) unless the URL already contains the version, as the default CDN URL does. A new build is then a new URL.

In a Rails app with Turbo, the stylesheet and the loader are also marked `data-turbo-track="reload"`, so a page visited after a deploy that changed them reloads instead of keeping the old ones.

### Async assets

Stencil's lazy build has no per-component CSS: each component's styles are compiled into its JavaScript chunk. The generator reads the loader's tag registry and each chunk's static imports into `manifest.json`, which gives every element the files it needs in load order.

With `config.assets.async = true`, each component records its tag as it renders, and the head helper writes:

```html
<link rel="stylesheet" href="/my_elements/elements.css?v=3f9a…">
<link rel="modulepreload" href="/my_elements/p-e7399b6f.entry.js">   <!-- an element the page rendered -->
<script type="module" src="/my_elements/elements.esm.js?v=3f9a…"></script>
<link rel="prefetch" as="script" href="/my_elements/p-0a1b2c3d.entry.js">  <!-- config.assets.preload -->
<style>:root{--radius-md:6px}</style>
```

- **`config.assets.always`** lists components preloaded on every page; **`config.assets.preload`** lists ones prefetched for later pages.
- **The head must render after the body**, which Rails, Sinatra and Bridgetown layouts all do. An element rendered after the head logs a warning in development.
- **Nothing depends on the preloads**: the loader fetches whatever wasn't preloaded.

## The config object

```ruby
My::Elements.configure do |config|
  config.tokens["--radius-md"] = "6px"               # design tokens, written by the head helper as one <style>
  config.token :radius_md, "6px"                     # the same
  config.token_selector = ":root"
  config.defaults[:button] = {variant: :outline}     # a prop's value when the caller doesn't pass it
  config.assets.source = :cdn
  config.assets.async = true
  config.assets.always = %i[layout]
  config.assets.preload = %i[dialog]
  config.form_builder = true                         # Rails: f.my_element_* on every builder; :default makes the gem's the default
  config.errors_summary_heading = "%{count} %{errors} prohibited this %{model} from being saved:"
end
```

Unknown tokens, components, props and enum values raise in development and test, and are logged and ignored elsewhere. The same settings come in as a hash where a framework has one: `config.my_elements.*` in a Rails app's `config/application.rb`, `set :my_elements, {...}` in Sinatra, and `init`'s keywords in Bridgetown.

## Forms

Every form-associated element gets a method on any Rails form builder:

```erb
<%= form_with model: @user do |f| %>
  <%= f.my_element_input :email, type: "email" %>
  <%= f.my_element_switch :newsletter %>
<% end %>
```

Unless the caller passes them, the method derives:

| Option | From |
|---|---|
| `name`, `id` | `form.field_name(attribute)`, `form.field_id(attribute)` |
| the value | The object's value: strings and numbers as they are, dates and times in the format the field reads, lists as JSON. |
| the checked state | For a control with a checked prop: Rails' `check_box` and `radio_button` rules. |
| the error | The attribute's first full error message. |
| the label | `human_attribute_name(attribute)` |
| `required` | An unconditional presence validator on the attribute. |

The generated `FormBuilder` class goes further. It renders a component for each Rails field method a component claims (`@formBuilder`, or the `formBuilder.fields` option), with Rails' own signature, and keeps Rails' methods as `rails_<name>`:

```erb
<%= my_elements_form_with model: @user do |f| %>
  <%= f.errors_summary %>
  <%= f.email_field :email %>
  <%= f.select :plan, [["Free", "free"], ["Pro", "pro"]] %>
  <%= f.rails_text_field :nickname %>
  <%= f.submit %>
<% end %>
```

- **`f.errors_summary`** renders the object's errors in the `formBuilder.errorsSummary` component, when that option names one.
- **Each form control also gets a short name** (`f.switch`) where Rails has no method of that name.
- **In Rails**, `config.form_builder = :default` makes the class every form's builder, and `false` keeps the methods off Rails' own builder.

## Frameworks

| | Rails | Sinatra | Bridgetown |
|---|---|---|---|
| Set up | nothing: the engine loads itself | `register My::Elements::Sinatra` | `init :"my-elements-bridgetown"` in `config/initializers.rb` |
| Settings | `config.my_elements.*`, or the configure block | `set :my_elements, {...}` | `init`'s keywords |
| Extras | Lookbook previews, the partial flavor, the reactive bridge | CSRF tokens from `Rack::Protection` | none |

Outside Rails, components render through a private ActionView view, so the gems need `actionview` and `activesupport` but not `railties`. The gemspec pins `view_component` to `>= 4.15, < 5` there, because the adapter overrides one of its private methods.

### Sinatra

```ruby
require "my/elements/sinatra"

class App < Sinatra::Base
  enable :sessions
  use Rack::Protection::AuthenticityToken          # CSRF tokens in the forms
  register My::Elements::Sinatra
  set :my_elements, {assets: {source: :local, async: true}}

  get("/") { erb :index }
end
```

`register` sets ERB to Erubi's `CaptureBlockEngine` (block helpers need it), adds the helpers and `render` for components, and resets the asset registry before each request.

### Bridgetown

```ruby
# config/initializers.rb
Bridgetown.configure do |config|
  init :"my-elements-bridgetown", assets: {source: :local, async: true}
end
```

A component rendered from a Bridgetown template captures the caller's block and each slot's block in Bridgetown's engine, then renders through the gem's own view. A slot block that takes arguments can't be captured ahead like that: pass its content as a string. Forms have no CSRF token.

## The generated tests

Each gem gets a Minitest suite in `test/` (not shipped in the gem), generated from the same model as the code:

| File | Checks |
|---|---|
| `test/components/…/<name>_component_test.rb` | One per component: what each prop and slot puts on the element, its defaults, events, bindings, form field and (in Rails) its partial. |
| `test/base_component_test.rb` | `BaseComponent` itself, on components the test declares. |
| `test/config_test.rb`, `assets_test.rb`, `helpers_test.rb` | The config object, the asset registry and manifest, a helper per component and the head tags. |
| `test/form_builder_test.rb` | Every FormBuilder method. Only when the library has form controls. |
| `test/engine_test.rb`, `sinatra_test.rb` or `bridgetown_test.rb` | The framework's adapter, through a real app, request or site build. |

Run them from the gem's directory, in a bundle with the gem's dependencies, `minitest` and `activemodel` (plus `rails` for the Rails gem and `rack-test` for Sinatra's):

```sh
ruby -Itest test/all.rb       # everything, and the coverage threshold (or: rake test)
ruby -Itest test/components/my/elements/button_component_test.rb
```

`test/line_coverage.rb` measures line coverage with Ruby's own `Coverage` library: every `.rb` file under `app/` and `lib/`, loaded or not. `test/all.rb` fails when the total or `app/components` is below `coverageThreshold`. It also reports how many templates were rendered, and writes `coverage/coverage.json`.

## Reactive pages

The Rails gem works with [ReActionView](https://reactionview.dev), Herb's reactive runtime, which rewrites single attributes in place on a server reply instead of replacing markup. The element stays mounted, so focus and its own state survive.

For that, use the **partial flavor** inside a reactive template:

```erb
<%= render "my/elements/input", value: @query, bind: :query, label: "Search" %>
```

Herb follows `@query` through a partial's locals and rewrites `value="…"` in place. It treats a ViewComponent call as one opaque expression, so the same reply would replace the whole element. The partial takes the same keywords as the component; named slots are locals, and the default slot is the block or the `content:` local.

- **`bind: :query`** writes the server state `query` on the model event (`data-stencil-set="update->query"`).
- **`state: :draft`** writes a client-declared state with no request. An element with a prop named `state` takes this as `client_state:`.
- **Only the model prop follows server state by default**, plus the props in `reactiveProps`. The default set is the form controls' `label`, `description`, `error`, `disabled`, `required` and `readonly`, and reflected `state` or `status` enums.
- **A reactive boolean** can't be an always-present attribute, so it's also listed in `data-stencil-attributes`, and the bridge adds or removes it.
- **A partial rendered with a block doesn't survive a reply** in Herb 0.11: pass `content:` instead.

The bridge (`app/javascript/…/stencil-bridge.ts`) registers the `data-stencil-*` attributes as Herb behaviors. Without ReActionView, `startStencilBridge()` falls back to a `MutationObserver`: it still assigns property payloads, and re-dispatches bindings as `stencil:bind` events for Stimulus or anything else.

## What your Stencil components need

- **`hydratedFlag: { selector: 'attribute', name: 'hydrated' }`** in the Stencil config, for reactive pages. The default is a class, which a rewrite of the host's `class` attribute would drop.
- **`formAssociated: true`** (with `@AttachInternals`) on form controls, so their values reach `FormData`.
- **`@slot` JSDoc** on components, so slot docs reach Ruby. Undocumented slots are still found by the source scan.
- **Props the component doesn't write to.** A `mutable` prop is never made reactive, because the server can't own it.

## Limitations

- **The data attributes and bridge names are fixed**: `data-stencil-props`, `data-stencil-set`, `data-stencil-state`, `data-stencil-attributes`, `stencil-bridge.ts`, `startStencilBridge()` and the `stencil:bind` event are the same for every library.
- **Components without shadow DOM duplicate their content when cloned.** Turbo's page cache clones the page, and a restored non-shadow component renders again beside its cloned children. Use shadow DOM, or opt those pages out of Turbo's cache.
- **A gem named after its namespace and framework** (`my-elements-sinatra` with `My::Elements`) has its entry point where the adapter would go, so the adapter is written to `lib/my/elements/sinatra_adapter.rb`. The module is `My::Elements::Sinatra` either way.

## Development

```sh
pnpm install
pnpm test        # the generator's tests
pnpm typecheck
pnpm build       # dist/index.cjs, which Stencil's config loader requires
```

The source runs on Node with no build step (type stripping): imports carry `.ts` extensions and only erasable TypeScript syntax is used.

## License

MIT
