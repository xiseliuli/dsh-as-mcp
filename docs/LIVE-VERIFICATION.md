# Live verification record

This page records which of this plugin's claims were checked against a **running harness**, not
only against tests. A stub is a model of the harness, and `docs/STUB-FIDELITY-AUDIT.md` exists
because those models have been wrong four times; the point of this page is to say plainly which
behaviours have been observed on the real thing, when, and how to reproduce the check.

It is a record, not a promise: the newest entries name the plugin version that shipped the
behaviour, and an entry is only here if a real DSH process produced the stated result.

## How the checks run

| Environment | What it was |
| --- | --- |
| Harness | DSH `0.2.1-rc.5` (the installed desktop app's runtime), plus `0.1.7-rc.2` and `0.1.5-rc.1` checkouts for API-shape questions |
| Profile | `dsh --profile <name> --from-default-profile web` with a `cordis.patch.yml` that enables `dsh-as-mcp` on `127.0.0.1:8821`, run headless with `--no-open --port 8822` |
| Client | a plain MCP client over Streamable HTTP (`fetch`, no SDK), so the wire format is what a third-party client would see |
| Older deployments | `tools/live-checks.mjs --old-endpoint` runs the same checks against a build that predates them; against the desktop app's 0.2.0 build it reported 3 protocol checks passing and 4 skips (Bearer challenge, `total`/`truncated`, paging metadata, workspace-scope usage) — a compatibility description, not a failure |
| Full sweep: one profile with the search index enabled and `DSH_PERMISSION_MODE=danger-full-access`, live-checks in every mode (`--with-model --with-subagent`) plus the complete acceptance run | 0.52.81 | live-checks **189/189** (protocol, cheap contracts, progress, cancellation, orchestration, model selection + route/token cross-checks, status reporting, truncation receipts, concurrent turns, real subagent, search hits, result reads) and acceptance **166/166** in the same boot — the shape a deployment opts into, not the stock `openAt: "never"` one |
| Reusable scripts | `scripts/smoke.mjs` (wire up), `scripts/exercise.mjs` (166 checks, real prompts), `tools/live-checks.mjs` (protocol + cheap contracts; `--with-model` adds progress/cancellation, `--with-subagent` a real subagent turn), and `tools/release.sh --acceptance` (boots a throwaway profile under a temporary `DSH_HOME`, runs the whole list, tears it down) |
| Transcript/composition | every session, prompt and tool call below ran as an external caller would; the desktop app's **UI** was never driven for these checks, but 0.52.80 drove the running **desktop composition** through its own MCP endpoint (read-only smoke, one real agent-team turn, and the full acceptance run) — see the two 0.52.80 rows below |
| Desktop composition (the app the user actually runs, reloaded onto 0.52.80) | 0.52.80 | `scripts/smoke.mjs` read-only: endpoint listening, 28 tools, 4 provider routes, 4 agent presets; one real agent-team turn (parent + subagent); `scripts/exercise.mjs` against `http://127.0.0.1:8790/mcp`: **166/166**, 0 failed — the stock composition, where `session-query` ships `openAt: "never"`, so the search-disabled branch is the one exercised |

## Verified behaviours

### Protocol and transport

| Behaviour | Since | Evidence |
| --- | --- | --- |
| Streamable HTTP `initialize`, `tools/list`, `tools/call`; `GET` stream; `text/event-stream` responses | ≤0.2.0 (first documented release) | smoke + exercise on every release |
| A missing or wrong bearer token is `401` with `WWW-Authenticate: Bearer realm="dsh-as-mcp"` | 0.20.6 | request without token → 401 + challenge header |
| Malformed JSON is `400` and a JSON-RPC `-32700` body | 0.20.6 / 0.23.2 | delivered `{not json` |
| Unknown method is `-32601` | 0.20.6 | delivered `no/such-method` |
| A declared body over 64 MiB is refused with `413` before it is read | 0.20.6 | declared `content-length` of 999 MiB → 413 |
| `progressToken` produces `notifications/progress` **while** a turn runs, about once a second, not batched at the end | 0.2.0 | a six-second turn: 7 notifications arriving at ~1.2/2.0/3.0/4.0/5.0/6.0 s |
| MCP `notifications/cancelled` stops the turn and settles the wait promptly | 0.24.0 | 600-word prompt cancelled at 3 s → wait settled 10–12 ms later with `turn.aborted: true`; the SDK only acknowledges this notification, so the endpoint routes it itself |
| A cancellation in the window before the prompt is committed still settles the wait as aborted | 0.52.80 | cancelled as soon as `session_list { running: true }` showed the session, before the prompt had a `user/message` in the log (the turn was aborted with the message still in the inbox): the wait settled **18 ms** after the notification with `turn.aborted: true`. Before the fix the same cancellation sat out its 30 s `timeoutMs` and reported `timedOut: true`; live-checks' cancellation section asserts the prompt, the elapsed bound and that the turn left the running filter |
| The same cancellation on the `mountOnWebServer` route | 0.24.1 | mounted route, same result |
| A disabled `http.enabled: false` + `mountOnWebServer: true` serves MCP only on DSH's web server | fixed 0.20.5 | no listener on 8821, `initialize` on `:8822/mcp` |

### Sessions, usage and money

| Behaviour | Since | Evidence |
| --- | --- | --- |
| `session_create` / `prompt` with an agent reply, tool calls and per-turn + cumulative token usage | ≤0.2.0 (first documented release) | exercise: real agent wrote, read and ran code |
| Usage is folded from the durable log and verified against the harness's own `tokenUsage` projection | 0.2.0 | same numbers from both on a real multi-step turn |
| `session_usage` by session, by batch `sessionIds`, per workspace `cwd`, or all sessions | 0.7.0 / 0.18.0 | exercise + manual: batch and cwd totals matched the per-session rows |
| `partial: true` only when a snapshot was taken mid-turn; a cancelled-and-settled turn reports final numbers | 0.20.4 | aborted prompt inspected mid-run vs after settle |
| Caller-set caps are cuts with receipts: `maxArgumentChars` and `maxReplyChars` truncate and report the original size/length | 0.52.80 | one real turn echoed a 464-byte tool argument cut to 200 chars (`truncated: true`, `argumentsBytes: 464`) and a 299-char reply cut to 40 (`replyTruncated: true`, `replyChars: 299`); a silent cut would fail the check |
| Money is reported only when `dsh-cost-meter` is installed, and says whether it is real money or a list-price estimate | 0.7.0 | desktop profile (plugin installed) and a bare profile (absent) |
| `idempotencyKey` replay returns the existing turn instead of sending the task twice | 0.12.0 | same key twice; one prompt visible in the log |
| `session_set_model` changes the route and `turn.models` names what answered | 0.11.0 | switched provider/model; reply named the new route |
| Image prompt attachments reach the agent | 0.8.0 | a generated PNG prompted as an image part |
| `session_fork` inherits the conversation prefix; the child is promptable | 0.6.0 | forked a live session, prompted the child; inherited-prefix usage reported separately |
| `session_rename` sets a user title | 0.10.0 | title visible in `session_list` |
| Same-session prompts serialize; different sessions run in parallel; cancelling one does not disturb the other | 0.13.0 | two 4-second tool steps in two sessions finished in 6.3 s total; one cancelled, the other completed |
| Compare-and-swap across interleaved clients: A reads the hash, B rewrites, A's guarded write is refused with the new hash and leaves B's content, A's retry succeeds | 0.51.1 | live-checks concurrency section; the one-client cases are covered by unit tests |
| `file_read` paging: a capped read reports `truncated`/`bytes`/`nextOffset`, the next window completes the file, and a mid-character window decodes one U+FFFD per orphaned byte with the rest aligned | 0.38.3 | live-checks file-paging section: 5 000-byte window then 5 003-byte remainder, and a window started one byte into a 3-byte euro yielded exactly 2 replacement chars before the aligned tail |
| `session_list` `cwd`/`running` filters, `total`/`truncated` honesty | 0.18.0 / 0.21.0 | filtered listings on a store of hundreds of sessions |
| `session_fork` requires a completed turn: a never-prompted source is refused with "has no completed turn to fork from" (description updated in 0.38.0) | 0.38.0 | live-checks fork/rename section: the refusal is legible; the positive fork path stays covered by the acceptance run, which forks a session that answered |
| `session_cancel` preserves queued work: a second queued message survives the cancel and then runs | 0.37.9 | live-checks orchestration: 1 message left after cancel, it ran, the withdrawn one did not; 35/35 checks |
| `session_messages` reports model tool calls with their result size/error, and `session_tool_result` fetches one recorded result by call id | 0.32.x / 0.36.0 | live: the acceptance run read a real bash call's result (115 chars) and matched it against the transcript's `resultChars` |
| `session_messages` tail window, `total`, `truncated`, per-message cap, `beforeSeq` backwards paging | 0.21.1 / 0.17.0 / 0.28.0 | paged a real transcript: 2-message tail, then the 2 before it, `total` consistent |
| `session_search` returns matches + `hasMore`, and hits carry `cwd`/`updatedAt`/`running` | 0.25.0, 0.26.0 | with the index enabled, a fresh marker token was found in the session that said it; absent tokens → 0; multiple terms ANDed |
| `dsh_info { probeSearch: true }` reports whether search really works | 0.27.0 | stock profile → `available: false` + the `openAt` instruction; `openAt: first-search` → `available: true` |
| A subagent spends on the parent session's route **at spawn time** | 0.51.8 / 0.51.9 | first probe: parent created on deepseek-account/deepseek-flash → child billed there. Second probe: parent answered on deepseek-official, was switched to deepseek-account, then spawned → child billed deepseek-account. live-checks now switches the parent before spawning and asserts the child follows |
| A real subagent turn is folded into its parent's usage as its own row and included in the totals | 0.7.0 (fold), verified 0.30.2 | web-composition profile: the agent spawned a helper; `session_usage { includeSubagents: true }` returned 2 rows (parent 27,419 tokens, subagent 18,567) and the report total equalled their sum; `tools/live-checks.mjs --with-subagent` asserts this (23/23 with the model checks on) |
| Subagent accounting works in the **desktop composition** | 0.52.80 | after reloading the app onto 0.52.80, one real turn asked the agent to spawn a helper: `session_usage { includeSubagents: true }` returned 2 rows (parent 44,109 tokens / 1 turn / 4 steps; subagent `origin: "subagent"` 19,648 / 1 turn / 2 steps with `parentSessionId`), the report total 63,757 was their sum, and the child's own `session_usage` receipt matched its row exactly. Desktop money reporting also worked: `cost.available: true`, `source: dsh-cost-meter`, parent $0.001578024 |
| `session.scope: "owned"` treats subagent sessions of an owned session as part of the tree | 0.30.2 | live: with the owned profile, the spawned subagent session appeared in `session_list`, its transcript was readable by id, and it was billed inside the parent's report; a session outside the tree stayed refused (unit tests cover the sibling case) |
| `session.scope: "owned"` ownership survives a plugin restart via `$DSH_HOME/dsh-as-mcp/owned.json` | 0.30.1 | created a session under `owned`, restarted the instance, and the same id was still visible and promptable while a foreign id stayed refused; a corrupt record hid it (fail-closed) |
| `session.scope: "owned"` confines session tools to sessions the endpoint created: prompt works on an owned session, foreign ids are refused by prompt/messages/usage/queue, `session_list` returns only the owned session, `session_usage` notes the rows it left out, and search reports `hidden` | 0.30.0 | live profile with `scope: owned`: owned prompt replied `SCOPED OK`; four foreign calls refused citing the setting; `session_list` total 1 of hundreds; `usage all` rows 0 + the note; `session_search Reply` returned 0 matches with `hidden: 20`; acceptance 142/142 under this scope |
| Pending queue listing and mutation: `session_queue` list / `remove` / `edit` (id preserved) / `steer` | 0.29.0 | queued prompts listed with ids; removed one never ran; steered text reached the running turn and the assistant replied `STEERED-ACCEPTED` |

| `session_status` reports a running turn, its ending and the log silence | 0.52.81 | a `session_prompt { wait: false }` followed by a held `session_status { waitMs }`: the status call answered `changed: true` while the turn ran (`running: true`, an open turn, `idleMs` 3 ms after the newest event, `stalled: false`, `logReadable: true`), then — once the turn settled — `running: false`, `lastTurn.reason: {kind: "completed"}`, `failure: null`; the same turn's awaited reply carried `turnEndReason: {kind: "completed"}` and no `failure` block |

| `session_status` works in the **desktop composition** after a reload | 0.52.82 | the app was restarted onto 0.52.82; `scripts/smoke.mjs` reported 29 tools with `session_status` in `tools/list`; a real desktop turn started with `session_prompt { wait: false }` was reported by a held `session_status { waitMs }` in 54 ms (`changed: true`, `running: true`, `openTurn: 1`, `openStep: 1`, `idleMs: 0`, `stalled: false`, `logReadable: true`), then settled as `running: false` with `lastTurn.reason: {kind: "completed"}` and `failure: null`; the awaited reply `DESKTOP SECOND OK` carried `turnEndReason: {kind: "completed"}` and no `failure` block. The probe session ran in a throwaway `/tmp` workspace and was moved to `~/.dsh/sessions-trash/2026-11-03T03-44-06-878Z` afterwards |

### Failure reporting (fault injection)

Run against a throwaway profile (`fault-probe`, copies of the credentials, headless, `DSH_PERMISSION_MODE=danger-full-access`),
driven over the same MCP endpoint a real upstream uses; the recipe and the raw replies are recorded in
`docs/FAULT-INJECTION-2026-11-03.md`.

| Behaviour | Since | Evidence |
| --- | --- | --- |
| A real `error` ending is reported on the reply as `turn.failure`, not returned as an ordinary success | 0.52.81 | forced a provider auth failure by corrupting only the throwaway copy's `refs.DEEPSEEK_API_KEY`: the turn ended `turnEndReason: {kind: "error", error: {message: "Authentication Fails, …", code: "AUTH", status: 401}}` with `reply: ""` and `failure: {kind: "error", message: "Authentication Fails, …"}`, settled in 478 ms (a timeout would have been 120 s); `session_status` on the same session reported the identical `lastTurn.reason` and `failure` |
| A log that disappears mid-turn is reported as a failure instead of "still running" | 0.52.81 | renamed the session log directory away 3 s into a real turn: the turn closed `turnEndReason: {kind: "error", error: {message: "ENOENT: … session.v4.jsonl.zstd"}}` with `failure.kind: "error"` and settled in 13.8 s, not its 120 s timeout; with the directory still moved, `session_status` answered `logReadable: false` instead of throwing |
| A crash-orphaned turn is reported as `interrupted` on the next read | 0.52.81 | a real turn was running (`bash: sleep 45`) when the harness was `kill -9`'d; after restarting against the same `DSH_HOME`, a cold `session_status` (no prompt first) returned `running: false`, `lastTurn.reason: {kind: "interrupted"}`, `failure: {kind: "interrupted"}`, `logReadable: true` — the "task died and nobody said so" case |
| `stalled` marks a running turn that has gone quiet for a minute | 0.52.81 | a real turn sleeping in a tool call: polling `session_status` every 5 s showed `running: true`, an open turn, `failure: null`, `idleMs` growing, and at `idleMs = 62 861 ms` `stalled: true` (60 s: `58 847 ms`, false) — a symptom, not a verdict, as documented |

### Files and shell

| Behaviour | Since | Evidence |
| --- | --- | --- |
| `file_read` ranges with `nextOffset`/`size`/`truncated`; `file_write`; `file_edit` literal edit with a match count; `file_list` recursive | 0.3.0 | exercise wrote, read back and edited real files |
| `file_read_image` sniffs the real format and refuses non-images | 0.7.0 / 0.20.7 | PNG accepted; a text file refused |
| Symlink loops are refused rather than walked forever | 0.20.7 | built a loop; `file_list` returned a legible error |
| `shell_run` returns stdout/stderr/exit code; a timeout kills the process (SIGTERM) | 0.3.0 / 0.5.0 | `sleep` beyond the limit; process gone, reply said timeout |
| Background jobs: `shell_start`, incremental `shell_output`, `shell_kill`, `shell_list { running }` | 0.5.0 / 0.22.0 | listed a live `sleep`, read partial output, killed it, it left the running filter |
| Output is capped rather than dropped silently; the reply reports how much was dropped | 0.16.0 | a chatty command's reply carried the dropped-bytes count |
| The sandbox/workspace rules that DSH applies to its own tools apply here by construction: the file tools call the harness `fs` service, and the plugin touches `node:fs` only to create a workspace root | 0.3.0 | code-path review, not an observed refusal (see the note below) |

### Agent tools and approval

| Behaviour | Since | Evidence |
| --- | --- | --- |
| `dsh_tool_list` reflects the session's own tool scope | 0.2.0 | listed the live scope of a real session |
| `dsh_tool_call` runs a permitted tool through DSH's own pipeline (guards, sandbox, approval, spill) | 0.2.0 | called `read`/`glob` in a real session |
| `run_code` is in the allow-list only when explicitly configured, because it can invoke any tool by name | 0.2.0 | default allow-list has no `run_code`; enabling it required a config edit |
| `approval.policy: "allow"` actually switches the session to the harness's unattended stance | 0.15.0 | live log line: the approval policy changed from `ask` to `never`; a create/fork reply carried `approvalPolicy` |
| A missing approval service or unresolvable agent reports `approvalPolicyError` instead of silently asking | 0.15.0 | bare profile |

### Composition, configuration, degradation

| Behaviour | Since | Evidence |
| --- | --- | --- |
| The settings panel exposes every documented field and writes live (`ctx.settings.update`) | 0.23.2 | changed a limit in the panel; the next `file_read` obeyed the new cap |
| `http.mountOnWebServer` waits for the web-server service and mounts (it used to mount nothing) | 0.20.5 | mounted route serves MCP; `dsh_info.mountNote` while waiting |
| A profile without `sessionQuery` degrades to `sessionController.inspect` reads and still reports usage | 0.20.0 | headless profile |
| A profile without `costMeter` says money is unavailable rather than printing zero | 0.7.0 | headless profile |
| A bare profile reports each missing service in `dsh_info.harnessServices` instead of refusing to load | 0.2.0 | sdk-minimal profile |
| Restarting DSH does not lose prior sessions; the endpoint reads them after a restart | 0.20.0 | restarted the temp instance and listed/read earlier sessions |

### Skills, presets, catalogs

| Behaviour | Since | Evidence |
| --- | --- | --- |
| `dsh_info.catalog` reads providers, models, agent presets, sandbox mode and permission presets from the live services | 0.7.0 | live profile returned the real catalog; a field that could not be read is named in `catalog.unavailable` |
| `includeModels` asks each provider route what it advertises (opt-in, per-provider time-boxed) | 0.7.0 | live profile |

| A restrictive sandbox policy actually refuses a plugin file write | 0.51.11 | booted a profile with `DSH_PERMISSION_MODE=read-only`: `file_write` answered "file access denied under read-only mode", `shell_run` could read (`cat /etc/hosts`) but its redirect to `/tmp` failed with "Operation not permitted" |
| Chunked request bodies are size-bounded, not just declared ones | 0.51.11 | a 70 MB body sent with `Transfer-Encoding: chunked` (no `content-length`) answered `413 request body too large` in 71 ms; a valid chunked `initialize` answered 200 |
| A mid-turn `session_set_model` applies to the running turn's later steps | 0.52.1 | probed: a turn started on deepseek-official, was switched to deepseek-account mid-flight, and reported both routes; per-turn `byModel` split it 18 062 + 18 586 = 36 648 = the row total. live-checks asserts this |

| A message queued by **another MCP client** can be seen and withdrawn here | 0.52.5 | live-checks orchestration: a second client (its own initialize and ids) queues a message, the first client lists and removes it, and the withdrawn text never runs. The queue lives on the session, so a connection-scoped id would show up here |
| Owned-session ownership survives a plugin/host restart | 0.52.12 | created a session under `session.scope: "owned"` (it appeared in `$DSH_HOME/dsh-as-mcp/owned.json`), killed the process, restarted the same profile: `session_messages` on that id was served, while a session id read from another profile's log was refused with the scope message. The probe id was then removed from the record |
| A corrupt `owned.json` fails closed | 0.52.13 | created a session under `session.scope: "owned"` (recorded), stopped the process, replaced the record with `{not json at all`, restarted: `session_messages` for that previously-owned id was **refused**, so a damaged record can only hide sessions, never expose them. The original record was restored byte-for-byte from a pre-probe copy |
| A narrowed deployment verifies cleanly: only `files`+`shell` groups enabled | 0.52.32 | `live-checks` against that profile: 11 tools advertised, 11 available, 17 unavailable each with a reason, all four disabled groups named (`workspace, session, agentTools, usage`), and the session/usage/queue/search sections degraded to explicit skips — 65/65 checks, 0 failed |
| A **session-only** deployment (no workspace/files/shell/agentTools groups) drives real turns | 0.52.33 | `live-checks --with-model` against that profile: 84/84 checks, 0 failed — model selection, `reasoningEffort`, route switch, usage receipt routes, transcript turn window, progress/cancel/orchestration/steering/idempotency all ran; every file/shell/workspace section reported as an explicit skip |
| `http.host` is validated, and an invalid one stops the endpoint from binding | 0.52.51 | booted a profile with `http.host: ''`: no listener on the plugin port and the process output carried `http.host must not be empty: use 127.0.0.1 for loopback, or 0.0.0.0 to listen on every interface`. With `0.0.0.0` the listener **does** bind (the non-loopback warning path exists in code, but plugin `log.warn` output was not captured in this harness's stdout, so the warning itself is not observed here) |
| Title generation leaves no usage record, while its `session/title-llm-request` names the route | 0.52.55 | read a probed session's own log: one `session/title-llm-request` carrying a route, **no** `assistant/message`/`assistant/attempt` event for it, and the receipt's `samples` equals the assistant events in the log (1 = 1). live-checks now asserts that equality, so title spend appearing in the fold would break it |

| The folded usage totals agree with the harness's own token projection | 0.52.56 | a real two-turn session's receipt carries `verifiedAgainstProjection: true` with no `projectionTotals` (the field that appears only on disagreement). live-checks now asserts this, so a shape change on either side fails a live run rather than a stub |
| `http.port: 0` advertises the port the OS assigned | 0.52.67 | booted a profile with `port: 0`: the plugin bound `61532`, and `dsh_info` answered `endpoint: "http://127.0.0.1:61532/mcp", listening: true` — not `:0`, and not the configured placeholder. Combined with 0.52.66 the panel now prefers this live URL over the mirror |
| A mounted-only endpoint's `dsh_info` is honest about where it lives | 0.52.68 | profile with `http.enabled: false` + `mountOnWebServer: true`: `initialize` works on `:8822/mcp`, no listener on the plugin port, and `dsh_info` answers `listening: false`, `mountedOnDshWebServer: true` with an endpoint string that is an **explanation**, not a URL. live-checks now asserts the endpoint/listening relation on every run |
- Poll for the condition, never sleep a fixed guess. The title-visibility check first waited 4
  seconds for the harness to write `session/title-llm-request`; it now polls the log for up to 20
  seconds and stops as soon as the event appears. A fixed sleep encodes this machine's speed and
  flakes elsewhere (0.52.73). The same applies to the checks that must act *while* a turn is open:
  cancellation, steering and the mid-turn switch poll `session_list { running: true }` instead of
  sleeping 1.5-3 seconds (0.52.74).

| A cancelled turn actually stops, not just the wait | 0.52.75 | after the aborted `session_prompt` wait returned, `session_list { running: true }` no longer listed the session (polled up to 20 s). The wait ending and the turn stopping are different facts; live-checks asserts both |
| `includeSubagents` has an observable effect both ways | 0.52.77 | with the flag (default `true`) the subagent is a row and the total includes it (55499 tokens); with `includeSubagents: false` no subagent row appears and the total is the session alone (36808). Running with `--with-model --with-subagent`: 174/174 |
| The `running` filter and the `includeTurns`/`includeCost` switches change what is returned | 0.52.78 | a freshly created (idle) session appears under `session_list { running: false }` and not under `true`; `session_usage { includeTurns: false }` returns an empty `byTurn` and `{ includeCost: false }` reports `cost.available: false`. Both are by-effect assertions, not "the parameter was accepted" |
| `includeTitle` and `sinceSeq` change what is returned | 0.52.79 | with a generated title present, `session_list { includeTitle: true }` carries it and the default row does not; `session_usage { sinceSeq }` starting after the first turn's last message returned fewer turns and fewer tokens than the whole log |
## Not verified here

These are gaps in *evidence*, not known defects:

| Item | Why | What it would take |
| --- | --- | --- |
| The wait-side detections `unreadable` and `vanished` observed live | fault injection covered `error`, `interrupted` and `stalled` (see the failure-reporting section), but the harness resolves the two await-time conditions itself first: a turn whose log disappears closes with `error` (ENOENT), and a crashed turn is synthesised as `interrupted` on the cold read, so neither reaches the driver's own branch. Both are unit-tested (`tests/driver.test.ts`), and their user-visible outcome — a failure report instead of a timeout — was observed live through the `error`/`interrupted` paths | fault the agent loop in-process (a test-only composition that disposes a session mid-turn), not the whole harness |
| Panel/visual rendering (widgets, slots, settings page layout) | the `ifc-view` MCP server used for visual inspection was disconnected in this session | reconnect `ifc-view`, or inspect the panel by hand |
| `session_usage` money figures match the cost plugin's own numbers **exactly** | 0.52.8 | installed the current `dsh-cost-meter` (1.9.x) from its registry into a throwaway profile (a copied package directory dies on its hoisted deps: `Cannot find package 'acorn'`). For session `session-33b7153d-…`: the receipt returned `costUsd 0.00008131200000000001, calls 2` and the plugin's ledger row for the same session was `cost 8.131200000000001e-05, calls 2` — the same float, and `costEstimateUsd` agrees when no plan covers the call. live-checks now asserts the `info.usage.costAvailable` → receipt-cost implication when a price plugin is mounted |
| Mutating a message queued by the **DSH UI** with `session_queue` | a *second MCP client* is covered live (0.52.5), and the queue projection/ids are shared code; the UI's own client was not driven | queue a message from the DSH UI while a turn runs, then `remove` it through the endpoint |

## Reproducing a check

```bash
# 1. a profile with the plugin on 127.0.0.1:8821 (see README "Install")
dsh --profile mcp-check --from-default-profile web --dump-config
dsh plugin --profile mcp-check add ./dsh-as-mcp-<version>.tgz
# 2. a cordis.patch.yml enabling dsh-as-mcp (see README "Configuration")
dsh --profile mcp-check --no-open --port 8822
# 3. in another terminal
node scripts/exercise.mjs --url http://127.0.0.1:8821/mcp --dir /tmp/exercise
node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp          # cheap contracts
node tools/live-checks.mjs --url http://127.0.0.1:8821/mcp --with-model  # progress + cancellation
```

Every check above is labelled in the scripts' output; a failure names the behaviour it was
checking, so a regression shows up as a sentence, not just a non-zero exit code.

## Flake discipline: a check must create the condition it relies on

Three real failures in the 0.52.4x rounds were the *script* measuring the machine, not the
plugin. Each was fixed by making the check produce the preconditions it asserts, and the
pattern is worth keeping:

| Symptom | Cause | Rule |
| --- | --- | --- |
| One full-shape run 144/1, three reruns green | the progress assertion demanded two notifications, but the sender is rate-limited to ~1/s and a fast turn legitimately emits one | assert the property that matters (the first notification arrived *during* the turn), and make multi-notification spread conditional |
| A steer could miss its turn | a prompt of three fast `echo` commands could finish before the 1.5 s switch/steer delay | the prompt starts with `sleep N` so the turn is provably open when the second call lands |
| A deadline check could measure the wrong thing | `sleep 5` under a 700 ms timeout is only ~4 s of separation from a natural finish | the command is much longer (`sleep 15`) than the guard window, so returning inside the window proves the deadline fired |
| `shapes.mjs` reported sparse `harnessServices` | the HTTP socket answers before the harness services are mounted | poll `dsh_info` until the service set is complete before running checks |

The wider point for maintainers: when a live check fails once and then passes repeatedly,
suspect the check's assumptions before the plugin — and when you fix it, make the assumption
explicit in a comment, because the next reader will otherwise "simplify" the sleep away.
