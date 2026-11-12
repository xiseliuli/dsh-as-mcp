# New capabilities in DSH 0.2.2-rc.1 — delta from the 0.1.7-rc.2 audit

**Question.** `docs/CAPABILITY-GAPS.md` audited this plugin against DSH **0.1.5-rc.1** (the version inside
DSH Desktop 2.0.9) and re-checked the version-sensitive claims against **0.1.7-rc.2**. This machine now runs
DSH **0.2.2-rc.1**. What does the installed harness expose that the bridge does not, what did the old audit
get wrong, and what is worth building next?

**Artifacts and how each claim was checked**

| What | Where / value |
| --- | --- |
| Installed harness | `release.version` **0.2.2-rc.1** in `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` → `dsh/desktop-runtime.json` (329 shared packages) |
| Authoritative service catalog | the asar file `dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/api-catalog.js`, extracted to `/tmp/dsh-inspect/api-catalog.js` (sha256 `c3482a44…5f0533a`); cited below as `api-catalog.js:NNNN` |
| Audited baseline (ref) | `/Users/xiseliuli/test_code/dsh-harness-ref` — `@deepseek-ai/dsh-root` **0.1.7-rc.2**, catalog at `packages/extensions/tool-cordis/lib/types/api-catalog.js` (89 services) |
| Older baseline (015) | `/Users/xiseliuli/test_code/dsh-harness-015` — **0.1.5-rc.1**, catalog at `packages/extensions/tool-cordis/src/api-catalog.ts` (71 services) |
| This profile | `~/.dsh/profiles/desktop/package.json` `dsh.profile.bundles` includes `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-experimental-forge-bundle`, `@deepseek-ai/dsh-experimental-agent-team-profile`, `@deepseek-ai/dsh-experimental-plugin-market-bundle`, and `dsh-as-mcp` |
| Bridge source | `src/mcp/tools.ts` (29 MCP tools), `src/dsh/driver.ts`, `src/dsh/types.ts`, `src/defaults.ts` |
| Live verification | raw JSON-RPC over the running endpoint `http://127.0.0.1:8790/mcp` with the profile bearer token (`~/.dsh/dsh-as-mcp/token`), `serverInfo.version` **0.52.84**; repo is 0.52.86 |

**Evidence standard.** **verified** = read first-hand in the asar/catalog/checkout or observed in a live call.
**inferred** = reasoned from a signature, a bundle patch or package docs without executing it.
**unverified** = explicitly called out; no claim below depends on one. Every count in §6 was recomputed from
the two catalogs rather than carried over from the old document.

---

## 1. Version delta: 0.2.2-rc.1 vs 0.1.7-rc.2

### 1.1 Counts

| Measure | 0.1.5-rc.1 (015) | 0.1.7-rc.2 (audited ref) | **0.2.2-rc.1 (installed)** | Δ vs audited |
| --- | --- | --- | --- | --- |
| Host services (`ctx.<key>`) | 71 | 89 | **107** | **+19 added, −1 removed** (net +18) |
| Public methods across services | 401 (old doc count) | 493 (recounted) | **638** | **+145** |
| Catalogued events | — | 81 | **88** | +8 added, −1 removed |
| MCP tools in `dsh-as-mcp` | 12 (0.1.5 era) | 29 (current code) | **29** (live `tools/list` agrees) | unchanged |
| `dsh-tool-*` / `dsh-experimental-tool-*` packages | 23 | 24 | **29** | +6 added, −1 removed, 1 renamed |
| `@deepseek-ai/dsh-client-*` packages in the runtime | — | 66 dirs under `packages/client` | **73** `dsh-client-*` + `dsh-experimental-client-*` packages in `desktop-runtime.json` | not host-reachable |

Old-document checks: the appendix values “89 services” and “401 methods (015)” are **correct as written**
(015 recount: 71 service keys, 401 methods by the same name-based count); “29 MCP tools” is correct. Its
§1.2 prose “twenty probes” contradicts its own appendix “22 probes”; the running endpoint reports **22**
(`dsh_info.harnessServices`), so the appendix is right and the prose is stale.

### 1.2 Added services (19, 105 methods)

| `ctx.<key>` | Methods | What it is (catalog summary / README) | Catalog line |
| --- | --- | --- | --- |
| `actionCards` | 4 | Card tool + kind registry + Session projection + user actions/status notices | `:17` |
| `claudeCodeMods` | 3 | Bridge for Claude Code mods, their hooks and harness listeners | `:541` |
| `cotTranslation` | 2 | Optional reasoning-translation delegates over Session-bound storage | `:787` |
| `cuaAccess` | 9 | Browser controls for provider-owned native permission/application decisions | `:890` |
| `forge` | 16 | Registry of forge (code-host) providers; change-request reads/actions | `:1154` |
| `forgePanel` | 20 | Serves the forge panel: checkout inspection, local diffs, worktree lifecycle, review actions | `:1266` |
| `forgeSession` | 5 | Session-scoped change-request bindings (track/dismiss/discover/watch) | `:1398` |
| `headlessStartup` | 6 | Facts the headless runner reads from its startup service | `:1618` |
| `liveshareShares` | 12 | Owner-only Remote surface over share-management operations | `:1805` |
| `otel` | 2 | Shared OpenTelemetry transport provider | `:2076` |
| `pluginMarket` | 5 | Fetches/validates/caches configured plugin-market indexes | `:2256` |
| `pluginRecommendations` | 1 | Catalog lookups for card text / official-plugin enablement | `:2296` |
| `productAnalytics` | 3 | Authenticated product-event intake | `:2323` |
| `remoteAccess` | 6 | Access-policy registry and per-Peer access snapshot | `:2424` |
| `sessionLogDeepSeek` | 1 | Incremental Session-log contributor with upload exclusions | `:2790` |
| `translator` | 3 | Host service with routing, cancellation and quiescent unload | `:4066` |
| `webApp` | 1 | The Web GUI this process serves | `:4261` |
| `workingDirectory` | 4 | One owner per Session's effective directory (get/ensure/set) | `:4368` |
| `worktrees` | 2 | Creates/restores retained Git worktrees under the mounted fs/sandbox | `:4604` |

### 1.3 Removed service (1)

| `ctx.<key>` | Was | Note |
| --- | --- | --- |
| `invariants` | 1 method (`check(...)` / invariant registry; 015 `:1134`, listed in old §4 as internal machinery) | Removed in 0.2.2. Nothing in the plugin probes or uses it. |

### 1.4 Changed pre-existing services — method names added (57) and removed (17)

Counted by method **name** per service, not by signature string. Signature-only changes: **28**.

**Added names:**

