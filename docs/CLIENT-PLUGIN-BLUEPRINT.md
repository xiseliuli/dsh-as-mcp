# Third-party DSH client plugin: settings-section blueprint

Target: DSH harness **0.1.5-rc.1** (DSH Desktop 2.0.9). Authoritative source tree read:
`/Users/xiseliuli/test_code/dsh-harness-015`. Every claim below is labelled **[V]** (verified by
reading source or by an installed artifact on this machine) or **[I]** (inferred).

Scope: a **third-party** (non-monorepo) npm package that contributes a **new section to the
settings panel**. No code was changed to produce this document.

---

## 0. The two halves of one package

A DSH plugin package can carry a **host half** and a **browser half** behind one manifest. **[V]**

| Face | Entry | Selected by |
| --- | --- | --- |
| Host | `exports["."]` → `src/index.ts` → `apply(ctx, config)` | the profile loader row |
| Client | `exports["./client"]` → e.g. `src/client.js` | `package.json` → `dsh.client` |

The client half is **not** imported by the host half. The host scans `dsh.client` out of every
loader row and turns it into a browser boot-graph row; the browser then fetches that row's
bundle and runs it as an ordinary Cordis plugin. **[V]** —
`packages/client/modules/src/index.ts:761` (row admission), `packages/client/web/src/boot.ts:124-135`
(`manifest.plugins.map(row => row.id)` → `loader.create({name})` → `loader.await()`).

The single best precedent is a **real installed third-party plugin on this machine**:
`~/.dsh/profiles/desktop/node_modules/dsh-tokenledger` — it declares `dsh.client`, ships a
**hand-written, build-step-free** `src/client.js`, and mounts a UI seat. Its own header comment
states the design rule directly: *"A hand-written `__ModuleLoader__` bundle. There is deliberately
no build step … no JSX syntax — the runtime's `jsx`/`jsxs` are called directly."* **[V]**

---

## 1. Contributing a `settings.section` entry

### 1.1 Declaration vs registration — you only register

`settings.section` is **declared** (declaration = kind + scope + owner props + authorization) by
the shell itself, as one `children` entry of its `sidebar.settings` registration. **[V]** —
`packages/client/ui-settings-general/src/client/index.ts:147-158`:

```ts
ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
  name: 'sidebar.settings', locale: NS,
  children: {
    'settings.trigger':    { kind: 'single', scope: 'root' },
    'settings.header':     { kind: 'single', scope: 'root' },
    'settings.action':     { kind: 'list',   scope: 'root' },
    'settings.close':      { kind: 'single', scope: 'root' },
    'settings.section':    { kind: 'list',   scope: 'root' },   // ← this
    'settings.onboarding': { kind: 'list',   scope: 'root' },
  },
  inject: shellInjected,
}, SettingsRoot))
```

You **register into** that declared list slot. The shipped sections all do exactly this — e.g.
`packages/client/ui-agent-preset/src/client/index.ts:196-203`:

```ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'agent-presets',                                   // the section key (nav identity)
  order: 20,                                             // nav position, ascending
  label: () => ctx.locale.bind('settings.agentPreset')('nav'),  // thunk → follows locale
  locale: 'settings.agentPreset',                        // synthesizes the `t` prop
  inject: sectionInjected,                               // your business face
}, AgentPresetSection))
```

### 1.2 Why `slots.inject` and not bare `register`

