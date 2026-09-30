# Stub-fidelity audit: `dsh-as-mcp` host half vs. the real harness

**Bug class under audit.** Test doubles that are *more permissive* than the real service they
replace: the suite stays green while a contract violation reaches production. The inverse
(doubles that are *stricter* than reality) is also reported.

**Artifacts audited**

| What | Where |
| --- | --- |
| Plugin host half | `src/dsh/driver.ts`, `src/index.ts`, `src/settings.ts`, `src/mcp/http.ts`, `src/mcp/tools.ts` |
| Plugin tests | `tests/*.test.ts`, `tests/harness.ts` |
| Authoritative harness | `/Users/xiseliuli/test_code/dsh-harness-015` (0.1.5-rc.1) |
| Second harness | `/Users/xiseliuli/test_code/dsh-harness-ref` (0.1.7-rc.2) |
| Shipped runtime | `/Applications/DSH Desktop.app/Contents/Resources/app.asar` (bundles 0.1.5-rc.1) |

**Working-tree note.** `src/dsh/driver.ts` and `tests/driver.test.ts` were being edited
concurrently while this audit ran (the two known fixes). Everything below was checked against
the tree as of `driver.ts` 796 lines / `driver.test.ts` 338 lines, with `git diff` showing the
two-argument `create` fix in `driver.ts:370-373` and the matching stub at
`tests/driver.test.ts:53-59`. The suite is green at that revision: `103 passed (10 files)`.

**Evidence standard.** Findings marked **verified** were read line-by-line in the harness
source (and, for the highest-severity one, corroborated by `strings`-level greps inside the
shipped Desktop `app.asar`). Findings marked **inferred** are reasoned from types/docs but were
not executed, because `/Users/xiseliuli/test_code/dsh-harness-015` is unbuilt (no
`node_modules`, no `lib/`) and therefore cannot be imported from a scratch script.

---

## Ranked findings

### 1. `file_read` cannot read any file larger than the cap: `fs.readBytes` rejects, it does not truncate — HIGH, source-only

**Real contract (verified).**
`fs.readBytes(target, signal, maxBytes)` is a bounded *whole-file* read whose bound rejects:

- `dsh-harness-015/packages/fs/fs/src/index.ts:202-212` — *"a target known or discovered to
  exceed `maxBytes` fails with `FS_TOO_LARGE` instead of returning a truncated result"*.
- `dsh-harness-015/packages/fs/fs-local/src/fsio.ts:400-404` — the implementation:
  `if (info.size > maxBytes) throw new FsError('cannot read "…": N bytes exceeds the M-byte limit', 'FS_TOO_LARGE')`.
- `dsh-harness-015/packages/fs/fs-local/tests/filesystem.spec.ts:285` — the harness's own test
  asserts `readBytes(target, undefined, 3)` rejects with `FS_TOO_LARGE`.
- The truncating primitive is a *different* method, `readByteRange(target, {offset, length},
  signal)` (`fs/fs/src/index.ts:214-227`; backend `packages/fs/fs-local/src/fsio.ts:439-455`,
  wired at `packages/fs/fs-local/src/index.ts:161`),
  whose doc says the window is the bound and no more than `length` bytes are ever buffered.
- Confirmed in the shipped runtime: `app.asar` contains the literal
  `bytes exceeds the ${maxBytes}-byte limit` and `instead of returning a truncated result`.
- Identical in `dsh-harness-ref` (`packages/fs/fs/src/index.ts:217-228`).

**Plugin (source is wrong).** `src/dsh/driver.ts:544-546`:

```ts
const bytes = await fs.readBytes(target, undefined, request.maxBytes + 1)
const truncated = bytes.byteLength > request.maxBytes
const slice = truncated ? bytes.subarray(0, request.maxBytes) : bytes
```

The `+ 1` only lets the driver detect truncation for a file of size *exactly* `maxBytes + 1`.
Any file larger than `maxBytes + 1` throws `FS_TOO_LARGE` before the `truncated` computation
runs. With the default `limits.maxReadBytes = 1024 * 1024` (`src/defaults.ts:52-55`), every
`file_read` of a file over 1 MiB + 1 byte fails with
`cannot read "…": N bytes exceeds the 1048577-byte limit`.

