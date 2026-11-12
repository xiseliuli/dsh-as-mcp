# Changelog

All notable changes to `dsh-as-mcp`, newest first. Versions follow SemVer; the
plugin is pre-1.0, so a minor bump is a feature and a patch is a fix or docs.

A Chinese summary of every release lives in [CHANGELOG.zh.md](./CHANGELOG.zh.md);
this file stays the authoritative record.

## 0.60.0

- **Opt-in human-in-the-loop for this endpoint's own mutating tools.** `approval.guardMutations` (default
  `false`) makes `file_write`, `file_edit`, `file_delete`, `file_move` and `shell_run` **hold before they
  run**: the request is published on `dsh://approvals`, offered to a stateful **2025-era** MCP client as an
  `elicitation/create` request on its GET stream, and released by `approval_decide` (`allow` runs it once,
  `reject` refuses it) or by an elicitation answer. If nobody answers within `approval.humanTimeoutMs`
  (default 120000) the call answers **rejected** — the bridge fails closed, so silence is never consent. An
  `allow` releases exactly one call; the next one asks again.
- **The two tools that serve it**: `approval_list` (the pending queue — `approvalId`, the tool, the harness
  reason, `createdAt`, and the `expiresAt` it will be answered `rejected` at; `includeSettled` adds the recent
  decisions with who answered) and `approval_decide` (answer one request; an id that is no longer pending
  returns `decided: false` rather than an error, so a race with the timeout is not a failure). The queue is
  also the `dsh://approvals` resource, pushed when a request is raised or settled, so a client can subscribe.
- **Why it guards the plugin's calls and not the harness's approvals.** Meaningful design note: the harness
  dispatches `approval/request` with a scoped waterfall, and `dsh-api-remotes` forwards that event to a browser
  peer; a plugin cannot claim it, and in a headless profile the request waits for a browser that is not there
  (observable as a turn that stays `running`). The bridge therefore covers what this endpoint executes itself,
  which is the part a remote caller can actually be made to confirm. `approval.policy` keeps its two values
  (`inherit`/`allow`).
- Docs and tests: both READMEs document the setting, the two tools and the fail-closed timeout, and their
  sample config shows `guardMutations`/`humanTimeoutMs`; `cordis.patch.yml` does the same; the settings panel
  gains a toggle and both dictionaries its strings. `tests/mcp-endpoint.test.ts` holds a guarded `file_write`
  until a decision (allow runs it once and the driver sees the write; reject returns a tool error and the
  driver is never called), `tests/approvals.test.ts` pins the broker (timeout/abort/dispose fail closed, first
  answer wins, pending cap, settled ring), and the config/settings/panel tests cover the new field.

## 0.59.0

- Four observability tools in the `session` group — `agent_list`, `subagent_tree`, `skill_list` and
  `skill_read` — bring the surface from 50 to 54 (the group from 28 to 32). They expose the read side of
  the DSH panels that answer "what is happening and what instructions apply": `agent_list` reports the
  agents the harness currently holds live (session id, `idle`/`running`, and whether each is a `root`),
  which is different from `session_list` — that sees every session on disk, this sees what is in memory;
  `subagent_tree` reports the sessions one session spawned (`id`, `createdAt`, `mode`, `label`) and, with
  `includeDescendants`, the whole subtree with `parentId` and `depth`; `skill_list` returns the
  instruction library the agent can load (`name`, `description`, `whenToUse`, `provider`, `source`,
  invocability, `path`, plus `complete` so a still-loading provider is not mistaken for an empty
  catalog); `skill_read` returns one skill's full instruction body so a caller can follow the user's own
  project conventions instead of inventing them.
- **Two deliberate boundaries.** A subagent child that cannot be read is reported with its `reason`
  (`corrupt`/`unsupported`/`unavailable`) rather than dropped, so a broken entry stays visible; and both
  skill tools are refused while `session.scope` is `"owned"`, because the catalog belongs to the instance's
  project/user instruction files rather than to any session — the same reasoning as the schedule surface.
  `agent_list` and `subagent_tree` do follow the owned scope, since both are about sessions.
- `dsh_info.harnessServices` gained `subagents` and `skills` probes (36 probes, was 34) and
  `dsh_info.notes` a paragraph describing the observability surface. No new configuration keys: the push
  surface, both transports, the tool groups and the settings panel are unchanged.
- Docs and tests: both READMEs gain four tool rows, `docs/CAPABILITY-GAPS.md` moves to 54 tools /
  36 probes, and `cordis.patch.yml` restates the session group as 32 tools. `tests/observability.test.ts`
  pins the live-agent projection (status, roots, owned filtering), the subagent tree (children vs
  descendants, a diagnostic child kept, the owned-scope refusal), and the skill catalog (snapshot
  completeness, the `list()`-only fallback that never claims completeness, the bounded body, the exact-name
  error, the owned-scope refusal); `tests/mcp-endpoint.test.ts` pins argument routing;
  `tests/availability.test.ts` covers the two new required capabilities.

## 0.58.0

- Five organization tools — `workspace_rename`, `session_move`, `session_reorder` in the `workspace`
  group and `file_delete`, `file_move` in the `files` group — bring the surface from 45 to 50. They are
  the writes a human makes in the sidebar and the file tree, with the same guards: `workspace_rename`
  changes only the label the DSH sidebar shows (directory, sessions and memberships untouched);
  `session_move` attaches an existing session to a workspace group or detaches it again (the
  drag-between-groups action, `action` defaulting to `attach`); `session_reorder` sets a session's
  position in its group's manual order (the drag-to-reorder action, `beforeSessionId` omitted meaning
  "end of the group").
- **File deletion and moves are deliberately narrow.** `file_delete` deletes one file through the
  filesystem seam and refuses a directory outright, because a recursive delete belongs in `shell_run`
  where the exact command is visible in the session log; `expectedSha256` gives it the same
  compare-and-swap guard `file_write`/`file_edit` use, and a file too large to verify within
  `limits.maxReadBytes` is refused with that reason rather than deleted unverified. `file_move` moves or
  renames one file, refuses an existing destination unless `overwrite: true` (then using the current
  destination version as the guard), and reports both phases of the seam's two-step operation —
  `operation` and `sourceDeleted`, with `sourceFailure` carrying the reason when the source removal
  failed, rather than presenting a half-completed move as atomic.
- `workspace_list` rows now carry `sessionIds` in the group's manual order, which is what makes
  `session_move`/`session_reorder` observable (and answers "which group is this session in" — something
  `session_list` cannot). The previous rows reported only a count.
- `dsh_info.harnessServices` gained a `workspaceOrganize` probe (34 probes, was 33) and
  `dsh_info.notes` two paragraphs on the file and workspace organization surface. No new configuration
  keys: the push surface, both transports, the tool groups and the settings panel are unchanged.
- Docs and tests: both READMEs gain five tool rows, `docs/CAPABILITY-GAPS.md` moves to 50 tools /
  34 probes, and `cordis.patch.yml` restates the workspace and files groups. `tests/organization.test.ts`
  pins the file guards (directory refusal, compare-and-swap, too-large-to-verify, two-phase move with a
  surfaced source failure) and the workspace writes (title through the workspace object, attach/detach,
  manual order, owned-scope refusal); `tests/mcp-endpoint.test.ts` pins argument routing;
  `tests/availability.test.ts` covers the new probe and group sizes.

## 0.57.0

- Three read-only forge tools in the `session` group — `forge_changes`, `forge_local_diff` and
  `forge_branches` — bring the surface from 42 to 45 (the group from 25 to 28). They expose the read
  half of what the DSH forge panel shows, so an external caller can answer "what did the agent change"
  and "are the checks green" without a local `gh` install: `forge_changes` lists the change requests
  bound to a session (URL, binding origin, repository/number, and the cached snapshot — title, state,
  draft, author, head/base branch, additions/deletions, mergeability, `mergeReady`, review decision,
  checks rollup and individual checks, unresolved threads, update time), `forge_local_diff` returns the
  working-tree diff for one of the panel's four scopes (`uncommitted` by default, `branch`, `staged`,
  `unstaged`) as a bounded file listing, or one file's unified patch text when `path` is given, and
  `forge_branches` returns the checkout's branches and the current one, which is exactly the set
  `worktree_create { from }` accepts.
- **Honest partial information.** A binding whose snapshot could not be read is still reported with its
  `failure` (for example `unauthenticated`) instead of disappearing, because that is what the panel shows
  too; a requested checks refresh that fails keeps the cached snapshot and marks `checksStale`; every
  payload is bounded (`maxFiles` for listings, `maxChars` up to 64 KiB for patch text, `omitted`/
  `truncated`/`textTruncated` flags when something was cut). Nothing in this group writes: no review is
  submitted, nothing is marked ready, nothing is merged — those stay deliberately absent, because they
  act on the user's code host with the user's credentials.
- Forge reads are scoped by a **live session handle** (`ctx.sessions.get`), so a cold session is refused
  with an explanation rather than reported as "no change requests", and `session.scope: "owned"` still
  applies to the session. `dsh_info.harnessServices` gained three probes — `sessions`, `forgeSession`,
  `forgePanel` (33 probes, was 30) — and `dsh_info.notes` a paragraph on the read-only scope. No new
  configuration keys: the push surface, both transports, the tool groups and the settings panel are
  unchanged.
- Docs and tests: both READMEs gain three tool rows, `docs/CAPABILITY-GAPS.md` moves to 45 tools /
  33 probes, and `cordis.patch.yml` restates the session group as 28 tools. `tests/forge.test.ts` pins
  the capability gate, the live-session requirement, the snapshot projection (including a failed
  binding), the refresh/stale semantics, the diff bounds and the branch passthrough;
  `tests/mcp-endpoint.test.ts` pins argument routing; `tests/availability.test.ts` covers the three new
  required capabilities.

## 0.56.0

- Four new tools at the end of the `session` group — `schedule_create`, `schedule_list`,
  `schedule_view` and `schedule_edit` — bring the surface from 38 to 42 (the group from 21 to 25).
  They wrap the Host `ctx.schedule` service, so a task is stored and delivered by the harness itself:
  its prompt fires at each occurrence whether or not this endpoint, or any client, is connected.
  `schedule_create` takes exactly one timing form — `rrule` (one `DTSTART` line plus one `RRULE` line,
  the same RFC 5545 subset the DSH Automation page writes), `afterSeconds` for a one-shot N seconds
  from now, or `everySeconds` for a fixed interval — and a `target` of `"session"` (update an existing
  conversation, needs `sessionId`), `"new_once"` (create one conversation on the first delivery and
  reuse it) or `"new"` (a fresh conversation per delivery), with `cwd`/`agentPreset` on the two
  new-conversation targets. A request that names two timing forms is refused rather than silently
  preferring one, and a new-conversation target that also names a `sessionId` is refused as
  self-contradicting. `schedule_list` pages tasks (active first by next occurrence, `limit` 1–200);
  `schedule_view` answers `found: false` for a missing id instead of an error; `schedule_edit`
  updates or deletes, pauses with `active: false` and resumes with `active: true`, and refuses change
  fields on a delete.
- **The whole schedule surface is refused while `session.scope` is `"owned"`.** A scheduled task is a
  Host record with no owning session, so an ownership filter cannot be expressed on it, and its
  delivery target may name any conversation on the instance; the error says exactly that and points at
  `scope: "all"`. Mutation outcomes are data rather than errors — `{ updated: true, task }`,
  `{ deleted: true }`, `{ found: false }`, `{ conflict: true }` — so a polling caller can act without
  parsing text, and `expectedUpdatedAt` carries the harness's own revision: a stale edit answers
  `conflict: true` and changes nothing instead of overwriting what the user just changed in the
  Automation page.
- `dsh_info.harnessServices` gained a `schedule` probe (30 probes, was 29) and `dsh_info.notes` a
  paragraph on the Host-global nature and the owned-scope refusal. No new configuration keys: the
  push surface, both transports, the tool groups and the settings panel are unchanged.
- Docs and tests: both READMEs gain four tool rows and a "Scheduled automation" section (with the
  create → list → pause/resume → delete flow and the owned-scope warning), `docs/CAPABILITY-GAPS.md`
  moves to 42 tools / 30 probes, and `cordis.patch.yml` restates the session group as 25 tools.
  `tests/schedule.test.ts` pins the driver contract (one timing form, target rules, page bounds, the
  owned-scope refusal, conflict/miss as data); `tests/mcp-endpoint.test.ts` pins argument routing;
  `tests/availability.test.ts` covers the new required capability.

## 0.55.0

- Three new tools in the `session` group — `session_command_list`, `session_command` and
  `session_goal` — bring the surface from 35 to 38 (the group from 18 to 21). A slash command
  executes **without a model turn** (the registry parses the line and invokes the handler directly),
  so `session_command` is the cheap half of "do what a human typing into the DSH composer would
  do": compact a long session, export its log, enter plan mode or set a goal. `session_command_list`
  reports every command the session's agent can see, with its description and input hint, and marks
  each `permitted` instead of hiding the refused ones; `session_command` takes the line with or
  without its leading slash and with arguments in the same string (`"compact"`, `"/export"`,
  `"/goal <objective>"`, `"/plan off"`), and the run goes through the harness's own command
  registry, so it is the same execution a human typing the line produces (the reply carries the
  harness's `commandId`, `ok`, the handler's `text` and the `sourceEventSeq` it recorded). The
  admitted set is explicit — `/compact`, `/plan`, `/goal`, `/export` — not "anything the registry
  lists": `/permission` would change the session's permission preset (a remote caller must not
  escalate its own session) and `/feedback` writes the user's own review records, so both are
  refused **before** any handler runs — a refused call writes nothing to the session log — and an
  unknown name is refused with the admitted set listed. A handler that reports an error comes back
  as `ok: false` with its text, while a name/argument the registry did not admit is an error saying
  nothing was logged.
- `session_goal` reads and mutates the session's **durable goal** — the long-running objective the
  harness's round driver keeps advancing across turns, which is how a caller delegates multi-hour
  work instead of holding one turn open. `action` is `get` (the goal, or `null`) or
  `create`/`edit`/`pause`/`resume`/`complete`/`clear`; `create` needs `objective`, `edit` needs
  `objective` and/or `maxGoalRounds`, and every other action acts on the goal that exists now, so
  its ref comes from a read rather than from the caller. `expectedRevision` (from a previous read) is
  the lost-update guard: a mutation whose goal changed underneath — say the user edited it in the DSH
  UI a moment ago — is refused instead of silently applied, the same spirit as the UI's conflict
  handling. A goal reports `id`, `revision`, `objective`, `phase` (`active`/`paused`/`blocked`/
  `complete`), `activation` (`armed`/`disarmed`), `maxGoalRounds`, `roundsStarted`, `blockedReason`
  when blocked and its timestamps; `clear` returns `goal: null` with `cleared: true`, and `complete`
  returns the completed goal.
- `dsh_info.harnessServices` reports two more probes, `commands` and `goals` (29 in total, up from
  27), and `toolAvailability` pre-flights the three tools against `sessionController` +
  `sessionController.resolveAgent` plus the matching service, so an agent-scoped command or goal
  service that a profile does not mount is reported unavailable instead of failing at call time.
  `dsh_info.notes` gains one paragraph per surface: commands run without a model turn and only the
  user-plane set is admitted, and goal mutations carry the harness's revision guard.
