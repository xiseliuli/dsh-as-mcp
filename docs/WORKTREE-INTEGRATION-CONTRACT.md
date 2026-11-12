# Worktree integration contract: worktree-per-session for `dsh-as-mcp`

**Question.** How should this host-side Cordis plugin implement *worktree-per-session* against the
installed **DeepSeek Harness 0.2.2-rc.1** — a `session_create` that can put the new session in a
Git worktree, a `worktree_create` for an existing session, a `worktree_restore`, and worktree /
working-directory state in `session_list` and `session_status` rows?

**Artifacts**

| What | Where |
| --- | --- |
| Installed runtime (authoritative) | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`, version **0.2.2-rc.1** (`dsh/desktop-runtime.json`) |
| Service/type catalog | `/tmp/dsh-inspect/api-catalog.js` — generated AST walk of every mounted Cordis service and every serialized wire type in that runtime |
| Extracted package sources | `/tmp/dsh-inspect/dsh/node_modules/@deepseek-ai/*` (same bytes as inside the asar) |
| Profile actually installed | `/Users/xiseliuli/.dsh/profiles/desktop/package.json` (`dsh.profile.bundles`) |
| Plugin under change | `src/dsh/driver.ts`, `src/dsh/types.ts`, `src/mcp/tools.ts`, `src/mcp/availability.ts`, `src/config.ts` |

**Evidence standard.** *verified* = read first-hand in the source named. *inferred* = reasoned from
types or docs without execution. Nothing below was executed against the harness; the harness
version is a release candidate and this document records one exact build.

Citations are abbreviated; every abbreviation resolves under the asar root
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/`:

| Tag | Path (under the asar root) |
| --- | --- |
| `WT` | `dsh/node_modules/@deepseek-ai/dsh-experimental-worktree/lib/index.js` (527 lines) |
| `WT-RM` | `dsh/node_modules/@deepseek-ai/dsh-experimental-worktree/README.md` |
| `API` | `/tmp/dsh-inspect/api-catalog.js` |
| `SCA` | `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js` |
| `SCC` | `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js` |
| `SCH` | `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/history/controller.js` |
| `SCI` | `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` |
| `SCW` | `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js` (wire declarations) |
| `WD` | `dsh/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js` |
| `WS` | `dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js` |
| `SIDEBAR` | `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` |
| `FORGE` | `dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-forge/lib/index.js` |
| `FORGEC` | `dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-forge/lib/client.js` |
| `LOOP` | `dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` |
| `SP` | `dsh/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js` |
| `SEV` | `dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js` |
| `BASE` | `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` |
| `FORGEBUNDLE` | `dsh/node_modules/@deepseek-ai/dsh-experimental-forge-bundle/cordis.patch.yml` |
| `RUNTIME` | `dsh/desktop-runtime.json` |

---

## 0. Verdict (what the Lead must build against)

| Question | Answer | Evidence |
| --- | --- | --- |
| Service key / shape | `ctx.worktrees`, a Cordis `Service` whose name is `worktrees`; two methods, `create` and `restore` | `WT:201-208`, `WT:253`, `WT:278`, `API:4604-4620` |
| Agentless form? | **No.** Both methods take a live `Agent`; it selects the source repository, supplies the sandbox policy, and is mutated by `create` (working directory change) | `WT:247-251`, `WT:301-302`, `WT:359` |
| Is `resolveAgent(sessionId)`'s result the real live Agent? | **Yes** when it returns `agent`: it is `ctx.agents.get(sessionId)` or a just-`resume`d, published `Agent`. It satisfies every member the worktree service dereferences. But on a **cold** session it *resumes/wakes* it, and can fail `session/writer-held` / `session/agent-busy` | `SCA:162-214`, `SCA:284-327`, `LOOP:511-650`, `API` `AgentHandle` |
| Freshly created session | `sessionController.create` returns only `{sessionId, agentPreset}` but the Agent it was built from is published before the call resolves; `resolveAgent`/`ctx.agents.get` return the live agent without resuming | `SCC:112-149`, `SCA:450-472`, `SCA:174-176`, `LOOP:1609-1622` |
| Sidebar grouping after entering a worktree | **Same workspace group iff the session was created with `workspaceId`.** Membership is computed from the *durable session header `cwd`*, which a working-directory change never rewrites. A session created with bare `cwd` was never in a workspace group; it stays in the **Ungrouped** bucket | `WS:102-105`, `WS:111-127`, `WS:367`, `WS:875-895`, `SIDEBAR:1027-1045` |
| Created directly *at* the worktree path | Its own group **only** if a workspace registration exists at that path and the session was created with that `workspaceId`; otherwise Ungrouped | `WS:367`, `SIDEBAR:1027-1045` |
| State reading for list/status | Rows from `sessionController.list()` already carry `projections` hints (`workingDirectory`, `forgeWorktree`); per-session exact read is `sessionController.projections({sessionId})`; robust fallback is folding `working-directory/change` from the durable log the driver already reads | `SCI:2730-2790`, `SCH:116-155`, `SCW:3712`, `SEV:82` |
| `forgeWorktree` host-side? | **Yes**, read-only, when the forge bundle is mounted: it is a host-registered projection unit (`key: "forgeWorktree"`), visible in projection snapshots, list hints, and the `projections` Remote. No forge Remote is needed. Its wire view is `null` unless the session's live directory is at/under the created worktree | `FORGE:931-950`, `FORGE:2670-2678`, `SCW:3107-3108` |
| Feasibility here | Yes, but **optional**: the forge bundle inserts the service; the desktop profile lists that bundle. Probe `serviceOf(ctx,'worktrees')`, never `inject`, and degrade with a named capability error | `FORGEBUNDLE:1-19`, profile `package.json`, `RUNTIME` sharedPackages, `src/dsh/driver.ts` `serviceOf` pattern |
| Version scope | Worktree service observed only in **0.2.2-rc.1**. The plugin peer range is `>=0.1.5-rc.1`, so every worktree path must be behind a runtime probe; the README needs one compatibility note | `package.json` peer range; §7 |

**Three gotchas that decide the implementation** (detail in §1.4, §2.2, §5):

1. **`resolveAgent` is not a read.** On a session that is not loaded it resumes the Agent: opens the
   session log, mounts the preset, takes the single-writer handle, publishes an Agent. Use
   `ctx.agents.get(sessionId)` first for an existing session (the forge panel itself does exactly
   that and answers `forgePanel/session-busy` when the session is not loaded, `FORGE:3118-3133`);
   only fall back to `resolveAgent` and document the wake-up.
2. **The durable header `cwd` is the grouping key, not the live directory.** `create` sets the
   header through `meta.cwd`; `working-directory/change` only moves the live directory and
   projection. Create with `workspaceId` to get group membership; `cwd` produces an Ungrouped
   session, and creating *with the worktree path* does not by itself create a group.
3. **The worktree service never rolls back and never serializes.** A failure after `git worktree
   add` keeps the branch and checkout and says so in the error; two concurrent `create` calls for
   one session both run (the service has no per-session lock; only the later *directory commit* is
   serialized, by the working-directory service). The plugin must serialize per session and surface
   retained artifacts.

---

## 1. The `ctx.worktrees` contract

### 1.1 Mount, service key, injections, config

`WorktreeService extends Service`, registered as `super(ctx, "worktrees")` (`WT:201-208`,
`WT:221-222`). It requires these providers in the same execution world (`WT:202-208`);
`ctx.worktrees` appears only where all of them are mounted:

```js
static inject = ["workingDirectory", "fs", "subprocess", "sandbox", "sandboxPolicy"]
```

Config schema and defaults (`WT:209-217`), validated at construction (`WT:224-234`):

| Field | Default | Constraint |
| --- | --- | --- |
| `directory` | `.agents/worktrees` | relative directory, no `.`/`..`/empty segments, no `\` or `:` |
| `namePrefix` | `dsh-` | must start a valid relative Git branch name, not `-` |
| `gitCommand` | `git` | non-empty |
| `nodeCommand` | `node` | non-empty |
| `timeoutMs` | `60000` | positive safe integer, applied **per command** via `deadline()` (`WT:144`) |
| `graceMs` | `3000` | positive safe integer |
| `maxOutputBytes` | `65536` | positive safe integer; over-cap output fails the command (`WT:177`) |

The desktop profile does not override them: the forge bundle inserts the row without config
(`FORGEBUNDLE:1-3`) and no profile patch sets `worktree` config (desktop profile
`cordis.patch.yml` has no `worktree` row). Treat a non-default `directory` as a
plugin-visible hazard, not an assumption: `restore` re-validates against the pool *currently*
configured (§1.4).

### 1.2 `create(agent, request?, signal?, onPhase?)`

Signature (`WT:253`; canonical prose in `API:4609`, `WT-RM` "Use this package"):

```ts
create(
  agent: Agent,
  request?: { name?: string; from?: string },
  signal?: AbortSignal,
  onPhase?: (phase: 'prepare' | 'checkout') => void,
): Promise<CreatedWorktree>

interface CreatedWorktree {   // API:6017-6020
  path: string            // canonical absolute checkout path (the committed working directory)
  branch: string          // the new branch
  baseCommit: string      // resolved full commit object name
  repositoryRoot: string  // canonical top level of the source checkout
}
```

Sequence, verified line by line (`WT:299-367`):

1. `onPhase?.("prepare")` (`WT:300`).
2. `cwd = await ctx.workingDirectory.ensure(agent, signal)` (`WT:301`) — the session's **live**
   directory; a session whose directory disappeared is first recovered to its header `cwd` (§2.3).
3. `policy = ctx.sandboxPolicy.resolve({ session: agent.session })` (`WT:302`).
4. `git check-ref-format refs/heads/<branch>` (`WT:304`); `git rev-parse --show-toplevel` in `cwd`
   → `repositoryRoot` (`WT:305-310`) — **fails here for a non-repository**.
5. `git rev-parse --verify --end-of-options <from|HEAD>^{commit}` in `repositoryRoot` →
   `baseCommit` (`WT:311-316`) — a revision that does not resolve fails here.
6. `git show-ref --verify --quiet refs/heads/<branch>` → error `worktree branch already exists: <branch>` (`WT:317-322`).
7. `pool = resolve(directory, {cwd: repositoryRoot})`; `path = resolve(branch, {cwd: pool})`;
   `lstat(path)` → error `worktree path already exists: <path>` (`WT:323-333`).
8. `prepareDirectory` — a sandboxed Node child (`WT:11-29`, `WT:476-485`) creates the pool (with a
   self-ignoring `.gitignore` only when it created it) and `mkdir(path)` exclusively.
9. `git worktree add --no-checkout -b <branch> -- <path> <baseCommit>` (`WT:336-347`), then
   `onPhase?.("checkout")` and `git reset --hard --no-recurse-submodules <baseCommit>` with filter
   overrides (`WT:348-357`).
10. Return `{ path: await ctx.workingDirectory.set(agent, path, signal), branch, baseCommit,
    repositoryRoot }` (`WT:358-363`). **The returned `path` is the canonical committed directory, and
    the session has already moved.**

Failure semantics: any error after the pool/path walk lands in `WT:364-366`:
`Could not finish worktree <branch> at <path>. Any created checkout and branch are retained. <cause>`.
Nothing is rolled back — no branch delete, no checkout remove, no `.gitignore` cleanup.

Name generation when `request.name` is omitted (`WT:42-45`, `WT:289-298`): `<namePrefix>` + first 8
hex of the first UUID in the session id, hyphen, 2 random bytes as 4 hex — e.g.
`dsh-6b1f02c4-9a3e`; a session id without a UUID gets 8 random hex. `name` is validated by the
same path rule as `directory` plus `startsWith('-')` (`WT:291`) — note it allows `/`, so
`feat/x` is both a branch and a nested directory.

### 1.3 `restore(agent, request, signal?, onPhase?)`

Signature (`WT:278`; `API:4615`):

```ts
restore(
  agent: Agent,
  request: { path: string; branch: string; baseCommit: string; repositoryRoot: string },
  signal?: AbortSignal,
  onPhase?: (phase: 'prepare' | 'checkout') => void,
): Promise<RestoredWorktree>

interface RestoredWorktree { path: string; branchRecreated: boolean }  // API:7893-7898
```

Preconditions and mutations, in order (`WT:368-463`):

| Check | Failure text |
| --- | --- |
| `lstat(path)` must find nothing | `worktree path already exists: <path>` (`WT:372`) |
| `path`, `repositoryRoot` resolve to the exact given spellings; `path` must be inside `directory`-rooted pool and not the pool itself | `worktree restoration must use a canonical directory inside the configured pool` (`WT:373-382`) |
| `branch` valid relative branch name | `worktree branch must be a relative Git branch name` (`WT:383`) |
| `baseCommit` matches `^(?:[a-f\d]{40}|[a-f\d]{64})$` | `worktree baseCommit must be a full commit object name` (`WT:384`) |
| `git check-ref-format`; `repositoryRoot` must equal `git rev-parse --show-toplevel` | `worktree repositoryRoot must be the source checkout root` (`WT:385-390`) |
| `baseCommit` must resolve in the repository | raw Git error via `runCommand` (`WT:391-396`) |
| For a registration of this path: must not be `locked` | `worktree is locked: <path>` (`WT:397-419`) |
| Missing registration is removed with `git worktree remove -- <path>` (only this target) | raw Git error |
| `show-ref --verify refs/heads/<branch>`: if missing → `branchRecreated = true` and the branch is recreated at `baseCommit`; else the existing branch is checked out | — (`WT:420-445`) |
| `onPhase?.("checkout")`, `git reset --hard` | wrapped `Could not restore worktree <branch> at <path>. Any created checkout and branch are retained. <cause>` (`WT:460-462`) |

Restore **does not change the calling session's working directory** (`WT:271-272`, `WT:456-459`
returns `{path, branchRecreated}` only). Uncommitted changes lost with the directory are not
recovered (`WT:268-271`).

### 1.4 The `Agent` requirement

The service takes `agent: Agent` but structurally dereferences exactly these members:

| Member | Use | Evidence |
| --- | --- | --- |
| `agent.session` | passed as `{ session }` to `sandboxPolicy.resolve`; `agent.session.id` seeds the generated name | `WT:290`, `WT:302`, `WT:370` |
| `agent.session.id` | `generatedWorktreeName(prefix, agent.session.id)` | `WT:290`, `WT:42-45` |
| `agent.session.append(...)` (durable event) | **indirect**, through `workingDirectory.ensure`/`set` → `commit` | `WD:99`, `WD:143` |
| `agent.session.header.cwd` | **indirect**, fallback original directory on recovery | `WD:102` |
| `agent.ctx.fiber.assertActive()` | **indirect**, before committing/returning the change; throws if the agent's fiber is no longer active | `WD:97`, `WD:140`, `WD:162` |
| `agent.inject(message)` | **indirect**, queues the directory-change notice; a throw is caught and logged, never fatal | `WD:152-155` |
| `agent.status` / `agent.runMaintenance` | **not used by the worktree service**; used by the forge panel to serialize with turns (`FORGE:3118-3133`) | `LOOP:554`, `LOOP:586` |

`LOOP:511-650` shows the concrete agent these were written against: `ReactLoopAgent` with
`id`, `session`, `ctx` (`this.ctx = this.scope.ctx`, `LOOP:543`), `inject` (`LOOP:576-581`),
`runMaintenance` (`LOOP:586-611`), `status` (`LOOP:554-556`), `whenIdle` (`LOOP:634-639`).

**Is the object from `sessionController.resolveAgent(sessionId)` that agent? Yes.**

- `resolveAgent` → `resolve` → first branch `liveAgent(sessionId)` returns
  `{ agent: this.ctx.agents.get(sessionId) }` (`SCA:173-176`, `SCA:276-283`).
- Otherwise it calls `resume`, which observes the session, composes the agent preset, and calls
  `this.ctx.agents.resume({ resumeSessionId, agentOptions, setup })`; the returned
  `AgentHandle.agent` is the published live Agent (`SCA:284-327`, `LOOP:1710-1778`,
  `API` `AgentHandle = { agent: Agent; dispose(): Promise<void> }`).
- `ctx.agents.create`/`resume` are documented as resolving "after setup, rollback-covered
  publication, and loop start complete" (`API` `agents` service; `LOOP:1609-1622`,
  `dsh-agent/lib/index.js:582-600`). At that point `agent.ctx.fiber` is active, so
  `assertActive()` passes.
- `resolveAgent` maps failures to stable RemoteErrors (`SCA:194-213`):
  `session/not-found`, `session/agent-busy` (subagent-owned session),
  `session/writer-held` (`SessionAlreadyOwnedError` — another DSH process holds the writer),
  `gateway/internal`.

**Side effects of calling it on a cold session** (this is the part to design around):
the session log is opened with write ownership, `interruptedTurnClosers` may be appended
(`LOOP:1740-1745`), the preset is mounted, the Agent is published, and the session becomes loaded
in this process. That is a *wake*, not a read. For a freshly created session the agent is already
live, so none of this happens — but for `worktree_create` on an arbitrary existing session it
does. The forge panel deliberately does **not** resume: `maintain()` looks up
`this.home.agents.get(session.id)` and throws `forgePanel/session-busy` ("The Session is not
loaded") when absent (`FORGE:3118-3133`).

Recommended resolution ladder (mirrors both precedents):

```ts
// 1. Freshly created session (session_create { worktree }): the agent is live.
const live = serviceOf<DshAgentRegistry>(ctx, 'agents')?.get(sessionId)
// 2. Existing session: prefer the live agent; fall back to resolveAgent only because the
//    plugin's stated contract is "works for any session it owns", and say so in the reply/docs.
const agent = live ?? (await controller.resolveAgent(sessionId))   // may wake; may writer-held
```

On error `'error' in found`, report the RemoteError text verbatim; the codes are actionable
(`session/writer-held` ⇒ another DSH process/window holds it; `session/agent-busy` ⇒ subagent
routing owns it, use subagent delivery).

Version tolerance: `resolveAgent` itself is optional on the plugin's hand-written controller type
(`src/dsh/types.ts` already declares it optional); a host without it cannot create worktrees at all
(no agentless form) — report that as the `agents`/`worktrees` capability error, not a crash.

### 1.5 What can go wrong with the Agent (targeted list)

| Situation | What happens | Evidence |
| --- | --- | --- |
| Agent unpublished (session cold, profile has `worktrees` but caller passed a stale handle) | `agent.ctx.fiber.assertActive()` throws; the service's promise rejects before/at the directory commit. In `create`, the throw can land after Git setup → retained artifacts + wrapped error | `WD:97`, `WD:140`, `WT:364-366` |
| Agent disposed/unloaded between resolution and use | same `assertActive()` failure; nothing in the service retries with a fresh agent | `WD:97`, `WD:162` |
| Session held by another DSH process | `resolveAgent` → `session/writer-held`; there is no worktree capability to use without an agent | `SCA:207-209` |
| Subagent-owned session (`origin: 'subagent'` or owned by a parent's agent) | `resolveAgent` → `session/agent-busy`; must be driven through subagent delivery, not this plugin | `SCA:106-121`, `SCA:194-199` |
| Session not found / archived-unknown | `resolveAgent` → `session/not-found`; the plugin's `assertSessionVisible` also fails closed for out-of-scope sessions | `SCA:194-196`, `src/dsh/driver.ts` `assertSessionVisible` |
| Resume side effect on a session with queued work | resume does not run a turn, but publishes an agent and can append interrupted-turn closers; an external caller that only wanted status has now woken the session | `LOOP:1740-1745` |

---

## 2. Working directory vs header `cwd`, and workspace grouping

### 2.1 Two different directories

| | Durable header `cwd` | Live committed working directory |
| --- | --- | --- |
| Where | `SessionHeader.cwd`, set at creation from the create request's `meta.cwd` (`SCC:112-149`, `SCA:456-472`; creation path `mkdir(cwd)` first) | `working-directory/change` session event, `{ cwd: string }` (`WD:143`, event type registered at `SEV:82`) |
| Mutability | immutable after creation | every `workingDirectory.set`/`ensure` recovery |
| Read | `session.header.cwd`; session summaries `cwd` field; workspace path index | `workingDirectory` projection (init = `header.cwd ?? null`, `WD:38`), or fold the log |
| Consumer | sandbox policy workspace root (`SP:166-174`), workspace membership (`WS:875-895`) | `workingDirectory.get()` (`WD:80-82`), system prompt text, model-visible notices |

`workingDirectory` service facts, verified:

- projections unit: `key: "workingDirectory"`, `stateVersion: 1`,
  `init: (header) => header.cwd ?? null`,
  `apply: (state, event) => event.type === "working-directory/change" ? event.data.cwd : state`,
  wire view = the absolute path or `null` (`WD:31-44`).
- `get(session)` reads the projection without I/O (`WD:80-82`); `set(agent, path)` canonicalises,
  stats, commits the event, and queues a user notice; returns the canonical path (`WD:117-124`).
- `ensure(agent, signal)` validates the current directory; when it is missing it restores
  `agent.session.header.cwd ?? defaultDirectory` and returns that (`WD:91-107`).
- System-prompt contribution: context name `working-directory:current`, order
  `WORKING_DIRECTORY`, `required: true`, `interpolate: false`, text
  ``Current working directory: "<path>".`` (`WD:45-51`, `WD:125-127`). During assembly it calls
  `ensure(agent)` first and rewrites the text (`WD:52-69`).
- The commit also injects a model-visible notice with `source.kind === 'working-directory'`
  ("The working directory changed from X to Y." / "... is unavailable. The working directory is now
  Y."), and a failed inject only warns (`WD:138-156`). Forge's `agent/pre-step` hook moves that
  notice into the first step's messages (`FORGE:1428-1443`); for an MCP-created worktree no hook
  moves it, so the notice rides along with the first prompt.

Because `create` finishes with `workingDirectory.set` (`WT:359`), **a worktree-created session has
`header.cwd` = the source directory and live dir = the worktree path**, and the returned
`CreatedWorktree.path` is that canonical live path.

### 2.2 Grouping proof: the sidebar groups by header-derived path accounting

Chain, each link verified:

1. **Path index is built from the durable header.** `WorkspaceRegistry` waits for
   `sessionPersistence`, builds one canonical-`cwd` header index at init
   (`WS:391-399`, `WS:758-807`) and re-indexes live sessions from `ctx.sessions` headers
   (`WS:900-903`). `indexHeader` stores `sessionPaths.set(header.id, realpathNormalize(header.cwd))`
   when the path is a directory; ENOENT goes to `missingSessionPaths`; anything else is invalid
   (`WS:875-895`).
2. **Membership candidate test reads that index.** `candidateMatches(id, path) =
   sessionPaths.get(id) === path || missingSessionPaths.has(id)` (`WS:367`); `WorkspaceEntity.sessionIds`
   filters the durable account by it (`WS:102-105`).
3. **Attach validates the header, not the live directory.**
   `attachSession` reads the session header and requires `realpath(header.cwd) === record.path`
   before adding the id (`WS:111-127`). The session controller calls exactly this after
   `create({workspaceId})` (`SCC:140-147`).
4. **Nothing re-indexes on a directory change.** The only `working-directory/change` consumer in the
   workspace package is… none: `WS` has no subscription to it (grep over `WS` for
   `working-directory` returns nothing). The index is header-only and updated by
   `rememberSessionPath` (attach) / `indexHeader` (init, header read) (`WS:367-371`, `WS:916-926`).
5. **The UI groups by the account.** `groupByWorkspace` emits one group per workspace, members
   resolved strictly from `workspace.sessionIds`; anything not accounted goes to a single
   `buildGroup("", undefined, undefined, …, "", orderedUngrouped(...))` bucket
   (`SIDEBAR:1027-1045`; owner lookup `SIDEBAR:875-877`).

**Consequences**

| Creation call | Sidebar group before worktree | After `worktrees.create` | After a DSH restart |
| --- | --- | --- | --- |
| `session_create { workspaceId }` (recommended) | that workspace | **same workspace** — header cwd unchanged, `candidateMatches` still true, sidebar reads `sessionIds` | **same workspace** — re-indexed from header cwd |
| `session_create { cwd }` with no workspaceId | Ungrouped bucket | **still Ungrouped** (it never had a group; the header is the same bare directory) | Ungrouped |
| `session_create { cwd: <worktree path> }` | Ungrouped unless a workspace is registered at that path; if a workspace exists there and the call used its `workspaceId`, that separate group | that group (it is the header path) | that group |
| `workspace_create(<worktree path>)` then `session_create { workspaceId }` | its own group | its own group | its own group |

So: **the operation the Lead wants — "several sessions in the same sidebar workspace group, each
in its own worktree" — requires `workspaceId` on `session_create`.** Passing `cwd` is the headless
escape hatch and must not be advertised as grouping. (Sidebar even keys blank "New Session" rows off
`summary.cwd === workspace.path` plus membership, `SIDEBAR:1426`.)

Also note the sandbox consequence of header-based policy: `sandboxPolicy.resolve({session})` sets
`workspaceRoot = session.header.cwd` (`SP:166-174`). A worktree under
`<repositoryRoot>/.agents/worktrees/...` is writable only because `repositoryRoot` lies at or under
the header cwd (e.g. header cwd = repo root). If a session is bound to a *subdirectory* of the repo,
Git runs confined to that subdirectory and writes to the shared Git metadata/destination can be
refused — the same rule the forge panel checks as `blockerOf`: `danger-full-access` → no blocker;
`read-only` → `"read-only"`; otherwise `within(policy.workspaceRoot, checkoutRoot) &&
within(policy.workspaceRoot, commonDir)` else `"outside-writable-root"` (`FORGE:1797-1801`).

### 2.3 When the worktree directory is deleted

Two layers react:

1. **Working-directory service, on any use.** `ensure(agent)` finds the live directory missing,
   restores `header.cwd` (the source checkout), commits a new `working-directory/change`, injects
   the recovery notice, and returns the source directory (`WD:91-107`, notice text `WD:143-151`).
   This is why a later `worktrees.create` on such a session succeeds *from the source checkout*
   instead of failing: `createCheckout` starts with `ensure` (`WT:301`). **Correction is lazy,
   though:** `workingDirectory.get()` does no I/O (`WD:80-82`), so the projection keeps naming the
   deleted path until the next `ensure` (system-prompt assembly, any turn, or a worktree call).
   Treat `session_status.workingDirectory` as "the committed path", not "a path that exists".
2. **Forge panel, for UI sessions.** It watches `created.path` containment and, when the Session
   is inside the missing checkout, holds the next message's turn during a restoration attempt;
   `restoreWorktree`/`continueInProject` decide recovery (panel doc `FORGE:1509-1520`,
   `FORGE:3016-3052`, `missingWorktree` helper `FORGE:1868-1910`). An MCP-created worktree has no
   forge record, so this hold does not apply; the restore is the MCP caller's explicit job
   (`worktree_restore`).

The bare `workingDirectory` projection cannot tell you *which* worktree was there (the record is not
in it). That is exactly what `forgeWorktree` adds for UI-created worktrees.

---

## 3. Forge UI behavior to mirror

### 3.1 The host-side orchestration (this is the reference implementation)

`dsh-experimental-client-ui-forge` has a host half (`FORGE`) and a client half (`FORGEC`). The
host half is where all worktree behavior lives; the browser only selects a base branch and renders.

**Record and projection** (`FORGE:891-1017`):

- Plugin record type `plugin:client-ui-forge/worktree` (`FORGE:894`) appended to the session log via
  `appendPluginRecord(session, WORKTREE_RECORD, data)`; actions:
  `{action:'request', from: string|null}`, `{action:'cancel'}`, `{action:'created', worktree}`,
  `{action:'restoring'}`, `{action:'restored'}` (`FORGE:902-917`).
- Projection unit `forgeWorktree`, `stateVersion: 4`, state
  `{request, created, locked, stepped, restoring, cwd}`; `init` seeds `cwd` from `header.cwd`;
  `apply` locks on `turn/start`, marks `stepped` on `step/start`, tracks
  `working-directory/change` into `cwd`, and applies records only during open windows
  (`FORGE:931-1017`).
- Wire view: `state.created !== null && state.cwd !== null && within(state.created.path, state.cwd) ?
  state.created : null` (`FORGE:946-949`). Created worktree fields: `path`, `branch`, `from`,
  `baseCommit`, `repositoryRoot` (`FORGE:902-908`, wire type `SCW:3107-3108`).
- Registered on the host context: `scope.sessionProjections.register(forgeWorktreeProjection)`
  (`FORGE:2670-2678`); panel config `worktreePrefix` defaults `"dsh-"` (`FORGE:2617-2630`).

**New-Session worktree creation timing** (`FORGE:1058-1075` doc, `FORGE:1267-1310`,
`FORGE:1428-1443`):

1. UI calls `forgePanel.requestWorktree(session, from|null)` → appends `{action:'request', from}`,
   rejects with `forgePanel/session-started` after a turn started or a worktree was created, and
   `forgePanel/session-busy` while a creation runs (`FORGE:2954-2967`).
2. Creation happens **either** while the first message waits in the inbox (a hold registered from
   `agent/inbox/inserted`, `FORGE:3063`) **or** at the first step proposal for a message no hold
   took (`preStep` step===1, request open, nothing created yet — `FORGE:1428-1443`).
3. `createCheckout` (`FORGE:1270-1310`): `ctx.get("worktrees")` (error "No worktree service is
   mounted" → RemoteError `forgePanel/worktrees-unavailable`), branch =
   `generatedWorktreeName(this.prefix, session.id)`, `worktrees.create(agent, {name, from?}, signal,
   onPhase)` (phases update live creation status), then appends
   `{action:'created', worktree:{path,branch,from,baseCommit,repositoryRoot}}`.
4. Failures become `CreationFailure` with `{branch, phase, reason, cause}` and stay visible until
   a retry (`forgePanel.retryWorktree`) or withdrawal; a waiting message keeps waiting
   (`FORGE:1363-1386`).

**Restore flow** (`FORGE:1233-1257`, `FORGE:3016-3030`): appends `{action:'restoring'}`, calls
`worktrees.restore(agent, created, signal, onPhase)` where `created` is the *record itself*
(exactly the four fields the service needs), appends `{action:'restored'}`, and reports failure as
`forgePanel/restore-failed`. `continueInProject` instead calls
`ctx.workingDirectory.set(agent, created.repositoryRoot)` (`FORGE:3045-3052`). Both run inside
`maintain()` = `agent.runMaintenance(...)` so they are serialized against turns, or inside the
wait of a message that is already held (`FORGE:3118-3133`).

**Selectors and glyphs** (client-only): base branch list comes from the host Remote
`forgePanel.branches(session)` → `{current, branches}` using the session's policy (`API:1266-1390`
`forgePanel` entry, `FORGE:266-296`); the row glyph is `IconBranchOutlineRegular` rendered when the
session list row's `projectionValues.forgeWorktree` is non-null (`FORGEC:10462-10470`,
`FORGEC:10551-10562`); toasts/notifications are browser copy (restore succeeded/failed, "session
already started", branches failed — `FORGEC` locale strings around `10420-10445`). None of this is
host API; it observes the projection the host publishes.

### 3.2 Host APIs (reusable) vs client-only orchestration

| Piece | Host API (reusable from any plugin) | Client-only |
| --- | --- | --- |
| Create/restore/enter a worktree | `ctx.worktrees.create/restore`, `ctx.workingDirectory.set` | — |
| Branch/base selectors | `forgePanel.branches` Remote (needs a `Session`, returns `{current, branches}`) | rendering, default selection |
| Worktree request/record/projection | record schema + `sessionProjections.register` pattern | — |
| Track "created" worktree for UI | `forgeWorktree` projection (request/created/restoring/restored), read via projections | React icon, hover card, toasts |
| Timing relative to turns | `agent.runMaintenance` / `agent.inject` / inbox holds | which click triggers what |
| Restore/leave decisions | `ctx.fs.lstat`, `ctx.workingDirectory.get`, git via sandboxed subprocess | confirmation dialogs |

**Do not call `forgePanel` Remotes from `dsh-as-mcp`.** They are an experimental sibling package's
surface, take a live `Session` object (not a session id), are UI-shaped (`follow` streams, panel
state), and their creation is asynchronous (returns before the worktree exists). Mirror the same
host primitives instead.

### 3.3 Can a host plugin read `forgeWorktree`? Yes — three faces (all read-only)

1. **Session list hints (free).** `sessionController.list()` is implemented by
   `SessionListController`: per live session it returns
   `hintsOf('sequenced', sessionProjections.snapshot(session, summaryKeys()))`; per cold session
   `hintsOf('cached', sessionProjectionCache.cachedSnapshot(header, summaryKeys()) ??
   cachedPredecessorTitle)` (`SCI:2888-2898`, `SCI:2730-2748`, `SCI:2784-2792`). `summaryKeys()` is
   every registered client-visible unit that does not declare `summary: false` (`API:2920-2925`);
   `forgeWorktree` and `workingDirectory` both qualify (their wire specs declare no `summary`
   flag — `FORGE:946-949`, `WD:40-44`). So each `SessionSummary` row carries

   ```ts
   interface SessionProjectionHints {                     // SCW:3707-3708
     readonly kind: 'cached' | 'sequenced'
     readonly asOfSeq: number
     readonly values: Partial<SessionProjectionSummaryValues>
     // values.workingDirectory?: string | null
     // values.forgeWorktree?: { path; branch; from: string|null; baseCommit; repositoryRoot } | null
   }
   ```

   `kind: 'cached'` means the row is a durable checkpoint that may lag (never wrong);
   `kind: 'sequenced'` means it reflects the live sequence.
2. **Per-session exact read without activating.** `sessionController.projections({sessionId},
   signal)` (`API:2750`, `SCH:116-155`) returns
   `{kind:'sequenced', asOfSeq, values}` for a live session (`sessionProjections.snapshot(live)`,
   **no key filter**, so every registered client-visible unit), `{kind:'migration-required',
   values}` cached hints for a migration-pending cold session, and `null` for an unknown session.
   Cancellation → `gateway/cancelled`; other failures → `gateway/internal`.
3. **Direct service access (what a plugin can call in-process).**

   ```ts
   ctx.sessionProjections?.snapshot(session, keys?)      // API:2914, sync, live Session only
   ctx.sessionProjectionCache?.cachedSnapshot(header, keys?) // API:2853, zero-I/O, header identity
   ctx.sessionQuery?.observeSession(sessionId, {projectionMode:'all'}) // default 'all'
   ```

   `observeSession` defaults to `projectionMode: "all"` and populates `observation.projections`
   (`SessionObservation.projections?: ProjectionSnapshot = {asOfSeq, values}` — the repo already
   uses this for `tokenUsage`); live sessions get `sessionProjections.snapshot(session)` (all units)
   and cold ones get the cached-row-seeded fold (`session-query/lib/index.js:351,477-482`).
   `SessionProjectionValues = Partial<SessionProjectionMap> & Readonly<Record<string,
   SessionProjectionValue>>` (`SCW:3744`), and the map declares
   `workingDirectory: string | null` and `forgeWorktree: ForgeSessionWorktree | null`
   (`SCW:3711-3712`), so both keys are typed and present when the units are registered.

**Caveat that decides the design:** `forgeWorktree` exists only while the **forge bundle** is
mounted (it is the unit's only registrant — `FORGE:2676`); without it the key is absent and
`controller.projections` simply has no `forgeWorktree` value. `workingDirectory` always exists in a
normal profile because the base bundle mounts `working-directory` (`BASE:166-176`). So:

- "Did the MCP plugin create a worktree here?" → remember the `CreatedWorktree` the service returned
  (or read `forgeWorktree` for UI-created ones, opportunistically).
- "Where does this session work right now?" → `workingDirectory` (projection or log fold) — this is
  the version-robust primitive; `forgeWorktree.created` adds the branch/base/repository identity.

---

## 4. Feasibility inside `dsh-as-mcp`

### 4.1 Probe, mount, degrade

- Key: `worktrees`. Probe exactly like every other optional service:
  `serviceOf<DshWorktreeService>(this.ctx, 'worktrees')` — the repo's `serviceOf` helper
  (`src/dsh/types.ts`, the `serviceOf` helper) and the `DshCapabilityError` pattern already used for `tools`,
  `shell`, `costMeter`.
- **Desktop profile: mounted as of 0.2.2-rc.1.** Evidence: the profile's bundle list contains
  `@deepseek-ai/dsh-experimental-forge-bundle`
  (`/Users/xiseliuli/.dsh/profiles/desktop/package.json`, `dsh.profile.bundles`), that bundle ships a
  loader patch that inserts `id: worktree, name: @deepseek-ai/dsh-experimental-worktree` and
  `id: tool-worktree` (`FORGEBUNDLE:1-8`), the package exists in the runtime manifest
  (`RUNTIME.sharedPackages`, 0.2.2-rc.1) and in the `@deepseek-ai/dsh` dependency table, and the
  desktop profile's own patch file has no `worktree` id at all (it sets `dsh-as-mcp disabled:
  false` and one config row per UI/LLM plugin; nothing disables or overrides the inserted worktree
  row). The same bundle also
  nests a second, isolated worktree service inside its `optional-forge-panel` group
  (`FORGEBUNDLE:10-19`); a plugin outside that group sees the **top-level** `worktrees` row.
  *Unverified*: that the loader's bundle composition actually mounts it in this user's running
  window at this moment (no live composition artifact was available — the profile's `cordis.yml` is
  intentionally empty `[]`); the probe at call time is authoritative.
- **Degrade:** when absent, do not fail plugin load and do not advertise the worktree tools as
  available; `session_create { worktree }` should fail *before* creating a session (a capability
  that is known-absent is a validation failure, unlike a Git failure — see §6.3), with a message
  naming the bundle ("enable 变更请求与工作树 / @deepseek-ai/dsh-experimental-forge-bundle").
- Never `inject: ['worktrees']`: this plugin is a capability bridge that must load in bare
  profiles (README "Capability detection, not `inject`").

### 4.2 What `dsh_info` should probe

Three probes cover the feature end to end (names follow the in-flight implementation; add them to
`DshDriver.describeCapabilities()`, `src/dsh/driver.ts`):

```ts
// ctx.worktrees exists at all — create/restore, both of which need it
worktrees: serviceOf<DshWorktreeService>(this.ctx, 'worktrees') !== undefined,
// the agent bridge that both worktree calls need (resolveAgent is additive)
agentResolve: typeof (this.sessionController() as { resolveAgent?: unknown })?.resolveAgent === 'function',
// a projection read that reports workingDirectory / forgeWorktree for status & list
sessionViews: typeof this.sessionQuery()?.observeSession === 'function'
  || typeof (this.sessionController() as { projections?: unknown })?.projections === 'function',
```

The repo idiom is `serviceOf<T>(ctx, 'worktrees')` — the existing `private worktreeService()`
already does exactly this, so the first line is already satisfied by the in-flight code.

`toolAvailability` (`src/mcp/availability.ts`): the **in-flight implementation folds the two tools
into the existing `session` group and gates them per tool** —

```ts
GROUP_TOOLS.session = [..., 'worktree_create', 'worktree_restore', ...]
REQUIRED_CAPABILITIES = {
  session_create: ['sessionController'],                                  // unchanged: worktree is a field
  worktree_create: ['sessionController', 'agentResolve', 'worktrees'],
  worktree_restore: ['sessionController', 'agentResolve', 'worktrees'],
}
CAPABILITY_LABEL = { worktrees: 'a worktree service (the forge bundle in DSH Desktop/Web)',
                     agentResolve: 'sessionController.resolveAgent()',
                     sessionViews: 'readable session projections' }
```

That is correct and is the simpler choice: availability is per *tool*, so an absent experimental
service marks only the two worktree tools unavailable while `session_create` stays available (its
`worktree` field is documented as needing the service, and a runtime failure is reported as
`worktreeError`). A separate `worktree` toggle would buy only the ability to hide the tools while
keeping the field — not worth a config surface. Keep `tools.session: false` as the single switch;
also add the two non-blocking notes the in-flight code has: one for `worktrees` absent
(`"session_create { worktree } reports worktreeError ... sessions still work in the workspace
directory itself"`) and one for `sessionViews` absent (`"session_status/session_list cannot report
workingDirectory ..."`).

`session_create` stays reachable without `worktrees` (session creation still works); its optional
`worktree` field is documented as requiring the service and reported by `dsh_info` as
`harnessServices.worktrees`. Suggested `dsh_info` note:
`"worktree_* and session_create { worktree } need the experimental worktree service, which the forge bundle provides."`

### 4.3 Tool group / config surface

No new `ToolToggles` key (see §4.2): fold the two tools into `tools.session` and gate each with
`REQUIRED_CAPABILITIES`. If a future release wants independent hide-ability, add
`tools.worktree` in `ToolToggles` and the normalizer (`src/config.ts:78-103`,
`src/config.ts:392-399`) and register the two tools inside `if (enabled.worktree)` — but the
field-only capability (`session_create { worktree }`) then needs its own rule, which is exactly the
complexity the folded design avoids.

---

## 5. Failure and concurrency matrix

All texts are the literal strings the installed build produces; wrap them in the plugin's own
sentence (the driver already wraps `selectModel` failures the same way).

| Situation | Behavior / exact message | Source |
| --- | --- | --- |
| Not a git checkout | `git rev-parse --show-toplevel` fails inside `runCommand` → `worktree command failed (<code>): fatal: not a git repository …`; nothing is allocated yet (branch check-format runs first and succeeds) | `WT:304-310`, `WT:137-192` |
| Session's cwd is a **linked worktree** | `repositoryRoot` is that linked checkout's top level; the pool is nested inside it (`<linked>/.agents/worktrees/...`). Supported; a second nested worktree of the same repo is created under the first. Do not assume `repositoryRoot` is the main checkout | `WT:305-310`, `WT-RM` "when it is a linked checkout, the pool is nested inside it" |
| Session bound to a **subdirectory** of the repo (or `read-only` / `workspace-write` outside-writable-root) | Git/Node confined by `sandboxPolicy.resolve({session})`, whose `workspaceRoot` is the **header** cwd: writes to the repo root/shared Git dir can be refused; the failure is the sandbox's/`runCommand`'s message. Pre-check with the forge panel's rule (`read-only` → `"read-only"`; else workspace root must contain checkout root and `--git-common-dir`) | `SP:166-174`, `WT:146-169`, `FORGE:1797-1801` |
| `git` or `node` missing in the execution world | `subprocess.resolveExecutable`/`spawn` failure inside `runCommand`; also `prepareDirectory` needs Node | `WT:146-169`, `WT:476-485`, `WT-RM` "Execution requirements" |
| Existing branch | `worktree branch already exists: <branch>` | `WT:317-322` |
| Existing checkout path | `worktree path already exists: <path>` (also the restore precondition) | `WT:333`, `WT:372` |
| Bad `from` | `worktree command failed (128): fatal: ambiguous argument …` / `unknown revision`; the session is untouched | `WT:311-316` |
| Bad `name` | `worktree name must be a relative Git branch name` (also for `directory`-like traversal: `\`, `:`, empty/`.`/`..` segments) | `WT:196-199`, `WT:291` |
| Invalid or absent `namePrefix`/`directory` config | service construction throws at mount (`worktree: directory must be …`, `worktree: namePrefix must …`) — whole plugin row fails, not a tool call | `WT:224-234` |
| Cancellation (`signal.aborted`) | `operationSignal.throwIfAborted()` → `AbortError`; if it lands after Git setup, artifacts are retained (same wrapping as below); MCP cancellation should surface as a cancelled tool call, not a generic failure | `WT:254-255`, `WT:279-280` |
| Timeout | per-command `deadline(signal, config.timeoutMs)`, default 60 s; `WORKTREE_TIMEOUT` error through `deadline` | `WT:144-145` |
| Failure after Git setup (hooks/filters checked out partly) | `Could not finish worktree <branch> at <path>. Any created checkout and branch are retained. <cause>` — no rollback | `WT:364-366` |
| Failure after restore Git setup | `Could not restore worktree <branch> at <path>. Any created checkout and branch are retained. <cause>` | `WT:460-462` |
| Restore with existing path | `worktree path already exists: <path>` | `WT:372` |
| Restore of a locked registration | `worktree is locked: <path>` | `WT:411` |
| Restore with a path outside the configured pool / non-canonical spelling | `worktree restoration must use a canonical directory inside the configured pool` | `WT:373-382` |
| Restore with wrong `repositoryRoot` | `worktree repositoryRoot must be the source checkout root` | `WT:386-390` |
| Restore with short/baseCommit garbage | `worktree baseCommit must be a full commit object name` (40 or 64 hex) | `WT:384` |
| Restore when the directory already exists but is empty/garbage | still fails (lstat), even if it is not a checkout | `WT:372` |
| Restore leaves the session directory unchanged | reply `{path, branchRecreated}`; no `working-directory/change` | `WT:271-272`, `WT:456-459` |
| Session's live dir deleted before `create` | `workingDirectory.ensure` recovers to **header cwd** and commits a change; creation then runs from the source checkout, silently not from the deleted worktree | `WD:91-107`, `WT:301` |
| Two concurrent `create` calls for one session | Not serialized by the service (the `pending` set only exists for disposal). Both enter Git work concurrently; they can race on Git's own repository/worktree locks and on the destination directory, and the final live directory is whichever `workingDirectory.set` commits last (`WD:157-168` serialises only the per-session directory commits, after the Git work). The **plugin** must serialize per session | `WT:253-263`, `WT:219-239`, `WD:157-168` |
| Interleaving with a running turn | `create` commits a durable `working-directory/change` and injects a notice mid-turn; the next step sees the new directory, the current request does not. Safe but surprising. Forge avoids it by running inside `agent.runMaintenance` (throws `agent "<id>" already has active work` when busy). Since this plugin's sessions are created blank, the only risk is `worktree_create` on a busy session — refuse or use maintenance | `WD:117-156`, `LOOP:586-611`, `FORGE:3118-3133` |
| Session owned by another DSH process | `resolveAgent` → `session/writer-held` ("another owner holds the writer"): no worktree op is possible from this process | `SCA:207-209` |
| Subagent-owned session | `resolveAgent` → `session/agent-busy`; use subagent delivery | `SCA:106-121`, `SCA:194-199` |
| Session not found | `resolveAgent` → `session/not-found`; also the plugin's ownership scope may reject first for `session.scope: "owned"` | `SCA:194-196` |
| Agent fiber inactive / disposed agent | `agent.ctx.fiber.assertActive()` throws during the directory commit (possibly after Git setup) | `WD:97`, `WD:140`, `WD:162` |
| Profile without the service | `serviceOf(ctx,'worktrees') === undefined`; pre-validate and refuse (recommended) or return `worktreeError` after creating the session | §1.1, §4.1 |
| Worktree service mounted but `workingDirectory`/`fs`/`sandbox*` absent | the service row cannot mount at all (static `inject`), so this is a profile-composition error, not a call error | `WT:202-208` |

---

## 6. Recommended recipe (plugin level)

### 6.1 Internal interfaces to declare (`src/dsh/types.ts`)

The current work-in-progress additions already match the verified shapes; keep them and add the
projection-reading members. Keep `DshAgentHandle` opaque and type both service methods with it —
the runtime guarantees the members in §1.4 because the only agents the plugin passes are live,
resolved ones (same convention as `DshToolRegistry.execute({agent})`).

```ts
/** CreatedWorktree — WT:358-363 / API:6017-6020. */
export interface DshWorktreeRecord {
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly repositoryRoot: string
}