**Production failure it allows.** The tool's own contract is the opposite:
`src/mcp/tools.ts:286-288` says *"Output is truncated at the configured byte limit"*, and
`readFile` returns `truncated: boolean` (`driver.ts:532-536`). `truncated: true` is effectively
unreachable in production, and reading a large log / generated file — the exact reason a byte
cap and a `truncated` flag exist — fails outright.

**Why the suite missed it.** There is **no `fs` stub anywhere in `tests/`** (no
`provide('fs', …)` in any test file). `DshDriver.readFile` / `writeFile` / `listDirectory` are
never executed by a test; the only `readFile` doubles are driver-level
(`tests/harness.ts:34`, `tests/live-config.test.ts:112`), which replace the code under audit
rather than the service it calls.

**Suggested change (source).** `fs.readByteRange(target, { offset: 0, length: request.maxBytes + 1 })`
and set `truncated = bytes.byteLength > request.maxBytes`. Suggested stub: add a
`provide('fs', …)` double whose `readBytes` throws `FS_TOO_LARGE` above the cap and whose
`readByteRange` windows, so the two semantics are distinguishable in a test.

---

### 2. `sessionController.selectModel` stub always resolves; the real one rejects — MEDIUM, stub wrong (source ordering questionable)

**Real contract (verified).** `dsh-harness-015/packages/api/session-controller/src/commands.ts:133-169`:
`selectModel` resolves the Agent (`:134`, throws `session/not-found`), calls
`ctx.llm.resolveCallConfig({provider, model, …})`, and maps any failure to
`RemoteError('session/model-unavailable', …)` (`:160-167`). A provider/model pair that no
adapter serves is a hard rejection.

**Stub (too permissive).** `tests/driver.test.ts:61`:

```ts
selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
```

It ignores its argument and never throws.

**Production failure it allows.** `driver.ts:370-384` does `create()` → `ownedSessions.add()`
→ `selectModel()`. With a configured-but-stale `session.provider` / `session.model`
(`src/defaults.ts:44-49`; settings panel), the session is **created and adopted**, then
`selectModel` throws, and `session_create` returns an error with no `sessionId` while a live
session exists in the DSH UI. The stub cannot express this because it never rejects.

**Source vs stub.** Stub is the fidelity gap. The source ordering is also worth a look: resolve
or validate the route before `create`, or catch the selection failure and still return
`{ sessionId, … }` with the model error reported.

**Source-side suggestion (not applied).** Wrap `selectModel` in `try/catch` and return the
`sessionId` with a `modelError` field, or pre-validate against `sessionController.modelCatalog()`
(`index.ts:262-265`). **Stub suggestion:** `selectModel` throws
`session/model-unavailable` for a sentinel provider such as `'unserved'`.

---

### 3. `sessionController.prompt` stub ignores every precondition the real command enforces — MEDIUM, stub wrong (source partially)

**Real contract (verified).** `dsh-harness-015/packages/api/session-controller/src/commands.ts:302-329`:

| Precondition | Real behaviour |
| --- | --- |
| content non-empty after trim | throws `gateway/bad-request`, *"prompt content must include non-whitespace text or an attachment"* (`:65-67`, `:303-309`) |
| `clientTimeZone` valid | throws `session/invalid-time-zone` (`:310-319`) |
| session resolves | `resolveAgent` may resume or throw `session/not-found` (`:320`) |
| selected provider routable | throws `session/model-unavailable`, *"no adapter serves provider …"* (`:322-329`) |
| signal not already aborted | `index.ts:345-349` `signal.throwIfAborted()` |

Field-by-field against the plugin's object (`driver.ts:428-436`):
`requestId` ✅ (`SessionRequestId` is a type-only brand — `types.ts:373`; a runtime string is
correct), `sessionId` ✅, `mode: 'queue' | 'steer'` ✅, `content: [{type:'text', text}]` ✅
(matches `PromptContentPart`, `types.ts:310-318`). The harness commits it exactly as the plugin
assumes: `source = { kind: 'user', rpcId: request.requestId, … }` (`commands.ts:330-334`), which
is what `locateTurn` (`driver.ts:657-671`) keys on. All five confirmed present in `app.asar`.