`ctx.slots.register` for an **undeclared** key fails; `ctx.slots.inject(key, cb)` runs `cb` while
the declaration is live and re-runs it if a late/re-declared owner appears, via the caller's
`ctx.effect` (so your fiber's unload disposes the entry). **[V]** —
`packages/client/ui-renderer/src/client/registry.ts:172-240` (`inject`), `:242-250` (`install`),
`SlotCore.register` at `packages/client/ui-slots/src/index.ts:826`. This is load-order safety, not
style: **use `inject`.** A delayed setup failure retires the injection permanently (no retry).

### 1.3 Nav identity: `id` + `order` + `label`. **There is no icon option.**

The `list` arm of the register options is exactly `{ id, order?, label?, priority? }` **[V]** —
`packages/client/ui-slots/src/index.ts:529-535` (`KindOptions`), stored at `:596-611`
(`StoredEntry.options` = `key/id/order/label/priority`). `label` may be a thunk, resolved at read
time by `resolveSlotLabel` (`:620`).

**IMPOSSIBLE for a third party: choosing your own nav icon.** The shell hardcodes icon-by-id
**[V]** — `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:27-31`:

```ts
function navIcon(id: string) {
  if (id === 'models')        return <IconDataOutline16 … />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 … />
  if (id === 'plugins')       return <IconPersonalizationOutline16 … />
  return <IconSettingsOutline16 … />          // ← every third-party id lands here
}
```

Your section renders with the generic gear. The only way around it is patching the shell.

### 1.4 The `close` prop and mount filtering

The shell mounts exactly one section, filtered by `id`, and passes `{ close }` as owner props
**[V]** — `SettingsRoot.tsx:95`:

```ts
{active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
```

---

## 2. Reading and writing a server settings namespace from the client

### 2.1 The server half (host plane)

Register the namespace on the **host** with a **schemastery** schema **[V]** —
`packages/settings/settings/src/index.ts:419-430`:

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.register('my-plugin', z.object({
    endpoint:  z.string().default(''),
    apiKey:    z.string().role('secret').default(''),
    verbose:   z.boolean().default(false),
  }), { applies: 'live' })          // or 'restart'
})
```

Pattern source: `packages/client/ui-settings-general/src/index.ts:20-26`.

* Namespace names must match `NAMESPACE_PATTERN` (lowercase hyphenated identifier), else
  `TypeError` **[V]** — `settings/src/index.ts:38-43`.
* `settings.register` is an effect on the caller's fiber; duplicate registration fails loud **[V]** —
  `:424-431`.
* `applies: 'live' | 'restart'` is surfaced to the UI **[V]** — `:45-53`.
* `role('secret')` is real schemastery API **[V]** — `@deepseek-ai/schemastery@3.18.4`
  `lib/types/index.d.ts:112` (`role?: string`), `:162`
  (`role(text: string, extra?: any): Schema<S, T, Mode>`).
* **Cost flag:** this makes `@deepseek-ai/schemastery` a genuine host dependency. It is published
  (`3.18.4`) **[V]**, and the installed third-party precedent declares it as
  `peerDependencies: {"@deepseek-ai/schemastery": "^3.18.1"}` **[V]**. There is no
  schemastery-free registration path. `dsh-as-mcp`'s current "zero `@deepseek-ai/*` deps" stance
  is therefore **incompatible with hosting a settings namespace**.

### 2.2 The client half: bind a scope

`ctx.settingsScope` is provided by the `ui-settings` browser plugin. Bind your namespace **[V]** —
`packages/client/ui-settings/src/client/settings-scope.ts:284-290`, `:254` (`super(ctx,'settingsScope')`):

```ts
const scope = ctx.settingsScope.bind<MySettings>({ namespace: 'my-plugin' })
scope.getSnapshot()      // SettingsScopeSnapshot<MySettings>
scope.subscribe(fn)      // synchronous listener
scope.set('verbose', true)
scope.unset('verbose')
scope.mutate([{ op: 'set', path: ['endpoint'], value: '…' }], expectedRevision)
```

Snapshot shape **[V]** — `packages/client/ui-settings/src/client/settings-contract.ts`:

```ts
interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base; user                              // composition / user layers
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'                 // no `secrets` field
}
```

**`inject` requirement:** you need the **service** name `settingsScope` in your bundle's cordis
`inject`. You do **not** need `remote.settings`: `bind()` registers the scope's disposer on the
*caller's* fiber while writes go through the **providing** fiber's `remote.settings`
**[V]** — `settings-scope.ts:221-232` (the `owner` field's doc comment says exactly this),
`:284-290`.

Persistence **[V]** — `packages/client/ui-settings/src/client/index.ts:43`:
`persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`. On a loopback Desktop/`dsh web`
page you get `'host'` and writes are real; otherwise every scope is permanently `unavailable`.

### 2.3 Failure modes you must render, not assume

* **Namespace not registered** (typo, host plugin not loaded) → `status: 'unavailable'`,
  `writable` still set from the envelope **[V]** — `settings-scope.ts:183-189`.
* **Value fails the schema** → `value` keeps its last accepted reading (status is not forced)
  **[V]** — `settings-scope.ts:190-199`, `decode()` at `:202-217`. A returned `undefined` from
  `decode` means "refuse", and the field is left alone.
* Gate your UI on `status === 'ready'`; this is what the shipped `CardForm` reports as
  `CardShell.available` **[V]** — `packages/client/ui-settings-plugins/src/client/card-form.ts`.

### 2.4 Conflicts

Writes carry the latest known revision; a `pendingRevision` fence and a write `generation` guard
keep ordering honest, and a **rejected or failed latest write triggers a recovery re-read** of the
shared mirror **[V]** — `packages/client/ui-settings/src/client/settings-scope.ts` (controller
fields `tail`, `writeGeneration`, `pendingRevision`; `mutate(ops, expectedRevision?)`).
Host side throws `SettingsConflictError` **[V]** — `settings/src/index.ts:154`.

There is **no client-side merge or retry**. Your section must re-plan from the refreshed snapshot
and re-issue the write. Same-document edits from two surfaces are last-writer-wins with a refusal,
not a merge.

### 2.5 `role('secret')` — write-only rendering

Redaction happens **host-side** **[V]** — `packages/settings/settings/src/redact.ts:50-53`:

```ts
if (node.meta?.role === 'secret') { secrets.push({ path, set: value !== undefined }); return undefined }
```

so the value never crosses the wire, and the descriptor carries a sidecar instead **[V]** —
`packages/settings/settings/src/types.ts:21-54`:

```ts
interface SettingsSecretView { path: string[]; set: boolean }
interface SettingsNamespaceView { ns; schema; value; base?; user?; applies; secrets: SettingsSecretView[]; revision }
```

**The bound scope DROPS that sidecar** — `derive()` copies only
`revision/base/user/writable/status/value` **[V]** — `settings-scope.ts:190-199`. So to render a
"key is set / not set" indicator you must read the **raw** mirror **[V]** —
`settings-scope.ts:267-269`:

```ts
const view = ctx.settingsScope.describe().getSnapshot().view
const ns   = view?.namespaces.find(n => n.ns === 'my-plugin')
const isSet = ns?.secrets.find(s => s.path.join('.') === 'apiKey')?.set ?? false
```

Note also the double redaction: the scope's `decode()` may refuse a section whose secret value has
been stripped, so treat "secret present + value refused" as normal, not as corruption. **[I]**

**Design note on writing secrets.** The shipped settings UI deliberately does **not** write
credential literals through the settings document: `card-form.ts` defines
`CardSecretSpec { field, write: (text) => Promise<boolean> }` documented as *"A control whose value
is written **outside** the settings section. A credential literal never rides a response"*, and
`ui-settings-plugins` writes through `remote.credentials` **[V]** —
`packages/client/ui-settings-plugins/src/client/card-form.ts`,
`.../src/client/index.ts:56`. A `role('secret')` field in the settings document *is* writable via
`scope.set()`, but it diverges from the shipped credential path and should be a deliberate choice.

---

## 3. `dsh.client`: exact shape, and the two different `inject`s

### 3.1 Manifest fields

**[V]** — parser `packages/client/modules/src/index.ts:185-207`,
row admission `:761`, type `packages/client/modules/src/client/manifest.ts:50-128`.

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-api-remotes"],
    "external": [],
    "immediately": false
  }
}
```

| Field | Required | Meaning | Valid values |
| --- | --- | --- | --- |
| `platform` | **yes** | Which shell the row serves | **only `"web"`** |
| `inject` | no | **Package names**: module-arrival edges + Cordis entry composition edges | array of package names |
| `external` | no | **Exact specifiers** answered synchronously by the module table from a non-baseline row | array of exact specifiers |
| `immediately` | no | Phase-one prefetch tier | boolean |

* `platform` **must be the string `"web"`. It is the only value that exists** — all 46
  `"platform":` occurrences in packages/manifests are `"web"` **[V]**. Any other value makes the
  row **silently** not a client row (`decl.platform !== 'web'` → `null`, `:761`) — no error, the UI
  simply never appears.
* `parseDshClient` **requires** `platform` to be a string; omitting it throws. **[V]** — `:185-207`.
* Declaring `dsh.client` while `exports["./client"]` is absent **throws** at row admission
  (`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`) **[V]** — `:761`.

### 3.2 The two `inject`s are unrelated — do not conflate them

| | Where | Array of | Consumed by |
| --- | --- | --- | --- |
| **A** | `package.json` → `dsh.client.inject` | **package names** | boot-graph arrival + entry composition |
| **B** | the bundle's `exports.inject` | **Cordis service names** | Cordis fiber inject |

The installed precedent contains **both** and they share no string **[V]** —
`dsh-tokenledger/src/client.js:1542` `const inject = ["slots", "locale"]` (B) versus its manifest
`dsh.client.inject = ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-primitives"]` (A).

**For a settings section, (A) may be omitted entirely.** Your bundle's dependencies are all platform
seed words, and your cross-plugin collaboration is through Cordis services, which (B) governs. (A)
is worth declaring only to express a real package-row ordering edge. Also note: listing a **static
assembly library** (`ui-primitives`, `ui-slots`) in (A) is a **silent no-op** — they are not loader
rows **[V]** — `2026-08-15-client-shells-and-dynamic-packages.md` (table: "Static assembly
libraries … **not Loader entries**"), and arrival skips unknown package rows. The installed
precedent does this harmlessly.

### 3.3 `external` — the only way to request another row's value

Exact, never normalized; a trailing `/client` aliases the package row. **[V]** —
`manifest.ts:50-128` (`stripClientSuffix`), `2026-08-15-…md` ("A request has exactly two suppliers:
1. The dynamic package row it names; a trailing `/client` aliases that package row. 2. An exact key
in the shell's static module table. **There is no general `dsh.client.provide` alias mechanism.**").

Graph composition rejects malformed/missing/self requests and synchronous cycles. **[V]** —
`packages/client/modules/src/index.ts:425-460` (`orderByModuleGraph`).

---

## 4. Props a settings-pane component receives

**[V]** — `packages/client/ui-slots/src/index.ts:222-232`:

```ts
type PropsRuntime<K, EntryKey> =
    OwnerOf<K> & KeyPropsOf<K, EntryKey> & SlotInjectFace<SlotInjectOf<K>>
  & (ScopeOf<K> extends 'session' ? SessionStandardProps : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps : object)
  & GlobalStandardProps
```

For `'settings.section'`, with the declaration at
`packages/client/ui-settings/src/client/contract/slots.ts:14-136`
(`{ kind:'list'; scope:'root'; owner: SettingsSectionOwnerProps }`, and
`SettingsSectionOwnerProps = { close: () => void }`) **[V]**:

| Share | Members | Why |
| --- | --- | --- |
| Owner | `close: () => void` | from the declaration; the shell passes `{close: onClose}` |
| Key props | — | not a `keyed` slot |
| Slot inject face | — | the `settings.section` declaration carries no `inject` member |
| Session kit | — | scope is `'root'` |
| `GlobalStandardProps` | **merged by other packages**, not by ui-slots | declared **empty** at `ui-slots/src/index.ts:209` |
| `PropsLocale<NS>` | `t` | only if your registration names `locale` |
| `InjectFace<YourInjected>` | your `inject: () => ({…})` face | only if you pass `inject` |
| `PropsRenderSlots<…>` | `renderSlot` | only if you declare `children` |

`GlobalStandardProps` merges (compile-time augmentation only — import the type file to see them)
**[V]**: `ui-session/src/client/index.ts:105-110` (`useSessions`,
`useSessionPendingInteraction`), `ui-layout/src/client/index.ts:41-44` (`usePanelInfo`),
`resources/src/client/contract.ts:22`.

Your component type is therefore:

```ts
type MySectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'my.ns'>
  & InjectFace<MySectionInjected>
```

Real destructuring example **[V]** —
`packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.tsx:26-33`:
`PropsRuntime<'settings.section'> & PropsLocale<'settings.plugins'> & PropsRenderSlots<'settings.plugins.tab'> & InjectFace<PluginsSettingsSectionInjected>`,
destructured as `{ t, renderSlot, useTabs }`. The agent-preset section is the minimal shape
**[V]** — `.../ui-agent-preset/src/client/AgentPresetSection.tsx:63-66`.

**The `t` seat is synthesized from `(namespace, revision)`**, so a locale switch hands out a *new*
`t` reference and memoized components re-render naturally **[V]** —
`packages/client/ui-slots/src/renderer.ts:22-32`.

---

## 5. Locale / dictionary registration

Two overloads **[V]** — `packages/client/locale/src/client/index.ts:355-385`:

```ts
// 1. TYPED — needs the LocaleNamespaceMap augmentation; ALL built-in locales required
register<N extends keyof LocaleNamespaceMap>(ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void
// 2. UNTYPED — single locale, for namespaces outside the merge table
register(ns: string, locale: string, dict: LocaleDict): () => void
```

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'my.ns': MySettingsKey }
}
ctx.effect(() => ctx.locale.register('my.ns', { zh, en }), 'my-plugin: dictionaries')
```

* `BuiltInLocaleId` = `'zh' | 'en'` **[V]** — `packages/client/locale/src/locale-settings.ts:15-18`
  (`LOCALE_IDS = ['zh','en']`).
* Duplicate `(ns, locale)` **throws**; registration **bumps the revision** so mounted outlets pick
  up late dictionaries **[V]** — `:391-400`.
* Locale ids must be BCP 47-shaped or registration throws **[V]** — `:386-390`.
* `ctx.locale.bind(ns)` → a stable `Translate` **[V]** — `:436-445`. Use it inside the *label
  thunk* (`label: () => ctx.locale.bind('my.ns')('nav')`) so the nav row re-localizes.
* The render-time `t` prop and this service are the same dictionary store, so registering once
  serves both the nav label and the section body.
* **Robustness:** the installed precedent wraps `locale.register` in try/catch and falls back to a
  built-in dictionary, because a missing `t` service must not cost you the section. **[V]** —
  `dsh-tokenledger/src/client.js:1552-1559`.

---

## 6. What is safe to `require()` from a third-party client bundle

### 6.1 The complete seed table — exactly 9 specifiers

**[V]** — `packages/client/web/src/platform.ts:8-18`:

```ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const
export const PRELOADED_CLIENT_EXTERNALS = []        // ← verified empty
```

`getStaticModules()` maps exactly those 9 ids to shell-static imports
`satisfies Record<PlatformModule, unknown>` **[V]** — `packages/client/web/src/seed.ts:24-38`.
Matching is **exact**.

### 6.2 The require algorithm — anything else throws

`makeRequire(spec)` resolves in this order, then **throws** **[V]** —
`packages/client/modules/src/client/system.ts`:

1. seed word (exact match, `PLATFORM_MODULES`);
2. a memoized record (`stripClientSuffix(spec)`);
3. a registered package factory (materialize);
4. **throw** — `client-modules: require("…") missed the module table — not a platform seed word,
   not a materialized module, and no registered package factory…`

`import(spec)` throws a sibling message when the specifier is not a boot-graph row: *"not a row in
the boot graph (the runtime mirror of the bundle purity gate)"* **[V]**.

**Consequence:** every bare import **not** in the 9 above must be **inlined into your bundle**.
This is also the documented policy: *"Dynamic plugins inline private libraries and obtain React and
other shared modules from the platform table"* **[V]** —
`2026-09-08-browser-third-party-build-inputs.md`. Browser-only third-party libraries belong in
`devDependencies`, not `dependencies` **[V]** (same note).

### 6.3 Building the artifact

The monorepo's own preset is **unusable by a third party**: `workspaceManifest()` globs
`packages/*/*/package.json` and **throws** `tsdown: no packages/*/*/package.json declares the name
<id>` for a package outside the monorepo **[V]** — `packages/client/tsdown.client.ts:345`.

You have two options.

**Option A — hand-write the bundle (no build step).** This is what the installed precedent does,
and it is the lowest-risk path. Shape **[V]**, transcribed from
`dsh-tokenledger/src/client.js:40-56`:

```js
window.__ModuleLoader__.load({
  id: "<your exact package name>",          // MUST equal the package name (it is the row id)
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react, jsx, jsxs, primitives;
    try {
      react = require("react");
      ({ jsx, jsxs } = require("react/jsx-runtime"));
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      // A require that throws inside a factory takes the whole bundle down with no
      // other trace; naming the specifier turns "the panel is missing" into
      // "this dependency is not in the graph".
      console.error("[my-plugin] a require failed:", error);
      throw error;
    }

    // … no JSX syntax: call jsx(Component, props, key) / jsxs(...) directly …

    const inject = ["slots", "locale", "settingsScope"];
    function apply(ctx) { /* section registration, see §1 */ }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

**Option B — your own bundler.** Output must be `format: 'cjs'`, `platform: 'browser'`,
`outDir: 'lib'`, `entryFileNames: 'client.js'`, wrapped with the monorepo's exact
banner/footer/intro **[V]** — `tsdown.client.ts:566-569`:

```ts
intro:  'var module = { exports: {} }; var exports = module.exports;'
banner: 'window.__ModuleLoader__.load({ id: "<id>", factory: (require) => {'
footer: 'return module.exports; } });'
```

and externalize exactly `PLATFORM_MODULES ∪ PRELOADED_CLIENT_EXTERNALS ∪ dsh.client.external`,
inlining everything else **[V]** — `tsdown.client.ts:410-411, 439`:
`deps: { neverBundle: isRequested, alwaysBundle: s => !isRequested(s) }`.

Shipping requirement: the artifact must exist on disk at the path `exports["./client"]` points to,
because the host serves it by path (`clientPath`) over `/plugins/<id>/client.js` **[V]** —
`packages/client/modules/src/index.ts:293, 596-597`. The row `id` is the **package name verbatim**,
scope included — `graphRow(packageName, rev, source.meta)` at `:968` — so a scoped package writes
`id: "@scope/my-plugin"`. Note the installed precedent points
`exports["./client"]` at `./src/client.js`, **not** `./lib/` — the location is free **[V]**.
`dsh plugin add` **does not build** client bundles; it only reconciles `dsh.profile.bundles`
**[V]** — `apps/cli/src/plugin.ts:48-89`.

### 6.4 npm distribution trap — pin exact versions

`npm view <pkg> version` (the `latest` tag) for the `@deepseek-ai` client packages returns
**`0.0.1-rc.1`**, which is **stale**; `0.1.5-rc.1` … `0.1.7-rc.2` all exist. **[V]**

* The stale `0.0.1-rc.1` `@deepseek-ai/dsh-client-ui-settings` declares
  `dsh.client.inject = ['@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-ui-sidebar']`,
  whereas **`0.1.5-rc.1`** declares `['@deepseek-ai/dsh-api-remotes']` — matching this worktree.
  **[V]**
* So: install type/dev packages as **`@deepseek-ai/dsh-client-ui-settings@0.1.5-rc.1`** etc.
  `0.1.5-rc.1` is published for `dsh-client-ui-settings`, `ui-slots`, `ui-primitives`,
  `dsh-client-locale`, and `dsh-api-remotes` **[V]**. `@deepseek-ai/schemastery` is at `3.18.4`
  (**stable, `latest` is correct there**) **[V]**.

---

## 7. Minimal complete example

Package name `dsh-example-settings`, namespace `exampleSettings`, section id `example`.

### `package.json`

```json
{
  "name": "dsh-example-settings",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./src/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "src/client.js", "cordis.patch.yml"],
  "peerDependencies": { "@deepseek-ai/schemastery": "^3.18.1" },
  "devDependencies": {
    "@deepseek-ai/dsh-client-ui-settings": "0.1.5-rc.1",
    "@deepseek-ai/dsh-client-ui-slots": "0.1.5-rc.1"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

`dsh.client.external` is omitted on purpose: nothing outside the 9 seed specifiers is required, so
nothing may be requested and the bundle must be self-contained. **[V]** (§6)

### `src/index.ts` — host half

```ts
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-example-settings'
export const inject = ['settings']

export interface Config {}
export function apply(ctx: any, _config: Config): void {
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.register('exampleSettings', z.object({
      endpoint: z.string().default(''),
      apiKey:   z.string().role('secret').default(''),
      verbose:  z.boolean().default(false),
    }), { applies: 'live' })
  })
}
```

### `src/client.js` — browser half (no build step)

```js
window.__ModuleLoader__.load({
  id: "dsh-example-settings",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react, jsx, jsxs;
    try {
      react = require("react");
      ({ jsx, jsxs } = require("react/jsx-runtime"));
    } catch (error) {
      console.error("[example] a require failed; the section cannot mount:", error);
      throw error;
    }

    var NS = "exampleSettings";
    var zh = { nav: "示例", endpoint: "接口地址", key: "密钥", keySet: "已设置", keyUnset: "未设置", save: "保存", verbosity: "详细日志" };
    var en = { nav: "Example", endpoint: "Endpoint", key: "API key", keySet: "Set", keyUnset: "Not set", save: "Save", verbosity: "Verbose" };

    function Section(props) {
      var t = props.t, close = props.close;
      var use = props.useExampleSection;
      var state = use();
      if (state.status !== "ready") {
        return jsx("div", { children: state.status === "unavailable" ? t("keyUnset") : "…" });
      }
      return jsxs("div", {
        children: [
          jsx("label", { children: t("endpoint") }, "endpoint"),
          jsx("input", {
            value: state.value.endpoint,
            disabled: !state.writable,
            onChange: (e) => { props.setEndpoint(e.target.value) },
          }, "input"),
          jsx("div", { children: state.secretSet ? t("keySet") : t("keyUnset") }, "secret"),
          jsx("button", { onClick: () => { props.save() }, children: t("save") }, "save"),
        ],
      });
    }

    var inject = ["slots", "locale", "settingsScope"];

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "example: dictionaries");
      } catch (error) {
        console.warn("[example] locale.register failed; falling back:", error);
      }

      var scope = ctx.settingsScope.bind({ namespace: NS });

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "example",
        order: 100,
        label: () => ctx.locale.bind(NS)("nav"),
        locale: NS,
        inject: () => ({
          useExampleSection: function () {
            var snap = react.useSyncExternalStore
              ? react.useSyncExternalStore(
                  (cb) => scope.subscribe(cb),
                  () => scope.getSnapshot(),
                  () => scope.getSnapshot(),
                )
              : scope.getSnapshot();
            var view = ctx.settingsScope.describe().getSnapshot().view;
            var nsView = view && view.namespaces.find((n) => n.ns === NS);
            var secret = nsView && nsView.secrets.find((s) => s.path.join(".") === "apiKey");
            return {
              status: snap.status,
              value: snap.value,
              writable: snap.writable,
              secretSet: secret ? secret.set : false,
            };
          },
          setEndpoint: (v) => { scope.set("endpoint", v) },
          save: () => { scope.mutate([{ op: "set", path: ["verbose"], value: true }]) },
        }),
      }, Section));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

