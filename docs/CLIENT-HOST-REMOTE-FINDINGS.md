# Can a third-party DSH plugin read HOST runtime state from its BROWSER half?

Target runtime: DSH harness **0.1.5-rc.1** (the version shipped inside DSH Desktop, read from
`/Applications/DSH Desktop.app/Contents/Resources/app.asar`). Authoritative source tree:
`/Users/xiseliuli/test_code/dsh-harness-015`. Every claim is labelled **[V]** (verified by reading
source or a real installed artifact on this machine) or **[I]** (inferred). No code was changed to
produce this document.

---

## The answer in one paragraph

**Yes.** Two mechanisms are available to a THIRD-PARTY (out-of-monorepo, npm-published) package,
both verified from installed npm artifacts under `~/.dsh/profiles/desktop/node_modules/`:

1. **Typert Remote** — the mechanism `dsh-cost-meter` uses. The HOST half exposes an ordinary
   Cordis service carrying a hand-written `typertRemote` binding, and publishes hand-written
   `InvocationDescriptor`s (either through an `exports["./typert"]` manifest that the mounted
   `dsh-typert-loader` auto-registers, or by calling `ctx.typert.register()` itself). The BROWSER
   half hand-writes a matching `TypertRemoteContribution` and calls `ctx.remote.$mount(...)`, after
   which the namespace appears as a Cordis service `remote.<namespace>` and methods are called as
   ordinary **async** functions returning `{ ok: true, value } | { ok: false, error }`. No
   monorepo codegen, no `api-remotes` edit, and no centrally maintained type map are required: the
   Typert *generator* that produces those artifacts during `tsdown` for `packages/*/*` is
   monorepo-only, but a third party replaces it by **hand-writing both halves**. This is precisely
   what the shipped `dsh-cost-meter` does. **[V]**
2. **Same-origin HTTP** — the mechanism `dsh-tokenledger` uses. The HOST half registers an exact
   route (`ctx.connection.fetch.register(...)`, which sits inside DSH's `/api` browser-auth and
   Host/Origin fence, or `ctx.webServer.register({ kind: 'exact', ... })`, which does not). The
   BROWSER half simply `fetch()`es it on the same origin. **[V]**

What does **not** exist for a third party is any *push* or *reactive* host→client channel: there is
no general host service mirrored into the browser, no client-observable store for host state, and
no third-party SSE/WebSocket seam. Both mechanisms are **pull** — the client calls (or polls) and
never learns that host state changed on its own. `ctx.remote.$host` is **not** a general host-state
handle: it exposes only `{ home, isLoopback }` (fixed Host facts), which is why it does not answer
`listening` / `url` / `error`. **[V]**

---

## 1. Mechanism A — Typert Remote (`dsh-cost-meter` precedent)

### 1.1 The client-callable contract

The service key is `remote`; every mounted namespace is a child Cordis service keyed
`remote.<namespace>`. **[V]** —
`packages/api/gateway/src/client/index.ts:659-661`:

```ts
function remoteServiceKey(namespace: string): string {
  return `remote.${namespace}`
}
```

The client-visible interface is **[V]** — `packages/typert/protocol/src/types.ts:299-313`:

```ts
/** Generated Host contract selected explicitly by a Client assembly. */
export interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[]
}

/** Client Remote capability implemented by the Gateway and consumed by Remote assemblies. */
export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  /**
   * Mount one generated Host-for-Client contribution in the caller's fiber.
   * @param contribution - explicitly selected Remote package artifact.
   * @returns disposer after namespace services and concrete methods are ready.
   */
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  ...
}
```

* **Exact service name a client bundle must list in its cordis `inject`:** `'remote'`. **[V]** —
  the installed `dsh-cost-meter` client bundle declares, at byte offset 245087 of
  `~/.dsh/profiles/desktop/node_modules/dsh-cost-meter/lib/client.js`:

  ```js
  const Bs=["remote"];async function Ds(t){const s=t.remote;if(s===void 0||typeof s.$mount!="function")return;const o=await s.$mount(en);t.effect(()=>()=>{o()},"cost-meter: remote contribution");const a=t.get("remote.costMeter");
  ```

  and exports it as the cordis inject list at the end of the bundle: `it.inject=Bs`. The client
  does **not** declare `'remote.costMeter'`; it reads the namespace service structurally with
  `ctx.get('remote.costMeter')` **after** `$mount` resolves. The namespace name is not otherwise
  registered anywhere on the client — `$mount` is what creates it. **[V]**
* **DEFINE a host-side method/namespace:** a host service must carry a `typertRemote` binding whose
  shape is `{ service: <the instance>, serviceKey, namespace }`. The gateway rejects a service
  without it. **[V]** — `packages/api/gateway/src/index.ts:1016-1035` (`validateBinding`) and
  `:1037-1056` (`readBinding`) require exactly `service === original`, `serviceKey === <cordis key>`,
  `typeof namespace === 'string'`.