`agentPresets`: `presetForSession`, `inspectCompositions` · `agents`: `turnBoundaryOf` ·
`connection`: `browserPeer`, `allowsRemoteAuthorities`, `createPeer`, `admitConnection` ·
`deepseekAccount`: `getDeviceIdentity` · `fileUploads`: `uploadImageStream` ·
**`fs`: `patchText`, `deleteFile`, `moveFile`** · `hmr`: `reconcileProfile` · `llm`: `imageRequestTarget` ·
**`pluginManager`: `readBundleDetail`, `listVersions`, `updateBundle`** · `ptcRuntime`: `release` ·
`sandboxPolicy`: `additionalWritableRoots` · **`schedule`: `deliveryLimits`, `remoteCreate`, `remoteList`,
`view`, `remoteHistory`, `run`, `deleteInactive`, `remoteEdit`, `edit`** ·
**`sessionController`: `events`, `observeEvent`, `observeProjections`, `state`, `observeState`, `wait`** ·
**`sessionProjections`: `onEventChanged`, `summaryKeys`** · `subagents`: `startActivation`,
`waitForChildren`, `drainDescendants`, `drainChildren` · `systemPrompt`: `refreshContext` ·
`terminalController`: `attach` · `tokenMeter`: `contextPressure` ·
**`tools`: `executable`, `resolve`, `definitions`, `setExecutor`, `checkGuards`** ·
`typertGateway`: `hasLiveClient`, `getPendingRemoteEvents` ·
`userQuestions`: `answer`, `attachWait`, `askTimed` · **`web`: `searchReady`, `fetchReady`** ·
`webServer`: `getOrigin`, `readResource`.

**Removed names:** `connection.operator` · `schedule.delete`, `schedule.update` ·
**`sessionController.inspect`, `sessionController.page`** · `sessionProjections.stateOf`,
`sessionProjections.cachedSnapshot` · `subagentModelSelection.current` · `subagents.start`,
`subagents.startContinuable`, `subagents.drainContinuable*` ·
`terminalController.follow`, `terminalController.write`, `terminalController.resize` ·
**`tools.presentAs`, `tools.executionMode`**.

**Signature changes that matter to this plugin:** `tools.execute` (single call → batch, see §3.3),
`sessionController.updateQueue`/`search`/`fork`/`prompt` now declared returning `Promise` without the
redundant `async` (behaviour unchanged; awaiting is correct), `terminalController` attach model, and the
`sessionProjections` register/snapshot API.

### 1.5 Claims in `CAPABILITY-GAPS.md` this catalog now proves stale

| Old claim | 0.2.2 truth | Evidence |
| --- | --- | --- |
| §7: `sessionController.updateQueue` is the only async mismatch; the surface is otherwise stable | **`ctx.tools.execute` changed shape from `ToolExecutionInput` to `ToolBatchInput`.** The plugin still passes the old single-call object, so **`dsh_tool_call` fails at runtime** with `Tool batch execution failed` | `api-catalog.js:4046`, `:9453-9458`; `src/dsh/driver.ts:3754-3761`; live call reproduced |
| §2.3: `sessionController.search` is dead on Desktop because `openAt: never` | **Still true on 0.2.2, and it is worse than stated:** the plugin *shipped* `session_search` (0.25.0) on top of `controller.search`, so that tool now fails on every shipped Desktop profile. Live call returns `session search is disabled … openAt "never"` | `dsh-base/cordis.patch.yml:149-161`, `dsh-web-app/cordis.patch.yml:22-30`; live `session_search` call |
| §1.5/§3: “the seven `cordis_*` tools execute arbitrary plugin code” | Already false in 0.1.7-rc.2 (projection: `cordis_inspect_list`/`cordis_inspect_query` only); 0.2.2's tool-cordis package also names only those two, and read-only inspection is now first-class (`cordis_inspect_*` are in this session's own tool list). The refusal rationale remains valid for the generic RPC, but the named `cordis_define/_run` hazard is gone from the shipped package | 015 `tool-cordis/src/*.ts` names `cordis_define/run/stop/undefine/inspect_self`; ref and 0.2.2 name only `cordis_inspect_list/query` |
| §7: “`schedule` is ref-only / opt-in disabled by default”, tools are `schedule_create/delete/list/update` | 0.2.2 mounts `dsh-tool-schedule` into **both** the standard and cordis presets; tools are `schedule_create`, **`schedule_edit`**, `schedule_list`, **`schedule_view`** (`delete`/`update` names gone) | `dsh-web-app/presets/standard.patch.yml:38-39`; `presets/cordis.patch.yml:41-42`; `dsh-tool-schedule/lib/index.js` |
| §4: `sessionProjections.*` is “internal machinery, not agent-facing at any boundary” | The controller now exposes `@Remote('projections')` plus `state`/`observeState` and `sessionQuery.readSurface`, i.e. projection reads are a sanctioned Remote boundary; the host plugin can call the same methods directly | `api-catalog.js:2726-2756`, `:3030` |
| §7: “`tools.execute` is gap #1 and is safe to build against 015 today and still be there on ref” | The membership is there, the **contract is not**: batch input/output on 0.2.2. Build against the installed shape, not the 015 one | `api-catalog.js:4046`, `:9453` |
| §1.5: `sessionController.inspect` is a supported fallback rung | **`inspect` and `page` are gone.** The plugin's `readEvents`/`readUsageCut` fallbacks call `controller.inspect(...)`; they only fire when `sessionQuery` is missing, which is not the shipped Desktop composition — so no observed break, but the fallback is dead code on 0.2.2 and would throw. `page` was replaced by `events` | `api-catalog.js:2610-2760` (no `inspect`); `src/dsh/driver.ts:3030-3045`, `:3410-3422`; live `session_status`/`session_usage` still succeed via `sessionQuery` |
| §2.2 gap #1 “shipped” note: the bridge is the operator console | Still the right framing, but on 0.2.2 the console's one generic invocation tool is **broken** until it speaks `ToolBatchInput` (§3.3) | live probe |

Not stale: session search’s opt-in posture, `sandboxPolicy`/`permissionPresets`/`approval` reads and refusals,
credentials/authorization refusals, `typertGateway.invoke` refusal, and the client-plane “not applicable”
analysis all remain correct.

---

## 2. New host methods on pre-existing services

> **Premise correction.** Several methods the brief expects to be new were verified to exist **already in
> 0.1.5-rc.1 and 0.1.7-rc.2**: `sessionController.modelCatalog`, `canOpenWorkspacePath`,
> `openWorkspacePath`, `workspacePathApplications`, and all of `workspaceRegistry.{insertBefore,
> archiveSession, unarchiveSession, pinSession, unpinSession}` (015 lacked only `unarchive`/`pin`/`unpin`/
> `initializeDefault`). They are new *to a reader of the old audit* only because §1.3 lists the methods the
> plugin calls, not the whole surface. Tables below mark `new in 0.2.2` explicitly.

### 2.1 `sessionController` — 22 → 26 methods (`api-catalog.js:2599`)