Three honest caveats about this example, all **[I]** and two of them avoidable:

* **Prefer the store seat over a hand-rolled hook.** A *stable* hook identity is normally supplied
  by the shipped `createSnapshotStore`/`defineStore` helpers (`@deepseek-ai/dsh-client-store`, a
  platform module) delivered through an `store` declaration on the slot registration, arriving as
  a `use<Name>` prop — see `packages/client/locale/src/client/index.ts:574-581` and
  `ui-settings-plugins/src/client/index.ts:56-58`. The inline `useSyncExternalStore` wrapper above
  is a fallback for a plugin that does not want the store seat; it re-creates the subscribe/getter
  closures on every render, which is correct but wasteful.
* The `inject` factory is re-invoked by the render machinery, so keep it free of side effects —
  the example only closes over `scope` and `ctx`, both stable.
* The combined read of the snapshot and the raw `describe()` mirror is two reads of the same
  document, so they cannot disagree; but the secret indicator is *not* part of the snapshot and
  therefore does not trigger a re-render on its own. If the indicator must be live, drive it from
  the scope's snapshot revision (which also moves on a settings change). **[I]**

### `cordis.patch.yml`

```yaml
- id: example-settings
  name: dsh-example-settings
```

---

## 8. Third-party limitations, explicitly