* **Where the definition is registered.** Two verified variants:
  * **(a) `exports["./typert"]` manifest + the mounted loader.** The manifest format is the one the
    Typert *generator* emits, but it may be hand-written. The installed `dsh-cost-meter` does
    exactly that: `package.json` has `"exports": { "./typert": { "default": "./lib/typert.host.js" } }`
    **[V]**, and `lib/typert.host.js:494` defines the strict codec factory by hand:

    ```js
    const strictCodec = (name, schema) => ({ mode: 'strict', typeSymbol: 'dsh-cost-meter#' + name, schema, create: () => schema })
    ```

    with the manifest itself at `lib/typert.host.js:513-520`:

    ```js
    export const TYPERT = {
      package: 'dsh-cost-meter',
      face: 'host',
      schemas: [],
      invocations: [
        { id: 'dsh-cost-meter#costMeter/getState', service: 'costMeter', namespace: 'costMeter',
          method: 'getState', invocation: { kind: 'direct' }, parameters: [], result: _state$codec },
        ...
    ```

    The loader resolves this without any manifest field naming it — the `exports` **key** is the
    whole registration trigger. **[V]** — `packages/typert/loader/src/index.ts:39`:

    ```ts
    export const TYPERT_HOST_EXPORT = './typert'
    ```

    `:315-340` (`resolveArtifact`): `require.resolve(\`${pkgName}/package.json\`)` →
    `typertExportOf(...)`; `:346` dynamically imports the path; `:428`
    (`for (const entry of ctx.loader.entries()) dirty.add(entry.options.name)`) seeds discovery from
    **Loader entries**, i.e. from the profile row itself. No `dsh.*` manifest field references the
    artifact. **[V]**
  * **(b) Manual registration from the host `apply()`.** The loader's own doc comment says it
    explicitly **[V]** — `packages/typert/loader/src/index.ts:21-23`:

    ```
     * Manual `ctx.typert.register()` remains available for contributions
     * that do not use a `./typert` artifact (hand-written wire schemas,
     * tests, non-loader compositions).
    ```

    `ctx.typert.register(contribution)` takes `{ package, face, schemas, model, invocations }`.
    **[V]** — `packages/typert/registry/src/types.ts:81-88`; implementation at
    `packages/typert/registry/src/service.ts:499-522` (`localStore.commit(owner, invocations)`).
  * **The codegen path is monorepo-only.** `@deepseek-ai/dsh-typert-generator` runs inside the
    monorepo's `tsdown` host pass over the `tsconfig.host.json` aggregate ("the normal Host Project
    Reference graph compiles the Typert generator, which runs during this tsdown pass with the Host
    aggregate as its only `ts.Program` seed") and "validates each contributor's `package.json`:
    `./typert` and `./client/typert` (and `./remote` when Remote methods exist) must point at the
    exact generated files". **[V]** — `docs/api-gateway.md` §"Strict generation pipeline";
    `packages/typert/generator/README.md` §"Emission and publication contract". A third party does
    **not** need it; it hand-writes the same shapes (cost-meter proves it).
* **Is the call async?** Yes, twice over: `$mount` returns `Promise<TypertDisposer>`, and every
  method call is async through `ctx.connection.rpc.call('/api', endpoint, ...)`. **[V]** —
  `packages/api/gateway/src/client/index.ts:201` and the cost-meter client's
  `await a[C](...F??[])`. The resolved value is `RemoteResult<T>` = `{ ok: true; value }` or
  `{ ok: false; error }` **[V]** — `packages/typert/protocol/src/types.ts:74-77`.
* **Is the namespace/type registry closed to the monorepo?** **The runtime registry is not closed;
  the assembly is.** Two distinct facts, and third parties only care about the first:
  * `@deepseek-ai/dsh-api-remotes` mounts a *fixed build-time selection* — "The capability set is
    fixed by explicit build-time value imports; the Client does not discover the Host's active
    Services or Remote definitions at runtime" and "Additional capabilities require an explicit
    `/remote` value import and mount in this assembly." **[V]** —
    `packages/api/remotes/README.md:71-72`. Documentation repeats the consequence:
    "the Host methods visible to any Client assembly are limited to the Remote methods selected at
    generation time." **[V]** — `docs/api-gateway.md:78`.
  * **But a third-party bundle never has to be in that selection.** `$mount` is a public method on
    the `remote` service, and it accepts *any* contribution object that passes the client-side
    validator (see §1.2). `dsh-cost-meter` — a plugin whose `./remote` artifact is obviously not
    imported by the monorepo's `api-remotes` — mounts its own and calls it. So the closed assembly
    is not a gate for a self-mounting bundle. **[V]**
  * The TypeScript merge maps `TypertRemoteNamespaceMap` / `TypertRemoteScopeMap`
    (`packages/typert/protocol/src/types.ts:204`, `:79`) are compile-time only; a JS client bundle
    can augment them locally in its own `.ts` sources or ignore them entirely. **[V]**