| Status | Method (exact signature) | Line | Why it matters to the bridge |
| --- | --- | --- | --- |
| **new** | `@Remote wait(request: SessionWaitRequest, signal: AbortSignal): Promise<SessionWaitValue>` | `:2738` | The principled replacement for `session_status` polling: resolves when the Session is idle / needs input / times out, with bounded assistant output |
| **new** | `@Remote events(request: SessionPageRequest, signal: AbortSignal): Promise<SessionEventsPage>` | `:2708` | Replaces the removed `page`; cold-safe message-aligned history page — overlaps existing `session_messages` |
| **new** | `@Remote({ mode: 'stream' }) observeEvent(request, signal): AsyncIterable<SessionEventFrame>` | `:2714` | Event stream without a snapshot; MCP has no stream tool result, so only usable with a bounded wrapper |
| **new** | `@Remote({ mode: 'stream' }) observeProjections(request, signal): AsyncIterable<SessionProjectionFrame>` | `:2720` | Projection-change stream |
| **new** | `@Remote state(request: SessionStateRequest, signal): Promise<SessionState>` | `:2726` | Passive state: `{ cursor, active, running, queue, pendingInput }` (`:8645`) — cheaper than reading the log for “is it done / does it need input” |
| **new** | `@Remote({ mode: 'stream' }) observeState(request, signal): AsyncIterable<SessionState>` | `:2732` | State replacement stream |
| same | `resolveAgent(sessionId): Promise<ApiSessionAgentResult>` | `:2604` | Unchanged; the enabling bridge for every `agent`-scoped call |
| same | `@Remote('list') async list(_request, signal): Promise<SessionListValue>` | `:2610` | Shipped; returns `{ items: SessionSummary[] }` (`:8373`), summaries now carry `projections?: SessionProjectionHints` (`:8657`) |
| same | `@Remote('search') async search(request, signal): Promise<SessionSearchValue>` | `:2616` | **Dead in shipped profiles** (`openAt: never`) — see §1.5 |
| same | `@Remote('create') create(request: SessionCreateRequest): Promise<SessionCreateValue>` | `:2622` | Used by `session_create` |
| same | `@Remote('selectModel') selectModel(...)` | `:2628` | Used by `session_set_model` |
| same | `@Remote('modelCatalog') modelCatalog(): Promise<ModelCatalog>` | `:2640` | **Not new**; `ModelCatalog` = `{default, routableProviders, groups, failures}` (`:7173`). `dsh_info` could read it (currently reads `llm.listProviders`) |
| same | `@Remote canOpenWorkspacePath(): boolean` | `:2646` | **Not new.** Desktop path hand-off capability; irrelevant to an MCP caller |
| same | `workspaceDesktop(): { name; available; fileManager }` | `:2652` | **Not new.** Serving-desktop description |
| same | `@Remote('openWorkspacePath') async openWorkspacePath(...)` | `:2658` | **Not new.** Opens a path on the **Host desktop** — a human-reaching action; stays absent |
| same | `@Remote('workspacePathApplications') async workspacePathApplications(...)` | `:2665` | **Not new in 0.2.2** (added in 0.1.7); lists desktop file handlers. Not agent-facing |
| same | `@Remote('rename') rename(request): Promise<SessionRenameValue>` | `:2672` | Used by `session_rename` |
| same | `@Remote('fork') async fork(request): Promise<SessionForkValue>` | `:2678` | Used by `session_fork` |
| same | `@Remote('prompt') async prompt(request, signal): Promise<SessionPromptValue>` | `:2684` | Used by `session_prompt` |
| same | `@Remote('attachment') attachment(request): Promise<SessionAttachmentValue>` | `:2690` | Image attachments; `session_prompt` already sends image content |
| same | `@Remote('updateQueue') updateQueue(request): Promise<SessionUpdateQueueValue>` | `:2696` | Used by `session_queue` |
| same | `@Remote('cancel') cancel(request): SessionCancelValue` | `:2702` | Used by `session_cancel` |
| same | `@Remote({mode:'stream'}) follow(request, signal): AsyncIterable<SessionFollowFrame>` | `:2744` | Log follower; old doc §6.3 already refused fake token streaming |
| **removed** | `inspect(sessionId, signal?)` | — | Was the plugin's terminal fallback rung; see §1.5 |
| **removed** | `@Remote('page') page(request, signal)` | — | Replaced by `events` |

Types: `SessionWaitRequest extends SessionStateRequest { timeoutMs?; afterSeq?; maxMessages? }`
(`api-catalog.js:8737`); `SessionWaitValue { reason: 'idle'|'input-required'|'timeout'; state; output:
{ records; truncated } }` (`:8741`, `:8733`); `SessionState` (`:8645`).

### 2.2 `workspaceRegistry` — 11 methods, unchanged since 0.1.7 (`api-catalog.js:4531`)

All of these are callable in-process by a host plugin (the old audit's §1.4 rule: `@Remote` is a prototype
marker, not an RPC-only gate).

| Method | Line | Note |
| --- | --- | --- |
| `async create(path, title?): Promise<Workspace>` | `:4536` | Used by `workspace_create` |
| `initializeDefault(resolveDirectory): Promise<Workspace \| undefined>` | `:4542` | **New since 0.1.5.** First-use default workspace |
| `get(id)`, `list()` | `:4548`, `:4554` | `list()` synchronous, durable order |
| `delete(id): Promise<boolean>` | `:4560` | Used by `workspace_delete`; registration only |
| `insertBefore(id, beforeId?): Promise<readonly WorkspaceId[]>` | `:4566` | Manual workspace order (sidebar drag); **pre-dates 0.2.2** |
| `archiveSession(sessionId, options: ArchiveSessionOptions = {})` | `:4572` | **Pre-dates 0.2.2** — the 0.1.7-rc.2 catalog already has the same `options = {}` signature; only 0.1.5 lacked it. `ArchiveSessionOptions { stopActivity? }` (`:5521`). Drops the pin in the same write; refuses active sessions unless `stopActivity` |
| `unarchiveSession(sessionId)` | `:4578` | **Pre-dates 0.2.2** (new since 0.1.5). Drops the archive mark only |
| `pinSession(sessionId)` / `unpinSession(sessionId)` | `:4584` / `:4590` | **Pre-date 0.2.2** (new since 0.1.5) |
| `async resolveByPath(path): Promise<Workspace \| undefined>` | `:4596` | Used indirectly by `workspace_create`? No — plugin uses `create`; this is the non-mutating lookup |

The browser-facing wrapper `workspaceController` exposes matching `@Remote` methods (`api-catalog.js:4425-4485`):
`create`, `initializeDefault`, `rename`, `delete`, `insertBefore`, `insertSessionBefore`, **`archiveSession`**,
**`unarchiveSession`**, **`pinSession`**, **`unpinSession`**, `follow`. All pre-date 0.2.2 (only `follow` became
`async *`). A host plugin can call either service; `workspaceRegistry` needs only ids, while
`workspaceController` takes request objects.

### 2.3 Other materially changed pre-existing services