/** RestoredWorktree — WT:456-459 / API:7893-7898. */
export interface DshRestoredWorktree { readonly path: string; readonly branchRecreated: boolean }

/** ctx.worktrees — WT:253, WT:278. */
export interface DshWorktreeService {
  create(agent: DshAgentHandle,
    request?: { name?: string; from?: string },
    signal?: AbortSignal,
    onPhase?: (phase: 'prepare' | 'checkout') => void): Promise<DshWorktreeRecord>
  restore(agent: DshAgentHandle,
    request: DshWorktreeRecord,
    signal?: AbortSignal,
    onPhase?: (phase: 'prepare' | 'checkout') => void): Promise<DshRestoredWorktree>
}

/** SessionProjectionHints — SCW:3707-3708; only the keys this plugin reads. */
export interface DshSessionProjectionHints {
  readonly kind: 'cached' | 'sequenced'
  readonly asOfSeq: number
  readonly values: Partial<{
    workingDirectory: string | null
    forgeWorktree: DshForgeWorktree | null
  }> & Readonly<Record<string, unknown>>
}

/** ForgeSessionWorktree — SCW:3107-3108 (wire view of the forgeWorktree projection). */
export interface DshForgeWorktree extends DshWorktreeRecord { readonly from: string | null }

/** Additive members on the controller (both optional: older hosts lack them). */
interface DshSessionControllerProjections {
  projections?(request: { readonly sessionId: string }, signal: AbortSignal): Promise<
    | { readonly kind: 'sequenced'; readonly asOfSeq: number; readonly values: Readonly<Record<string, unknown>> }
    | { readonly kind: 'migration-required'; readonly values: Readonly<Record<string, unknown>> }
    | null
  >
}
```

Also extend the existing `DshSessionSummary` with
`readonly projections?: DshSessionProjectionHints` (the wire row has it — `SCW:3819-3826`), and
add `projections?` to `DshSessionQuery.observeSession` usage only if you read it directly (the repo
already declares `DshSessionObservation.projections?: DshProjectionSnapshot`).

Public reply types in `driver.ts` (already started): `WorktreeInfo extends DshWorktreeRecord { from:
string | null }` (null = source `HEAD`, the forge convention — `FORGE:902-916`), `WorktreeReply =
WorktreeInfo & {sessionId}`, `RestoreWorktreeReply = {sessionId, path, branchRecreated}`.

### 6.2 `session_create { worktree }` — order of operations

```ts
async createSession(request /* + worktree?: {name?, from?} */) {
  // 0. Validate everything that is knowable before a session exists (existing precedent:
  //    provider/model half-pair is refused before create, driver.ts "Validated before the
  //    session exists").
  if (request.worktree !== undefined) {
    requireWorktreeService()                     // no service ⇒ refuse, no orphan session
    assertWorktreeRequest(request.worktree)      // name: relative branch-ish; from: non-empty
  }
  // 1. Create the session exactly as today, bound to workspaceId or cwd. The durable header
  //    cwd is now the workspace/directory and membership is already committed for workspaceId.
  const created = await controller.create({ workspaceId|cwd, agentPreset })  // SCC:112-149
  this.rememberOwnedSession(created.sessionId)

  // 2. Create + enter the worktree, before model selection/approval so the session is in its
  //    final directory when the route is installed. The agent is live: no resume side effect.
  let worktree, worktreeError
  if (request.worktree !== undefined) {
    try {
      worktree = await this.createWorktree({ sessionId: created.sessionId, ...request.worktree })
    } catch (error) {
      // 3. Partial-failure policy = the modelSelectionError precedent: the session is real and
      //    usable; report the failure in the reply and log it. Retry is worktree_create.
      worktreeError = `the session was created, but its worktree was not: ${reason(error)}`
      this.log.warn(...)
    }
  }
  // 4. selectModel / applyApprovalPolicy unchanged (both resolve the now-live agent).
  // 5. Reply: sessionId, cwd (the CREATED directory, not the worktree), agentPreset, model,
  //    workingDirectory (read after step 2: worktree.path on success, cwd on failure),
  //    worktree | worktreeError, approval fields.
}
```

Why after create and not before: the worktree service needs a live `Agent`, and for a new session
that agent only exists after `controller.create` (`SCC:112-149` → `SCA:450-472` → published). Why
before `selectModel`: `selectModel` resolves the same agent; ordering avoids two resolves on a
session that is already loaded, and makes any model/approval failure happen in the final directory.

Reply convention: `cwd` must stay the **creation** directory (it is what the caller passed / what
the workspace means); put the live directory in `workingDirectory` and the record in `worktree`,
never overload `cwd`.

### 6.3 `worktree_create` for an existing session

```ts
async createWorktree(request: { sessionId; name?; from?; signal? }): Promise<WorktreeReply> {
  await this.assertSessionVisible(request.sessionId, 'worktree_create')   // ownership scope
  const worktrees = this.requireWorktreeService()                         // capability error
  const controller = this.requireSessionController()

  // Serialize per session in this plugin (the service does not).
  return await this.serializeWorktreeOp(request.sessionId, async () => {
    // Agent ladder: live first (no side effects), resolveAgent only as the documented fallback.
    let agent = this.agentRegistry()?.get(request.sessionId)
    if (agent === undefined) {
      if (typeof controller.resolveAgent !== 'function') throw new DshCapabilityError('agents', ...)
      const found = await controller.resolveAgent(request.sessionId)      // WAKES a cold session
      if ('error' in found) throw new Error(`session "${id}" could not be scoped to an agent: ${found.error}`)
      agent = found.agent
    }
    // Mid-turn interleave guard: worktree create commits a durable directory change.
    if (agent.status === 'running') throw new Error(
      `session "${id}" is running; wait for its turn to settle before moving it into a worktree`)

    const created = await worktrees.create(agent, {
      ...(name === undefined ? {} : { name }), ...(from === undefined ? {} : { from }),
    }, signal, onPhase /* 'prepare' | 'checkout' → MCP progress notifications */)
    return { sessionId, ...created, from: from ?? null }
  })
}
```

Notes: `agent.status` exists on the concrete Agent (`LOOP:554`) and on the repo's `DshAgent`
(`'idle' | 'running'`). If a later revision wants forge parity, the stricter primitive is
`agent.runMaintenance(job)` (throws `agent "<id>" already has active work`); it is reachable
through the opaque handle cast but is not required for v1 because the intended callers create blank
sessions. Do not pre-validate the source checkout by importing Git logic: the service already
produces precise failures, and the plugin does not depend on `@deepseek-ai/*` packages.

### 6.4 `worktree_restore`

```ts
async restoreWorktree(request: { sessionId; path; branch; baseCommit; repositoryRoot; signal? }) {
  await this.assertSessionVisible(request.sessionId, 'worktree_restore')
  const worktrees = this.requireWorktreeService()
  // Cheap pre-flight copies of the service's own rules, to fail before the agent wake-up:
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(request.baseCommit)) throw new Error(...)
  return await this.serializeWorktreeOp(request.sessionId, async () => {
    const agent = await this.agentForSession(request.sessionId)   // ladder from §6.3
    const restored = await worktrees.restore(agent, {
      path: request.path, branch: request.branch,
      baseCommit: request.baseCommit, repositoryRoot: request.repositoryRoot,
    }, request.signal, onPhase)
    return { sessionId: request.sessionId, path: restored.path, branchRecreated: restored.branchRecreated }
  })
}
```

Caller-facing contract: take the four fields from a previous `worktree_create`/`session_create`
reply or from `session_status.worktree` (when the forge project has one); restore does **not** move
the session, so a session whose directory disappeared will be back in it on the next
`workingDirectory.ensure` (the projection still names the restored path, `WD:80-107`).

Why not persist the record in the session log (the forge does: `plugin:client-ui-forge/worktree`)?
It would require writing a foreign plugin's record type and, worse, the forge panel reacts to
`request`/`created` records (`FORGE:987-1017`, `FORGE:2954-2967`): an MCP-written record could
trigger a second creation or corrupt the panel's projection. Keep the record caller-owned for v1;
record it in docs as a possible future peer integration.

### 6.5 Reading live state for `session_list` / `session_status`

**Preferred for `session_list`: zero extra reads.** The rows `controller.list()` already returned
carry `projections` hints (`SCI:2730-2790`, `SCI:2888-2898`), populated from the live snapshot for
attached sessions and from the persisted projection cache for cold ones. Add an opt-in (like
`includeTitle`) so the payload only grows when asked:

```ts
// inside listSessions, after item selection
const values = options.includeWorktree === true ? item.projections?.values : undefined
const workingDirectory = typeof values?.workingDirectory === 'string' ? values.workingDirectory : undefined
const forgeWorktree = worktreeInfoOf(values?.forgeWorktree)   // tolerant parse; wire shape DshForgeWorktree | null
// Report `worktreeState: item.projections?.kind` ('sequenced' = live exact, 'cached' = checkpoint)
```

The in-flight implementation instead calls `sessionQuery.observeSession(id, {projectionMode:'all'})`
once per listed row (`readSessionViews`). That works, but for a **cold** session it is a full
durable-log preparation + all-projections fold (the lease is disposed, so it does not pin the
prepared cache, but the read still costs a log read). For `session_list { includeWorktree, limit:
200 }` that is up to 200 log reads where the list rows already carry the same two values. If the row
hints are ever needed as an exact read, `controller.projections({sessionId})` is the cheaper middle
ground (no activation, no prepared-session read). Keep `observeSession` as the fallback for the
version where the row hints are absent.

`session_status` — one exact read, with a log-fold fallback that needs no projection service:

```ts
private async readWorkingDirectory(sessionId, events): Promise<string | null | undefined> {
  // 1. Exact, cold-safe, no activation (0.2.2+; probe the member).
  const controller = this.sessionController()
  if (typeof controller?.projections === 'function') {
    try {
      const v = await controller.projections({ sessionId }, signal)
      if (v?.kind === 'sequenced' && typeof v.values.workingDirectory === 'string') return v.values.workingDirectory
    } catch { /* fall through */ }
  }
  // 2. Version-tolerant fold of the same durable events readSessionStatus already holds.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'working-directory/change') {
      const cwd = (events[i].data as { cwd?: unknown }).cwd
      return typeof cwd === 'string' ? cwd : undefined
    }
  }
  return undefined    // never entered: header cwd applies
}
```

`session_status`'s `readSessionStatus` already reads every durable event (`readEvents`), so step 2
adds **no I/O at all** and is the only path that works without `sessionQuery`/projections: prefer it
when `controller.projections` is absent, and prefer the projection when present (it is the
harness's own state and survives log format quirks).

Then:

- `workingDirectory?: string | null` — the live committed directory (`null`/absent when unknown;
  "never changed" is represented by the header `cwd`, so the plugin should report the header cwd in
  that case, or omit the field and document that absence means "unchanged").
- `worktree?: WorktreeInfo | null` — from `values.forgeWorktree` (only forge-created), with
  `from` from the record; MCP-created worktrees are visible as `workingDirectory` and are echoed in
  the create reply. Say this in the field's doc comment, exactly as the WIP
  `SessionStatus.worktree` comment already does.
- `statusSignature()` (`src/dsh/driver.ts`, the function both `sessionStatus` and its wait loop use) must include `workingDirectory` if a long-poll
  should wake on a directory change; the in-flight code already appends
  `status.workingDirectory` and `status.worktree?.path` to the signature. A worktree operation on
  another session's `status` wait also appends an event (so `lastEventSeq` changes) — the explicit
  signature fields make the change attributable to the directory.

### 6.6 Progress reporting (`onPhase`)

The driver already has a throttled MCP progress reporter (`src/mcp/tools.ts:181-203`). Thread a
callback through `createWorktree`/`restoreWorktree` and map the harness phases verbatim:

| `onPhase` | MCP progress message |
| --- | --- |
| `prepare` | `"validating the source checkout and allocating the worktree"` |
| `checkout` | `"checking out <branch> at <baseCommit>"` |

`onPhase` "must not throw" (`WT:250`, `WT:275`): wrap the reporter so a client disconnect cannot
fail the operation. This is optional for the first cut: the in-flight `createWorktree` does not
forward `onPhase` yet, so a worktree checkout runs with no progress frames. The work is bounded by
`timeoutMs` per Git command (60 s default), which is long enough that a caller waiting on a signal
benefits from the two frames.

### 6.7 Alignment with the in-flight implementation (read before finishing)

`src/dsh/driver.ts`/`types.ts`/`mcp/*` already contain a worktree implementation while this contract
was being written. Verified against the current working tree:

| Piece | In flight | Contract verdict |
| --- | --- | --- |
| `DshWorktreeRecord` / `DshRestoredWorktree` / `DshWorktreeService` in `types.ts` | matches §1.2/§1.3 exact shapes, `DshAgentHandle` kept opaque | **correct, keep** |
| `session_create.worktree: true \| {name?, from?}`, order create → worktree → selectModel/approval | matches §6.2 | **correct, keep** |
| Partial failure (`worktreeError` after the session exists) | matches the `modelSelectionError` precedent | **correct, keep** |
| Missing-service behaviour | currently caught like a runtime failure → session created + `worktreeError` | acceptable; §6.2 recommends pre-validating the *capability* before create so a caller that passed `worktree` never gets an unrequested plain session. Either is defensible; if pre-validating, keep runtime Git failures partial |
| Agent resolution (`agentForSession` always calls `resolveAgent`) | works (a fresh session's agent is live, so no resume), but on a cold existing session it wakes it | recommend the §6.3 ladder: `agents.get()` first, `resolveAgent` fallback, and mention the wake in the tool description |
| Per-session serialization / busy guard for `worktree_create` | absent | add both (§5: concurrent creates race Git's own locks; a running turn should be refused or serialized with `runMaintenance`) |
| `includeWorktree` state read | one `observeSession` per row | prefer the list-row hints (§6.5) or `controller.projections`; keep `observeSession` fallback |
| `onPhase` forwarding | absent | optional (§6.6) |
| probes `worktrees`/`agentResolve`/`sessionViews` and the folded `session` group | match §4.2 | **correct, keep** |

Two things worth double-checking in review because they are easy to get subtly wrong: (1) the
reply's `cwd` must remain the **creation** directory while `workingDirectory` carries the checkout —
§6.2 step 5; (2) `session_list { includeWorktree }` must not run for sessions the ownership scope
filtered out (the current code reads views after filtering and slicing, so it is fine — keep it that
way).

---

## 7. Version guard and compatibility note

**What is 0.2.2-only.** The named service `worktrees`, its two methods, the
`working-directory/change` production path that `create` exercises, `forgeWorktree`, and
`sessionController.projections` are all verified only in the installed **0.2.2-rc.1**. The plugin's
CI-visible history (docs written against 0.1.5-rc.1 / 0.1.7-rc.2) does not list a worktree service
or a `projections` Remote, and the worktree package's peer set pins `dsh-*` at `0.2.2-rc.1`; the
first version that introduced the capability is *not verified* — treat "0.2.2-rc.1" as the floor.

**How to probe without crashing older hosts**

- Keep the declared peer range unchanged (`>=0.1.5-rc.1`); never import `@deepseek-ai/dsh-*`
  (the repo's first design rule in the `src/dsh/types.ts` header comment).
- `serviceOf(ctx,'worktrees')` is safe on every host: `ctx.get(name)` returns `undefined` for an
  unknown service.
- Probe each optional read separately: `controller.projections`, `sessionProjections.snapshot`,
  `sessionProjectionCache.cachedSnapshot`, `sessionQuery.observeSession` (already optional).
  `sessionQuery.observeSession` exists since 0.1.5-rc.1 (`src/dsh/types.ts`, `observeSession`); the
  `workingDirectory` key exists whenever the base bundle's `working-directory` row is mounted
  (`BASE:166-176`), which is normal on all supported versions.
- The log-fold fallback (`working-directory/change` in the durable log) is the only piece with no
  service dependency. *Unverified*: whether pre-0.2.2 hosts ever wrote that event — on such a host
  the fold simply returns `undefined`, which the reply must tolerate.

**README compatibility note (recommended; not part of this contract's write scope)** — add to
`## Compatibility` and to the `## Deployment requirements` table:

> **Worktrees (Git).** `worktree_create`, `worktree_restore`, and `session_create { worktree }`
> need `ctx.worktrees`, first verified in DSH `0.2.2-rc.1`, provided by the experimental forge
> bundle (`@deepseek-ai/dsh-experimental-forge-bundle`, UI name "变更请求与工作树"). On an older or
> bare profile the tools are reported unavailable in `dsh_info.toolAvailability` and
> `session_create { worktree }` is refused before a session is created. Without that bundle the
> rest of the endpoint is unchanged; `session_status.workingDirectory` still works through the
> base bundle's working-directory projection (or the durable log).

Also add the new probe rows to `docs/CAPABILITY-GAPS.md`'s service table (§1.2 style) only if that
doc is being refreshed; it is a snapshot document, and `docs/NEW-CAPABILITIES-0.2.2.md` (task-1)
covers the inventory.

---

## Appendix A — one-line summary of every verified claim

| # | Claim | Evidence |
| --- | --- | --- |
| A1 | `ctx.worktrees` has exactly `create` and `restore` | `WT:253`, `WT:278`, `API:4609-4615` |
| A2 | `create` returns `{path, branch, baseCommit, repositoryRoot}` | `WT:358-363`, `API:6017-6020` |
| A3 | `restore` returns `{path, branchRecreated}` and does not move the session | `WT:456-459`, `WT:271-272` |
| A4 | Defaults: `.agents/worktrees`, prefix `dsh-`, 60 s per command, 64 KiB output | `WT:209-217` |
| A5 | Generated name = prefix + uuid8 + `-` + 4 hex | `WT:42-45`, `WT:290` |
| A6 | `create` ends by committing the session's working directory | `WT:359` |
| A7 | Agent members dereferenced: `session`, `session.id`, `ctx.fiber.assertActive`, `inject` | `WT:290-302`, `WD:97-155` |
| A8 | `resolveAgent` returns the live `ctx.agents.get` agent or a resumed published one | `SCA:173-214`, `SCA:284-327`, `LOOP:1710-1778` |
| A9 | `resolveAgent` failure codes: not-found / agent-busy / writer-held / gateway-internal | `SCA:194-213` |
| A10 | `controller.create` publishes the agent and attaches workspace membership | `SCC:112-149`, `SCA:450-472` |
| A11 | Header `cwd` is set at creation; `working-directory/change` carries `{cwd}` | `SCC:112-149`, `SEV:82`, `WD:143` |
| A12 | `workingDirectory` projection init = header cwd; wire view = path or null | `WD:31-44` |
| A13 | Workspace membership tests header-derived `sessionPaths`, not live dir | `WS:367`, `WS:102-105`, `WS:111-127`, `WS:875-895` |
| A14 | Sidebar groups strictly by `workspace.sessionIds`, else Ungrouped | `SIDEBAR:1027-1045` |
| A15 | `workingDirectory.ensure` recovers to header cwd + notice | `WD:91-107`, `WD:138-156` |
| A16 | Forge worktree record type/actions/projection/view | `FORGE:891-1017` |
| A17 | Forge creates at inbox hold or first step proposal, then records `created` | `FORGE:1363-1386`, `FORGE:1428-1443`, `FORGE:2954-2967` |
| A18 | Forge restore calls `worktrees.restore` with the record and runs as maintenance | `FORGE:1233-1257`, `FORGE:3118-3133` |
| A19 | `forgeWorktree` is registered on the host's `sessionProjections` | `FORGE:2670-2678` |
| A20 | `controller.list` rows carry projection hints from live snapshot or cached checkpoint | `SCI:2730-2790`, `SCI:2888-2898` |
| A21 | `controller.projections` returns sequenced / migration / null without activating | `SCH:116-155`, `API:2750` |
| A22 | `sessionProjections.snapshot` / `cachedSnapshot` / `observeSession` signatures | `API:2853-2950`, `SCW:3707-3744`, `session-query/lib/index.js:351,477-482` |
| A23 | Forge bundle inserts the worktree rows; profile lists the bundle | `FORGEBUNDLE:1-19`, desktop `package.json` |
| A24 | Sandbox policy's workspace root is the header cwd | `SP:166-174`, `FORGE:1797-1801` |
| A25 | Worktree service never rolls back; retained artifacts are in the error | `WT:240-246`, `WT:364-366` |
| A26 | No per-session serialization in the worktree service; the directory service serializes only commits | `WT:220-239`, `WD:157-168` |

## Appendix B — unverified / out of scope

- **Runtime behavior was not executed.** Every claim is read from the packaged code; no Git
  operation, no `ctx.get` probe, and no MCP call was run against the live harness. The desktop
  profile's composed Cordis tree is not materialized on disk (`cordis.yml` is `[]`; composition is
  bundle patches applied at boot), so "the forge bundle is mounted in this window" rests on the
  profile's bundle list + the bundle's unconditional patch, not on an observed `worktrees` service.
- **Which earlier DSH version introduced the worktree service** is not verified. Treat
  `0.2.2-rc.1` as the first verified version; do not claim an older floor.
- **Whether `git`/`node` are present in the desktop profile's execution world** for every
  session policy was not verified; the service requires both (`WT-RM` "Execution requirements").
- **`working-directory/change` on pre-0.2.2 harnesses** was not verified (log fold is a safe
  no-op if absent).
- **`internal/service` event** (forge reacts to the `worktrees` service appearing,
  `FORGE:2698-2700`) is not in the generated public event catalog; do not depend on it — probe at
  call time instead.
- **`agent.runMaintenance` on the opaque handle** is verified only as the concrete
  `ReactLoopAgent` method (`LOOP:586-611`); the minimal `DshAgent` type the plugin declares does not
  include it, and no host Remote exposes it. If used, it is an untyped cast.
- **Whether a DSH-UI-created worktree record can be *safely* mirrored by an external plugin** was
  not attempted; §6.4 explains why the plugin should not write forge records.