### 1.2 What the client-side validator actually requires

This is the crux that makes hand-writing viable: the client accepts **plain objects as codecs**;
zod is *not* required on the client. **[V]** —
`packages/api/gateway/src/client/index.ts:709-720`:

```ts
function requireStrictCodec(codec: TypertCodec, endpoint: string, field: string): void {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
}

function parseInput(codec: TypertCodec, value: unknown, endpoint: string, field: string): unknown {
  if (codec.mode !== 'strict') {
    throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
  }
  ...
    return codec.schema.parse(value)
```

and the shared registry behind `$mount` (`callerCtx.typert.remotes.register(contribution)`,
`:244`) requires only a callable `parse`. **[V]** —
`packages/typert/registry/src/service.ts:697-703`:

```ts
function validateCodec(codec: InvocationDescriptor['result'], subject: string): void {
  if (codec.mode === 'src-json') return
  validateNonempty(`${subject} type symbol`, codec.typeSymbol)
  if (typeof codec.schema.parse !== 'function') {
    throw new Error(`typert: ${subject} strict codec has no parse() method`)
  }
}
```

The installed `dsh-cost-meter` client bundle confirms this end to end. At byte offset 98257 it
defines `function se(t){return{parse:t}}` and at 98691:

```js
Ce=(t,s)=>({mode:"strict",typeSymbol:"dsh-cost-meter#"+t,schema:s,create:()=>s})
```

and at 98853 assembles the whole contribution by hand:

```js
en={package:"dsh-cost-meter",descriptors:[{method:"getState",result:Ce("CostState",pt)},
 {method:"updateConfig",parameters:[ie("patch","ConfigPatch",Ga)],result:Ce("CostState",pt)},
 ... {method:"clearCredential",parameters:[ie("target","CredentialTarget",$t)]}]
 .map(t=>({id:"dsh-cost-meter#costMeter/"+t.method,service:"costMeter",namespace:"costMeter",
           invocation:{kind:"direct"},parameters:[],result:Ce("FetchPricesResult",Ka),...t}))};
```

**[V]** — `~/.dsh/profiles/desktop/node_modules/dsh-cost-meter/lib/client.js` byte offsets
98257 / 98691 / 98853 / 245087 / 245154 / 245274.

### 1.3 The host side needs no protocol-package import

`dsh-cost-meter`'s host bundle contains **zero** occurrences of `bindTypertRemote`,
`TypertRemoteService`, or `@deepseek-ai/dsh-typert-protocol`; it attaches the binding by hand
**[V]** — `~/.dsh/profiles/desktop/node_modules/dsh-cost-meter/lib/index.js:2325-2330`:

```js
Object.defineProperty(service, 'typertRemote', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: { service, serviceKey: 'costMeter', namespace: 'costMeter' },
})
```

This matters because the `@deepseek-ai/*` runtime packages are **not resolvable** from a
third-party package's own `node_modules` on this machine: `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/`
contains only `cosmokit` and `schemastery`; the harness packages live inside the Desktop app's
`app.asar`. **[V]** So the practical third-party path is: no protocol import, hand-written binding,
hand-written descriptors.

### 1.4 Strict-vs-SRC: a second host path that needs no artifact at all

If a host service carries the `typertRemote` binding and its methods carry `@Remote` markers on the
prototype, the Host gateway will dispatch it through the **SRC fallback** even with no registered
strict descriptor. **[V]** — `packages/api/gateway/src/index.ts:266-290`:

```ts
  private claimsEndpoint(endpoint: string): boolean {
    ...
    if (this.ctx.typert.local.get(endpoint) !== undefined || this.ctx.typert.local.hasSeen(endpoint)) return true
    this.srcClaims ??= this.collectSrcClaims()
    return this.srcClaims.has(endpoint)
  }

  private collectSrcClaims(): ReadonlySet<string> {
    const claims = new Set<string>()
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver = this.ctx.get(serviceKey) as unknown
      ...
      const binding = Reflect.get(original, 'typertRemote') as unknown
      ...
      for (const candidate of remoteMethods(original)) {
        claims.add(endpointOf(namespace, candidate.exportName ?? candidate.method))
      }
    }
```