| Service | What changed vs 0.1.7-rc.2 | Lines | Relevance |
| --- | --- | --- | --- |
| **`schedule`** | 6 → 13 methods; replaced `delete`/`update` with `edit`; added `view`, `run`, `deleteInactive`, `history`, `deliveryLimits`, and the Remote-facing `remoteCreate/remoteList/remoteEdit/remoteHistory`; `create(sessionId, request)` → `create(request, actorSessionId?)` | `:2514-2597` | Durable scheduled prompts now ship in the standard preset (`schedule_*` model tools). A first-class `schedule` tool group is defensible; the old “ref-only, disabled” note is stale |
| **`fs`** | 15 → 18: `patchText(target, hunks, expected?, signal?, sandboxPolicy?)` `:1530`, `deleteFile(target, expected?, …)` `:1536`, `moveFile(source, dest, options, …)` `:1542`; `editText` still present `:1524`; `watch` already existed (`:1439`) | `:1434-1548` | `file_edit` already maps `editText`; `delete`/`move`/`patch` are the new bytes-level capabilities |
| **`tools`** | 8 → 11 and **shape change**: `execute(input: ToolBatchInput): Promise<ToolBatchResult>` `:4046`; added `executable` `:4016`, `resolve` `:4022`, `definitions` `:4028`, `setExecutor` `:4040`, `checkGuards` `:4058`; removed `presentAs`, `executionMode`; `schemas(scope?, toolSet?)`, `register(definition, options)` changed | `:3993-4060` | **Breaks `dsh_tool_call`** (§3.3) |
| **`web`** | 4 → 6: `searchReady(llmProvider?)` `:4241`, `fetchReady(llmProvider?)` `:4247` | `:4235-4253` | Cheap readiness for `dsh_info`; search/fetch signatures unchanged |
| **`pluginManager`** | 12 → 15: `readBundleDetail` `:2163`, `listVersions` `:2206`, `updateBundle` `:2212` (all `@Remote`) | `:2158-2248` | Read methods are dsh_info material; write/install methods stay in §3's absent column |
| **`sessionProjections`** | API reshaped around `ProjectionKeySelection`; added `onEventChanged` `:2908`, `summaryKeys` `:2920`; `register`/`snapshot`/`viewCheckpoint` signatures changed; removed `stateOf`/`cachedSnapshot` | `:2885-2955` | Internal machinery; the sanctioned reads are `sessionController.projections`/`sessionQuery.readSurface` |
| **`sessionProjectionCache`** | `cachedSnapshot(meta, keys?)` now takes `meta: SessionHeader` (was `session`) `:2853` | `:2848-2880` | Session-list hint reads; internal |
| **`typertGateway`** | 4 → 6: `hasLiveClient()` `:0`, `getPendingRemoteEvents()` `:0` | — | The generic RPC refusal stands |
| **`userQuestions`** | 1 → 4: `answer(agent, callId, answer)` `:0`, `attachWait(agent, callId, signal)` stream, `askTimed(request & {agent}, callId, timeoutMs)` | — | Human-facing; stays absent (old §3 borderline item is now easier to build, not safer) |
| **`terminalController`** | 10 → 8: `attach(agent, id, signal): RemoteStream<TerminalFrame, TerminalInput>` `:3820` replaces `follow`; `write`/`resize` removed | `:3785-3831` | Still no model-facing terminal tool mounted in this profile; not a bridge target |
| **`goal`/`goals`** | `goals` unchanged (10 methods); `goals.disarm` and `goals.block` are host-only additions vs 015, already in 0.1.7 | `:1550-1615` | Existing `get_goal` bridge entry still valid |
| **`agents`** | +`turnBoundaryOf(session)` `:0` | — | Could refine `session_status` turn reporting; low value |
| **`subagents`** | `start`/`startContinuable`/`drainContinuable*` removed, `startActivation`/`waitForChildren`/`drainDescendants`/`drainChildren` added | — | The bridge deliberately routes subagents through `session_*` tools |
| **`hmr`** | +`reconcileProfile(requiredIds?)` `:0` | — | Plugin lifecycle; not agent-facing |
| **`sandboxPolicy`** | +`readonly additionalWritableRoots` `:0` | — | dsh_info posture detail |
| **`llm`** | +`imageRequestTarget(provider, model, image)` `:0`; `prepareCall` +`configure?` | — | Not needed |
| **`connection`/`webServer`/`fileUploads`/`deepseekAccount`** | Remotes/peer refactors, `getOrigin`, `readResource`, `uploadImageStream`, account device identity | — | Infrastructure; no bridge value |

---

## 3. New model-facing tools in 0.2.2

### 3.1 Tool-package delta

`dsh-tool-*` packages: 24 in 0.1.7-rc.2 → **29** in 0.2.2. Added: `dsh-tool-call-timeout-policy`,
`dsh-tool-executor-native`, `dsh-tool-executor-ptc`, **`dsh-tool-schedule`**,
**`dsh-tool-working-directory`**, **`dsh-experimental-tool-worktree`**; removed: `dsh-tool-lsp`;
renamed: `dsh-tool-agent-team` → `dsh-experimental-tool-agent-team` (same nine tool names).
`dsh-tool-workspace-dependencies` already existed in 0.1.7. Within the fs package, `apply_patch` is a new
tool name (not present in 0.1.5/0.1.7 sources).

A name sweep of the 29 compiled packages finds **56 distinct model-visible tool names**; the list below is the
delta that matters.

### 3.2 Which new tools are mounted here, and can the bridge reach them?

Mounting was read from the composition patches in the asar; reachability from the live `dsh_tool_list`.

