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
| Full sweep: one profile with the search index enabled, live-checks in every mode (`--with-model --with-subagent`) plus the complete acceptance run | 0.51.6 | live-checks 115/115 (protocol, cheap contracts, progress/cancel, orchestration, model selection + route/token cross-checks, concurrent turns, real subagent, search hits, result reads) and acceptance 163/163 in the same boot |
| Reusable scripts | `scripts/smoke.mjs` (wire up), `scripts/exercise.mjs` (142 checks, real prompts), `tools/live-checks.mjs` (protocol + cheap contracts; `--with-model` adds progress/cancellation, `--with-subagent` a real subagent turn), and `tools/release.sh --acceptance` (boots a throwaway profile under a temporary `DSH_HOME`, runs the whole list, tears it down) |
| Transcript/composition | every session, prompt and tool call below ran as an external caller would; the desktop app itself was never driven for these checks |

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
| The same cancellation on the `mountOnWebServer` route | 0.24.1 | mounted route, same result |
| A disabled `http.enabled: false` + `mountOnWebServer: true` serves MCP only on DSH's web server | fixed 0.20.5 | no listener on 8821, `initialize` on `:8822/mcp` |

### Sessions, usage and money

| Behaviour | Since | Evidence |
| --- | --- | --- |
| `session_create` / `prompt` with an agent reply, tool calls and per-turn + cumulative token usage | ≤0.2.0 (first documented release) | exercise: real agent wrote, read and ran code |
| Usage is folded from the durable log and verified against the harness's own `tokenUsage` projection | 0.2.0 | same numbers from both on a real multi-step turn |
| `session_usage` by session, by batch `sessionIds`, per workspace `cwd`, or all sessions | 0.7.0 / 0.18.0 | exercise + manual: batch and cwd totals matched the per-session rows |
| `partial: true` only when a snapshot was taken mid-turn; a cancelled-and-settled turn reports final numbers | 0.20.4 | aborted prompt inspected mid-run vs after settle |
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
| `session.scope: "owned"` treats subagent sessions of an owned session as part of the tree | 0.30.2 | live: with the owned profile, the spawned subagent session appeared in `session_list`, its transcript was readable by id, and it was billed inside the parent's report; a session outside the tree stayed refused (unit tests cover the sibling case) |
| `session.scope: "owned"` ownership survives a plugin restart via `$DSH_HOME/dsh-as-mcp/owned.json` | 0.30.1 | created a session under `owned`, restarted the instance, and the same id was still visible and promptable while a foreign id stayed refused; a corrupt record hid it (fail-closed) |
| `session.scope: "owned"` confines session tools to sessions the endpoint created: prompt works on an owned session, foreign ids are refused by prompt/messages/usage/queue, `session_list` returns only the owned session, `session_usage` notes the rows it left out, and search reports `hidden` | 0.30.0 | live profile with `scope: owned`: owned prompt replied `SCOPED OK`; four foreign calls refused citing the setting; `session_list` total 1 of hundreds; `usage all` rows 0 + the note; `session_search Reply` returned 0 matches with `hidden: 20`; acceptance 142/142 under this scope |
| Pending queue listing and mutation: `session_queue` list / `remove` / `edit` (id preserved) / `steer` | 0.29.0 | queued prompts listed with ids; removed one never ran; steered text reached the running turn and the assistant replied `STEERED-ACCEPTED` |

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
## Not verified here

These are gaps in *evidence*, not known defects:

| Item | Why | What it would take |
| --- | --- | --- |
| Subagent accounting inside the **desktop composition** | the running desktop app is older than the current build, and restarting it is the user's action; the web composition has now been verified (see the matrix) | install the current tarball in the desktop profile, restart DSH, run one agent-team turn, compare `session_usage` with the per-session log |
| Desktop-composition acceptance run | same restart dependency | run `scripts/exercise.mjs` against the desktop profile's endpoint |
| Panel/visual rendering (widgets, slots, settings page layout) | the `ifc-view` MCP server used for visual inspection was disconnected in this session | reconnect `ifc-view`, or inspect the panel by hand |
| `session_usage` money figures match the cost plugin's own numbers **exactly** | the pass-through is unit-tested against a stub `costMeter` service, but a real reconciliation needs the third-party `dsh-cost-meter` mounted in a throwaway profile. An attempt on 0.52.7 failed before the check could run: copying the plugin out of the desktop profile (the only install on this machine) leaves its hoisted dependencies behind, so its import died with `Cannot find package 'acorn'`. The desktop profile itself cannot host the check because its running build is older than the current plugin | install `dsh-cost-meter` from its registry into a throwaway profile (so its dependency tree resolves), run one turn, and compare `session_usage` money with the plugin's ledger for that session |
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