### Impossible / unsupported

| # | Limitation | Evidence |
| --- | --- | --- |
| 1 | **No nav icon choice.** The shell maps id→icon with a generic fallback. | `ui-settings-general/src/client/SettingsRoot.tsx:27-31` **[V]** |
| 2 | **No `dsh.client.provide` alias mechanism.** A request's only suppliers are a dynamic row or an exact static table key. | `2026-08-15-…md` **[V]** |
| 3 | **Cannot use the monorepo's `clientBundle()` preset** — `workspaceManifest()` throws for any package outside `packages/*/*`. | `tsdown.client.ts:345` **[V]** |
| 4 | **Cannot declare `dsh.client.inject` to *provide* anything**; listing a static assembly library there is a silent no-op. | `2026-08-15-…md` table; arrival skips unknown rows **[V]** |
| 5 | **No client-side conflict merge/retry** — a stale write is refused and the mirror re-read. | `settings-scope.ts` controller **[V]** |
| 6 | **No settings registration without schemastery.** | `settings/src/index.ts:419-422` **[V]** |
| 7 | **`platform` has exactly one valid value (`"web"`);** others silently disable the row. | `modules/src/index.ts:761` **[V]** |
| 8 | **No partial availability:** an entry that fails import/apply or waits on a missing service fails the boot audit. | `packages/client/web/src/boot.ts:124-140` (`assertEntriesActive`) **[V]** |