and `:626-640` (`resolveDescriptor` → `resolveSrcDescriptor`). **Two caveats**
**[V/I]**: (i) the markers are written by the protocol decorators (`@Remote` / `@RemoteScope`),
which are TC39 *standard* decorators (`packages/typert/protocol/src/index.ts:66-72` declares
`ClassMethodDecoratorContext`), so the third party's host build must lower standard decorators — and
esbuild (which `dsh-cost-meter` and `dsh-as-mcp` use for their host bundles) does not implement
standard decorators. cost-meter therefore avoided decorators entirely and went strict-only. (ii) A
**client** contribution still needs strict codecs (§1.2), so SRC only removes the *host* artifact,
not the client descriptor. **[V]**

### 1.5 Gotchas that are not enforced anywhere

* The client descriptors and the host descriptors are **two independent hand-written copies**. The
  loader validates only the host copy; `$mount` validates only the client copy. Nothing cross-checks
  that the wire `args`/method names/return shapes agree — a mismatch surfaces as a runtime
  `gateway/*` failure, not a build error. **[I]** (no shared validation code exists between
  `typert-loader` and `api-gateway/client`).
* `$mount` rejects a method name that collides with the namespace service's own members
  **[V]** — `packages/api/gateway/src/client/index.ts:536-540` (`assertMethodAvailable`).
* It also rejects a namespace that collides with an existing property on the `remote` service
  **[V]** — `:297-308`.
* Unload is automatic: `$mount` registers the contribution inside `callerCtx.effect(...)`
  **[V]** — `:201-209` — so a bundle's fiber teardown withdraws it.

---

## 2. What `typert` is, and what `./typert` is in `dsh-cost-meter`

**`typert` is a four-package subsystem, not one thing.** **[V]** —
`packages/typert/README.md` §Packages:

| Package | Role | ctx key |
|---|---|---|
| `generator/` | Analyzes source types **at build time** and generates reflection, schemas, and Remote descriptors | — |
| `loader/` | Auto-registers generated Typert artifacts from Loader compositions into the runtime registry | consumes `ctx.loader` and `ctx.typert` |
| `protocol/` | Declares the Remote decorators, wire descriptors, codecs, and provider contracts | — |
| `registry/` | Stores generated package reflection and live Zod schemas at runtime | `ctx.typert` |

**`dsh-cost-meter`'s `./typert` is the loader's input artifact — a host-face `TYPERT` manifest — and
it is hand-written, not generated.** Re-read against the artifact:

* `package.json`: `"exports": { "./typert": { "default": "./lib/typert.host.js" } }` **[V]**
* No `dsh.*` field references it. `dsh` is `{ "bundle": {"patch": "./cordis.patch.yml"}, "client": {"platform": "web"}, "compatibility": {...} }`
  — there is no `typert` key. Discovery is purely by the `exports` key **[V]** —
  `packages/typert/loader/src/index.ts:39` and `:315-340`.
