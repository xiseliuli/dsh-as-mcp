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

/** What a bound namespace scope publishes. */
export interface SettingsScopeSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: T | undefined
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

/** A namespace scope bound on the caller's fiber. */
export interface SettingsScope<T> {
  /** @returns the current snapshot; the reference is stable until a change. */
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** The `settingsScope` service, injected on the client context. */
export interface SettingsScopeService {
  bind<T>(spec: { readonly namespace: string }): SettingsScope<T>
  describe(): { getSnapshot(): SettingsDescribeSnapshot }
}

/** The `slots` service, injected on the client context. */
export interface SlotService {
  /**
   * Run `callback` while a slot declaration is live, re-running it if the
   * declaration arrives late or is re-declared. `ui-renderer/src/client/registry.ts:172-240`.
   */
  inject(name: string, callback: () => unknown): void
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
 * Services are resolved through `get` rather than declared as properties, so a
 * profile missing one yields `undefined` instead of a throw or a wait. This
 * mirrors the host half, which resolves every capability the same way.
 */
export interface ClientContext {
  readonly locale: LocaleService
  readonly slots: SlotService
  get(key: string): unknown
  effect(callback: () => void | (() => void), label: string): void
}