- No new configuration keys: push, the two transports, the tool groups and the settings panel are
  unchanged. Both READMEs gain the three tool rows, a "Session orchestration" flow and a
  deployment-requirements row; `docs/CAPABILITY-GAPS.md` is re-counted to 38 tools and 29 probes and
  marks slash commands and durable goals as shipped, with `resolveAgent` named as the bridging layer.
  `tests/orchestration.test.ts` pins the new driver surface (allow-list before the handler, slash
  normalization, the revision guard, projection of the goal view) and `tests/mcp-endpoint.test.ts`
  the argument passthrough; `tests/availability.test.ts` covers the new pre-flight rules.

## 0.54.0

- Server push now covers the whole run instead of one turn-ending signal. The existing
  `subscriptions/listen` stream carries a feed set as readable synthetic resources — no new tools,
  so the surface stays at 35: `dsh://sessions` (add/remove/activity/status and subagent starts and
  ends), `dsh://session/<id>/events` (the newest durable events projected to
  `{seq, type, at, turn, step, summary, error}`, published on every append, at most 64 per read),
  `dsh://session/<id>/assistant` (live `start`/`text`/`reasoning`/`tool`/`finish`/`end` frames with
  a monotonic `seq`, sourced from `agent/assistant-stream`), `dsh://session/<id>/status` (the
  `session_status` payload), `dsh://session/<id>/projections` (the allowlisted
  `workingDirectory`/`worktree`/`goal`/`plan`/`todos`/`agentPreset`/`title` values), and
  `dsh://jobs` / `dsh://jobs/<id>` (background shell jobs; the job tail read is non-consuming, so
  watching it cannot steal bytes from `shell_output`). The `dsh://session/<id>/turn` settlement
  resource from 0.52.86 remains and is now one feed among the set instead of the only one.
  `resources/list` and `resources/templates/list` advertise the feeds; `dsh_info.notes` names them
  too.
- Publishes are coalesced per URI at 150 ms (`PUSH_COALESCE_MS`): the first publish of a window
  goes out immediately, later ones collapse into one trailing publish, and different URIs never
  wait on each other — so a token stream costs at most one notification per window per URI instead
  of one per token. Turn settlement stays deliberately immediate. The live tails are bounded in
  process: assistant frames keep 256 KiB / 2 000 frames per session and a read returns at most 200
  frames and roughly 32 KiB of text (newest first, `truncated` when older frames were dropped), an
  events read stops at 64, a job read returns at most the newest 8 192 characters of a 16 KiB
  retained tail, and the job feed polls about once a second only while somebody is subscribed. No
  subscriber means no work: the collectors return early and no harness service is read, so a
  fire-and-forget prompt with no listener costs what it did before. `session.scope: "owned"` gates
  notifications as well as reads — a session this endpoint did not create or fork produces no
  frame (its subagent sessions included: their parent's feeds publish, and their own feeds remain
  readable through the owned tree) — so the push channel cannot be used to enumerate ids the
  tools would refuse.
- A stateful 2025-era Streamable HTTP leg now sits beside the modern one. An `initialize` answers
  with an `mcp-session-id` header; `POST`/`GET`/`DELETE` carrying it are served by a per-session
  server and transport, and the long-lived `GET` with `Accept: text/event-stream` is the
  notification channel — so `notifications/resources/updated` finally reaches 2025-era clients
  that have no `subscriptions/listen`. Sessions are capped at 8 (least recently used evicted) and
  closed after 30 minutes idle, answering `404 Session not found` so the client re-initializes.
  Resumability is deliberately absent: `Last-Event-ID` replay is not implemented because every
  notification is payload-less and a reconnect re-reads. Clients that never take the session id
  keep the previous stateless serving unchanged — later `POST`s answered from a fresh stateless
  instance, `GET`/`DELETE` still `405` (the stateless legacy GET is not a push channel; a stateful
  session's GET is).
- `bin/mcp-stdio.mjs` opens that GET stream after a stateful `initialize` and forwards every
  server notification and server→client request to stdout as one JSON line, reconnecting with
  500 ms→30 s backoff (a stream that delivered messages restarts at the base delay) and sending
  the last SSE id it saw (harmless: the server ignores it). A stateless endpoint — no session id,
  or a GET answered `404`/`405` — prints one push-disabled note and keeps the old request/reply
  behavior. `src/mcp/feeds.ts` owns the collectors, reads and buffers, `src/mcp/push.ts` the
  per-URI coalescing and the 2025 fanout, `src/mcp/http.ts` the stateful session manager;
  `tests/feeds.test.ts`, `tests/feed-resources.test.ts`, `tests/legacy-http.test.ts` and
  `tests/stdio-bridge.test.ts` pin each half, and both READMEs gain a "Server push and the two
  transports" section with the era table, the feed table and the backpressure bounds. The tool
  surface, the tool schemas and every configuration key are unchanged.

## 0.53.0

- The endpoint now covers Git worktrees and the sidebar's session organization. Six new tools —
  `worktree_create`, `worktree_restore`, `session_archive`, `session_unarchive`, `session_pin`,
  `session_unpin` — bring the surface from 29 to 35. `session_create` gained
  `worktree: true | { name, from }`: the session is created first in the workspace (or bare
  directory), so a session created with `workspaceId` keeps its place in that workspace group (a
  cwd-only session stays ungrouped), and only then is a Git branch created, checked out and made the
  session's live working directory — the sequence the DSH UI's "New worktree" option performs. A
  failed worktree request leaves the session usable in the workspace and reports `worktreeError`
  (retry with `worktree_create`); a profile with no worktrees service is refused *before* the
  session is created. `worktree_create` does the same for an existing session, refusing while a turn
  is running and serializing concurrent worktree operations per session (the harness service has no
  lock of its own). `worktree_restore` re-checks a removed worktree out from the record
  `worktree_create` returned, recreating the branch at `baseCommit` when it was deleted too.
  `session_status` reports `workingDirectory` and the forge panel's `worktree` record when the
  profile can read projections, and a change in either now wakes a held `waitMs`; `session_list`
  gained `includeWorktree` to fold the same two fields into its rows, which also carry `archived`
  and `pinned` flags. Archive/pin write the same registry sets the DSH sidebar's actions write:
  archiving an active session requires `stopActivity: true` (the flag that also asks its work to
  stop), archiving keeps the log, and the harness still has no session delete.
- Fixed the one regression DSH 0.2.2 introduced in this bridge: `dsh_tool_call` failed every call
  with "Tool batch execution failed" while `dsh_tool_list` kept working, because `ctx.tools.execute`
  changed from a single-call input/output to a batch contract (`{ calls, signal, agent }` in,
  `{ results }` out). The driver now tells the two shapes apart by the presence of `tools.resolve`
  (shipped together with the batch executor), sends its one call in the right envelope and unwraps
  the batch result, so the same build works on ≤0.1.7 and 0.2.2+. The allow-list and session-scope
  checks run before either path.
- DSH 0.2.2 removed `sessionController.inspect`. Log reads now prefer `sessionQuery`, keep `inspect`
  on ≤0.1.7 and fall back to the controller's `events` message-aligned pages on 0.2.2 — enough for
  "what is open now" and for the transcript, though a bounded page can cover less of a very long
  log. Usage needs the whole log and deliberately does not use the paged reader (it would silently
  under-count), so without `sessionQuery` (or `inspect` on ≤0.1.7) it reports an explicit capability
  error instead of the `TypeError` a missing method used to produce. `session_search` remains
  disabled on shipped Desktop profiles (the `session-query` index is configured `openAt: "never"`)
  and says so. Worktree tools need the harness's `worktrees` service, first verified in
  `0.2.2-rc.1` and shipped by the experimental forge bundle in Desktop/Web;
  `dsh_info.harnessServices.worktrees` reports it and `toolAvailability` names every tool the
  current profile cannot serve. Both READMEs gain a Worktrees section — the same-group workflow, a
  typical flow and the two limits (no service, no commit) — and a tool table with all 35 rows;
  `docs/CAPABILITY-GAPS.md` is re-counted to 35 tools and 27 probes.
- `docs/NEW-CAPABILITIES-0.2.2.md` is the capability audit behind this release: the installed
  `0.2.2-rc.1` service catalog against the old audit, what is now reachable, the ranked candidates
  and the explicitly rejected additions (`typertGateway.invoke`, credentials, approval/sandbox
  writes, …, restated for the implementation phase). `docs/WORKTREE-INTEGRATION-CONTRACT.md` is the
  host-side contract the implementation follows: `ctx.worktrees.create/restore` signatures, the
  proof that workspace grouping uses the durable header `cwd` (so entering a worktree keeps the
  group only when the session was created with `workspaceId`), the forge panel's behavior to mirror,
  the failure/concurrency matrix, and the recommended order of operations. `tools/check-docs.mjs`
  and `tests/docs-consistency.test.ts` keep the two READMEs, the changelogs and the tool table in
  step.

## 0.52.86

- A fire-and-forget turn can now report its own ending to a modern (2026-07-28) MCP client
  instead of leaving the caller to poll. The endpoint advertises `resources.subscribe`, registers a
  readable synthetic resource `dsh://session/<id>/turn` (the `session_status` payload), and — when a
  `session_prompt { wait: false }` is admitted while a `subscriptions/listen` stream is open —
  watches that turn with the same wait a blocking call uses and publishes
  `notifications/resources/updated` when it settles: completed, failed, cancelled, or gone without
  an ending. The watch is armed only while someone is listening (an unsubscribed fire-and-forget
  prompt still costs nothing), one watch per request id (an idempotent retry does not
  double-publish), and bounded by the same `promptTimeoutMs` — a wait that timed out never observed
  an ending, so it publishes nothing rather than claiming one. Clients that do not subscribe,
  including every 2025-era client and the stdio bridge, are unaffected and keep polling
  `session_status`; the listen stream must be open *before* the prompt is admitted.
- The server instructions and the `session_prompt` `wait` option now state the subscription contract
  where a client will actually read it. `src/mcp/push.ts` owns the per-endpoint subscription bus and
  the publish call, the driver arms and tears down the watchers, and
  `tests/push-notifications.test.ts` pins the URI encoding, the subscriber gate, the advertised
  capability, the readable template, both instruction sentences, and publish-once against a fake
  session log.
- The tool surface, the legacy stateless transport and the rest of the endpoint are unchanged.

## 0.52.85

- The MCP server's settings panel now also renders on the **Plugins page**, under this bundle's own
  page: the browser half registers the same `McpSection` into the host's `plugins.bundle.config`
  keyed seat, keyed by the bundle's package name (the page dispatches `entryKey = pkg.name`), so a
  setting can be changed without opening DSH Settings. Both entries render the same component over
  the same shared configuration form and snapshot — one value, two doors; a write from either is
  visible in the other without a reload — and the new cell is registered only while the host serves
  this entry's form (`ctx.configForms.whileServed`), exactly like the settings section. Because the
  Plugins page renders bundle configuration inside a bare `section.detailSection` with no title of
  its own, the cell asks the panel for a heading; the settings entry keeps relying on the settings
  shell's nav and adds none. A host whose Plugins page declares no such seat simply shows no cell,
  and the settings entry is unaffected. `src/client/contract.ts` now types both slot kinds (a list
  entry's `id` arm and a keyed entry's `key` arm) and cites the harness `KindOptions` shape, instead
  of assuming `settings.section`.
- `tests/client-half.test.ts` pins the new surface against the built bundle and the source: the cell
  is keyed by the package name (a wrong key renders nothing, silently, because the page's
  `configured` ledger is exactly the set of registered keys), both surfaces sit behind the same
  `whileServed` gate, and exactly one store backs both doors. The built `lib/client.js` still
  requires only the platform's seeded modules.
- The endpoint, tools and host half are unchanged apart from the version the MCP `initialize`
  result advertises.

## 0.52.84

- The GitHub-install instructions now lead with the approval that keeps working. pnpm matches a
  git dependency's build by `<name>@<git url>` with no `#<ref>`, so one `allowBuilds` entry covers
  every later commit; the previous text led with the commit-pinned key pnpm prints
  (`…/tar.gz/<sha>: true`), which stops matching on the next push and forced a fresh manual
  approval on every update. The section also states the correct floor for the two commands it
  documents — `github:…` and a release `.tgz` are both fetched as tarballs, so the repository form
  needs pnpm ≥11.19.0 (11.11.0 only covers cloned git dependencies), and pnpm 10 names the same
  decision `onlyBuiltDependencies` — and points at the channels that need no build approval: `npm`
  and the prebuilt Release asset, neither of which runs `prepare`.
- `tools/check-docs.mjs` now fails when either README's git-install guidance drifts from the
  package's own identity. While `package.json` keeps a `prepare` script and `lib/` stays
  gitignored, both languages must carry the manifest-derived key
  (`dsh-as-mcp@git+https://github.com/xiseliuli/dsh-as-mcp.git`) and name
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. A package or repository rename, or making the build
  unnecessary, therefore breaks the release check instead of silently leaving readers a key that
  matches nothing. Issue #1 is why this exists: a Plugin Hub 1.6.5 install fell back to the git
  channel after its own npm lookup missed this package, pnpm's build gate refused the `prepare`
  run, and DSH's generic hint left the reporter to copy a key by hand.
- Install guidance is the only change: the built `lib/` and every tool behave as in 0.52.83, apart
  from the version the MCP `initialize` result advertises.

## 0.52.83

- A first-time MCP client now learns the reporting contract where it actually looks. The `initialize`
  instructions, the `session_prompt` description and its `wait` option all name the fire-and-forget
  handoff (`wait: false` → follow with `session_status`, whose `waitMs` reports the first change) and
  the failure channel (`turn.failure` = `{kind, message}`; a completed turn carries no failure block).
  `session_prompt` advertises an output schema for the first time, including `turn.failure`, and
  `session_status` now advertises its whole report (`idleMs`, `stalled`, `failure`, `lastTurn`,
  `changed`, `waitedMs`, …) instead of only `sessionId`/`running` — a schema-aware client can see the
  contract without guessing. Many MCP hosts do not forward `initialize.instructions` to their model,
  so the tool surface is the only onboarding text that can be relied on; the wording is pinned by a
  test rather than left to habit.
- `tools/live-checks.mjs` gained an onboarding section: a real endpoint must carry non-empty
  instructions naming the follow-up, and both tools must keep those sentences and schema fields.
  That makes a wording edit which drops the contract fail a check instead of silently making the
  feature undiscoverable. Measured on 0.52.83, one boot with the search index open: live-checks
  **195/195** (`--with-model --with-subagent`, the six onboarding checks among them) and acceptance
  **166/166**.

## 0.52.82

- The changelog now has a Chinese summary for every release: `CHANGELOG.zh.md` mirrors the version
  headings of this file one-to-one, with 1–3 Chinese bullets each. `tools/check-docs.mjs` fails when
  the two files disagree on the version set or order, or when a version carries no Chinese bullet, so
  a release that forgets its Chinese entry cannot ship silently. The Chinese file is a summary, not a
  translation — implementation detail, measurements and design rationale stay here, in the
  authoritative record. It is linked from both files and ships in the npm package (`files`).
- The failure-reporting evidence gap from 0.52.81 is closed by fault injection against a throwaway
  profile. A forced credential failure ended a real turn with `turnEndReason`/`turn.failure`
  `{kind: "error"}` (AUTH 401, empty reply, settled in 478 ms instead of the 120 s timeout); the same
  was observed when the session log was renamed away mid-turn (ENOENT, `error`, 13.8 s); `kill -9`
  of the harness mid-turn produced, on the next cold read, `session_status.lastTurn.reason`
  `{kind: "interrupted"}` and `failure {kind: "interrupted"}`; and `stalled` flipped to true on a
  real running turn after 62.9 s of log silence. Two wait-side detections remain unit-tested only:
  `unreadable` (the harness closes a log-less turn with `error` before the wait can read it) and
  `vanished` (a crash is synthesised as `interrupted` on the cold read). `docs/LIVE-VERIFICATION.md`
  now carries the verified rows and a narrowed statement of what is still not observed live; the raw
  run (setup, replies, the credential-precedence hazard) is recorded in
  `docs/FAULT-INJECTION-2026-11-03.md`.

## 0.52.81

- New `session_status` reports one session's live state: whether a turn is open right now, its turn
  and step, the newest durable event (`lastEventSeq`/`lastEventAt`), how long the log has been quiet
  (`idleMs`), `stalled` once a running turn has been silent for a minute, how the last turn ended,
  and a normalized `failure` when it ended abnormally. Work started with `session_prompt { wait:
  false }` previously had no reporting channel at all — a caller could only poll `session_list` /
  `session_messages` and could not tell a finished task from a dead one. `waitMs` turns the call
  into a long-poll: it returns as soon as anything changes or the bound elapses, so a supervisor is
  told once per change instead of on a guessed interval. Read-only, one durable-log read.
- `session_prompt` now says when a turn failed instead of returning it as an ordinary reply.
  `turn.failure` carries `{kind, message}` for the harness's own failure endings (`error`,
  `blocked`, `max-tokens`, `interrupted`) and for an ending this build does not recognize; it is
  absent for `completed`, for a caller-requested `aborted`, and for a fork boundary. It also reports
  two conditions the wait detects itself: `unreadable` — the session log stopped being readable
  mid-wait, which used to surface as a bare ENOENT only after the caller's timeout — and `vanished`
  — the turn stopped without a `turn/end` while its agent went idle, which used to sit out the whole
  timeout and report `timedOut: true`, i.e. "still running". `tests/driver.test.ts` covers the
  ending normalization, the error reply, the vanished turn and the unreadable log.