* What it exports: `export const TYPERT` (default export too) carrying `{package, face, schemas,
  invocations, model}` — `lib/typert.host.js:513` and `:805`. Its own header comment states it
  plainly: *"手写清单,结构与 `@deepseek-ai/dsh-typert-generator` 产物一致"* ("hand-written manifest,
  structure identical to the generator's output"). **[V]**
* **How the client half consumes it: it does not.** There is no `exports["./remote"]` in
  cost-meter's `package.json`, and its client bundle contains no import of, or reference to, the
  typert artifact. The client re-declares the same descriptors inline (`en`, §1.2). The host
  manifest is consumed by `typert-loader`; the client contribution is consumed by
  `ctx.remote.$mount()`. They are two hand-maintained copies of one contract. **[V]**
* **Is this the third-party mechanism, or something cost-meter does privately?** It is the
  third-party mechanism. `typert-loader` has no allow-list and no monorepo path requirement — it
  resolves `<pkg>/package.json` from `ctx.baseUrl` (the config-tree anchor) and imports whatever
  `exports["./typert"]` names **[V]** (`loader/src/index.ts:292`, `:315-340`, `:428`). The only
  strictness is shape validation: `validateTypertManifest` (`:83-141`) and `requireStrictCodec`
  (`:264-275`), the latter requiring `'_zod' in codec.schema` — i.e. **real zod v4 instances on the
  host side**:

  ```ts
  if (typeof codec.schema !== 'object' || codec.schema === null || !('_zod' in codec.schema)
    || typeof (codec.schema as { parse?: unknown }).parse !== 'function') {
    throw new Error(`typert-loader: ${pkgName} ${subject} is not backed by a zod v4 schema`)
  }
  ```

  (`dsh-as-mcp` already depends on `zod ^4.2.0`, so this costs nothing new.) **[V]**

---

## 3. `dsh-tokenledger/src/client.js`, read in full

**It does not use Typert Remote at all.** It obtains host data from a **same-origin HTTP GET** and
declares only `slots` + `locale` in its cordis `inject`. **[V]** —

* File header, `src/client.js:1-31`: *"It renders; it does not compute. Every figure comes from the
  host half's `/api/tokenledger/usage` … A hand-written `__ModuleLoader__` bundle. There is
  deliberately **no build step** … the runtime's `jsx`/`jsxs` are called directly."*
* Bundle shape and requires, `src/client.js:40-62`:

  ```js
  window.__ModuleLoader__.load({
    id: "dsh-tokenledger",
    factory: (require) => {
      ...
      react = require("react");
      ({ jsx, jsxs } = require("react/jsx-runtime"));
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  ```
* The host-data origin, `src/client.js:64-68`:

  ```js
  const NS = "tokenLedger";
  const USAGE_PATH = "/api/tokenledger/usage";
  const BALANCE_PATH = "/api/tokenledger/balance";
  ```
* The read, `src/client.js:402-410`:

  ```js
  async function fetchJson(path, signal) {
    const response = await fetch(path, { headers: { accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload === null || typeof payload !== "object" || payload.ok !== true) {
      throw new Error("unexpected response");
    }
    return payload;
  }
  ```

  called from `useUsage` (`:431-453`) and `useBalance` (`:462-484`), each with an `AbortController`.
* Cordis `inject`, `src/client.js:1541-1542`:

  ```js
  /** Client-half services this bundle needs before it can register. */
  const inject = ["slots", "locale"];
  ```

  (The other `inject` — `package.json` → `dsh.client.inject` at `:57-64` — is a *package-name*
  list, `["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-primitives"]`,
  and shares no string with the service list. Two different `inject`s. **[V]**)
* `apply()` (`:1551-1572`) registers dictionaries + a `sidebar.footer.action` seat only. There is
  no `ctx.remote`, no `$mount`, no websocket, no store subscription.
* The host route it reads: `src/http.js:49-51`:

  ```js
  export const BASE_PATH = "/api/tokenledger";
  export const USAGE_PATH = `${BASE_PATH}/usage`;
  export const BALANCE_PATH = `${BASE_PATH}/balance`;
  ```

  registered in `attachRoutes` (`src/http.js:287-330`) as
  `webServer.register({ kind: "exact", path, handler })`, with the plugin's own admission check
  `screenRequest` (`src/http.js:147-156`):

  ```js
  export function screenRequest(req) {
    if (req?.method !== "GET") return { status: 405, body: { ok: false, error: "method-not-allowed" } };
    const peerOk = isLoopbackAddress(req.socket?.remoteAddress);
    const hostOk = isLoopbackAddress(hostNameOf(req.headers?.host));
    // Both, and the peer address is the one that cannot be forged.
    if (peerOk && hostOk) return undefined;
    return { status: 403, body: { ok: false, error: "forbidden" } };
  }
  ```

**Answer to the sub-question:** it reads neither the settings scope nor a Remote method; it calls
the host at runtime over same-origin HTTP and polls on a timer (`useUsage`'s `useEffect` re-run via
`nonce`, plus a refresh button). It also does **not** read `ctx.settingsScope` at all. **[V]**

---

## 4. Other viable ways for a client half to observe host state

### 4.1 Same-origin `fetch` to a host route — ✅ viable, and the cheapest

The page origin is a real HTTP origin, not `file://`: the Desktop shell loads
`http://127.0.0.1:<port>/`. **[V]** — `dsh-desktop/dsh-plugin-desktop/src/desktop-network.ts:65-70`
(`return '127.0.0.1'`; `` return `http://127.0.0.1:${String(port)}/` ``) and
`dsh-plugin-desktop/src/index.ts:131` (`new URL(\`http://127.0.0.1:${String(port)}/\`)`). The
running GUI on this machine is `http://127.0.0.1:43120`. So a relative `fetch('/api/...')` is
**same-origin** and CORS never applies. **[V]**

Two route registries, with different security postures:

* **Inside the fence — `ctx.connection.fetch.register(route)`.** **[V]** —
  `packages/client/connection/src/rpc.ts:116-140`:

  ```ts
  /** One exact, transport-independent Fetch route owned by a Host feature. */
  export interface ConnectionFetchRoute {
    /** Absolute path below `/api`; query parameters remain available on the request URL. */
    readonly path: string
    /** Methods this route owns. */
    readonly methods: readonly ConnectionFetchMethod[]
    /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
    readonly requestBody: ConnectionRequestBodyMode
    /** Handle one request after the physical carrier has applied its trust and authentication policy. */
    readonly fetch: (request: Request) => Promise<Response>
  }
  ```

  The doc comment says "below `/api`", but the registered key is the **full pathname**: the lookup
  is `this.fetchRoutes.get(new URL(request.url).pathname)` **[V]** (`rpc-host.ts:127`), and all five
  shipped registration sites pass the full `/api/...` pathname **[V]** —
  `packages/session-query/session-log-export/src/index.ts:42` (`'/api/session.export'`),
  `packages/api/session-controller/src/media-references.ts:70-71` (`'/api/file'`),
  `packages/client/file-upload/src/protocol.ts:2` (`'/api/session/uploadFileBinary'`),
  `packages/client/ui-deliverables/src/presented.ts:7,10` (`'/api/present.open'`,
  `'/api/present.host'`). `assertFetchRoute` enforces the `/api/` prefix and the segment grammar
  `^[A-Za-z0-9_$.-]+$` **[V]** (`rpc-host.ts:33`, `:292-303`, `:266-276`).
  **Security:** these routes are dispatched by the shared handler that the Connection's `/api`
  **prefix** route reaches only after `connection.requestRejection(req)` (Host/Origin trust, then
  the browser session cookie) **[V]** — `packages/client/connection/src/index.ts:124-138`, and
  `rpc-host.ts:96-100`:

  ```ts
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }
  ```

  So this is the option with no security work to do.
* **Outside the fence — `ctx.webServer.register({ kind: 'exact', path, handler })`.** **[V]** —
  `packages/host/webserver/src/index.ts:38`, `:317-327`:

  ```ts
  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    ...
  ```

  The Connection registers `/api` as a **prefix** route (`connection/src/index.ts:126-127`:
  `kind: 'prefix', path: API_PATH`), so an exact webserver route at `/api/<something>` **wins**
  before the fence runs. That is exactly what `dsh-tokenledger` relies on, and why it implements
  its own `screenRequest`. The webserver itself "knows no harness concepts" and carries "no TLS,
  authentication, or origin policy of its own" **[V]** — `packages/host/webserver/README.md`
  §Summary. A third party using this path is outside DSH's browser-trust fence and owns its own
  admission check.
* **Plugins fetching their own separate loopback listener (different port) from the browser —
  ❌ blocked by CORS in practice.** The GUI origin would be `http://127.0.0.1:<webport>`, the
  listener `http://127.0.0.1:8790` — a different origin. A repository-wide search for
  `Access-Control-Allow-Origin` / `access-control-allow-origin` finds **no** occurrence in any
  `packages/**` or `apps/**` TypeScript **[V]**, and `dsh-as-mcp`'s own listener sets only
  `content-type` / `content-length` / `cache-control` on its responses **[V]** —
  `src/mcp/http.ts:38-46` (`deny()`). So a browser `fetch` to it would fail
  preflight/response inspection. **[I]** (I did not run a browser to demonstrate the CORS refusal;
  the absence of ACAO headers is the verified part.)

### 4.2 WebSocket / SSE — ❌ not a third-party seam

* The only browser-facing WebSocket is the API Gateway stream mux at
  `/api/remote.mux` (path constant `REMOTE_STREAM_MUX_PATH`), owned by `dsh-api-gateway` and used
  for `ctx.remote.$stream()`; it is not a general host→client channel and exposes no
  plugin-registerable logical endpoint except through the Gateway's own stream descriptors.
  **[V]** — `packages/api/gateway/README.md` §Host service ("The Client opens the Gateway-owned
  `/api/remote.mux` WebSocket…"), `packages/api/gateway/src/index.ts:209-229`
  (`webServer.registerUpgrade(route)` for that one path).
* `text/event-stream` appears in this tree only in `packages/experimental/webworker-runtime`
  (its own tunnel), `packages/experimental/inspector` (CDP), and LLM adapters' test/production
  servers — no general host→browser event bus. **[V]**
* `$on` / forwarded Cordis events exist and are real, but the legal key set is a
  **build-time allowlist owned by the monorepo** (`API_REMOTE_FORWARDED_EVENTS`) — "Forwarding one
  more event requires one entry in that array" **[V]** — `packages/api/remotes/README.md`
  §Forwarded Host events, and `packages/typert/protocol/src/types.ts:136-204`
  (`TypertRemoteEventSelection`). A third party cannot add a key. Effectively closed.

### 4.3 Host writing state where the client already reads

* **The settings document — ❌ for liveness, but a partial fit for configuration.** `listening`,
  `url` and `error` are intentionally not persisted, so extending the settings document would make
  them durable, wrong-after-restart data. The scope is also a *settings* channel (host-validated,
  schema-backed) and is explicitly scoped to the client's `settingsScope` service. **[V]** — the
  workspace's own `docs/CLIENT-PLUGIN-BLUEPRINT.md` §2 documents the whole path, including
  `persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`
  (`packages/client/ui-settings/src/client/index.ts:58`).
* **A client store — ❌ there is no host→client store.** `@deepseek-ai/dsh-client-store` is
  "Observable browser state stores … React-free observable and snapshot-store primitives" with no
  host binding **[V]** — `packages/client/store/README.md` §Summary. No host service named `store`
  exists (`grep "super(ctx, 'store')"` finds nothing) **[V]**.
* **`ctx.remote.$host` — ❌ not general.** It is `RemoteHostFacts = { home, isLoopback }` and is
  documented as "Fixed Host facts as plain reads: no store, no subscription, no generation counter."
  **[V]** — `packages/api/gateway/src/client/index.ts:110-123` and
  `packages/api/gateway/README.md` §Client service. It cannot carry plugin state.

### 4.4 Reactive seam summary

There is no third-party push. Both viable mechanisms are pull, so a live indicator requires either
(i) a client-side poll/interval + `connection/reset` re-read — exactly what `dsh-cost-meter`'s
client does (at byte offset 246017 of `lib/client.js`,
`t.effect(()=>t.on("connection/reset",()=>{m()}),"cost-meter: reconnect reload");const b=setInterval(()=>{...},1e3);`
— **[V]**) — or (ii) a host-initiated client notification, which does not exist for third parties.

---

## 5. Concrete recommendation for `dsh-as-mcp`

Current state, read from this workspace: the host already computes exactly the needed shape
**[V]** — `src/status.ts:10-23` (`EndpointStatus` with `listening`, `url`,
`mountedOnWebServer`, `error`, `tokenSource`, `settingsRegistered`) and
`src/index.ts:102-113`:

```ts
  const status = (): EndpointStatus => {
    const current = getConfig()
    const advertisedHost = current.http.host === '0.0.0.0' ? '127.0.0.1' : current.http.host
    return {
      listening: listener !== undefined,
      url: listener?.url ?? `http://${advertisedHost}:${current.http.port}${current.http.path}`,
      mountedOnWebServer: unmountFromWebServer !== undefined,
      error: listenError,
      tokenSource: effectiveToken().source,
      settingsRegistered: binding.registered(),
    }
  }
