/**
 * The client-service surface this bundle uses, declared locally.
 *
 * A third-party client bundle can `require` only nine seeded specifiers, and
 * `@deepseek-ai/dsh-client-ui-slots` is one of them — but its *types* are not
 * published usefully (npm's `latest` for that package is a stale 0.0.1-rc.1),
 * and none of the services below are `require`-able objects anyway: they arrive
 * through Cordis injection on the context.
 *
 * So the surface is declared here rather than imported, and every member cites
 * the harness source it was read from. This is deliberately the *minimum* this
 * panel touches — if a member is not needed to render or write a field, it is
 * not declared, so there is nothing to drift silently.
 *
 * @module dsh-as-mcp/client/contract
 */

/** One redacted secret slot. `set` is all the host ever tells us. */
export interface SettingsSecretView {
  readonly path: readonly string[]
  readonly set: boolean
}

/** One namespace in the raw describe mirror. */
export interface SettingsNamespaceView {
  readonly ns: string
  readonly secrets: readonly SettingsSecretView[]
}

/**
 * The raw describe mirror.
 *
 * Needed only for secrets: the bound scope's snapshot drops the `secrets`
 * sidecar, so "is a token set?" can only be answered here.
 * `ui-settings/src/client/settings-scope.ts:267-269` exposes `describe()`, and
 * `settings/src/redact.ts:50-53` is where the literal is replaced by `{path,set}`.
 */
export interface SettingsDescribeSnapshot {
  readonly view?: { readonly namespaces: readonly SettingsNamespaceView[] } | undefined
}

/** What a shared configuration form publishes. */
export interface SettingsScopeSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** The resolved value: schema defaults, then the composition base, then the user layer. */
  readonly value: T | undefined
  /** The inherited layer beneath the user's overrides. */
  readonly base?: T | undefined
  /** The raw user layer, absent when the entry carries no override. */
  readonly user?: T | undefined
  readonly revision: number | undefined
  readonly writable: boolean
  readonly mode: 'host' | 'memory'
}

/**
 * One write operation.
 *
 * The shape is `settings/src/types.ts:61`:
 * `{op:'set'; path:string[]; value:JsonValue} | {op:'unset'; path:string[]}`.
 * `set(field, value)` only reaches a top-level scalar, so nested writes go
 * through `mutate` with an explicit path.
 */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/**
 * One shared configuration form, as `configForms.get()` returns it.
 *
 * `ui-settings/src/client/config-forms.ts` builds one per Host entry id and
 * shares it between every editor of that entry, so two surfaces editing the same
 * namespace cannot silently overwrite each other.
 */
export interface ConfigForm<T> {
  /** @returns the current snapshot; the reference is stable until a change. */
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  /**
   * Queue one atomic namespace mutation.
   * @returns whether the Host accepted it, after any recovery read.
   */
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean>
}

/**
 * The `configForms` service, injected on the client context.
 *
 * This is what DSH 0.2.0-rc.2 replaced the old `settingsScope` service with: the
 * namespace is the Host plugin **entry id**, and the same service carries the
 * describe mirror that answers "is a secret set?".
 */
export interface ConfigFormsService {
  /** Get the shared form for one Host plugin entry id. */
  get<T>(namespace: string): ConfigForm<T>
  /** The shared describe mirror, for cross-namespace reads such as secret slots. */
  describe(): { getSnapshot(): SettingsDescribeSnapshot }
  /**
   * Run `register` while the Host serves any of `namespaces`, and stop when none
   * is served any more — so a deployment that never composed the owner shows no
   * trace of the page. The caller owns the returned disposer.
   */
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => (() => void) | undefined | void,
  ): () => void
}

/** The `slots` service, injected on the client context. */
export interface SlotService {
  /**
   * Run `callback` while a slot declaration is live, re-running it if the
   * declaration arrives late or is re-declared. `ui-renderer/src/client/registry.ts:172-240`.
   * @returns the disposer ending the injection.
   */
  inject(name: string, callback: () => unknown): () => void
  /** Register into an already-declared slot. */
  register(options: {
    readonly name: string
    readonly id: string
    readonly order?: number
    readonly label?: () => string
    readonly locale?: string
    readonly inject?: () => unknown
  }, component: unknown): unknown
}

/** The `locale` service, injected on the client context. */
export interface LocaleService {
  /**
   * The single-locale untyped form, for namespaces outside the merge table —
   * which is every third-party namespace. `locale/src/client/index.ts:369-371`.
   */
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  /** A stable translate function for one namespace. `locale/src/client/index.ts:436-445`. */
  bind(ns: string): (key: string) => string
}

/**
 * The browser plugin context.
 *
 * `locale`, `slots`, and `configForms` are declared because this bundle lists
 * them in `inject`, so Cordis has resolved them before `apply` runs. Everything
 * else is resolved through `get`, so a profile missing one yields `undefined`
 * instead of a throw or a wait — mirroring the host half.
 */
export interface ClientContext {
  readonly locale: LocaleService
  readonly slots: SlotService
  readonly configForms: ConfigFormsService
  get(key: string): unknown
  effect(callback: () => void | (() => void), label: string): void
}