- The wait's progress notification now separates the two numbers a heartbeat needs: `turn 3: 2 tool
  call(s), 41s elapsed, log quiet for 12s`. A long turn and a dead one used to look identical.
- `session_status` is covered in the live sweep (a `wait: false` prompt followed by a held status
  call, then the settled ending and the absence of a failure block) and the forwarding test; both
  README tables, the capability audit's tool count and `docs/LIVE-VERIFICATION.md` are updated.
  Measured on 0.52.81, one boot with the search index open: live-checks **189/189**
  (`--with-model --with-subagent`) and acceptance **166/166**; the status section's held call
  reported `changed: true` while the turn ran and `idleMs` 3 ms after the newest event.

## 0.52.80

- A cancellation that lands in the window *after* the harness opened the turn but *before* the
  prompt was committed no longer leaves the waiting `session_prompt` running to its timeout. The
  durable log holds no `user/message` for that request (the turn was aborted with the message still
  in the inbox), so `locateTurn` had nothing to anchor on and the wait reported `timedOut: true` on
  a turn the caller had already cancelled. The driver now keeps a per-session cancellation
  generation: `cancelSession` bumps it, and the wait settles with `turn.aborted: true` as soon as
  it sees the bump. `cancelSession` is what both `session_cancel` and an MCP
  `notifications/cancelled` call, so both paths are covered. Measured: a 30 s `timeoutMs` used to
  return at 29 995 ms with `aborted: false`; after the fix the same cancellation settled 18 ms after
  the notification in the full sweep. `tests/driver.test.ts` pins the pre-commit window (a stub
  whose admission commits nothing).
- The full live sweep now runs with the session-search index open and
  `DSH_PERMISSION_MODE=danger-full-access` (`tools/sweep-local.sh`), so the checks meet the shape a
  deployment actually opts into instead of the stock `openAt: "never"` one. Two findings from
  building it, both recorded in the script: a headless throwaway profile leaves the stock approval
  policy `ask`, parking a turn on a question nobody answers (the cancellation check then has
  nothing to stop — it sat at the 300 s prompt timeout with `turn.aborted: false`); and the
  cancellation window above, which the earlier profiles happened not to hit. Measured after both
  fixes, one boot with the search index open: live-checks **180/180** (`--with-model
  --with-subagent`) and acceptance **166/166**.
- The caller-set truncation caps are asserted with receipts: one real turn with
  `toolCalls: "full"`, `maxArgumentChars: 200` and `maxReplyChars: 40` must return a tool call
  with `truncated: true` and its original `argumentsBytes` beside the cut arguments, and a reply
  with `replyTruncated: true` whose `replyChars` is the original length. "The parameter was
  accepted" would pass a silent cut. Measured in the sweep: 464 bytes → 200 chars and 299 → 40
  characters, each with its original length beside it.
- New maintainer tool `tools/clean-probe-sessions.mjs` (not shipped in the package): the checks
  create real sessions, and a long-lived checkout accumulates thousands of them in
  `$DSH_HOME/sessions`. It removes only sessions it has *positive evidence* the checks created —
  a throwaway workspace key, or a log whose every prompt carries the plugin's own `rpcId`
  (`dsh-as-mcp-…`) — and never a session with any human prompt, whichever key it is in and
  whatever its transcript says; a `user/message` without an `rpcId` counts as human (subagent
  prompts look like that, so check subagents are left as noise rather than guessed at). It also
  never touches a session written to in the last 10 minutes, and never changes anything on a dry
  run. `--yes` moves removals to `$DSH_HOME/sessions-trash/` instead of deleting them; `--purge` is
  the only permanent path. The first draft of this tool matched check-prompt *text* anywhere in a
  log, and on 2026-11-03 that deleted two real developer sessions (one while the app had it open)
  because their transcripts quoted the checks' own sources;
  `docs/INCIDENT-2026-11-03-session-log-deletion.md` records the incident, what survived, and the
  rule this entry states. `tests/clean-probe-sessions.test.ts` pins the behaviour with 15
  synthetic-store cases, including a human session whose transcript contains every marker and a
  symlinked workspace key that must not be followed.

## 0.52.79

- Two more options are asserted by effect: `session_list` folds titles only when `includeTitle` is
  set (checked when the session has a generated title), and `session_usage { sinceSeq }` returns a
  windowed fold — fewer turns and fewer tokens than the whole log — rather than ignoring the
  parameter. Both reuse the turns the real-turn section already paid for. Measured: full
  163/163, session-only 95/95 (the includeTitle check ran on a real generated title); README
  tables and the matrix updated.

## 0.52.78

- Two more options are asserted by their effect rather than their acceptance:
  `session_list { running: false }` must list an idle session that `running: true` excludes, and
  `session_usage` with `includeTurns: false` / `includeCost: false` must omit the `byTurn` and
  `byTurn` empty and cost unavailable. A filter that is accepted but ignored would pass a
  one-directional test.
- The first version of the omission assertion expected the fields to be *absent*; the contract
  is an empty `byTurn` array and `cost.available: false`, so the shape is asserted instead. The
  failure was my assertion, not the code. Measured after the fix: full 161/161, session-only
  93/93, cheap subset 110/47/64/68; README tables updated.

## 0.52.77

- `session_usage`'s `includeSubagents` is now asserted both ways: with it (the default), the
  subagent is a row and the report total includes its spend; with an explicit
  `includeSubagents: false`, no subagent row appears and the total is the session alone
  (measured 55499 vs 36808 tokens). The option was exercised one way only, so "accepted but
  ignored" would have passed.
- The first version of this check assumed the default was `false` and failed live — the code and
  both READMEs already said `true`. The assertion now disables the default explicitly; the
  mistake is recorded here because a doc-vs-code disagreement is exactly what this check exists
  to catch, even when the code was right and the check was wrong.

## 0.52.76

- Documented a distinction found while probing what happens to a message queued behind a
  cancelled turn: this endpoint runs **one turn at a time per session** (`enqueueTurn`), so a
  second prompt from the same connection waits behind the running turn instead of entering the
  harness inbox — measured at 21.9 s for a 20 s turn. Queuing *behind* a running turn needs a
  second MCP client (and even then the queue view did not confirm the message while a waiting
  request was in flight), which is now stated in the `session_prompt` row of both READMEs; the
  probe's cancellation assertion was removed rather than kept as a check that depends on that
  in-flight timing.

## 0.52.75

- After a cancelled wait returns, the check now also requires the turn to actually stop: the
  session must leave `session_list { running: true }` (polled up to 20 seconds). The wait ending
  and the turn stopping are two different facts, and only the first was asserted before.
  Measured: full 159/159, session-only 91/91; READMEs and the matrix carry the numbers.

## 0.52.74

- The checks that must act while a turn is open (cancellation, steering into the running turn,
  the mid-turn model switch) no longer sleep 1.5-3 seconds hoping the turn has started: they
  poll the session listing's `running` filter (up to 20 seconds) and proceed the moment the turn
  appears. Same flake discipline as the title check, applied to the remaining fixed waits.
  The first attempt polled the wrong session variable in the prompt-steer block (the check then
  saw 3 turns instead of 2); the assertion caught it immediately and the wait is now on
  `steerSession`, with the full shape green at 158/158.

## 0.52.73

- The title-visibility check no longer sleeps a fixed 4 seconds waiting for the harness to write
  its title request; it polls the session log for up to 20 seconds and stops as soon as the event
  appears (or the log is missing). A fixed guess is how a check measures the machine and flakes
  on a slow run — the same discipline the rest of the suite follows. Full shape with
  `--with-model` re-run after the change: 158/158.

## 0.52.72

- Hybrid deployments now also check admission on the second entry: a request without a bearer is
  refused with `401` + `WWW-Authenticate: Bearer`, and a wrong bearer is refused too. The two
  entries share a token file, but that is configuration — the check is what the route does.
  Hybrid shape measured at 116/116; both READMEs say so.

## 0.52.71

- The hybrid cross-entry section now also checks state: a session created through the plugin
  listener is listed through the web-server entry, and a rename made through that entry is what
  the listener reports. Same host, two doors — a client handed the wrong URL must not see a
  different view of the same session. Hybrid shape measured at 114/114 (109 + 5 cross-entry
  checks); both READMEs say so.

## 0.52.70

- Added a `hybrid` shape (listener **and** `mountOnWebServer`) and a live cross-entry check: a
  second MCP client going in through DSH's web server must advertise the same tools, report the
  same build and listener state, and see the same registered workspaces as the plugin's own
  listener. A second entry that disagreed would be a deployment that half-works depending on
  which URL a client was handed. Measured: hybrid 112/112 (109 + 3 cross-entry), mountonly
  109/109. Building the shape surfaced a bug in my own patch template: the hybrid profile rendered
  `mountOnWebServer: false` (the flag only switched on `mountedOnly`), so the second entry was the
  SPA fallback — the new cross-entry check caught exactly the half-working deployment it exists to
  catch, and the template is fixed.

## 0.52.69

- `tools/shapes.mjs` gained a `mountonly` shape: `http.enabled: false` +
  `mountOnWebServer: true`, served on DSH's web server, checked over that route. live-checks
  understands `--mounted-only` and then expects `listening: false`,
  `mountedOnDshWebServer: true` and an endpoint string that describes where it lives instead of
  echoing a URL. The mounted-only deployment previously had only a hand probe per release.
  Measured on this build with `--with-model`: 158 full, 90 session, 63 narrow, 68 files+shell,
  109 mounted-only; cheap subset 109/46/63/68. Both README tables updated.

## 0.52.68

- `dsh_info`'s endpoint/listening pair is now asserted as a relation in every live run: the
  `endpoint` string is a dialable URL exactly when `listening` is true, and explicitly not a
  URL when the endpoint is served elsewhere (the mounted-only explanation). The two fields were
  recorded separately before, so a non-URL endpoint next to `listening: true` would have passed.
  Live-verified the mounted-only configuration: `initialize` works on DSH's web server, the
  plugin port has no listener, and `dsh_info` answers `listening: false`,
  `mountedOnDshWebServer: true`, endpoint `/mcp (served by the DSH web server; ...)`. (A first
  probe read a field name that does not exist — `mountedOnWebServer` instead of
  `mountedOnDshWebServer` — and I re-ran it before recording anything.)

## 0.52.67

- Live-verified the `port: 0` configuration end to end: the plugin bound an OS-assigned port
  (`61532`) and `dsh_info` reported `endpoint: "http://127.0.0.1:61532/mcp", listening: true`
  — the port the OS chose, not `0`. The panel prefers that live URL since 0.52.66, so both
  halves of the same problem are now covered. (Two earlier probe attempts failed on my own
  script, not the plugin: an unbalanced parenthesis and a port discovered from the wrong
  process.)

## 0.52.66

- The panel's client snippet now uses the endpoint a client can actually dial:
  - the live `status.url` when the listener is up (so a `port: 0` configuration shows the
    port the OS assigned, not `0`);
  - `<this page's origin><path>` when the plugin listener is disabled and the endpoint is
    served by DSH's own web server — the mounted-only configuration used to print the
    plugin's unbound port;
  - the configuration mirror last, which is the only source while the panel loads.
  A non-URL status string (the mounted-only explanation) is never used as an endpoint. The
  choice lives in `dialableEndpoint` with unit tests for each branch.

## 0.52.65

- A panel on a host that mounts no status route (or whose fetch fails) used to show no health
  badge and no reason. It now says the endpoint status cannot be read here — health stays
  hidden, which is the honest state, but silently missing looked like an unfinished panel.

## 0.52.64

- The panel's client configuration no longer appears while its configuration is half-read: it
  used to render `http://127.0.0.1:` (port and path still missing) as if it were copyable. The
  URL now comes from `endpointUrl`, which returns `undefined` until the port and path are both
  known and rewrites a wildcard bind to a dialable host; the pane stays hidden until then.
  Unit tests cover the half-read cases and the wildcard rewrite.

## 0.52.63

- Two views of one background job are now checked against each other: a row in
  `shell_list { running: true }` must report `done: false` from `shell_output`, and after
  `shell_kill` that same call must report `done: true`. The two filters were each trusted on
  their own before.

## 0.52.62

- Found a real ambiguity while adding a cross-view check: `workspace_list`'s `sessionCount` is
  the registry's **attach list** (sessions created with `workspaceId`), while a session created
  by `cwd` alone is not attached — so the row can read 0 while `session_list { cwd }` shows a
  session. The docs now say exactly that, and the live check asserts both halves: a session
  created through the registration moves the count, one created by cwd alone does not.
- The first version of the check asserted the two tallies were equal, which failed live
  ("workspace 0 vs listing 1") and exposed the ambiguity instead of endorsing a wrong reading.

## 0.52.61

- `workspace_list`'s `sessionCount` is now checked against a session the endpoint actually
  creates in that directory: it must move by one. The listing check alone only proved the field
  was a number; this proves it is the harness's own tally for the right workspace.

## 0.52.60

- The configuration-sample check now covers **both** READMEs: the Chinese sample was compared
  by nothing, so a value could drift there while the English one stayed honest. Proven by
  changing the zh sample's `maxReadBytes` to 1048577 —
  `DRIFT: README.zh.md sample says limits.maxReadBytes: 1048577, the default is "1048576"` —
  then restoring.

## 0.52.59