**Stub (too permissive).** `tests/driver.test.ts:62-67` records the id, appends the message and
returns `{accepted: true}` — no validation of content, mode, session existence, provider route
or signal.

**Production failure it allows.** `src/mcp/tools.ts:229` accepts `prompt: z.string().min(1)`, so
`"   "` (whitespace only) passes the suite and fails in production with `gateway/bad-request`.
The provider-not-routable path is likewise invisible. Both surface as tool errors, so this is a
"wrong answer / untested error path" issue rather than a broken happy path.

**Suggested stub change.** Throw the real bad-request message when every text part trims to
empty; add one case that makes `prompt` throw `session/model-unavailable` for a sentinel session.
**Source suggestion:** tighten the schema to reject whitespace-only prompts.

---

### 4. `sessionController.cancel` stub always accepts; the real one requires a live Agent — LOW, stub wrong

**Real contract (verified).** `commands.ts:493-511`: `ctx.agents.get(sessionId)`; when
`undefined` it throws `session/not-found`, *"session "…" not found (not attached)"* (confirmed in
`app.asar`). Only a live Agent is cancellable.

**Stub (too permissive).** `tests/driver.test.ts:68` `cancel: () => ({ accepted: true })` (and
`tests/apply.test.ts:395`). It never throws.

**Production failure it allows.** `session_cancel` on a session that was created but has no live
Agent returns `{accepted: true}` in the suite and a `session/not-found` tool error in production.
The documented use — stop a *running* turn (`src/mcp/tools.ts:272-277`) — is unaffected.

**Suggested stub change.** Throw unless the id is the session the stub knows is live.

---

### 5. `session_create { cwd }` with a relative path passes the stub and fails the real header validator — LOW-MEDIUM, source + stub

**Real contract (verified).** `SessionHeader.cwd` must be an **absolute** path:
`dsh-harness-015/packages/core/session/src/index.ts:111-115` throws
`session header cwd must be an absolute path, got "…"`. `sessionController.create` forwards
`request.cwd` straight into the session metadata (`commands.ts:87-101`); nothing resolves it.

**Plugin (source).** `driver.ts:370-373` forwards `request.cwd` verbatim. The tool describes it
as *"Bare directory to bind the session to"* (`src/mcp/tools.ts:188`), while the sibling
`workspace_create.path` is documented as absolute and `driver.createWorkspace` explicitly
absolutizes a relative path (`driver.ts:281`). A caller reasonably passes a relative `cwd` and
gets a raw header-validation error.

**Stub (too permissive).** `tests/driver.test.ts:53-59` checks only "not both"; it accepts any
string as `cwd`. (The workspace-name case is faithful: `driver.ts:358-367` resolves
`cwd = workspace.path` for the reply only and sends `{ workspaceId }` alone, matching
`commands.ts:87-90`.)

**Suggested change.** Absolutize `cwd` in `createSession` (as `createWorkspace` does) and/or say
"absolute" in the schema; stub-side, reject a non-absolute `cwd`. Note the real `create` also
accepts *neither* argument and falls back to `process.cwd()`
(`session-controller/src/index.ts:124`, `commands.ts:101`), so the plugin's
`provide either workspaceId or cwd` guard (`driver.ts:355-357`) is deliberately stricter than the
harness — a defensible choice, not a bug, but it means `session_create {}` fails where the
harness would succeed.

---

### 6. `workspaceRegistry.create` stub does not model "path must be an existing directory" — LOW, stub wrong (nearly unreachable)

**Real contract (verified).** `packages/workspace/workspace/src/index.ts:157-163`:
`realpathNormalize` (fully-qualified only, `paths.ts:59-67`) then
`if (!(await stat(canonical)).isDirectory()) throw new Error('cannot create a workspace at …: path is not a directory')`.