```

It then parks that closure on the **host** ctx **[V]** — `src/index.ts:186-189`:

```ts
  // Exposed so the settings panel can render live status, and so tests can
  // observe the endpoint without reaching into the closure.
  ;(ctx as unknown as { dshAsMcpStatus?: () => EndpointStatus }).dshAsMcpStatus = status
```

**That property is not reachable from the browser half.** The browser bundle runs in the web shell
with its own Cordis `ctx`; there is no bridge that reflects arbitrary host `ctx` properties. Any
plan that depends on it will silently render nothing. **[V]** (the client bundle's require table is
the 9 seed words plus cordis services; there is no host-object mirror anywhere in
`packages/client/modules` or `packages/client/connection`).

### Recommended: Mechanism B, the in-fence exact Fetch route (smallest, verified, no schema duplication)

1. **Host**: register one exact route inside DSH's trust fence, reading the existing `status()`
   closure. Shape verbatim from a shipped monorepo user of the same API **[V]** —
   `packages/session-query/session-log-export/src/index.ts:85-104`:

   ```ts
   connectionOf(ctx).fetch.register({
     path: SESSION_LOG_EXPORT_PATH,       // '/api/session.export' — the FULL pathname
     methods: ['GET', 'HEAD'],
     requestBody: 'buffered',
     fetch: async (request) => { ... return new Response(...) },
   })
   ```

   i.e. for `dsh-as-mcp`: `path: '/api/as-mcp/status'`, `methods: ['GET']`,
   `requestBody: 'buffered'`, `fetch: async () => Response.json(status())`. Reach the service the
   way the same file does — `Reflect.get(ctx, 'connection')` — or gate on
   `ctx.inject(['connection'], ...)`; do **not** make `connection` a hard `inject` if the plugin
   must also work in compositions without a web carrier. Register inside `ctx.effect(...)` so it
   unloads with the plugin.
2. **Client**: `fetch('/api/as-mcp/status')` from the settings section, with an `AbortController`,
   on an interval (5 s is plenty for a listening indicator) and on
   `ctx.on('connection/reset', ...)`. No `inject` beyond `slots` / `locale` / `settingsScope`;
   **no** `remote`, **no** `$mount`, **no** zod, **no** `./typert` artifact, **no** descriptor
   duplication. The browser session cookie is attached automatically (same origin), so the route is
   authenticated by DSH itself. **[V]** for every API used; **[I]** for the assembled recommendation.

   Note the path must satisfy `/^\/api\/[A-Za-z0-9_$.-]+(\/[A-Za-z0-9_$.-]+)*$/`
   (`assertFetchRoute` → `endpointFromPath`, `rpc-host.ts:33`, `:292-303`, `:266-276`); `/api/as-mcp/status` does.
   Also note that with a 2-segment endpoint the gateway would have claimed it too, but the shared
   handler consults exact routes **before** the interceptor, so the exact route wins unambiguously
   **[V]** (`rpc-host.ts:125-137`, `:292-303`).

### Acceptable alternative: Mechanism A (Typert Remote) — choose it only if you want in-band typing

It is the documented, typed, cancellation-aware RPC path, and it is what a "proper" DSH plugin
does. But for four read-only scalars it costs: a hand `typertRemote` binding
(`Object.defineProperty(service,'typertRemote',{...})`), a hand `TYPERT` manifest with **zod v4**
schemas (the loader's `_zod` check), a second hand-written descriptor list in the client bundle,
and an agreed endpoint name across two files that nothing verifies. You already depend on
`zod ^4.2.0`, so the dependency cost is zero, but the duplication cost is real. Both halves must
agree exactly. Poll it the way cost-meter does.

### Do NOT

* Do not try to read `ctx.dshAsMcpStatus` from the client — different `ctx`.
* Do not `fetch` the plugin's own `http://127.0.0.1:8790/mcp` from the browser — cross-origin with
  no ACAO header anywhere in DSH or in the plugin. ✅ *(this is also the reason `mountOnWebServer`
  exists in the plugin already — keep using same-origin paths for anything the browser reads.)*