- The README yaml configuration sample is now checked against `src/defaults.ts`: every scalar
  (http host/port/path/toggles, all six tool toggles, session fields, limits, approval policy)
  must equal the shipped default, because a profile patch **replaces** the row's config and a
  sample that drifted would silently change behaviour for whoever copied it.
  `agentTools.allow/deny: []` stay documented as "empty means the built-in allow-list" and are
  asserted to be empty rather than compared with the default array.
- Proven by changing the sample's `promptTimeoutMs` to 900001 —
  `DRIFT: README sample says session.promptTimeoutMs: 900001, the default is "900000"` — then
  restoring. Building the check surfaced two of its own bugs (a `''` empty-string mismatch and
  an inline `DEFAULT_APPROVAL` object it could not parse), both fixed.

## 0.52.58

- The drift check now compares five caps stated in README prose with the constants that
  enforce them: image size (`MAX_IMAGE_BYTES`, 8 MiB), request body (`MAX_REQUEST_BYTES`,
  64 MiB), prompt images (`MAX_PROMPT_IMAGES`, 4), background jobs (`MAX_SHELL_JOBS`, 16) and
  remembered owned ids (`MAX_OWNED_SESSIONS`, 1000). Proven by editing "8 MiB" to "9 MiB" —
  `DRIFT: README.md claims 9 for the MiB image cap, the code says 8` — then restoring. Both
  READMEs list the check.

## 0.52.57

- `docs/CAPABILITY-GAPS.md` opened by claiming "25 tools" for several releases while the code
  had 28. The page now says 28, and the drift check compares that opening sentence with the
  registered tools — the appendix count was already checked, the introduction was not.

## 0.52.56

- A live turn now asserts that the usage fold agrees with the harness's own token projection:
  `verifiedAgainstProjection === true` and no `projectionTotals` (that field appears only when
  they disagree). Two independent implementations agreeing is the check unit tests cannot
  provide — a stub projection just repeats whatever the test built. Verified live: full shape
  153/153, session-only 89/89; READMEs and the matrix carry the numbers.

## 0.52.55

- Verified the documented blind spot: the session title is generated by an LLM call that
  leaves no usage record. The live check reads the session's own durable log through
  `shell_run` — it finds `session/title-llm-request` **with a route** and no usage-bearing
  event for it, and the receipt's `samples` equals the number of `assistant/message` +
  `assistant/attempt` events in the log. If the title call ever started writing usage, that
  equality would break. Full shape after the addition: 152/152; the matrix records the
  measurement and both READMEs carry the new count.

## 0.52.54

- The acceptance run now pins fork accounting instead of only "inherited > 0": the child's
  `inherited` must equal the parent's total at the cut, a fresh child's `totals` must be zero,
  and after the child runs one turn its `totals` must equal that reply's usage while
  `inherited` stays the parent's figure (with exactly one `byTurn` row). The acceptance run
  goes from 163 to 166 checks and is green; both READMEs carry the new count.

## 0.52.53

- Prompt image attachments now have live coverage: one real turn carries a 1×1 PNG and
  settles (the path is read through the filesystem seam and becomes an image block), a
  five-image prompt is refused before any turn runs, and an unreadable image path is an error
  that names the file.
- The first attempt also documented a real distinction: the 1×1 PNG used by the image-reading
  check (a valid header, enough for `file_read_image`'s byte sniffing) was refused as
  "Unsupported or malformed image data" when attached to a prompt — the prompt path decodes
  the image. The check now embeds a normally-encoded 2×2 PNG, and both READMEs say that
  attachments must be decodable, not just sniffable. Full shape after the fix: 150/150.

## 0.52.52

- Live-verified `approval.policy`: with `allow`, `session_create` reports
  `approvalPolicy: "never"` (the harness's unattended stance); with `inherit` the reply
  carries no policy and the session keeps the default. `live-checks` now asserts that
  relation against `dsh_info.config.approval`, so a run under either setting checks the
  posture the caller is actually given. Both branches were run: a throwaway profile with
  `allow` reports "approval.policy allow makes the session unattended — never" (104/104 the
  cheap suite); the default `inherit` profile exercises the other branch. Re-measured shapes:
  147/88 with `--with-model`, cheap subset 104/45/59/65; both READMEs updated.

## 0.52.51

- Live-verified the new host validation: a profile with `http.host: ''` starts **no
  listener** and its output names the rule, while `0.0.0.0` binds as intended. The
  non-loopback *warning* is in the code but plugin `log.warn` output is not captured in this
  harness's stdout, so the matrix records the binding behaviour and says the warning itself
  was not observed rather than implying it was.

## 0.52.50

- `http.host` is now validated: an empty value is refused (it would have bound on every
  interface while the operator said nothing, with only a log warning) and so is a URL pasted
  into the field; surrounding whitespace is trimmed instead of reaching `listen()`. The panel
  example and README already said `127.0.0.1`, this is the config agreeing.

## 0.52.49

- `http.port` is now bounded at 65535 in config validation. The old check only required a
  non-negative integer, so `70000` loaded fine and failed later as a listen error where the
  operator has less to go on. The error says the range, and the panel's own 0-65535 bounds
  now mirror the host rule exactly.

## 0.52.48

- The drift check now also compares each panel number's minimum with the host's
  `positiveInt` rule: a panel field for one of those keys must declare `min: 1`. Proven by
  lowering `session.promptTimeoutMs` to `min: 0` —
  `DRIFT: panel number "session.promptTimeoutMs" has min 0, but the host requires a positive
  integer (min 1)` — then restoring. Two bugs in the new check were caught while proving it:
  it first matched only single-line field specs (two of the four are multi-line) and it
  referenced the parsed sources before their declarations; both fixed.
- Both READMEs list the new check.

## 0.52.47

- The drift check now compares each panel `select` against the exported enum the config
  schema validates with (`SESSION_SCOPES`, `APPROVAL_POLICIES`): offering a value the host
  refuses looks like a supported choice, which is worse than free text. A new select without
  a mapping fails the check rather than drifting silently. Proven by deleting the `allow`
  option — `DRIFT: panel select "approval.policy" offers [inherit], APPROVAL_POLICIES is
  [inherit, allow]` — then restoring. Both READMEs list the new check.

## 0.52.46

- The four positive-integer settings (`session.promptTimeoutMs`, `limits.maxReadBytes`,
  `limits.shellTimeoutMs`, `limits.agentToolTimeoutMs`) had no minimum in the panel, so a
  user could type `0` or a negative value and only learn it was refused after the write
  failed. They now declare `min: 1`, matching the host's `positiveInt` rule.
- Added field invariants as tests: every path unique (no shadowing), each `select` carries
  options, each `number` declares a minimum and never a maximum below it.

## 0.52.45

- Number fields no longer keep an unwritten value on screen: a draft the host would refuse
  (empty, half-typed, out of range) is reset to the last committed value when the field
  loses focus, instead of silently doing nothing while the input still showed e.g. `70000`.
  The rule moved into `parseNumberDraft` so it is unit-tested (bounds accepted, invalid and
  out-of-range rejected); text fields are unchanged.

## 0.52.44

- Wrote the **flake discipline** into `docs/LIVE-VERIFICATION.md`, with the four cases from the
  0.52.4x rounds as the table: the progress check that demanded two rate-limited
  notifications, the steer/switch that could miss a finished turn, the deadline check whose
  command was too short to discriminate, and the shapes driver that read `harnessServices`
  before the services mounted. Both READMEs point at the section.

## 0.52.43

- The same self-inflicted-flake audit applied to the acceptance script: the symlink-loop
  walk's 5 s race is now 15 s (the project is tiny, so the window only catches an endless
  following-walk rather than measuring speed), and the background-job output poll allows
  10 s for a 0.3 s job instead of 4 s.

## 0.52.42

- Two more guards against self-inflicted flakiness. The steering checks start their long
  turn with `sleep 10` (was 8) so the steer cannot arrive after the turn closed. The
  `shell_run` deadline check now runs `sleep 15` under a 0.7 s timeout and accepts anything
  under 8 s: the long command costs nothing (the call returns at the deadline) while the wide
  window still proves the deadline cut the wait instead of the command finishing naturally.

## 0.52.41

- Removed the same class of flake risk from the mid-turn switch check: it switched routes
  1.5 s after starting a turn made of three fast `echo` commands, so on a quick route the
  turn could end first and the switch would apply to a *later* turn — the assertion would
  fail without anything being wrong with the plugin. The prompt now starts with
  `sleep 6`, so the turn is guaranteed to be open when the switch lands (and the check keeps
  asserting that both routes answered the same turn).

## 0.52.40

- Hardened the progress-notification check after one full-shape run reported 144/1 that
  could not be reproduced (three later runs: 145/0, 145/0, 145/0). The suspect assertion
  required **two** notifications more than 500 ms apart, but the sender is rate-limited to
  roughly one a second, so a fast turn can legitimately emit a single one. The check now
  requires that the first notification arrived *during* the turn (the actual promise: not
  batched at the end) and that, when several arrive, they are spread out. Two full-shape runs
  and a session-shape run are green afterwards (146/146 and 87/87 — splitting the assertion
  added one check), and both READMEs carry the new counts.

## 0.52.39

- `session_prompt { mode: "steer" }` now has live evidence, separate from the queue-steer
  path: a steered prompt is answered inside the running turn (reply carries the marker,
  no timeout, not aborted) and the session still records only two turns for two prompts
  plus the steer — so steering does not buy a turn. Probed first, then encoded.
  Re-measured shapes after the addition: all six 145, session+usage 86, narrow 59,
  files+shell 65 (cheap subset 104/46/59/65). One shapes run reported 144/1 on the full
  shape; an immediate rerun was 145/0 and the failing check could not be recovered from the
  truncated output, so `tools/shapes.mjs` now prints the failing check names in its summary
  — a recurrence will be identifiable instead of a bare count.

## 0.52.38

- Fixed a false claim in the settings panel: when the host mounts no status route (or the
  status fetch fails), `readStatus` answers `undefined`, but the component still marked the
  read as successful and rendered the "not listening" badge. Unknown is not a state anyone
  observed — the badge now appears only when a status was actually read (and disappears
  again if a later poll cannot read one). A source-level test keeps the rule from
  regressing (`setStatusRead(next !== undefined)` plus the `statusRead &&` gate).

## 0.52.37

- `tools/release.sh --shapes` runs the shape driver as a release step (add `--with-model` to
  spend turns). The driver also now picks **free ports** per shape instead of assuming
  8821/8822 and killing whatever listens there — a release step must never kill an
  operator's own endpoint. Both READMEs list the flag.
- Verified end to end: `release.sh --skip-tests --shapes` reports 103/44/59/65 for the four
  shapes (the cheap subset), and the READMEs now say those differ from the 143/84 rows because
  those are measured with `--with-model`.

## 0.52.36

- `tools/shapes.mjs` turns the hand-measured deployment matrix into one command: per shape it
  boots a throwaway profile with that shape's `tools` block, installs the packaged tarball,
  waits until the harness services are mounted, runs `live-checks`, prints the counts, and
  cleans up. Verified end to end — it reproduces the table exactly (143/84/59/65) with
  `--with-model`.
- Writing it exposed a real startup ordering fact: the HTTP socket answers **before** the
  harness services are mounted, so a check run at first response sees
  `harnessServices.sessionController: false`. The driver now polls `dsh_info` until the
  controller is visible (fixed a spurious failure that the hand-walkthrough never hit because
  it waited ~18 s). Both READMEs point at the script.

## 0.52.35

- Re-measured every row of the deployment-shape matrix on the current build instead of
  trusting earlier runs: all six groups is **143/143** with `--with-model` (the table said
  130 from a build before later checks were added); the narrowed shapes re-confirmed at
  84/84, 59/59 and 65/65. Both READMEs carry the corrected number.

## 0.52.34

- Both READMEs now carry the deployment-shape matrix the last four rounds produced: all six
  groups (28 tools, 130/130 with `--with-model`, 163/163 acceptance), `session+usage`
  (13 tools, 84/84), `workspace+session+agentTools+usage` (18 tools, 59/59) and
  `files+shell` (11 tools, 65/65), with the skip behaviour stated so an operator comparing a
  narrowed deployment knows what was and was not exercised.

## 0.52.33

- Verified the **session-only** deployment shape — the one a client that just wants to drive
  an agent would run: `workspace/files/shell/agentTools` off, `session` and `usage` on.
  `live-checks --with-model` reports 84/84 checks, 0 failed: routing, `reasoningEffort`,
  usage receipts, transcript turn windows, progress/cancellation, orchestration, steering
  and idempotency all run, while every file/shell/workspace section degrades to an explicit
  skip. The matrix records it.

## 0.52.32

- Verified the whole check suite against a **minimal** deployment (only `files` and
  `shell` groups on): 11 tools advertised, 11 available, 17 unavailable with reasons, all
  four disabled groups named, and the session/usage/queue/search sections degraded to
  explicit skips — 65/65 checks, 0 failed. Both READMEs now say the script can verify a
  narrowed deployment instead of only a fully-enabled one.

## 0.52.31

- The availability contract now checks the disabled-group path: on a profile with
  `tools.files: false` and `tools.shell: false` it asserts each disabled group's reason
  names the switch an operator would flip (`tools.files: false`), while `availableTools`
  still equals the advertised `tools/list` set (probed first: 18 tools advertised, 18
  available, `file_read` reason "the files tool group is disabled"). Default profiles skip
  this check because no group is off.
- Running the suite against that narrowed profile also exposed a real defect in
  `live-checks.mjs` itself: the workspace section wrote a file unconditionally and aborted
  with "Tool file_write not found" when the files group was off. It now gates that part on
  the advertised surface and reports it as skipped, so the script can verify a narrowed
  deployment instead of crashing on it.

## 0.52.30

- Four edge contracts now have live checks, all probed first: `workspace_delete` of an
  unknown id answers `deleted: false` rather than failing; `session_list` for a cwd with no
  sessions returns an empty list with `total: 0`; a whitespace-only `session_rename` title
  is refused before touching the harness; and `dsh_tool_list` on an unknown session returns
  no tools plus a `scopeError` naming the session instead of a transport failure.

## 0.52.29

- The settings panel's token mask shows a four-character prefix only for tokens at least
  **16 characters** long, the length below which the host already warns. The old threshold
  was 9, so a 9–15 character token displayed four of its characters — nearly half of a
  short token. Tests pin the boundary (15 masked fully, 16 shows `abcd••••••••`).

## 0.52.28

- The `cwd` contract shared by the file tools now has live checks: a relative write is
  readable and listable through the same base (`file_list { path: ".", cwd }`), and a
  missing relative path names the resolved file in its error. All cheap; no turns.

## 0.52.27

- `session_fork`'s two cut forms now have negative live checks: passing both `atSeq` and
  `atTurn` is refused ("pass atSeq or atTurn, not both"), and an unknown `atTurn` lists the
  turns the log actually records instead of failing vaguely. Both reuse the two-turn
  session `--with-model` already has, so they cost no turns.

## 0.52.26

- `file_read_image` format coverage: the live check classifies a **GIF**, **WEBP** and
  **BMP** header as their MIME types, alongside the existing PNG/text/missing/over-cap
  cases. The first version assumed BMP was unsupported and failed against the running
  plugin — it reads BMP fine; what refuses BMP is a *prompt attachment*, whose format list
  is deliberately narrower. Both sides are now checked: `file_read_image` accepts it, and
  `session_prompt { images: [bmp] }` refuses it with the accepted formats named (that call
  spends no turn). Detection is by magic bytes, so a header is enough. A second script
  mistake was found and fixed in the same round: the prompt-refusal assertion tried to
  assert that the error did *not* mention bmp (it names the path, which contains "bmp");
  it now asserts the harness wording — "cannot carry (supported: png, jpeg, webp, gif)".

## 0.52.25

- `idempotencyKey` now has cross-client evidence: the acceptance run covers one client's
  retry, but two harness instances can drive one session. The live check sends with a key,
  re-sends the same key through a *second* MCP client (expects the recorded turn, same
  reply), tries the key with different content (refused), and asserts only one turn ran.

## 0.52.24

- Two boundary contracts now have live checks: a `file_read` offset at EOF is an empty
  complete read (`truncated: false`, no `nextOffset`) and a past-EOF offset is empty rather
  than an error, so a paging loop terminates cleanly; and `session_queue` with an unknown
  `messageId` is refused with a readable message ("queued item is no longer pending")
  instead of silently accepting.
- The first run failed both new checks for reasons in the *script*, not the plugin: the
  EOF offset was computed from JavaScript string length while the tool counts **bytes**
  ('€' is one char, three bytes), and the queue regex did not accept the harness's
  "no longer pending" wording. Both fixed, and the README now says the paging offsets are
  byte offsets.

## 0.52.23

- The orchestration live check now edits a pending message while it waits (`action:
  "edit"`): the preserved queue entry's text is replaced after the cancel, and the
  transcript afterwards must contain the edited text and not the original — an edit that
  only changed what a listing shows would fail this.

## 0.52.22

- Probed and asserted `session_queue { action: "steer" }`: queued while a sleeping turn
  runs, the message is steered into that turn and its text appears inside the turn that
  was already running rather than as a new one. The live check starts such a turn, steers,
  settles it, and uses the turn count as the witness: three prompts produced **two** turns
  (the steered message folded into the running one), and the steered text appears in the
  transcript. Transcript rows do not always carry a turn number, so the count is the
  honest evidence.

## 0.52.21

- The transcript's turn window now has live evidence: with the two turns
  `--with-model` already runs, `session_messages { fromTurn }` returns only the later
  turn (and its reply) while `toTurn` stops before it — the same parameter names as
  `session_usage`, checked against the turn numbers the replies reported.

## 0.52.20

- `session_set_model { reasoningEffort }` now has live evidence: the selection is applied
  and echoed back (`reasoningEffort: "high"`, same model). Probed first, then wired into
  `live-checks --with-model` as a no-turn assertion (it skips rather than fails when a
  route rejects the effort, so the check does not assume every provider has one).

## 0.52.19

- The file-edit live check now covers the compare-and-swap direction that only writes had:
  a hash read before another client changed the file makes `file_edit` refuse with the
  current hash and leaves the file intact, and the same edit succeeds once the hash is
  re-read. This is the lost-update window for edits, stated in the docs and now exercised.

## 0.52.18

- Two more documented options now have live evidence: `dsh_tool_call { maxResultChars }`
  reads a file through the agent's `read` tool with a 100-char cap and asserts `truncated`
  plus the untruncated `resultBytes` (the agent's own formatting makes that size smaller
  than the file — the check asserts "bigger than the cap", not the file size), and
  `shell_kill { waitMs }` kills a running job with an explicit wait and still reports
  `status: "killed"`. The read call accepts both `file_path` and `path` argument shapes so
  the check is not pinned to one harness version.

## 0.52.17

- Live-checked the options documented in 0.52.16, and corrected the docs where the
  behaviour was the opposite of the wording: `workspace_create` and `file_write` **create**
  missing paths/parents by default and take `createDirectory: false` /
  `createDirectories: false` as the strict mode. Checks now assert both directions
  (default creates, `false` refuses), plus `file_list { maxDepth }` bounding a recursive
  walk and `session_fork { atTurn }` stopping a child before the later turn — the last one
  reuses the two turns `--with-model` already runs, so it adds no spend.

## 0.52.16

- Documented the non-obvious options that were absent from **both** READMEs, in parallel:
  `session_fork { atTurn }`, `session_set_model { reasoningEffort }`, the compare-and-swap
  `expectedSha256` of `file_write`/`file_edit`, `file_write { createDirectories }`,
  `file_read`/`file_list { sha256 }`, `file_list { maxDepth }`, `shell_kill { jobId,
  waitMs }`, `dsh_tool_call { maxResultChars }`, `workspace_create { createDirectory }`,
  and the `oldText`/`newText` names of `file_edit`. The zh `file_read` row also gained the
  `sha256` sentence the en row already had. Options that are self-describing
  (`command`, `provider`, `content`, `timeoutMs`) are still described in prose only.

## 0.52.15

- The drift check now catches the class of defect 0.52.14 fixed by hand: a tool option
  referenced in one README and not the other. Per tool it compares which `inputSchema`
  option names each README mentions (as code spans) and fails when the sets differ — proven
  by removing `` `probeSearch` `` from the en README, which now answers
  `DRIFT: README.md never mentions option "probeSearch" of dsh_info, while README.zh.md
  does`, then restoring. It does not demand every option be documented, only that coverage
  be symmetric.

## 0.52.14

- Fixed an English/Chinese row-content drift: the zh `dsh_info` row documented
  `probeSearch` (an option the schema really has, covered by tests and live checks) while
  the en row did not. The en row now says what the option does. The drift check compares
  the *set* of tool rows, not the content of a row, so this class of omission is not
  machine-caught — noted here rather than silently fixed.

## 0.52.13

- Verified the other half of the ownership contract: a **corrupt** `owned.json` fails
  closed. A session created under `session.scope: "owned"` became unreadable once the
  record was replaced with `{not json at all` and the process restarted — the damaged
  record hides sessions, it cannot expose them. The original record was copied before the
  probe and restored byte-for-byte; the throwaway profile was deleted.

## 0.52.12

- Verified the restart behavior README already promised for `session.scope: "owned"`:
  a session created through the endpoint is written to `$DSH_HOME/dsh-as-mcp/owned.json`,
  and after killing and restarting the process the same session was still readable while
  a session from another profile's logs was refused with the scope message. Unit tests
  covered the record's round-trip; this covered the composition. The probe id was removed
  from the real record afterwards; the throwaway profile was deleted.

## 0.52.11

- The drift check now owns one more number that had drifted before: the capability-probe
  count in `docs/CAPABILITY-GAPS.md`'s appendix must equal what `describeCapabilities()`
  reports (22 today). Proven by lowering the doc to 21 — the check answers
  `DRIFT: ... says 21 capability probes, describeCapabilities() reports 22` — then
  restoring it. Both READMEs list the new check.

## 0.52.10

- The subagent live check now proves the documented split between two views: a prompt
  reply's `session` block excludes the subagent's tokens while `session_usage` includes
  them as a row. The check asserts the reply total equals the self row and is strictly
  smaller than the report total, so "the tool exists because the reply cannot see the
  child" is evidence rather than prose.

## 0.52.9

- Fixed a drift the new in-test docs check caught (and that a `2>/dev/null | tail -1`
  check in the same shell hid): the 0.52.8 matrix row cited the price plugin's own version
  `1.9.41`, which the check rightly reads as a release of *this* plugin with no changelog
  entry. The row now says "the current `dsh-cost-meter` (1.9.x)". Process note: the 0.52.8
  install used `--skip-tests` while the suite had that failure, so from 0.52.9 on a round
  that touches tests/docs runs the release *with* tests instead of skipping them.

## 0.52.8

- Closed the money row: installed `dsh-cost-meter@1.9.41` from its registry into a
  throwaway profile and compared the receipt with the plugin's own ledger for the same
  session — `costUsd 0.00008131200000000001, calls 2` against the ledger's
  `cost 8.131200000000001e-05, calls 2`: the same float and the same call count, so the
  figures are a faithful pass-through rather than a recomputation. (The earlier attempt
  failed because a copied package directory loses its hoisted dependencies.)
- live-checks now asserts the implication when a price plugin is mounted: if
  `dsh_info.usage.costAvailable` is true, the receipt must actually be priced by
  `dsh-cost-meter`.
- Both READMEs say the money figures are the plugin's ledger values passed through.

## 0.52.7

- Attempted the money reconciliation in a throwaway profile and recorded why it did not
  run: the only `dsh-cost-meter` install on this machine is hoisted inside the desktop
  profile, so copying its package directory leaves its dependencies behind and its import
  dies with `Cannot find package 'acorn'`; the desktop profile itself runs an older build.
  The verification matrix now names that concrete blocker and the exact way to close it
  (install the price plugin from its registry into a throwaway profile) instead of the
  vaguer "compare on a known row". No code change.

## 0.52.6

- Documented what a `session_queue` row carries: id, text, image count, and the harness's
  inbox `source` kind. A message queued through the endpoint reports `source: "user"` —
  probed live — so the field is the harness's classification, **not** a client identity;
  both READMEs say that, and the live orchestration check asserts the row shape.

## 0.52.5

- The orchestration live check now covers a **second MCP client**: it queues a message
  from another connection, sees it in `session_queue` from the first, withdraws it there,
  and asserts the withdrawn text never ran. The queue lives on the session, so a
  connection-scoped id would be a bug a single-client test cannot see. (A message queued
  from the DSH UI itself remains unverified — that needs the UI.)

## 0.52.4

- The two script-integration suites (`smoke-script`, `exercise-script`) allow one retry per
  test. A full-suite run under load produced a single timeout in the smoke suite that
  passed immediately when rerun; the assertions are deterministic, so the retry absorbs
  scheduler flake without hiding a logic failure. (The 0.52.3 install went ahead with that
  flake in the log because the failure grep was truncated — the suite was rerun green
  twice before this entry.)

## 0.52.3

- `session_tool_result` now has owned-scope coverage: under `session.scope: "owned"` it
  refuses a foreign session's tool result (the read that could otherwise expose output by
  guessing call ids) and still answers for a session the endpoint created. The behavior
  was already correct — `assertSessionVisible` — but every other session tool had a test
  for the refusal path and this one did not.