### Requires internal monorepo tooling (workarounds exist)

| # | Item | Third-party workaround |
| --- | --- | --- |
| 9 | `tsdown.client.ts` preset, `workspaceManifest`, purity-gate verifier | hand-write the bundle (Option A) or replicate banner/footer/intro (Option B) |
| 10 | `scripts/verify-client-packages.ts` | not run against third parties at all; note the "**import shared types only, never a runtime value import**" rule is enforced **only** for `packages/client/*` — for anything outside it, `dsh.client.external` naming another client row is *allowed*, provided a real runtime import exists and there is no cycle **[V]** |
| 11 | npm `latest` dist-tag for `@deepseek-ai/dsh-client-*` is stale (`0.0.1-rc.1`) | pin `0.1.5-rc.1` exactly **[V]** |

### Loud failure modes worth knowing before you debug blind

* `dsh.client` declared without `exports["./client"]` → **throws** at row admission. **[V]**
* Declared bundle missing on disk → `MissingClientBundleError`, aggregated as
  `ClientPackageCompositionError` with the instruction *"run `pnpm run build` before launch"*
  (misleading for a third party that has no such script). **[V]** —
  `packages/client/modules/src/index.ts:88-123`.
* A `require()` of a non-seeded specifier throws **inside your factory**, taking the whole bundle
  down with no other trace — hence the try/catch-and-name-the-specifier idiom in §6.3, which the
  installed precedent adopted after debugging exactly this. **[V]**