**Stub (too permissive).** `tests/apply.test.ts:112` returns a synthetic workspace for any path.
The plugin `mkdir`s first when `createDirectory !== false` (`driver.ts:289-294`), so the
nonexistent case is mostly pre-empted; the unmodeled case is a path that exists as a **file**,
where the real `mkdir` throws `EEXIST` and the real `create` would throw "not a directory".
Its `resolveByPath` double (`tests/apply.test.ts:104-111`) is faithful for the ENOENT case that
matters (verified: `workspace/src/index.ts:269-282`) but uses `existsSync`, so it is *more*
permissive than `realpathNormalize` for relative paths (real rejects with `TypeError`).

**Suggested stub change.** Throw when the path is not a directory. Cosmetic today.

---

### 7. `inspect` / `readSession` doubles return partial shapes — INFO, faithful for what is consumed

- Real `inspect` returns `{ meta, inheritedEventCount, events }`
  (`session-controller/src/index.ts:201-214`; `session-persistence/src/index.ts:78-89`).
- Real `readSession` returns `{ session, inheritedEventCount, events }` with a **cloned**
  header and cloned, replay-validated events (`session-query/src/index.ts:177-196`;
  `types.ts:49-56`).
- Stubs: `tests/driver.test.ts:69` `inspect: async () => ({ events: log })` (no `meta`, no
  `inheritedEventCount`); `:77` `readSession: async () => ({ session: {}, inheritedEventCount: 0, events: log })`.

The driver reads only `.events` (`driver.ts:502-510`), so both are faithful *for the consumed
field*. Note the stub hands back the **live array**, whereas the real method clones — but the
real read is also live-fresh (`session-query/src/corpus.ts:91-98` prefers
`ctx.sessions.get(sessionId)`), so polling still sees events immediately. A future use of
`session.cwd` / `session.agentPreset` or of `meta` would be silently untested by these empty
headers.

*Inferred, not verified:* real `readSession` also runs `Session.create(...)` over the snapshot
for replay validation on every poll. Whether an in-progress live turn can fail that validation
(and thus make a poll throw) was not executed; it is worth a targeted test against a real
harness.

---

### 8. Cross-version: `settings.installSection` is the 0.1.5 API and does not exist in 0.1.7-rc.2 — INFO, no action for today's target

**0.1.5-rc.1 (authoritative).** `dsh-harness-015/packages/settings/settings/src/index.ts:461-496`
declares `installSection<const Namespace, T>(owner, ns, schema, entry, hooks)`; the hooks are
`{ setSource(current: () => T): void; onChange(): void; validate?: (value: T) => void }`
(`:871-893`); `ns` must be a lowercase hyphenated identifier (`:470`).
`src/settings.ts:221-241` matches exactly on all five arguments and on all three hook shapes,
and `SETTINGS_NAMESPACE = 'dsh-as-mcp'` satisfies the namespace rule. Installed Desktop evidence:
`app.asar` contains 17 occurrences of `installSection`.

**0.1.7-rc.2 (ref).** The service was replaced: `packages/settings/settings/src/index.ts` exposes
`configure` / `describe` / `update` / `replace` / `mutate` over Cordis profile patches, and there
is **no** `installSection`, `register`, `watch` or `section`. On that release
`settings.installSection(...)` throws a `TypeError` inside the async IIFE, which
`src/settings.ts:245-250` catches and logs; `registered()` stays `false`, no panel entry appears,
and the plugin keeps running from its composition configuration. That is graceful degradation,
not a crash — but the panel silently disappears on a 0.1.7 profile.

**Verdict.** The stub (`tests/settings.test.ts:40-58`) models the 0.1.5 contract only, which is
correct for the target runtime. No finding against the plugin today; recorded because the task
asked for both harnesses.

---

## Services confirmed faithful (no mismatch found)

- **`workspaceRegistry`** — service key, synchronous `get(id): Workspace | undefined`
  (`index.ts:165-172`), synchronous `list(): Workspace[]` (`:174-188`), `create(path, title?)`
  (`:141-163`), and the entity fields the driver reads (`id` — not `workspaceId` — `path`,
  `title`, ISO-8601 `createdAt`/`updatedAt`, `sessionIds`, async `status()`; `types.ts:32-112`).
  `toWorkspaceInfo` (`driver.ts:325-337`) reads all of them correctly.