## 0.52.2

- The documentation drift check now runs in the test suite too (`tests/docs-consistency.test.ts`
  spawns `tools/check-docs.mjs`), so `vitest run` alone reports README/changelog/wiring
  drift instead of leaving it for the release step. Both READMEs say where it runs.

## 0.52.1

- Documented and asserted where a model switch takes effect: a `session_set_model` during
  a running turn applies to that turn's later model calls. The probe started a turn on
  `deepseek-official/deepseek-flash`, switched to `deepseek-account/deepseek-flash`
  mid-flight, and got one turn reporting both routes, whose per-turn `byModel` split
  (18 062 + 18 586) summed to the row total (36 648) — the case 0.52.0's field exists for.
  `session_set_model`'s description, both READMEs and the matrix now say so, and
  live-checks `--with-model` reproduces it.

## 0.52.0

- Per-turn usage rows now carry a `byModel` split when the turn used more than one
  route: a mid-turn escalation or fallback has a single row total, which hides how much
  the expensive model charged. Single-route turns omit the field (the row and
  `models[0]` already describe them fully), so the common case costs nothing.
- Usage-fold test covers the multi-route split, the single-route omission and the row
  total; both READMEs describe the field.

## 0.51.11

- Verified two items that had been listed as unverified, and corrected one claim:
  - a `read-only` sandbox really refuses plugin writes (`file_write` → "file access denied
    under read-only mode"; `shell_run` reads fine but its redirect fails with "Operation
    not permitted"), so the "the harness policy still applies" claim is evidence, not
    architecture;
  - chunked request bodies (no `content-length`) **are** size-bounded: 70 MB chunked
    answered `413` in 71 ms while a valid chunked `initialize` answered 200. The README
    said a chunked request was "not covered by this check", which understated the code
    (`readJsonBody` counts streamed bytes); both READMEs now say what happens, and the zh
    security section gained the missing bullet.
- Both rows moved from "Not verified here" to the verified matrix.

## 0.51.10

- `tools/release.sh` accepts `--with-model` and the `--full-live` shorthand for
  `--with-model --with-subagent`. The documented desktop-closing command used to fail as
  an unknown argument because only `--with-subagent` was parsed — the README and the
  usage header now match what the script accepts.

## 0.51.9

- Refined the subagent route semantics: inheritance happens **at spawn time**, not at
  session creation. A probe answered on `deepseek-official/deepseek-flash`, switched the
  session to `deepseek-account/deepseek-flash`, then spawned — the child was billed on the
  switched route. Both READMEs now say "the parent's route at spawn time", and the live
  subagent check switches the parent's model before spawning and asserts the child follows
  it (the earlier "child routes within parent routes" assertion is kept).

## 0.51.8

- Documented and asserted **subagent route inheritance**: a child spawned by a session
  created on a non-default route spends on that same route (probe: parent
  `deepseek-account/deepseek-flash` → child billed on the same route), so a caller
  choosing the parent's model steers what its agents cost. Both READMEs say so, the live
  subagent check asserts the child's `byModel` routes are within the parent's, and the
  verification matrix records the probe.

## 0.51.7

- Full sweep recorded in `docs/LIVE-VERIFICATION.md`: one profile with the search index
  enabled ran live-checks in every mode (`--with-model --with-subagent`, 115/115) and the
  complete acceptance run (163/163) in the same boot, so the two suites agree on the same
  process rather than each being green alone. Re-run before touching the desktop
  composition.

## 0.51.6

- The acceptance run's phase-receipt check now cross-checks numbers, not just shape: a
  `fromTurn`/`toTurn` receipt for one turn must equal the `byTurn` row's own total in
  the same report *and* the same turn's row in the full receipt. A windowed report that
  quietly folded the wrong events would pass a shape check; it cannot pass this.

## 0.51.5

- `tools/live-checks.mjs --with-model` cross-checks the token numbers too: each prompt
  reply's per-turn `turn.usage.totalTokens` must equal that turn's row in the
  `session_usage` receipt, and the row sum must equal the receipt's session total. The
  route cross-check said *which* model ran; this says the number being billed agrees
  across both views.

## 0.51.4

- `tools/live-checks.mjs --with-model` cross-checks two views of the same turns: the
  `session_usage { includeTurns }` rows must name the same route each prompt reply's
  `turn.models` reported, on both the initial and the switched turn. Billing and routing
  disagreeing about which model ran is exactly the kind of drift a single-view test
  cannot see.

## 0.51.3

- `tools/live-checks.mjs --with-model` closes the loop on the catalog: it creates a
  session on a route dsh_info actually advertises, runs a real turn, checks the turn
  reports that route, then switches to a second route when one exists and checks the
  next turn follows. The catalog check alone proved the list was well formed; this
  proves `session_create` and `session_set_model` consume it.

## 0.51.2

- `tools/live-checks.mjs` checks the catalog honesty in `dsh_info`: every route is a
  named id, each per-route model list is well formed and belongs to a named route, a
  catalogue that could not be read is named in `catalog.unavailable` instead of silently
  missing, and the default agent preset (when present) names one of the listed presets.
  That catalog is what `session_create`'s arguments are chosen from, so a silent hole
  there sends callers guessing. The first run flagged the presets because this
  profile's registry exposes ids only — the check now asserts the real contract (`id`
  required, `name`/`description` optional) instead of an imagined one; 82/82 cheap
  checks pass.

## 0.51.1

