# Changelog

All notable changes to `dsh-as-mcp`, newest first. Versions follow SemVer; the
plugin is pre-1.0, so a minor bump is a feature and a patch is a fix or docs.

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