* Do not rely on the settings scope for `listening` / `url` / `error`; they are runtime facts, not
  configuration. Deriving the URL client-side from the configured host/port/path (the
  `status()` fallback branch) is a fine *display* fallback, but it cannot distinguish "bound" from
  "would be bound" — so if a route cannot be added, report configuration only and label it as
  **configured, not live**.

---

## 6. What I did NOT verify

Everything below is a claim I could **not** confirm from source or a real installed artifact.

1. **No third-party artifact was executed.** I did not run `dsh` with a plugin built for this
   investigation, and I did not observe a `$mount` or a fetch route succeed at runtime. Mechanism A
   is verified by reading the installed `dsh-cost-meter` bundle and the harness source; Mechanism B
   by reading the installed `dsh-tokenledger` source and the harness source. The running GUI returned
   `403 forbidden` for `GET /` (browser-token gate), so I could not inspect its live boot graph from
   the page itself.
2. **`dsh-cost-meter`'s `typert.host.js` registration is not observed to have happened.** The
   shipped composition contains `typert-loader` (verified by reading the app's config inside
   `app.asar`), and the artifact is present and well-formed per the loader's validator — but I did
   not see a log line confirming it registered, nor run its endpoints.
3. **Whether `ctx.connection.fetch.register` survives every carrier.** The Connection README says
   shell-owned (non-Web) carriers "dispatch the shared Fetch handler directly" and that the Host half
   "always provides … exact `GET`/`HEAD`/`POST` route registries" — so it should — but I did not
   exercise a shell-owned carrier (Electron `file://` path), and the Desktop app on this machine
   uses the HTTP origin.