- `tools/live-checks.mjs` exercises the compare-and-swap lost-update window for real:
  client A reads the hash, client B rewrites the file, A's guarded write is refused with
  the new hash and leaves B's content intact, and A's retry with the current hash
  succeeds. The earlier tests covered the one-client cases; this covers the interleaving
  the guard exists for.

## 0.51.0

- `file_list { sha256: true }` hashes each file's content for bulk change detection; a
  file above `limits.maxReadBytes` (or one that cannot be read as text) carries
  `sha256Unavailable` with the reason instead of a silent omission, so a partial picture
  is never passed off as complete. Directories carry neither field. Off by default.
- Test covers hashing, the unavailable reason, the directory case and the no-flag path.
  The first live run hashed 0 files and caught the *third* instance of the same slip —
  the schema gained the option but the handler did not forward it (after 0.46.0's turn
  range and 0.50.0's read hash). `tools/check-docs.mjs` now has a systemic guard: it
  parses every tool's `inputSchema` and its guard body and fails when an option never
  reaches `args.<name>`, proven by injecting a synthetic dead key (DRIFT) and removing
  it again. The re-run hashes 2 files and passes 163/163. Both READMEs updated.

## 0.50.0

- `file_read { sha256: true }` returns the SHA-256 of the **whole** file (not the
  returned window) as the compare-and-swap value a later `file_write`/`file_edit` can
  carry, so a read→decide→write cycle no longer needs a second call. The hash reads the
  whole file, so it is opt-in and refuses a file above `limits.maxReadBytes`. Without
  the flag nothing extra is read and the field is absent.
- Tests cover the whole-file-vs-window hash (with the hash ceiling taken from the
  configured limit, not the window), the absent field and the over-ceiling refusal; the
  acceptance run compares the hash with the one `file_write` returned and uses it for a
  CAS edit (162/162). The first live run returned no hash and caught the same class of
  wiring slip as 0.46.0: the new argument had not been forwarded by the tool handler.
  Both READMEs updated.

## 0.49.0

- `file_write` and `file_edit` accept `expectedSha256` (compare-and-swap) and return the
  resulting file's `sha256`: an external harness that reads a file, decides, then writes
  it back no longer clobbers a concurrent edit — a mismatch names the actual hash and
  writes nothing. `file_write` with `expectedSha256` refuses to create a missing file
  (omit the field to create one).
- Tests cover the matching write, a stale write, a missing file, the matching edit and a
  stale edit; the acceptance run does a real CAS round-trip on disk. Both READMEs updated.

## 0.48.0

- `session_fork` accepts `atTurn`: cut the child at the end of that turn instead of a raw
  event seq — the unit a caller bills and reasons in. The reply echoes the resolved
  `atSeq` and the `atTurn`; an unknown turn lists the turns the log records, and passing
  both `atSeq` and `atTurn` is refused rather than silently preferring one.
- Fork tests cover the resolution, the unknown-turn error and the mutual exclusion; the
  acceptance run forks at turn 1 and checks the child's inherited prefix. Both READMEs
  updated.

## 0.47.0

- `session_messages` accepts `fromTurn`/`toTurn`: read one phase of a long transcript
  by turn range, matching the `fromTurn`/`toTurn` receipt `session_usage` now offers.
  Attribution follows the existing rule — assistant and tool rows carry `turn`; the
  user prompt has no turn number and is not part of a turn-attributed read.
- Driver and endpoint tests cover the range and its forwarding; the acceptance run
  compares a range read with the exact-turn read (same rows). Both READMEs updated.

## 0.46.0

- `session_usage` gained `fromTurn`/`toTurn`: fold only the turns in that inclusive
  range, so a caller can bill a task phase (say "the turns after the review started")
  instead of the whole session. The range is echoed as `turnRange`, totals/byModel/
  byTurn describe only those turns, and — like a `sinceSeq` window — the report is not
  projection-verified. An inverted range is refused with the inclusive-interval rule.
- Fold and driver tests cover the subset totals, the echoed range, the single-turn
  case and the inverted-range refusal; the acceptance run bills the session's last
  turn as a one-turn phase (19 398 of ~77 500 tokens). The first live run returned the
  whole tally and exposed that the new arguments had been wired into the
  `session_messages` handler/schema rather than `session_usage` — caught before release
  and fixed. Both READMEs updated.

## 0.45.0

- `session_usage` gained `sinceSeq`: fold each row from that event seq onward, for an
  incremental receipt on a long session (or a segment of it) without re-reading spend
  already billed. The window is echoed as `sinceSeq`; `verifiedAgainstProjection` is
  false and no `projectionTotals` is emitted, because the harness projection covers the
  whole log and comparing a window with it would be meaningless. A window starting
  before a fork's inherited prefix is clamped to the prefix.
- Driver test covers the full-vs-segment totals, the echoed window, the per-turn
  subset and the projection caveat; the acceptance run checks a real segment against
  the full tally. Both READMEs updated.

## 0.44.0

- Per-turn usage rows now also carry `models`: the `provider/model` routes that charged
  that turn, sorted, so a per-round bill can show which model spent the tokens (a route
  that changed mid-turn is exactly what a bare total hides). A turn whose only samples
  were unattributed retries carries none rather than an empty list.
- Usage-fold test covers per-turn routes including the unattributed case; the
  acceptance run asserts real turns name their routes. Both READMEs updated.

## 0.43.0

- `session_usage { includeTurns: true }` per-turn rows now carry `durationMs` (from the
  turn's start to its end event) alongside their token buckets, so a caller can bill
  per turn and see which turn was slow. Absent when the log lacks a boundary inside the
  folded window (an inherited prefix, a turn still running) instead of guessed.
- Usage-fold test covers the settled and still-running cases; the acceptance run
  asserts the real session's settled turn carries a duration. Both READMEs updated.

## 0.42.0

- `session_messages { includeToolResults: "errors" }` keeps only the tool results the
  harness marked as failures, so finding why a turn went wrong is one read instead of
  scanning every result. `true` still returns all rows; the boolean form is unchanged.
- Driver test covers the filter; the acceptance run compares the returned failures
  with the error flags in the full result list. Both READMEs describe it.

## 0.41.0

- `session_messages` rows now carry their `turn` and `step` when the log attributes
  them, and `turn: N` narrows a read to one turn. Since assistant and tool rows are the
  ones the log attributes (`turn`/`step` on the event), a turn-filtered read is the
  turn's own rows; the user prompt has no turn number and is documented as excluded
  rather than guessed. Useful for "what did turn 3 do" and for grouping a long
  transcript without re-reading it all.
- Driver and endpoint tests cover attribution and the filter; the acceptance run
  asserts real tool rows carry turn/step and that a turn-filtered read stays inside
  that turn. Both READMEs describe the fields.

## 0.40.0

- `session_messages` gained `includeToolResults`: each recorded `tool/result` becomes a
  `role: "tool"` row with `callId`, `text` and `error`, capped by `maxCharsPerMessage`
  like any other message. `includeToolCalls` says what was invoked and how large the
  outcome was; this says what the outcome *said*, so one read can reconstruct the whole
  timeline instead of pairing `session_tool_result` lookups with the transcript. Off by
  default, because a result can be as large as a file.
- Covered by driver and endpoint tests and the acceptance run (real bash results appear
  as capped tool rows); both READMEs describe the option.

## 0.39.0

- `session_prompt`'s turn receipt now carries `turn.durationMs`: wall-clock time from
  the turn's start event to its end event. Tokens say what a turn cost; this says how
  long the caller waited, which is what a timeout or an SLO is tuned against. It is
  absent when the turn is still running at the wait boundary (no honest duration), and
  the driver test pins both cases. The first acceptance run reported no duration and
  exposed an ordering detail worth knowing: DSH commits `turn/start` *before* the user
  message, so the start event sits outside the transcript window — the summary now
  walks back to the owning turn's start, and the live run reports the real turn
  (3 489 ms for the FizzBuzz turn).
- Both READMEs mention the field in the `session_prompt` row.

## 0.38.6

- `tools/live-checks.mjs` checks that `dsh_info` agrees with the surface it describes:
  the reported version equals this checkout's package version (so a stale installed
  build is caught instead of silently verified), the endpoint echo matches the URL the
  caller reached, `toolAvailability` names exactly the advertised tools with a reason
  for each unavailable one, `enabledToolGroups` and `harnessServices` are boolean maps
  covering every group/service, health reports the runtime and a live RSS figure, the
  effective session scope is echoed, and the caveats come back as notes.

## 0.38.5

- `tools/live-checks.mjs` checks the shell deadline and the job table: `shell_run`
  returns at its deadline with `timedOut: true` (~706 ms for a 5 s command), a quick
  command returns its output with `timedOut: false`, the 17th start evicts the oldest
  *finished* job and succeeds, and once 16 jobs are *running* the next start is
  refused with the "does not silently stop" explanation. Both README tables now state
  the retention rule.

## 0.38.4

- `tools/live-checks.mjs` covers the listing and image limits: a non-recursive listing
  is one level, a recursive one reaches nested files, `maxDepth` bounds the walk,
  listing a file is a legible error, a real 1x1 PNG comes back as a metadata text
  block plus an MCP image block, a text file is refused as "not an image", a missing
  path says so, and a 9 MiB file is refused with the 8 MiB cap named. Both READMEs
  note the metadata block that precedes the image.

## 0.38.3

- `file_read`'s description now says precisely what a mid-character window does: each
  orphaned byte decodes as one U+FFFD (a 3-byte character started one byte early yields
  two), and the rest stays aligned — the old wording implied a single replacement
  character. Found by the new live paging check, which also asserts that a capped read
  reports `truncated`/`bytes`/`nextOffset` and that the next window completes the file
  byte-for-byte text.

## 0.38.2

- `tools/live-checks.mjs` gained a prompt-input section: an empty prompt is refused
  with the accepted shapes, a non-image attachment is refused by name, more images
  than the cap is refused before any file is read, and a refused prompt is never
  half-admitted (the transcript does not grow). No model turn is spent.

## 0.38.1

- **Fixed silent model-selection handling in `session_create`.** Asking for only
  `provider` or only `model` used to create a session on the default route and hide
  the mistake in a log line (and could even pair a requested provider with a
  configured model). The schema says the two are paired, so a half pair is now
  refused *before* the session exists. A half pair in the *profile settings* still
  creates the session but reports `modelSelectionError`, so the reply stops hiding the
  reason. The tool description and both READMEs state the contract; driver tests
  cover both cases, and live-checks assert the error quality (half pair, missing
  directory, unroutable pair still creating the session with the route explanation,
  unknown preset).

## 0.38.0

- `session_fork`'s description (and both READMEs) now state the precondition the
  live check found: the source needs at least one completed turn. A session that has
  never answered has no prefix to branch from and the harness refuses it with
  "has no completed turn to fork from" — accurate, but previously undocumented, so a
  caller forking a freshly created session was surprised. The live check now asserts
  that refusal is legible; the positive fork path stays covered by the acceptance and
  smoke runs, which fork a session that has answered.
- `tools/live-checks.mjs` gained a fork/rename section: titles are stored trimmed and
  come back through `session_list`, an unknown session id is a legible error, and an
  empty title is refused before it reaches the harness.

## 0.37.14

- `tools/live-checks.mjs` checks the `dsh_tool_list`/`dsh_tool_call` promises: the
  list is real for a session (15 agent tools here), an unlisted name is refused with
  the `agentTools.allow` hint, a listed tool with empty arguments fails with the
  tool's own validation message rather than a transport error, and a 30 KB `bash`
  result comes back capped at `maxResultChars` with `truncated`, `resultBytes` and no
  `value`.

## 0.37.13

- `tools/live-checks.mjs` checks the workspace promises: the same path registers once
  (returns the existing id), `workspace_list` reports path/session count/existence,
  `workspace_delete` removes only the registration and leaves the directory and files
  untouched, an unknown id answers `deleted: false` instead of failing, and
  `createDirectory: false` refuses a missing directory without creating it.

## 0.37.12

- `tools/live-checks.mjs` checks the file-tool promises that are easiest to get wrong:
  an ambiguous `oldText` is refused *and writes nothing*, `replaceAll` replaces every
  occurrence, `createDirectories: false` fails before creating the parent, and a
  relative path resolves against `cwd` for read as well as write. Cheap section, no
  model turn.

## 0.37.11

- **Fixed `shell_output.lossy`, which could never be true.** `drainShellJob` recorded a
  shell-service loss only as `truncated` and never set `job.lossy`, so a page for a job
  whose bytes the service had already dropped reported `truncated: true, lossy: false`
  — exactly the ambiguous receipt the field exists to prevent. Found by the new
  retention check: a 200 KiB writer came back as one 64 KiB page with no way to tell
  *why* the rest was missing. The flag is now persisted, a regression test covers it,
  and the live check requires both flags for that case.

## 0.37.10

- `tools/live-checks.mjs` checks the background-shell retention claim: a job that
  writes 200 KiB in one go must come back bounded to the retained 128 KiB buffer,
  report `truncated`, and finish reading; an unbounded or silently lossy job fails
  the check. Cheap section, no model turn.

## 0.37.9

- `tools/live-checks.mjs --with-model` now checks the claim `session_cancel` makes
  ("queued work is preserved"): it queues a second message behind a long turn,
  cancels, and asserts the message is still pending and then runs. The withdrawn
  message from the same section must still never run.

## 0.37.8

- The `initialize` instructions now cover the surface added since they were written:
  `toolAvailability` before planning a sequence, the inspection trio
  (`includeToolCalls` / `session_tool_result` / `session_list origin`),
  `session_search` and its opt-in index, and `session_queue`/`session_cancel` with the
  `session.scope: "owned"` caveat. Instructions that stop at the first three tools
  leave the rest undiscovered. The endpoint test now asserts the phrases.

## 0.37.7

- `session_messages` now carries the admission `requestId` on user messages (the same
  id `idempotencyKey` derives and the log records as `source.rpcId`). A caller can
  correlate its own prompts and retries with transcript entries instead of matching
  on text; the acceptance run checks the awaited prompt's id.

## 0.37.6

- **Fixed a real duplicate-send race in idempotent retries.** `wait: false` returns
  when `controller.prompt()` resolves, but the durable user message can be committed
  a moment later; a retry inside that window did not find its own log entry and asked
  the agent to do the work twice. The acceptance check for "queue then await" caught
  it as two user messages carrying the same `rpcId`. The driver now keeps a small
  in-memory ledger of admissions it made (bounded, 24 h / 200 keys) as a fallback
  when the log has not caught up; the log remains the path for retries after a
  restart. A regression test defers the commit and asserts the retry waits instead of
  re-sending.

## 0.37.5

- Documented and verified the intended way to await queued work: queue a prompt with
  `wait: false` plus an `idempotencyKey`, then call again with the same key and
  `wait: true`. The retry replays the admission and *waits* for that turn instead of
  sending a second prompt. The tool description and both READMEs now say so, a driver
  test covers the pending-turn replay, and the acceptance run checks the reply and
  that only one such user prompt exists in the transcript.

## 0.37.4

- `tools/live-checks.mjs --with-model` gained an orchestration section: start a long
  turn with `wait: false`, queue work behind it, list and withdraw that queued
  message, cancel the running turn, then prompt the session again. Each tool exists
  on its own; this asserts they compose on one session without corrupting it (the
  follow-up prompt answers, and the withdrawn message never ran).

## 0.37.3

- `tools/live-checks.mjs --with-model` also runs two real turns in two independent
  sessions at once, and asserts each answered its own prompt, neither was aborted by
  the other, and each transcript kept its own conversation (a mixed-up correlation
  would show up as the other session's marker in the transcript). Serialization is
  per session, and a harness driving several tasks relies on that.

## 0.37.2

- `tools/live-checks.mjs` gained a concurrency section: 20 parallel `dsh_info`
  calls must all answer with one version, 8 parallel file writes then reads must
  stay consistent, and 12 parallel `session_list` calls must agree on the total.
  It is not a benchmark — it asserts that the shared-session and shared-file paths
  do not degrade into failures under parallel callers, which is how an external
  harness or an agent team actually drives the endpoint.

## 0.37.1

- `session_tool_result` gained `from: "end"`: when a result exceeds `maxChars` the
  tail is kept instead of the head, which is where a stack trace or the closing error
  lives. The reply echoes `from: "end"` so a caller can tell which end it holds.
  Surrogate pairs are not split. Acceptance compares the tail with the full result's
  last characters, and the driver test covers the cut.

## 0.37.0

- `session_tool_result` can now address a result by `toolName` as well as `callId`:
  it returns the most recent completed call of that tool and names the resolved call
  id. A caller watching a session usually knows "the last bash result is what I
  need" without tracking ids; an unknown name lists the tools that do have recorded
  calls, and passing both selectors (or neither) is refused.
- Covered by driver tests and the acceptance run (by-id and by-name fetch of a real
  bash result); both READMEs updated.

## 0.36.1

- `tools/live-checks.mjs --with-subagent` also exercises the debug path end to end:
  it reads the subagent's transcript with `includeToolCalls`, takes a completed call
  id, fetches that result with `session_tool_result`, and checks the returned length
  equals the transcript's `resultChars`. Skips cleanly when the child made no call.

## 0.36.0

- **`session_tool_result`** (28th tool): read one recorded tool result by call id —
  the text, its original length, whether the harness marked it an error, and a
  `maxChars` cap. `includeToolCalls` already says how large a result was; this is the
  targeted follow-up for debugging the failure itself, without re-reading a long
  transcript. The call id comes from that transcript, so the lookup is bounded and
  scoped to one call.
- Availability map, both README tool tables, the capability audit and the acceptance
  script's expected-tool list are updated; the exercise now fetches a real bash
  result by id and checks its length against the transcript's `resultChars`.

## 0.35.0

- `session_search` hits now carry `parentSessionId` and `origin: "subagent"` when the
  matched session is an agent child, from the same listing the enrichment already
  performs. A search result now says where in the tree it sits, not just which
  workspace and how recent.
- Verified with a real subagent and the search index enabled (live-checks
  --with-subagent): the child's "SUBAGENT-OK" hit carried its parent.

## 0.34.0

- `session_list` gained an `origin` filter (`root` | `subagent`), applied before the
  limit so `total` stays honest. With the parentage fields this completes the tree
  view: "which sessions did I start" and "which are my agents' children", without
  reading transcripts.
- Verified live with a real spawned subagent: `origin: "subagent"` returned only the
  child, `origin: "root"` only the parent (live-checks --with-subagent).

## 0.33.0

- `session_list` exposes parentage: a subagent session carries `parentSessionId` and
  `origin: "subagent"`, so a caller can reconstruct the agent tree from the flat list
  without reading each transcript. The fields come from the same session listing the
  call already performs, so there is no extra read.
- Verified live with a real spawned subagent: the child row named the parent and
  origin, the root row carried neither (live-checks --with-subagent).

## 0.32.1

- `session_messages { includeToolCalls: true }` now also reports each call's
  outcome once it exists: `resultChars` (textual result length) and `error` when the
  harness marked the result as an error. A call whose tool has not answered yet
  carries neither, which is how a poller can tell "still running" from "done". The
  results are correlated by call id in one pass over the log, so a read stays O(events)
  and the arguments/results themselves are measured, not repeated.

## 0.32.0

- `session_messages` gained `includeToolCalls`: each assistant message then carries
  the tool calls the model requested (name, call id, argument JSON length). Text
  alone says "I'll run it"; the call list is what makes a poll of a running session
  actionable, and it stays bounded because arguments are measured, not repeated.
- The first acceptance run failed this check with 0 calls, which exposed a real bug:
  a model message that only requests tools has no text, and the transcript loop had
  been dropping text-less messages — so tool-call-only steps never appeared. With
  `includeToolCalls` such a message is now kept (empty text, calls attached); without
  it, the historical prose transcript is unchanged. Covered by a driver regression
  test, and the acceptance run now sees 4 calls.

## 0.31.2

- `tools/live-checks.mjs` is now usable against older deployments: every check is
  gated on the endpoint's own `tools/list` (a build without `shell_start` or
  `session_search` reports those sections as skipped), and `--old-endpoint` turns a
  contract mismatch into a skip too. Against the desktop app's 0.2.0 build it
  reports 3 protocol checks passing and 4 skips — the Bearer challenge,
  `total`/`truncated`, paging metadata and workspace-scope usage — which is exactly
  the list of contracts that build predates. A strict run against the current build
  passes 16/16, so the gating does not hide a real regression.

## 0.31.1

- `dsh_info.toolAvailability` now also names the tools that passed
  (`availableTools`), so a caller can compare it with `tools/list` instead of
  trusting a count. It is the same set — disabled groups are absent from both, and
  group-enabled tools missing a service appear only in `unavailable` — which
  `tools/live-checks.mjs` now asserts at runtime (skipping endpoints that predate
  the field).
- Unit and endpoint tests cover the new list; the count and the list length agree.

## 0.31.0

- `dsh_info` now reports **`toolAvailability`**: for every advertised tool, whether
  this deployment can serve it and, when not, the concrete reason (a disabled tool
  group, or the missing service — `session_queue` without `updateQueue`, background
  shell tools without a `start()`/`execute()` handle, `dsh_tool_*` without `agents`,
  ...). The dependency map lives in `src/mcp/availability.ts` next to the probes it
  consumes, so it cannot drift from the capability names, and it is unit-tested for
  each rule plus the notes (search index caveat, empty allow-list).
- The raw `harnessServices` booleans are unchanged; this is a pre-flight aid for
  callers planning calls, not an authorization layer.

## 0.30.9

- `tools/check-docs.mjs` now checks the settings panel's localization: the zh and
  en dictionaries must have the same key set, every key the panel references must
  exist in both, and unreferenced ("dead") keys are listed. Two parsing bugs were
  found and fixed while writing it: the zh scan swallowed the en block, which hid a
  missing zh key, and runtime-composed keys (`client.tokenSource.${source}`,
  `state.*`) were not counted as referenced.
- Three genuinely dead keys were removed from both dictionaries
  (`field.approval.policy.allow.hint`, `field.auth.token.replace`,
  `client.statusLabel`). Negative-tested: deleting a zh key or misspelling a field
  label each make the check exit 1.

## 0.30.8

- `tools/check-docs.mjs` now checks release claims: changelog headings must be
  unique and strictly newest-first, every version cited in
  `docs/LIVE-VERIFICATION.md` must have a changelog entry, and the tool count
  restated in `docs/CAPABILITY-GAPS.md` must equal what the code registers.
- It found one real drift: the verification record cited `0.1.0`, which predates
  the changelog (whose oldest entry is 0.2.0) — the two rows now read
  "≤0.2.0 (first documented release)". Negative-tested with a bogus 9.9.9
  citation: exit 1 naming it.

## 0.30.7

- `tools/check-docs.mjs` now also checks configuration: each README's YAML sample
  must set exactly the keys `normalizeConfig` accepts (minus the optional
  `auth.token`), and the settings panel must expose a field for every one of those
  keys and no field for an unknown key. Two parsing bugs surfaced while writing it
  and were fixed (the root `config` guard was read as a section, and the section /
  panel regexes only accepted lowercase names, so `agentTools` looked absent).
  Negative-tested: deleting `session.scope` from the sample makes the check exit 1
  naming it.

## 0.30.6

- Added `tools/check-docs.mjs` and a `docs consistency` step in
  `tools/release.sh`. It compares the two README tool tables with the tools the
  code registers, the package version with the newest changelog heading, the
  shipped `files` list with what exists on disk (and with maintainer-only
  directories), and every `docs/*.md` / script path the READMEs reference.
- It immediately found real drift that prose review had missed: the en tool table
  was missing `session_queue` (the row edit had silently not applied), and the zh
  table had 24 rows, a duplicated `session_create`, and seven missing tools
  (`workspace_delete`, `file_edit`, `file_read_image`, `shell_start`,
  `shell_output`, `shell_kill`, `shell_list`). Both tables now list all 27, and
  the check was negative-tested (renaming a row makes it exit 1).

## 0.30.5

- `tools/release.sh` gained `--acceptance`: it boots a throwaway profile under a
  temporary `DSH_HOME` (OS-chosen free ports, isolated session store, the
  operator's provider credentials copied into the 0700 directory so real turns
  work), runs the full acceptance script against it, and tears everything down
  through an EXIT trap. Verified live: 142/142 checks, cwd runs, no leftover
  profile, process or `/tmp` directory.

## 0.30.4

- Added `tools/release.sh`: the release checklist as an executable (both
  typechecks, tests, both bundles, pack, an assertion that the tarball contains no
  maintainer-only directory, optional live checks with `--live`, optional desktop
  install with a rollback directory). It refuses to reinstall the version already
  in the desktop profile, because pnpm treats the same tarball path as
  already-installed — the trap that made a rebuilt plugin look installed while the
  profile still ran the previous build.

## 0.30.3

- Verified the last outstanding accounting question against a real harness: the
  agent spawned a subagent, `session_usage { includeSubagents: true }` returned it
  as its own row (parent 27,419 tokens, subagent 18,567) with the report total
  equal to their sum, and under `session.scope: "owned"` the subagent session was
  listed, billed and readable as part of the owned tree.
- `tools/live-checks.mjs` gained `--with-subagent`, so that check is repeatable
  instead of a one-off probe: it spawns a helper, asserts the reply, the
  subagent row, the totals identity, and the tree access (23/23 with the model
  checks on). The desktop composition remains the one unverified path.

## 0.30.2

- `session.scope: "owned"` now treats **subagent sessions below an owned session**
  as part of the owned tree: listing, search, usage by id and transcript reads
  accept a child whose ancestor this endpoint created, and still refuse anything
  outside the tree. Subagents are the harness's own descendants of the session, so
  excluding them made an owned session's bill and listing quietly omit work it
  caused. The tree is resolved once per call from the session listing (no extra
  reads per row), and a listing failure fails closed.
- `cancelSession` became async (the visibility check may need the listing), so its
  tool handler awaits it; a reply that used to be a bare `{accepted:true}` is
  unchanged.

## 0.30.1

- `session.scope: "owned"` now remembers what it created: created and forked
  session ids are written to `$DSH_HOME/dsh-as-mcp/owned.json` (`0600`, directory
  `0700`, newest 1000 ids, atomic tmp + rename), so ownership survives a plugin
  reload or DSH restart instead of lasting one process. A missing or corrupt
  record reads as "nothing is owned" — fail-closed, it can only hide sessions.
  Tests now run under their own temporary `DSH_HOME`, so a suite run can no longer
  write this record into the developer's real `~/.dsh`.

## 0.30.0

- **`session.scope`** (`all` | `owned`, default `all`): the containment option the
  security audit's F4/F11 asked for without changing the default. Under `owned`,
  every content-bearing session tool — prompt/steer, cancel, list, transcript,
  fork, rename, set-model, queue list/mutation and search — is limited to sessions
  this endpoint created or forked; a refusal names the setting. Search filters
  matches instead of failing and reports `hidden`; `session_usage` refuses explicit
  foreign ids and notes rows it left out of aggregate scopes; `session_list`
  filters before its limit, so `total` stays honest. Exposed in the settings panel
  and both READMEs. Two fail-closed consequences are documented: ownership is
  per plugin process (sessions from before a restart are no longer owned) and
  search filters the harness's global page of 20 after it arrives (`hidden` says
  when that page was entirely foreign). Verified live on a `scope: owned` profile
  — owned prompt worked, four foreign calls were refused, `session_list` returned
  only the owned session, usage noted the rows it left out, search reported
  `hidden: 20` — and the acceptance run passed 142/142 under that scope.