---

## 9. Verified vs inferred — summary

**Verified [V]** (read from source, or from an installed artifact on this machine): the 9-entry
`PLATFORM_MODULES` and empty `PRELOADED_CLIENT_EXTERNALS`; the require/throw algorithm; the
`dsh.client` field set and the `platform`-must-be-`"web"` admission rule; the declaration of
`settings.section` by the shell and the register-into-it pattern; the absence of an icon option and
the shell's hardcoded icon map; the section owner prop `{close}`; the full props composition and
each `GlobalStandardProps` merger; the `settingsScope` service surface (`bind`, `describe`,
snapshot fields); the missing-namespace and decode-failure paths; the conflict/recovery policy; the
secret redaction pipeline and the scope's dropping of the `secrets` sidecar; both `locale.register`
overloads and the `zh`/`en` locale id set; schemastery's `role()`; the `workspaceManifest` throw;
`dsh plugin` not building client bundles; the npm version/dist-tag situation; and the entire
`dsh-tokenledger` precedent (manifest, hand-written bundle, both `inject`s, locale fallback).

**Inferred [I]**: only the two caveats on the example in §7 (prefer the store seat over a
hand-rolled hook) and the claim that a redacted secret can make the section's `decode()` refuse a
value. Everything else is source-verified.

**Not verified empirically:** no third-party client bundle was built, published, or mounted during
this investigation, and the live Desktop app could not be probed (its HTML returns `forbidden`
without the browser token). `apply()` of the related `dsh-as-mcp` plugin has still never executed
inside a real DSH process. Treat the artifact format as **verified-by-reading plus
verified-by-installed-precedent**, not as verified-by-execution.