- **`sessionController.list({}, signal)`** — the first argument's real type is
  `SessionListRequest { readonly cursor?: string }` (`api/session-controller/src/types.ts:242-244`),
  so `{}` **is** a valid filter (the method is `list(_request, signal)`, `index.ts:216-225`).
  The row field is `sessionId`, not `id` (`types.ts:196-207`), and `updatedAt` is a **number** —
  the driver reads both correctly (`driver.ts:398-404`), while `WorkspaceInfo.updatedAt` correctly
  stays a string.
- **`sessionController.selectModel` return path** — `result.selected.provider` /
  `result.selected.model` matches `SessionSelectModelValue { selected: ModelSelection }`
  (`types.ts:276-284`), where `ModelSelection` adds an optional `reasoningEffort` the plugin
  ignores (`driver.ts:380-381`). *Stub-side only:* the double never rejects (finding 2).
- **`sessionController.create` argument rule** — the known "not both" bug is fixed in
  `driver.ts:370-373` and now modelled by the stub (`tests/driver.test.ts:53-59`).
- **`sessionController.inspect` / `sessionQuery.readSession`** — method names, arity and the
  `events` field all match; `readSession` exists on the `sessionQuery` service
  (`session-query/src/index.ts:105, 183`).
- **`fs` argument/return *shapes*** (apart from finding 1's semantics) — `resolve(path, {cwd})`
  (`fs/fs/src/index.ts:107-116`), `processPath` (`:118-126`), `stat → FsInfo | undefined`
  (`:159-165`, `types.ts:70-83`), `listDir → FsDirEntry{name,type,size?,target,version?}`
  (`:229-236`, `types.ts:100-115`), `writeText(target, content) → {operation, version, before, after}`
  (`:238-256`, `types.ts:127-144`). The driver passes the documented optional `cwd` and omits
  `expected`/`sandboxPolicy` deliberately.
- **`shell`** — every option name matches: `command`, `workdir`, `timeoutMs`, `signal`
  (`shell/shell/src/types.ts:38-79`); the driver correctly maps its own `cwd` → `workdir`
  (`driver.ts:620-625`). `resolve()` → `ShellExecSpec` then `run(spec)` is the documented pairing
  (`shell/shell/src/index.ts:78-92`). Result fields `exitCode`, `signal`, `timedOut`, `aborted`,
  `timeoutMs`, `stdout.text`, `stdout.truncated`, `stderr.*` all exist
  (`types.ts:112-138`; `CollectedOutput` in `subprocess/subprocess/src/types.ts:22-29`), and the
  driver reads exactly those. `timeoutMs` is silently clamped to the executor's `maxTimeoutMs`
  (`util/timeout/src/index.ts:45-55`, `shell/bash-local/src/index.ts:157-161`) and the result
  does not expose the effective value to the MCP caller — cosmetic only, not a fidelity bug.
- **`agents`** — the plugin only probes existence (`driver.ts:188, 213`); it calls **no** method
  (`get`, `cancel`, `whenIdle` are declared in `types.ts` but unused). Service key `'agents'` is
  real (`core/agent/src/index.ts:255-256`). The approval answerer's
  `request.agent.session.id` (`src/index.ts:258-263`) is real: the public `Agent` exposes `id`
  (`core/agent/src/types.ts:13-15`) and the runtime face augments it with `readonly session: Session`
  (`core/agent/src/runtime-types.ts:164-168`).
- **Turn-attribution event shapes** — `turn/start {turn}` and `turn/end {turn, reason}` with
  `reason.kind === 'aborted'` (`core/session/src/types.ts:276-285`, `:196-224`);
  `user/message` carrying `source.kind === 'user'` + `rpcId` (`commands.ts:330-334`);
  `assistant/message {message.content}` (`types.ts:321-329`); `tool/call {callId, name, arguments}`
  (`:341`). Everything `locateTurn` / `summarizeTurn` / `readTranscript` matches on is real.
- **`ctx.webServer.register`** — `{kind, path, handler} → () => void`, duplicate `(kind, path)`
  throws (`host/webserver/src/index.ts:42-48, 159-173`). The test double
  (`tests/apply.test.ts:239-245`) mirrors it.
- **`connection.fetch.register`** — `{path, methods, requestBody, fetch} → () => Promise<void>`
  (`client/connection/src/rpc.ts:116-135`; host side `rpc-host.ts:97-99, 140-156`). The plugin's
  route `STATUS_ROUTE = '/api/dsh-as-mcp/status'` (`src/status.ts`) satisfies
  `assertFetchRoute` / `endpointFromPath` (`rpc-host.ts:266-275, 292-303`), including the
  multi-segment `dsh-as-mcp` spelling. The double returns a sync disposer where the real service
  returns a Promise (`tests/apply.test.ts:285-289`) — harmless, `ctx.effect` accepts both.
- **`approval/request` waterfall** — signature `(req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>)`
  (`interaction/user-approval/src/types.ts:76-91`). The listener is dispatched through
  `scopeTarget(req.agent, req.agent)` (`user-approval/src/index.ts:273`), and an *untagged*
  listener — which the plugin's `apply` context is — is admitted globally
  (`core/scope/src/index.ts:170-185`). Returning `'allowed-once'` and delegating with `next()` are
  both correct.
- **`settings.installSection`** — exact match on 0.1.5-rc.1 (see finding 8).

---

## Inverse check: stubs *stricter* than reality

**None found.** Every stub that rejects was checked against the real reject:

- `tests/driver.test.ts:53-59` throws only for the `workspaceId` + `cwd` combination, which
  `commands.ts:87-90` throws for.
- `tests/apply.test.ts:104-111` throws ENOENT for a missing path, which `realpathNormalize`
  does (`workspace/src/index.ts:269-282`); if anything it is *more* permissive (relative paths,
  non-directory paths).
- `tests/settings.test.ts:46` asserts `owner instanceof Context`, which mirrors the real
  `owner: Context` parameter (`settings/src/index.ts:472-478`).

No stub forces the source into an unnatural shape or hides working code.

---

## The structural reason these survived

The plugin's doubles are layered in a way that leaves the highest-risk seam untested:

1. **`fs` and `shell` have no service double at all.** No test calls `provide('fs', …)` or
   `provide('shell', …)`. Finding 1 lives there.
2. **The `session` doubles are minimal.** `fakeSessions` (`tests/driver.test.ts:37-79`)
   implements only `create/list/selectModel/prompt/cancel/inspect` and none of their
   preconditions; `fakeWorkspaceRegistry` (`tests/apply.test.ts:82-114`) implements
   `list/get/resolveByPath/create`.
3. **The "round trip" smoke test never touches a real harness.**
   `tests/smoke-script.test.ts:66-74` runs `scripts/smoke.mjs --prompt` against
   `stubDriver()` (`tests/harness.ts:12-49`), so it exercises the MCP transport, not the harness
   contract. A smoke run against a real DSH is the only thing that would have caught findings
   1–5 — which is exactly how the original two were found.

Cheapest high-value next step: add `provide('fs', …)` and `provide('shell', …)` doubles that
enforce the real preconditions (`FS_TOO_LARGE` on `readBytes` over the cap, `workdir`/
`timeoutMs` option names, output-field names), plus the two one-line `prompt` /`selectModel`
rejections from findings 2 and 3. Each is a few lines and would have failed against the current
source before its fix.

---

## Counts

| Class | Count |
| --- | --- |
| Real mismatches (findings 1–6) | **6** |
| — source wrong (finding 1) | 1 |
| — stub wrong (findings 2, 3, 4, 6; finding 5 both) | 5 |
| Informational only (findings 7, 8) | 2 |
| Stubs stricter than reality | 0 |
| Services confirmed clean | `agents`, `shell`, `sessionQuery`, `sessionController.list`, `sessionController.selectModel` shape, `webServer`, `connection.fetch`, `approval/request`, `settings.installSection` (0.1.5) |

**Primary-use-case verdict.** None of the six remaining mismatches breaks the README's headline
flow (`workspace_create → session_create → session_prompt`) the way the two already-fixed bugs
did. The most severe, finding 1, breaks a documented and commonly used *tool* path —
`file_read` of any file over `limits.maxReadBytes + 1` (1 MiB + 1 by default), where the tool
promises truncation and the source produces `FS_TOO_LARGE`. Findings 2–6 turn edge cases and
error paths into untested territory rather than breaking the happy path.