## 0.29.3

- Security audit caught up with the tools added after it was written. A third
  review round records two accepted consequences rather than findings:
  **F11** — session mutation (`prompt`/`steer`, `cancel`, `rename`,
  `set_model`, `fork`, `session_queue`) is instance-wide, so a token holder can
  alter sessions it did not create; **F12** — `session_search` discloses bounded
  transcript snippets from every visible session, which is why search is opt-in at
  the deployment level and why `dsh_info { probeSearch: true }` reports its state.
  Both READMEs' security sections now say the reach is not just reading. One
  unexercised case is recorded: withdrawing a message a *different* client queued.

## 0.29.2

- Added `docs/LIVE-VERIFICATION.md`: a record of which behaviours were checked
  against a real harness, the version that shipped each one, and how to reproduce
  the check — plus an explicit "not verified here" list (desktop-composition
  subagent accounting pending the app restart, panel visuals, chunked-body
  bounding, an observed sandbox refusal) and the reasons. Linked from both
  READMEs; versions were cross-checked against this changelog rather than
  remembered.

## 0.29.1

- Verified the other two `session_queue` actions against a live harness and
  documented their semantics: `edit` keeps the queued message id (a caller can
  keep using the id it listed), and `steer` really reaches the running turn — the
  steered text appears as a user message in the transcript and the assistant's
  reply followed it (`STEERED-ACCEPTED`), with the running turn's earlier work
  intact. No runtime change.

## 0.29.0

- **`session_queue`** (27th tool): edit, withdraw or steer one *pending* queued
  message, addressed by the message id now carried by `session_messages`. A caller
  that queued work with `wait: false` can retract it before it spends a turn —
  `session_cancel` stops the running turn, this changes the work waiting behind it.
  With only `sessionId` it lists the pending inbox from the live `inbox`
  projection — the only place a queued message exists before its turn starts.
  The capability is reported as `sessionQueue` in `dsh_info.harnessServices`.

## 0.28.0

- `session_messages` gained `beforeSeq`: a transcript longer than the 500-message
  window is now reachable by paging backwards. Pass the seq of the oldest message
  you hold and the tail of the older window comes back, so repeated calls walk the
  whole log without a server-side cursor. `total` keeps counting everything the
  filters match, so a caller can tell how much further back it can go.

## 0.27.0

- `dsh_info { probeSearch: true }` answers "does session search really work here?"
  instead of only "does the controller expose search": it runs one random-token
  search (which matches nothing) so a disabled index is reported as
  `search.available: false` with the enabling instruction. Opt-in because the
  first search may open and reconcile the index.
- `tools/live-checks.mjs` uses that probe and asserts `session_search` agrees with
  it, for both enabled and disabled deployments.

## 0.26.0

- `session_search` hits now carry context: `cwd`, `updatedAt` and `running` from
  one session listing, so a caller can tell which workspace a match came from and
  how recent it is without a second call. A listing failure does not fail the
  search — the matches are still returned, just without that context.

## 0.25.1