| Tool package | Tool names | Mounted in this Desktop profile? | In default `agentTools.allow`? | Verdict |
| --- | --- | --- | --- | --- |
| `dsh-tool-working-directory` | `working_directory({ cd })` | **Yes** — `dsh-base/cordis.patch.yml:169-170` mounts it on the host plane (not behind a preset) | No | **bridge** after adding the name; **worth a first-class `session_working_directory`** only if reading is needed too (`ctx.workingDirectory.get(session)`) |
| `dsh-experimental-tool-worktree` | `create_worktree({ name?, from? })` | **Yes in this profile** — the profile selects `@deepseek-ai/dsh-experimental-forge-bundle`, whose patch inserts `worktree` + `tool-worktree` (`experimental-forge-bundle/cordis.patch.yml`); the bundle README says shipped profiles leave it disabled, so this is deployment-specific | No | **bridge** after allow-listing; first-class `worktree_create` only if the bridge must work without widening the allow-list |
| `dsh-tool-schedule` | `schedule_create`, `schedule_edit`, `schedule_list`, `schedule_view` | **Yes** — mounted by the **standard** preset (`dsh-web-app/presets/standard.patch.yml:38-39`) and the cordis preset (`:41-42`), so every default Desktop agent has them | No | **worth adding** as a first-class `schedule_*` group (durable reminders are a real orchestration primitive); bridge is possible but each name must be allow-listed by the operator |
| `dsh-tool-fs` | `apply_patch` | **No** — `applyPatch: false` in `dsh-base/cordis.patch.yml:297-301` and restated in the standard and cordis presets | No | **not applicable by default**; `fs.patchText` host method exists, so a first-class `file_apply_patch` could be built without the model tool |
| `dsh-tool-session-query` | `session_search`, `session_trace`, `session_event_read`, `session_event_search`, `session_event_trace` | **No** — only the `dsh-experimental-session-search` bundle mounts it, and that bundle is not in this profile's `dsh.profile.bundles`; content search is also disabled (`openAt: never`) | No | **not applicable** for the same reason the old audit refused a `session_search` tool; and the shipped `session_search` already fails (§1.5) |
| `dsh-tool-workspace-dependencies` | `load_workspace_dependencies` | **No** — mounted only by the sdk-app / sdk-minimal app patches | No | **not applicable** in Desktop; if the caller wants a dependency snapshot it already has `shell_run`/`file_*` |
| `dsh-experimental-tool-agent-team` | `team_task_create`, `team_task_get`, `team_task_list`, `team_task_update`, `wait_agent`, `spawn_teammate`, `interrupt_agent`, `list_agents`, `send_message` | **Yes** — profile selects `@deepseek-ai/dsh-experimental-agent-team-profile`, which disables `tool-subagent*` and inserts `agent-team`/`tool-agent-team`/`ui-agent-team` | No (and the old §3 refusal already covers these as work-outliving / human-reaching) | absent on purpose |
| `dsh-tool-cordis` | `cordis_inspect_list`, `cordis_inspect_query` (read-only) | Only the cordis preset mounts it; **not** in the standard preset | No | absent (inspection of the runtime is developer tooling) |
| `dsh-tool-call-timeout-policy`, `dsh-tool-executor-native`, `dsh-tool-executor-ptc` | none (plumbing: policy/executor plugins) | composition-defined | n/a | not applicable |
| `dsh-tool-lsp` (removed) | `lsp` | package gone | n/a | the old “opt-in, unmounted” note is now “removed from the package set” |

**Live confirmation.** `dsh_tool_list { sessionId }` on a real session returns exactly
`bash, edit, get_goal, glob, grep, job_kill, job_list, job_output, read, read_image, skill, todo_write,
web_fetch, web_search, write` — 15 of the 17 default-allow-listed names (`str_replace_editor` and `pwsh` are
not mounted in this preset). None of the 0.2.2-added tools is visible, as designed.

### 3.3 Regression: `dsh_tool_call` is broken on 0.2.2-rc.1 (verified live)

- 0.2.2: `tools.execute(input: ToolBatchInput)` (`api-catalog.js:4046`), where
  `ToolBatchInput { calls: readonly ToolCallBlock[]; signal; maxParallelToolCalls?; agent?; toolSet?; log? }`
  (`:9453`), returning `ToolBatchResult { results; additionalContexts; concluded }` (`:9457`).
- Plugin 0.52.84: `registry.execute({ callId, name, arguments, agent, signal })` — the 0.1.x single-call
  `ToolExecutionInput` shape (`src/dsh/driver.ts:3754-3761`).
- Implementation: `async execute(input) { return this.selectExecutor(input.agent).execute(input) }`
  (`dsh-tools/lib/index.js:641-643`), and the executor raises
  `ToolBatchExecutionError('Tool batch execution failed', { cause })` (`dsh-tools/lib/types/executor.js:7`).
- Live call: `dsh_tool_call { sessionId, name: "read", args: {...} }` → `isError: true`,
  `dsh_tool_call failed: Tool batch execution failed`. Allow-list refusal for `create_worktree` /
  `working_directory` still happens **before** execution and works.
- Fix shape: wrap the single call as `{ calls: [{ id: callId, name, arguments }], signal, agent }` and unwrap
  `results[0]`, keeping the existing allow-list and scope checks. This is a **compatibility fix, not a new
  capability**, and it should be the first implementation item.

---

## 4. New UI-facing capabilities with host backing (observable in DSH Desktop today)

### 4.1 Forge: New Session worktree option, forge panel, change requests

Source: `dsh-experimental-client-ui-forge/README.md` (full panel spec), `dsh-experimental-forge-bundle/README.md`,
`dsh-experimental-worktree/README.md`, `dsh-experimental-forge-session/README.md`, entry guide
`docs/upgrade-guide/v0.2.2-alpha.2/forge-worktree-entry/guide.md`.

| UI capability | Host-side API a plugin could call | Plugin exposure |
| --- | --- | --- |
| New Session “Worktree” option; branch selector from local branches | `forgePanel.branches(session, signal)` `api-catalog.js:1284`; `forgePanel.requestWorktree(session, from, signal)` `:1361` | none |
| Worktree creation card (create/stop/retry/cancel) | `forgePanel.stopCreation` `:1373`, `retryWorktree` `:1378`, `cancelWorktree` `:1367`; underlying `worktrees.create(agent, {name?, from?}, signal?, onPhase?)` `:4609` | none; `create_worktree` model tool can be bridged (§3.2) |
| Removed-worktree card / restore / continue in project | `forgePanel.restoreWorktree` `:1384`, `continueInProject` `:1390`; `worktrees.restore(agent, request, …)` `:4615`; `workingDirectory.set(agent, path)` `:4391` | none |
| Change-request panel (checks, diffs, review, merge) | `forge.*` `:1159-1258`, `forgeSession.*` `:1403-1426`, `forgePanel.changeRequestChecks` `:1322`, `changeRequestDiff` `:1329`, `changeRequestText` `:1336`, `submitReview` `:1343`, `markReady` `:1349`, `merge` `:1355` | none |
| Local changes card (branch scope, staged/unstaged) | `forgePanel.localDiff(session, scope, signal)` `:1308`, `localText` `:1315` | none |
| Session-list icons + hover card for worktree/change requests | `forgePanel.changeRequestStates(signal)` stream `:1277`; session summary carries the `forgeWorktree` projection (`client-ui-forge` README) | none; `session_list` does not surface it |
| GitHub sign-in readiness | `forge.readiness(repository, signal)` `:1192` | none |

**Host reachability caveat.** `forge.*` methods take `ChangeRequestRef`/`ForgeRepository` values, obtainable from
`forge.repositoryFromRemote(url)` / `changeRequestFromUrl(url)`; `forgeSession.*` and `forgePanel.*` take a live
`Session`, obtainable in-process with `ctx.sessions.get(id)` (`api-catalog.js:3130`) — the same host-callable
rule the old audit established. **Verified read-only** on 0.2.2: the services are in the catalog and the
Desktop composition mounts the forge bundle. **Unverified:** no live call was made through a host plugin;
the exact `ForgePanelState` shape is catalogued at `:6389`.

### 4.2 Sidebar: archive, pin, manual order, group-by

Source: `dsh-client-ui-workspace/README.md` (extracted from the asar; the same file exists in the 0.1.7
checkout, so these are **not new in 0.2.2** — see §1.5-style correction below).

