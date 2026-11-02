# Changelog

All notable changes to `dsh-as-mcp`, newest first. Versions follow SemVer; the
plugin is pre-1.0, so a minor bump is a feature and a patch is a fix or docs.

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