- Added a **Deployment requirements** section to both READMEs: one table of what
  each tool group needs (service, and where the capability is configurable —
  `session-query`'s `openAt`, `costMeter`, `approval`, `webServer`), so an
  operator can see why a tool is unavailable without reading the source.
- `tools/live-checks.mjs` now checks session search too, accepting both legitimate
  deployments: a fresh token returns no matches when the index is open, and a
  disabled index reports how to enable it. Verified live on both (stock profile
  and `openAt: first-search`), 11/11 each.

## 0.25.0

- **`session_search`** (26th tool): a literal search over session *message content*
  that returns each match as `sessionId` plus a snippet, bounded at 20 with
  `hasMore`. It answers "which conversation discussed this?" without listing,
  reading and grepping transcripts, and it needs `sessionController.search` (the
  capability is reported as `sessionSearch` in `dsh_info.harnessServices`).

## 0.24.3

- Added `tools/live-checks.mjs` (maintainer-only, not in the published package): a
  reusable live verification run covering the protocol contract, list/paging
  contracts, and — with `--with-model` — progress streaming and MCP cancellation.
  Verified against a real 0.24.2 instance: 10/10 cheap checks and 16/16 with the
  model checks (progress notifications arriving about a second apart; a
  cancellation settling the wait in 12 ms with `turn.aborted: true`).

## 0.24.2

- Documentation consistency audit against everything verified in the 0.11.0–0.24.1
  rounds: CAPABILITY-GAPS now records those findings (bounded replies, usage
  receipt options, list contracts, `workspace_delete`, the `approval.policy`
  implementation, protocol/cancellation work, the `mountOnWebServer` fix),
  its service-probe table lists the real twenty probes, and its "the plugin
  cannot address the session's agent" conclusion is marked closed by
  `resolveAgent` (which is what made `dsh_tool_call` and `approval.policy`
  possible). README/README.zh cancellation and `partial` wording now matches the
  verified behaviour, and the zh design note gained the cancellation sentence the
  en one already had.

## 0.24.1

- Verified the web-server mount against the same protocol behaviours: with
  `enabled: false, mountOnWebServer: true` the only listener is DSH's own, and
  progress notifications stream roughly once a second (not batched at the end)
  while a cancellation notification settled the wait 11 ms after it arrived, with
  `turn.aborted: true` and the session still usable.

## 0.24.0

- **MCP `notifications/cancelled` is now honored.** The SDK version in use
  accepts the notification and does nothing with it, so a cancelled
  `session_prompt` used to keep waiting until its turn ended. The endpoint now
  reads the JSON body itself (passing it to the transport through `parsedBody`),
  maps in-flight `session_prompt` request ids to their sessions, and cancels the
  turn when the matching cancellation arrives — the waiting call settles as
  aborted/partial.
- Same layer answers an unparseable body with the JSON-RPC `-32700` parse error
  and keeps the 64 MiB declared-body refusal.

## 0.23.2

- Verified the settings panel's live-write chain end to end (the same path the
  panel uses, driven by a throwaway plugin that calls `ctx.settings.update`): the
  write landed in the composed config without a restart, `dsh_info` reported the
  new `limits.maxReadBytes`, and the very next `file_read` was capped by it
  (2048 instead of the previous 1 MiB). Unit tests already covered the per-call
  read; this is the first time the settings service itself was in the loop.
- Also confirmed `file_read` paging metadata is complete for a capped read:
  `offset`, `bytes` (returned), `nextOffset` (continuation) and `size` (the whole
  file) are all present, so a clamped default read is still continuable.

## 0.23.1

- Verified live (not only in unit tests) that tool-group toggles work end to end:
  with workspace/files/shell/agentTools/usage all off, `tools/list` advertises
  exactly `dsh_info` plus the session group (9 tools), calling a disabled tool
  answers JSON-RPC `-32602 Tool ... not found` rather than running and being
  refused, `dsh_info` reports the toggles, and `session_prompt` replies omit the
  `session`/`usage` blocks cleanly (`usageUnavailable` is not raised).
- Added a test that disables each group in turn and asserts exactly that group's
  tools leave `tools/list` while every other group stays.

## 0.23.0

- `session_usage { cwd }` totals every session that ran in one workspace
  directory (canonicalised), newest first and bounded by `limit`. Subagent rows
  fold in like every other scope, an empty directory is explained in `notes`, and
  mixing it with the id selectors is refused. This is "what did this project
  cost?" in one call instead of listing then batching.

## 0.22.0

- `shell_list` gained a `running` filter (`true` only live jobs, `false` only
  settled ones). Settled jobs stay in the list until a new start prunes them, so a
  caller polling one long-lived session had to filter the page itself.
- Verified live first: the 16-job cap refuses a 17th start with an explicit
  message instead of silently evicting a running job, and a job whose output
  exceeds the 128 KiB buffer reports `truncated`/`lossy` plus the spill paths
  rather than losing bytes silently.

## 0.21.4

- Steer and queue semantics verified live: a `mode: "steer"` message sent into a
  running turn is folded into that turn (one turn, usage covering the whole turn),
  while `mode: "queue"` becomes the next turn. Titled docs now also state
  explicitly that different sessions are not serialized against each other
  (measured concurrently: 6.3 s for two prompts each blocked on a 4 s tool step),
  and that cancelling one session leaves another untouched.
- Added the missing unit test for per-session serialization: a second prompt is
  not even submitted until the first wait settles.

## 0.21.3

- Timeout boundaries verified live: `shell_run` returns `timedOut: true` with
  SIGTERM and leaves the shell usable; a `session_prompt` wait timeout returns
  `timedOut`/`partial` while the turn keeps running, the session stays usable and
  the final usage settles; `dsh_tool_call` with a small `timeoutMs` aborts the
  call and the session stays usable.
- An agent-tool abort now names the deadline: the harness reports both a client
  cancellation and our timeout as "tool call aborted", so the reply says
  "aborted after <N>ms because timeoutMs elapsed" instead.

## 0.21.2

- Verified the plugin on a deliberately degraded profile (workspace and
  session-controller rows disabled): every missing-service tool names the service
  and the bundle that provides it, while `file_read`, `shell_run` and `dsh_info`
  keep working. One dead-end was fixed: with no session listing, the empty usage
  report told the caller to try `all: true`, which cannot work there; it now says
  to pass a known sessionId instead.

## 0.21.1

- `session_messages` reports `total` (messages matched by `sinceSeq`/`role`) and
  `truncated` when the newest-`limit` window hid older ones. Like `session_list`,
  the reply could previously not tell a caller whether it had seen the
  conversation from the start or only its tail.

## 0.21.0

- `session_list` reports `total` (matches before the limit) and `truncated` when
  the limit hid some. A bare list could not distinguish "these are all my
  sessions" from "the first page of them", which matters to a caller scanning for
  its sessions before acting.

## 0.20.7

- Acceptance covers more filesystem and shell edges, all verified live first:
  `maxBytes` reads report `truncated`/`nextOffset`; a symlink loop is listed but
  never followed (a walk that recurses into one never ends); `file_read_image`
  sniffs the bytes rather than the extension; and `shell_output` does not
  re-deliver output already read.

## 0.20.6

- A 401 now carries `WWW-Authenticate: Bearer realm="dsh-as-mcp"`. Without the
  challenge a standard MCP client cannot tell that presenting a bearer token is
  the fix and reports a dead endpoint instead of retrying.
- Acceptance gained protocol-contract checks (malformed JSON -> parse error,
  unknown method -> method-not-found, missing token -> Bearer challenge,
  declared oversized body -> 413) and model-selection failure checks (a bad
  route is reported by name with the known routes and the discovery hint).

## 0.20.5

- **Fixed `http.mountOnWebServer: true` mounting nothing on a real install.** The
  route was never registered because the DSH web-server service mounts after the
  plugins that use it and the code sampled it once at boot; requests fell through
  to the SPA fallback and answered 405. The plugin now waits for the service
  (`internal/service`) and mounts as soon as it appears. `dsh_info` reports
  `mountNote` while it is still waiting.

## 0.20.4

- `session_usage` now also carries `partial: true` on the report itself when any
  included row was read mid-turn, plus a note saying the totals will still grow.
  Previously only the individual rows were marked, so a caller reading `totals`
  could take a snapshot for a final bill.

## 0.20.3

- Docs and tests only. Recorded and verified post-restart continuity: a session
  created before a DSH restart stays readable, `session_usage { sessionId }`
  returns the same totals, and `session_prompt` continues it with cumulative
  usage spanning both processes; only ownership-based defaults reset. Added a
  regression test that owning a session never gates prompting or scoped usage.

## 0.20.2

- `workspace_create` on a path that exists as a file now says "exists but is not
  a directory" instead of echoing mkdir's `EEXIST` syscall message.
- The acceptance script gained an error-path section: unknown session ids and job
  ids, a missing file, a file registered as a workspace, forking an empty
  session, and an unknown-id usage receipt (row error + totals exclusion), then a
  health read to prove the endpoint survived the barrage.

## 0.20.1

- Settings panel: the timeout fields offered a minimum of `0`, which the host
  validator rejects; they now start at `1`. Added tests that every panel field
  path points at a real config leaf and that numeric bounds never offer a value
  the host refuses.

## 0.20.0

- `session_prompt` replies carry `turn.models`: the `provider/model` routes that
  answered the turn (unique, first-seen order), so a caller can confirm which
  model ran without reading token buckets.
- Requests that declare a body over 64 MiB are refused with `413` before the body
  is read (defence in depth; tools that carry large payloads have their own caps).

## 0.19.1

- Documentation and metadata only. Added this changelog; no runtime change.

## 0.19.0

- **`workspace_delete`** (25th tool): unregister a workspace without touching its
  files or session history; idempotent (`deleted: false` for an unknown id).

## 0.18.0

- `session_list` gained `cwd` (canonicalised) and `running` filters, applied
  before the limit so "the newest N of mine" means exactly that.
- `session_usage` gained `sessionIds` for one receipt over several known
  sessions: duplicates collapse, subagents fold per id, and mixing it with
  `sessionId`/`all` is refused.

## 0.17.0

- `session_messages` gained `maxCharsPerMessage`; a cut message reports
  `truncated` and its original `chars`.
- `session_prompt` gained `maxReplyChars`; a cut reply reports `replyTruncated`
  and its original `replyChars`. `TurnResult.replyChars` is always present.
  Both caps are opt-in, so the default behaviour is unchanged.

## 0.16.0

- `dsh_tool_call` now caps the result text: 20 000 characters by default,
  `maxResultChars` up to 200 000. The reply always carries `resultBytes`, sets
  `truncated` when cut, and drops the structured `value` in that case — an agent
  tool can return a whole file.

## 0.15.1

- `dsh_info.harnessServices` now reports `approval`, `sessionRename` and
  `sessionModel`, so a caller can tell "unavailable" from "refused".
- Documentation audit: corrected the `approval.policy` description, added image
  and background-shell notes to the security section, documented mid-turn
  `partial`, and corrected the claim that `dsh plugin --profile desktop add` is
  refused on the current harness (it works; only managed operations are refused).

## 0.15.0

- **`approval.policy: "allow"` is now implemented** (it was documented and
  parsed but never applied): sessions this plugin creates — and forked children —
  are switched to the harness's unattended stance through the approval service.
  The create/fork reply reports `approvalPolicy: "never"` or
  `approvalPolicyError`.

## 0.14.2

- Metadata and exports: package description reflects the real tool surface and
  the public driver types added since 0.2.0 are exported from the package root.

## 0.14.1

- Acceptance-script fixes: cross-section state was block-scoped, so the run threw
  `usageReported is not defined` and never reached the later sections; the fork
  check read the wrong reply field. Both fixed, with a regression test.

## 0.14.0

- `session_usage` (and every usage read) marks a report `partial: true` when the
  session's newest turn is still running, so a mid-flight read is never mistaken
  for a final bill.

## 0.13.0

- Structured output: six data tools declare an `outputSchema`, and every
  object-shaped reply also carries `structuredContent` beside the text block.

## 0.12.0

- `session_prompt` gained `idempotencyKey`: a retried call returns the existing
  turn instead of sending the task twice (measured: 0 extra tokens, one user
  message). Reusing a key with different content is refused.

## 0.11.0

- **`session_set_model`**: switch a session's provider route/model for later
  turns; per-model usage shows which route spent what.
- Shared, actionable model-selection failures (requested pair, known routes, how
  to list models).

## 0.10.0

- **`session_rename`**: explicit user titles, visible in the DSH UI and readable
  back through `session_list { includeTitle }`.
- `dsh_info` gained redacted `config` (limits, approval, defaults — never the
  token) and endpoint `health` (node, platform, memory).

## 0.9.0

- `session_prompt` tool calls are summarised by default (`name`, `callId`,
  `argumentsBytes`) instead of echoing full arguments; `toolCalls: full|none` and
  `maxArgumentChars` control the detail. Measured: a 5.8 KB `write` call no longer
  appears in the reply.

## 0.8.0

- `session_prompt` accepts up to four images (`png`/`jpeg`/`webp`/`gif`) read
  through the filesystem seam and passed to the agent as prompt attachments.
- A client abort now ends a waiting `session_prompt` with `aborted`/partial
  instead of running to the timeout.

## 0.7.0

- **`file_read_image`**: images returned as MCP image blocks, format sniffed from
  the bytes, 8 MiB cap.
- `dsh_info { includeModels: true }` lists each provider route's advertised
  models, time-boxed per provider.

## 0.6.0

- **`session_fork`**: branch a session at an exact event prefix; the inherited
  prefix is reported separately by `session_usage`. Uses the controller's fork
  (cold-readable, persists the child); the store's fork was rejected after live
  testing showed its child cannot be prompted.

## 0.5.0

- **Fixed a live bug**: `shell_run` failed on harness 0.2.1 with "Cannot read
  properties of undefined (reading 'text')" because `execute()` resolves a live
  process handle whose foreground result is `result()`.
- **`shell_start` / `shell_output` / `shell_kill` / `shell_list`**: background
  commands with bounded buffers, watchdogs, and support for both the 0.1.5
  (`start`) and 0.1.7+ (`execute`) shell shapes.

## 0.4.0

- `session_prompt` reports `notifications/progress` (at most once a second) when
  the client supplies a `progressToken`.
- `session_list { includeTitle }` folds each session's latest title.

## 0.3.0

- **`file_edit`**: exact literal replacement, unique unless `replaceAll`, nothing
  written on an ambiguous match — editing no longer costs a read plus a write of
  the whole file.
- `file_list { recursive }` with relative paths, depth bound, cycle-safe walk and
  an entry cap.
- `session_messages` gained `sinceSeq`/`role` for incremental transcript reads.

## 0.2.1

- `dsh_info` gained `version`/`uptimeMs`, a `catalog` block (providers, agent
  presets, sandbox mode, permission presets, session count) and an opt-in model
  list.
- MCP `initialize` carries workflow instructions for the calling model.
- The prompt wait wakes on `session/event` instead of re-reading the log on a
  fixed 200 ms cadence.
- `session_usage { includeCost: false }` skips the price ledger on wide scans;
  list-price totals are aggregated beside real money.
- `file_read` gained `offset`/`nextOffset`/`maxBytes` for cheap paging.

## 0.2.0

- **Usage accounting**: every `session_prompt` reply carries exact per-turn and
  cumulative tokens (plus money when `dsh-cost-meter` is installed), and
  **`session_usage`** reports a receipt after the fact — the harness has no
  session-end event, so the tally rides the reply and an explicit tool.
  Subagents fold in as their own rows; fork-inherited prefixes are separated;
  compaction is reported but excluded from totals; the fold is verified against
  the harness's own `tokenUsage` projection.