4. **CORS refusal was not demonstrated in a browser.** I verified only that no
   `Access-Control-Allow-Origin` header is emitted anywhere in DSH or in `dsh-as-mcp`'s listener, and
   reasoned from the browser same-origin policy. **[I]** on the refusal itself.
5. **The monorepo-only vs third-party boundary for `tsdown`/`clientBundle` is taken from the
   workspace's own `docs/CLIENT-PLUGIN-BLUEPRINT.md` §6.3/§8** (which cites
   `packages/client/tsdown.client.ts:345`) rather than re-derived by me in this pass.
6. **Whether a third party can install `@deepseek-ai/dsh-typert-generator` from npm and run it on an
   out-of-monorepo package.** I did not test this. The generator README says publication is opt-in
   via `exports` and that `WorkspaceAnalyzer` seeds from `tsconfig.host.json` /
   `tsconfig.client.json` aggregates; the monorepo's `workspaceManifest()` is documented to throw
   for a package outside `packages/*/*`. I therefore treat "third parties hand-write the artifacts"
   as the safe statement and "third parties run the generator" as unverified. **[I]**
7. **SRC (`@Remote` marker) viability for a third-party host bundle.** I verified the gateway reads
   `remoteMethods(original)` from any service with a `typertRemote` binding, and that the protocol
   decorators are TC39 standard decorators. I did **not** build such a bundle, and I did not verify
   whether esbuild (used by both installed third-party plugins' host builds) can emit standard
   decorator semantics. Treat the decorator path as **[I]**, and prefer the strict/manual artifact
   path or Mechanism B.
8. **`ctx.typert.register()` called directly from a third-party host `apply()`** was verified as an
   existing API and as the loader's documented fallback, but not executed. Whether `ctx.typert` is
   reliably available at a third-party plugin's `apply()` time (it is registered by the `typert`
   row, which precedes `typert-loader` and `typert-gateway` in the shipped config) is **[V]** from
   the config order but **not** exercised.
9. **The client-side effect of `dsh.client.inject` package names** is repeated from the workspace
   blueprint; I did not re-derive it, and it does not affect either recommendation (both omit it).