| UI capability | Host API | Plugin exposure |
| --- | --- | --- |
| Archive / Unarchive (visible-archived filter, undo, “stop and archive” for a busy session) | `workspaceRegistry.archiveSession(id, {stopActivity?})` `:4572`, `unarchiveSession(id)` `:4578`; browser wrapper `workspaceController.archiveSession/unarchiveSession` `:4461/:4467` | none |
| Pin / Unpin (pinned partition leads in both views) | `workspaceRegistry.pinSession/unpinSession` `:4584/:4590`; wrapper `@:4473/:4479` | none |
| Manual order by dragging rows; Workspace order | `workspaceRegistry.insertBefore(id, beforeId?)` `:4566`; wrapper `insertBefore` `:4449` and `insertSessionBefore` `:4455` | none |
| View options → Group by **Workspace / Workspace Tree**, flat list | Browser-only preference; the Host backing is the Workspace registry/list (`workspaceRegistry.list()` `:4554`, `workspaceController.follow` stream `:4485`) | not applicable (pure client state) |

**Correction to the brief.** Archive existed in 0.1.5-rc.1; **pin, unarchive and manual Session order arrived
between 0.1.5-rc.1 and 0.1.7-rc.2** (the 0.1.7 checkout's `client/ui-workspace/README.md` already documents
“Pinned Sessions lead ordinary Sessions”, “Manual”, the archive filter and Unarchive). The host methods backing
them therefore **pre-date 0.2.2**; what a reader of the old audit missed is that they were never classified as
reachable-but-unused. They are not part of the 0.2.2 delta, but they are part of the **unexposed surface** and
should be ranked with the new items.

### 4.3 New session-list metadata

`SessionSummary` (`api-catalog.js:8657`) = `{ agentAvailable, formatStatus?, sessionId, updatedAt, running,
blank, parentSessionId?, origin?, cwd?, projections?: SessionProjectionHints }`. `SessionProjectionHints` =
`{ kind: 'cached'|'sequenced', asOfSeq, values: Partial<SessionProjectionSummaryValues> }` (`:8493`) — the list
row now carries cached projection values (title, goal/plan state, usage, forge worktree, schedule clock, …)
without a log read. A plugin calling `sessionController.list` can read `summary.projections.values` to
recover title/status without resuming an agent; `dsh-as-mcp`'s `session_list` currently projects only
`sessionId/cwd/running/blank/updatedAt/parentSessionId/origin` and ignores the block.

---

## 5. Classification of every candidate capability

Legend: **exposed** = an existing MCP tool already covers it; **bridge** = reachable through `dsh_tool_call`
after adding the name to `agentTools.allow`; **worth adding** = first-class tool proposal; **absent on purpose**
= would violate §3 of `CAPABILITY-GAPS.md`; **n/a** = not meaningful for a host-side MCP bridge.

| # | Capability (host surface) | Classification | Mapping / reason |
| --- | --- | --- | --- |
| 1 | Session create/list/prompt/cancel/fork/rename/model/queue/transcript/usage | **exposed** | `session_*` (15 tools) |
| 2 | Workspace create/list/delete/unregister | **exposed** | `workspace_*` |
| 3 | File read/write/edit/list/image | **exposed** | `file_*`; `fs.patchText/deleteFile/moveFile` are **worth adding** |
| 4 | Shell foreground/background/kill/list | **exposed** | `shell_*` |
| 5 | Harness model tools (read/write/edit/glob/grep/shell/web/jobs/skill/todo/goal) | **exposed via bridge** | `dsh_tool_list`/`dsh_tool_call` — **currently broken on 0.2.2** (§3.3); 15 names visible |
| 6 | `working_directory` model tool + `ctx.workingDirectory` | **worth adding (low)** | Tool exists and is mounted; bridge after allow-list. First-class `session_working_directory { sessionId, read?, path? }` only if the bridge is off |
| 7 | `create_worktree` model tool + `ctx.worktrees.create` | **bridge** (recommended) / worth adding (medium) | Add `create_worktree` to `agentTools.allow`; first-class `worktree_create` duplicates it unless the operator refuses to widen the allow-list. Note it **changes the session's cwd** |
| 8 | `ctx.worktrees.restore` | **worth adding (low)** | Not model-facing; useful only for panel recovery — leave to UI |
| 9 | `forge` read surface (`changeRequests`, `latest`, `fetchChecks`, `diff`, `fileText`, `readiness`, `branches`, `localDiff`, `localText`, `changeRequestStates`) | **worth adding (high, read-only)** | First-class `forge_changes` proposed below; highest external value on this list |
| 10 | `forge` actions (`submitReview`, `markReady`, `merge`) | **absent on purpose (first pass)** | They write to the user's code host with the user's credentials — the same class as `credentials`/`settings` writes; if ever shipped, opt-in config + explicit confirm, not first pass |
| 11 | `forgeSession.track/dismiss/watch` | **worth adding (low)** | Binding a PR URL to a session is user-plane bookkeeping; fold into `forge_changes` only as a passive read |
| 12 | `forgePanel.requestWorktree/cancelWorktree/stopCreation/retryWorktree/restoreWorktree/continueInProject` | **bridge-ish / n/a** | These exist to drive a waiting UI message; `create_worktree` is the model-shaped equivalent |
| 13 | Session archive/unarchive | **worth adding (high, low effort)** | `workspaceRegistry.archiveSession/unarchiveSession`; propose `session_archive` |
| 14 | Session pin/unpin | **worth adding (medium)** | `session_pinSession/unpinSession`; propose `session_pin` |
| 15 | Session manual order (`insertBefore`/`insertSessionBefore`) | **not applicable** | Presentation-order mutation a remote caller should not own; no task value |
| 16 | `sessionController.wait` / `state` / `observeState` | **worth adding (high)** | Propose `session_wait`; deterministic replacement for polling loops, no new authority |
| 17 | `sessionController.events` / `observeEvent` / `observeProjections` / `projections` | **worth adding (low)** | `session_messages`/`session_tool_result` already cover transcript reads; projections are internal-shaped |
| 18 | `sessionQuery.observeSession/searchSessions/searchEvents` | **exposed / n/a** | `session_messages`, `session_tool_result`, `session_search` (which fails — see #6 below); search remains opt-in and disabled |
| 19 | `sessionSummary.projections` hints | **worth adding (low)** | Extend `session_list` rows with title/activity without resuming an agent |
| 20 | `schedule` service + `schedule_*` tools | **worth adding (medium)** | Durable reminders are an orchestration primitive; full group `schedule_create/list/view/edit` — but the nine name-list entries are only addable by bridge; first-class gives sane schemas and idempotency. Old doc's “opt-in” note is stale |
| 21 | `sessionTitle.rename/refresh`, `sessionController.rename` | **exposed** | `session_rename` |
| 22 | `goals.*` (10) | **exposed via bridge** | `create_goal`/`get_goal`/`update_goal` are in the default allow-list; `goals.block` is host-only and not needed |
| 23 | `jobs.*` observation/kill | **exposed via bridge** | `job_list`/`job_output`/`job_kill` |
| 24 | `jobController` Remote (human-facing list/follow/kill streams) | **n/a** | Browser job UI; the model tools already cover the same jobs |
| 25 | `mcpResources` (1 method: `register`) | **n/a** | No host-callable read path exists; DSH's own agent reads MCP resources through tools |
| 26 | `tools` registry read (`schemas`, `definitions`, `executable`, `resolve`) | **exposed via bridge** | `dsh_tool_list` uses `schemas`; the batch execution fix is §3.3 |
| 27 | `pluginManager` reads (`listPlugins`, `listBundles`, `listVersions`, `readBundleDetail`, `registries`) | **worth adding (low)** | Fold installed-plugin facts into `dsh_info`, read-only |
| 28 | `pluginManager` writes (`installBundle`, `updateBundle`, `removeBundle`, `setPluginEnabled`, `setBundleEnabled`, `setVersionExemption`) | **absent on purpose** | Code/install plane; remote configuration tampering — old §3 |
| 29 | `configEditor.entries/configuration/edit`, `settings.*` | **absent on purpose** | Config plane; old §3 |
| 30 | `pluginMarket`, `pluginRecommendations`, `pluginRegistryProbe` | **n/a / low** | Market browsing; no task capability |
| 31 | `credentials`, `credentialsController`, `authorization`, `deepseekAccount` | **absent on purpose** | Secrets/account; old §3 |
| 32 | `approval.setPolicy`, `permissionPresets.set`, `catPermission` | **absent on purpose** | Escalation surface; old §3 |
| 33 | `webServer.register/registerFallback/readResource` | **absent on purpose** | Can shadow the MCP endpoint; old §3 |
| 34 | `storage`, `storageDomain`, `sessionPersistence`, `sessions.enter/create/prepare/announce`, `agentLoop.create` | **absent on purpose** | Raw persistence/agent composition; old §3 |
| 35 | `subprocess.spawn/resolveExecutable` | **absent on purpose** | Beneath `ctx.shell`; old §3 |
| 36 | `typert`, `typertGateway.invoke/stream` (6 methods) | **absent on purpose** | Generic RPC passthrough — the one refusal that matters most; unchanged |
| 37 | `userQuestions.answer/attachWait/askTimed`, `actionCards.act`, `present`-style | **absent on purpose** | Reach the human at the keyboard; old §3 borderline item stays excluded |
| 38 | `liveshareShares`, `remoteAccess`, `cuaAccess`, `computerUse`, `browserUse`, `directoryPicker*` | **absent on purpose / n/a** | Remote sharing, access policy, native permission and screen control |
| 39 | `terminalController.attach` + `terminals` | **n/a in this profile** | `dsh-terminal`, `dsh-terminal-bash`, `dsh-tool-terminal` and `dsh-api-terminal-controller` all exist in the runtime's 329 packages, but `dsh-base`/`dsh-web-app` mount only the **controller** (`dsh-web-app/cordis.patch.yml:126-127`) and `dsh-experimental-terminal-bundle` is not in this profile's bundles, so no PTY backend/tool row is composed. Old gap #16 (interactive PTY) therefore remains closed here; **unverified** whether adding the bundle row makes `ctx.terminals` usable in this Desktop composition |
| 40 | `fs.watch`, `shellEnv`, `spillStore`, `tokenMeter`, `toolResultPruner`, `sessionTelemetry`, `webhookRuntime`, `workflowEngine`, `ptcRuntime`, `compaction` | **n/a** | Internal machinery or superseded by existing tools |
| 41 | `actionCards` register/record/view | **n/a** | Host-side card projection plumbing |
| 42 | `web.searchReady/fetchReady` | **worth adding (trivial)** | Add two booleans to `dsh_info.health`/catalog |
| 43 | `hmr.reconcileProfile`, `pluginManager` lifecycle, `headlessStartup`, `webApp`, `otel`, `productAnalytics`, `productTelemetry`, `claudeCodeMods`, `cotTranslation`, `translator`, `sessionLogDeepSeek`, `sessionFileReferences`, `fileReferences`, `fileUploads` | **n/a** | Runtime/telemetry/translation infrastructure; no caller value |

### 5.1 Proposed new tools (ranked by value / effort / risk)

Wording fits the existing naming scheme; all are named, schema-validated, and non-generic (no RPC
passthrough). Ranked first-to-last.

| Rank | Proposed MCP tool | Inputs | Backing method(s) | Value | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| 0 (fix) | — (repair `dsh_tool_call`) | existing | `tools.execute` with `ToolBatchInput` | Restores the bridge's only generic tool path on 0.2.2 | Low | none new; same authority as before |
| 1 | **`forge_changes`** | `{ sessionId, url?, includeChecks?, includeDiff? }` | resolve `Session` via `sessions.get(resolveAgent)`, then `forgeSession.changeRequests(session)` `:1403`; `forge.fetchChecks` `:1213`, `forge.diff` `:1220`, `forge.latest` `:1258`; fallback `repositoryFromRemote` | Lets a caller see the PR/checks/diff the user's session opened — no equivalent today (shell + `gh` is the only path, and needs the CLI) | Medium (Session handle + result projection) | Low (read-only; requires `gh` sign-in only for the same data the UI reads) |
| 2 | **`session_wait`** | `{ sessionId, timeoutMs? ≤ 300000, afterSeq?, maxMessages? }` | `sessionController.wait` `:2738` → `{reason, state, output}` | Replaces poll loops over `session_status`/`session_messages` for `wait:false` prompts; gives a truthful “idle / input-required / timeout” answer | Low | None (read-only, bounded) |
| 3 | **`session_archive`** | `{ sessionId, restore?: boolean, stopActivity?: boolean = false }` | `workspaceRegistry.archiveSession/unarchiveSession` `:4572/:4578` | The plugin can create sessions but cannot tidy the sidebar; matching the UI's archive semantics including busy-session refusal | Low | Medium: `stopActivity:true` stops the user's running work — default false preserves the Host's own refusal; explicitly documented |
| 4 | **`session_pin`** | `{ sessionId, pinned?: boolean = true }` | `workspaceRegistry.pinSession/unpinSession` `:4584/:4590` | Cheap ordering/UX control for sessions the caller created | Low | Low |
| 5 | **`file_delete`** + **`file_move`** | `{ path, cwd?, expectedVersion? }`; `{ source, destination, cwd? }` | `fs.deleteFile` `:1536`, `fs.moveFile` `:1542` | Atomic, version-guarded file operations on the same seam as `file_write`; today only `shell_run` reaches them | Low | Low (same fence as `file_write`; `expectedVersion` gives lost-update safety) |
| 6 | **`worktree_create`** | `{ sessionId, name?, from? }` | `worktrees.create(agent, request)` `:4609` (or bridge `create_worktree`) | “Try this change in an isolated checkout” from the caller | Medium | Medium: it moves the session's effective cwd (visible, recorded, reversible via `working_directory`) |
| 7 | **`schedule_*` group** (`schedule_create`, `schedule_list`, `schedule_view`, `schedule_edit`) | session-scoped schedule requests | `schedule.create/list/view/edit` `:2531-2597`; or bridge the mounted model tools | Durable prompts make the DSH session a long-lived worker instead of a chat; no plugin surface today | Medium (schedule id round-trip, time-zone semantics) | Medium: sustaining unattended execution (same class as `work_goal`) — opt-in config, like `approval.policy` |
| 8 | **`dsh_info` extensions** | existing schema | `pluginManager.listPlugins` `:2182`, `web.searchReady/fetchReady` `:4241/:4247`, `sessionController.modelCatalog` `:2640`, `sandboxPolicy.additionalWritableRoots` `:0`, `agents.turnBoundaryOf` | Removes blind configuration in `session_create` further; posture visibility | Trivial | None (read-only) |

**Explicitly rejected additions, restated for the implementation phase:** `typertGateway.invoke` (generic RPC —
must never exist); `credentials.*`/`authorization.*`/`deepseekAccount.*`; `settings.*`/`configEditor.edit`/
`pluginManager` writes; `approval.setPolicy`/`permissionPresets.set`; `webServer.register*`;
`storage*`/`sessionPersistence.*`/`sessions.enter/create`/`agentLoop.create`; `subprocess.*`;
`userQuestions.*`/`actionCards.act`; `forgePanel.submitReview/markReady/merge` (first pass);
`liveshareShares`/`remoteAccess`/`cuaAccess`/`computerUse`/`browserUse`; `openWorkspacePath` and any other
Host-desktop action.

---

## 6. Appendix: counts, evidence and the verification log

### 6.1 Recomputed counts

| Measure | Value | How |
| --- | --- | --- |
| Installed DSH version | `0.2.2-rc.1` | `dsh/desktop-runtime.json` → `release.version`; packages self-report `0.2.2-rc.1` |
| Shared packages in the desktop runtime | 329 | `desktop-runtime.json.sharedPackages.length` |
| Services in `api-catalog.js` | **107** | `SERVICE_API.length` |
| Methods across those services | **638** | sum of `methods.length` |
| Catalogued events | **88** | `EVENT_API.length` |
| Audited-ref services / methods / events | 89 / 493 / 81 | same walk over `/Users/xiseliuli/test_code/dsh-harness-ref/.../lib/types/api-catalog.js` |
| Added services / methods / events vs ref | 19 / 57 added names / 8 added events | name-level diff; 1 service and 17 method names removed, 28 signatures changed |
| `dsh-tool-*`/`experimental-tool-*` packages | **29** | asar listing of `@deepseek-ai/dsh-(experimental-)?tool-*/package.json`; ref has 24 |
| Distinct model-visible tool names in those packages | **56** (superset; per-preset mounting decides visibility) | name sweep of each package's compiled `lib/index.js` plus preset config `toolName` rows |
| MCP tools on the live endpoint | **29** | live `tools/list`; `dsh_info.toolAvailability.available = 29`, `unavailable = []` |
| `dsh_info.harnessServices` probes | **22**, all `true` on this profile | live `dsh_info` (old appendix says 22; old §1.2 prose says “twenty”) |
| Default `agentTools.allow` | 17 names | `src/defaults.ts:64-82`; live-visible 15 (preset omits `pwsh`, `str_replace_editor`) |
| Client packages in the runtime | 73 `dsh-client-*`/`dsh-experimental-client-*` | `desktop-runtime.json` name filter — still structurally unreachable from the host plane |

### 6.2 Live verification log (2026-11-12, endpoint `http://127.0.0.1:8790/mcp`, plugin 0.52.84)

| Probe | Result |
| --- | --- |
| `initialize` | `serverInfo { name: "dsh-as-mcp", version: "0.52.84" }`, tools capability only |
| `tools/list` | 29 tools, matching `src/mcp/tools.ts` registrations |
| `dsh_info` | 29 available tools; 22 harness probes all true; catalog presets `standard, ptc, minimal, cordis`; providers `deepseek-official, deepseek-account, opencode-go, opencode-go-xise` |
| `session_list` | works; returns subagent sessions with `parentSessionId`/`origin` |
| `session_status` | works on a live session (`openTurn`, `openStep`, `lastEventSeq`, …) — confirms the removed `inspect` fallback is not on the hot path |
| `session_messages`, `session_usage` | work |
| `session_search` | **fails** — `session search is disabled … openAt "never"` (confirms old §2.3; contradicts the shipped tool's premise) |
| `dsh_tool_list` | 15 allowed+mounted names listed; no 0.2.2-added tool appears |
| `dsh_tool_call {name:"read"}` | **fails** — `Tool batch execution failed` (the `ToolBatchInput` regression, §3.3) |
| `dsh_tool_call {name:"create_worktree"}` / `"working_directory"` | refused by the allow-list *before* execution (expected) |

### 6.3 Citations index

- Service/method/type line numbers: `/tmp/dsh-inspect/api-catalog.js` as cited inline (`:NNNN`).
- Asar package paths: `dsh/node_modules/@deepseek-ai/dsh-experimental-forge-bundle/cordis.patch.yml`;
  `dsh/node_modules/@deepseek-ai/dsh-experimental-tool-worktree/README.md`;
  `dsh/node_modules/@deepseek-ai/dsh-experimental-worktree/README.md`;
  `dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-forge/README.md`;
  `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/README.md`;
  `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:641-643`;
  `dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/executor.js:7`.
- Composition patches: `dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` (session-query `openAt:
  never` :149-161; `tool-working-directory` :169-170; `tool-fs` `applyPatch: false` :297-301);
  `dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` (`openAt: never` :22-30; terminal-controller
  :126-127); `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:27-31,38-39`;
  `.../presets/cordis.patch.yml:41-42`; `dsh-experimental-agent-team-profile/cordis.patch.yml`.
- Live profile: `~/.dsh/profiles/desktop/package.json` (`dsh.profile.bundles`), `cordis.patch.yml`.
- Plugin source: `src/defaults.ts:64-82` (allow-list), `src/mcp/tools.ts:211-1600` (29 registrations),
  `src/dsh/driver.ts:3754-3761` (batch-shape regression), `:3030-3045`/`:3410-3422` (dead `inspect` fallbacks),
  `:2869-2875` (`session_search` via `controller.search`).

### 6.4 What is still unverified

- No host-plugin-level execution was performed against `forge*`/`worktrees`/`schedule` — those entries are
  classified from catalog signatures + mount patches + package READMEs, not from a live first-class call.
- Whether a manually mounted `dsh-tool-terminal` row would find a working `ctx.terminals` backend in this
  Desktop composition (no PTY row is mounted by base/web-app).
- The exact `ForgePanelState`/`ForgeLocalDiff` shapes beyond their catalog declarations (they are browser
  consumers' contracts; a first-class forge tool would project a smaller shape of its own).
