# Security audit — `packages/dsh-as-mcp`

Adversarial review of the DSH plugin that exposes a running DeepSeek Harness instance as an
MCP server. Written to find real vulnerabilities, not to confirm the design.

## Snapshot and method

| Fact | Value |
| --- | --- |
| Audited revision | `6105534` ("fix: shell_run on 0.1.7-rc.2, and stop handing the token to the logger"), working tree clean |
| Source hashes | `src/index.ts` `7c51aff5…`, `src/mcp/http.ts` `7bed0509…`, `src/mcp/token.ts` `d8461499…`, `src/mcp/tools.ts` `04f879a4…`, `src/dsh/driver.ts` `e725342f…`, `src/settings.ts` `aa15739e…` |
| Harness under audit | `/Users/xiseliuli/test_code/dsh-harness-015` (0.1.5-rc.1) |
| Deployed artifact | `~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/lib/index.js` `1cbe2c21…` — **older than HEAD**, does not contain `maskToken` |
| Live instance | `DSH Desktop` PID 46317, cwd `/Users/xiseliuli`, listeners `127.0.0.1:8790` (plugin) and `127.0.0.1:43120` (DSH web) |

Method: source review of the plugin and of every harness seam it touches, plus read-only probes of
the live endpoint (`initialize`, `tools/list`, `dsh_info`, `workspace_list`, oversized-body test,
`/api` fence test). No workspace or session was created, no file was written, no command was run,
no prompt was sent. Claims below are marked **verified** (read in source, or observed live) or
**inferred** (reasoned from source without executing the attack).

## Verdict

The authentication design is sound and the obvious holes are closed: bearer-only admission with a
256-bit generated token, a constant-time comparison, no token in any response or client payload, the
status route placed inside DSH's `/api` Host/Origin + browser-cookie fence, and a 4 MiB request-body
cap enforced by the SDK. Nothing in the plugin grants a caller more *authority* than the harness
itself would grant a human at the same machine — it never writes policy, never escalates a
sandbox mode, and never touches `ctx.approval` except to answer requests from sessions it created.
What the audit did find is that the plugin's own `file_*`/`shell_run` tools resolve the **agentless**
deployment policy rather than any session's, and that they perform two mutations by calling
`node:fs` directly *before* the sandbox is consulted — so the effective boundary is "whatever the
DSH process's own uid can reach, under the deployment default mode, with the process cwd as the
workspace root", which on this deployment is the user's entire home directory. Adding
`session_create {cwd}` / `workspace_create {path}`, which are unvalidated, a remote caller chooses
its own containment root, and a session created that way inherits `permission.defaultPreset`
(`danger-full-access` on this machine). Two findings are genuine source defects (High); the rest are
one fixed-in-HEAD credential-leak that is still live in the deployed build, an unbounded-wait DoS,
and instance-wide session access, which the README now documents honestly. **Nothing lets a caller
exceed DSH's own permission model** — but on a `workspace-write` deployment the model's boundary is
not the workspace a user would assume, and the plugin is what makes that reachable remotely.

---

## Findings

### F1 — `file_write` / `workspace_create` create directories with `node:fs`, before and outside the sandbox policy (High)

**What it is.** Both tools call `mkdir` from `node:fs/promises` on a caller-supplied path *before*
`ctx.fs` is consulted. Directory creation therefore never passes through `SandboxedFileSystem`'s
policy check, and the path is resolved with pure lexical `path.resolve`, not canonicalized.

**Evidence.**
- `src/dsh/driver.ts:2` imports `mkdir` from `node:fs/promises`; `:3` imports `resolve as resolveAbsolute` from `node:path`.
- `src/dsh/driver.ts:595-602` — `writeFile` with `createDirectories` (the tool default, `tools.ts:316-319`, `:327`):
  ```ts
  const absolute = isAbsolute(request.path) ? request.path : resolveAbsolute(request.cwd ?? process.cwd(), request.path)
  const parent = resolveAbsolute(absolute, '..')
  await mkdir(parent, { recursive: true })
  ```
  This runs before `fs.resolve`/`fs.writeText` on `:603-606`.
- `src/dsh/driver.ts:289-294` — `createWorkspace` mkdirs the caller's path before `registry.resolveByPath`/`create` (`:298`, `:314`).
- Harness: `fs-sandbox/src/index.ts:80-88` fences `writeText` by `checkedTarget` **before** delegating; `:122-146` shows `read-only` throws `FS_SANDBOX_DENIED` and `workspace-write` requires containment of the freshly canonicalized path. `sandbox-policy/src/index.ts:112` makes `read-only` the default mode when nothing configures one, and `:166` resolves `mode = request.mode ?? session override ?? defaultMode`.
- The seam already creates parents *inside* the fence, so the pre-mkdir is not needed for its stated purpose: `fs-local/src/fsio.ts:580-581` (`writeFileAtomic` does `await mkdir(dirname(absolutePath), { recursive: true })`).

**Concrete failure.**
1. *Mode bypass.* On any deployment whose effective mode is `read-only` (the harness's fail-safe
   default, e.g. a CLI profile with no `sandbox-policy.mode`), `file_write {path:"~/x/y/z.txt",
   createDirectories:true}` creates `~/x/y` even though every write the harness permits is refused.
   **Verified** at source level; the same call under `danger-full-access` is unremarkable.
2. *Containment/symlink bypass.* `~/link → /some/other/root` (any directory, including one outside the
   `workspace-write` root) plus `file_write {path:"~/link/newdir/f.txt", createDirectories:true}` makes
   `mkdir` follow the symlink and create `newdir` under `/some/other/root`; only afterwards does
   `fs.resolve` + `checkedTarget` refuse the *file* write. The directory, however, exists. **Inferred**
   (lexical `path.resolve` + recursive `mkdir` follow intermediate symlinks; not executed — this audit
   wrote nothing). The same shape lets `workspace_create` create trees outside every registered root.

**Class.** Source defect. The in-code justification at `driver.ts:290-292` ("the one place the driver
touches node:fs") is accurate but understates the consequence: it is the only *mutation* the plugin
performs that bypasses the harness's mode and containment checks entirely.

**Fix.** Delete both `mkdir` calls. `writeFileAtomic` already creates parents inside the fence
(`fsio.ts:580-581`), so `createDirectories` needs no code at all under a write mode; under `read-only`
the correct outcome is refusal. For `createWorkspace`, ask the registry to create the directory (or add
an explicit policy-checked `mkdir` to the fs seam) instead of falling back to `node:fs`. If a
pre-flight directory check is wanted, use `ctx.fs.resolve` + `ctx.fs.stat` and report a clear error.

### F2 — The caller chooses the agent's containment root, and a created session inherits the deployment's default permission preset (High)

**What it is.** `session_create` accepts an arbitrary `cwd` — absolutized, never checked for existence
and never checked for containment — and `workspace_create` registers an arbitrary path. Because
`sandboxPolicy.resolve({ session })` uses `session.header.cwd` as `workspaceRoot`, the caller picks the
root that bounds the agent it is about to drive. New sessions then take
`permission.defaultPreset` from user settings with no interactive acknowledgement.

**Evidence.**
- `src/dsh/driver.ts:364` (`cwd = resolveAbsolute(request.cwd)`), `:365-367` (only "not both"), `:380-383` (`controller.create({ cwd })`), `:384` (`ownedSessions.add`).
- `src/mcp/tools.ts:186-192` — the `session_create` schema constrains nothing (`z.string().optional()`).
- Harness: `sandbox-policy/src/index.ts:166` — `workspaceRoot` comes from the session header; `session-controller` `create` adopts the given `cwd` (no existence check — contrast `workspace/src/index.ts`, which realpaths and requires `isDirectory`).
- `permission-presets/src/index.ts:199-204` applies `config.defaultPreset` at construction; the `permissions` projection states a genuinely fresh session uses the current user default.
- This machine: `~/.dsh/settings.yaml` has `permission: defaultPreset: danger-full-access`; the Desktop
  preset table maps that to sandbox `danger-full-access` + approval `never`. The risk acknowledgement
  for that preset exists only in the browser UI (`client-ui-permission-presets`, `RiskConfirmation` —
  a client-side dialog), so no host control is bypassed; there is simply nothing to bypass when the
  *default* is the widest preset.

**Concrete failure.** `session_create {cwd: "/"}` then `session_prompt {sessionId, prompt: "…"}` yields
an agent whose file and shell tools are fenced to `/` with approvals set to `never`, driven entirely by
the remote caller, on a deployment an operator would describe as `workspace-write`. Similarly
`workspace_create {path: "/"}` registers the filesystem root as a project in the user's UI.
**Verified** at the level of every seam involved (the cwd is adopted verbatim; the policy root derives
from it; the preset is the user default); the end-to-end prompt was **not** executed.

**Class.** Source defect for the missing validation; design trade-off for "exposing `cwd` at all"
(a session has to start somewhere) and for the deployment's own `danger-full-access` default.

**Fix.** Validate `cwd`/`path` the way the registry does (`realpath` + `isDirectory`) and reject
nonexistent or non-directory paths up front. Add a `session.allowedRoots` (or reuse a workspace
allowlist) and refuse any `cwd` outside it; default it to the DSH process cwd so behavior is unchanged
for the common case. Consider refusing `cwd`/`path` values that are filesystem roots. Document in
`dsh_info` what preset a created session will receive.

### F3 — The bearer token was passed to `log.info` on every boot (Medium; fixed at HEAD, still live in the deployed build)

**What it is.** The endpoint-announcement line logged the literal token. Committed at HEAD
`6105534`; the installed artifact and the running process predate it.

**Evidence.**
- Before: `HEAD~1:src/index.ts:235-236` — `'… "Authorization: Bearer %s"', listener.url, token.token`.
- After: `src/index.ts:234-242` logs `maskToken(token.token)` plus a pointer to the source; `src/mcp/token.ts:79-83` implements the fingerprint (`abcd…(43 chars)`).
- The other line, `src/index.ts:191-194`, was never a leak: its `%s` argument is `'generated at <file>'` or `'from <source>'` (`:193`), verified by reading it; the label is merely misleading.
- Deployed: `~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/lib/index.js:1523` still substitutes the source description, and the file contains **no** `maskToken` (`grep -c maskToken` → `0`); the process listening on `:8790` started before the fix.
- Why the literal is nonetheless absent from disk today: DSH Desktop's Electron log pipeline applies
  `maskSecrets` (`/lib/mask-secrets-*.js` inside `app.asar`: mask `"****"`, `/\bBearer\s+[A-Za-z0-9._-]+/giu`,
  `/\b[a-zA-Z0-9]{32,}\b/gu`, plus named-secret patterns) — desktop-only. Verified: `maskSecrets("bearer token from file")`
  → `"bearer **** from file"`. The harness source contains no masking (`grep -l maskSecrets` over the
  extracted app matches only Electron's own libs), and the plugin's `loggerOf` falls back to `console.*`
  when `ctx.logger` is absent (`src/dsh/types.ts`), so a CLI/`dsh web`/tarball host writes the token to
  stdout or the journal.
- Empirical hygiene check on the live install: `grep -rlF "$TOKEN"` over
  `~/Library/Application Support/DSH Desktop/logs/`, `~/.dsh/sessions/` and `~/.dsh/` matched only
  `~/.dsh/dsh-as-mcp/token` itself.

**Concrete failure.** Any user who can read DSH's logs (wider than the token file's 0600, e.g. a shared
journal, a support bundle, a log-shipping agent) obtains a credential that controls shell execution as
the account — the same blast radius as F4/F6.

**Class.** Source defect (fixed). Residual risk is deployment lag, not code.

**Fix.** Already at HEAD. Rebuild the plugin, reinstall into `~/.dsh/profiles/desktop/node_modules/`,
and restart DSH Desktop so the running listener matches; until then the deployed endpoint still hands
the raw token to the logger and relies on Electron's masking.

### F4 — The bridge is instance-wide: it can read and steer the operator's own live sessions (Medium, documented trade-off)

**What it is.** `session_list`, `session_messages`, `session_prompt` and `session_cancel` address any
session id in the instance. `ownedSessions` is consulted only by the approval answerer, never to scope
these tools. `session_prompt` with `mode: 'steer'` delivers into an already-running turn.

**Evidence.**
- `src/dsh/driver.ts:422-433` (`controller.list({}, signal)` — every visible session), `:504-522` (whole transcript of any id), `:442-496` (`promptSession` of any id; `steer` at `:460`), `:499-501` (`cancelSession`).
- `src/mcp/tools.ts:204-215`, `:256-281`.
- `src/dsh/driver.ts:156`, `:178-180` — `ownedSessions`/`ownsSession`, read only at `src/index.ts:266`.
- README `packages/dsh-as-mcp/README.md:139-144` states this explicitly and correctly.

**Concrete failure.** A token holder calls `session_list` and finds the session the user is currently
typing into, reads its transcript (`session_messages`), and injects a prompt into the live turn
(`session_prompt {mode:'steer'}`) — prompt-injecting the user's own agent, which may hold a wider
policy than the plugin's own tools. This is not an escalation beyond the controller API (the same
bytes are in `$DSH_HOME/sessions`, reachable via `shell_run`, as the README notes), but it is the
plugin's own doing that the plugin does not narrow it.

**Class.** Design trade-off, documented. Worth a mitigation because the consequence is "a calling agent
can direct the human's agent".

**Fix.** Add `session.scope: 'owned' | 'instance'` (default `owned` for `prompt`/`cancel`, `instance`
only when explicitly enabled) and make `session_prompt` on a non-owned session require an explicit opt-in.
At minimum, have `dsh_info` name this property (it currently only says "work appears live in the DSH UI").

### F5 — Unbounded `timeoutMs` plus a whole-log replay every 200 ms (Medium)

**What it is.** `session_prompt.timeoutMs` has no upper bound, and the settle-wait re-reads and
re-validates the entire session log every 200 ms per waiting caller. There is no cap on concurrent
requests or waits.

**Evidence.**
- `src/mcp/tools.ts:238-243` — `z.number().int().positive().optional()`, no `.max()`; default from `src/defaults.ts` (`promptTimeoutMs: 900000`).
- `src/dsh/driver.ts:467-494` — `deadline = Date.now() + timeoutMs`, then `for(;;)` with `await this.readEvents(...)` and `await delay(TURN_POLL_INTERVAL_MS)` (`TURN_POLL_INTERVAL_MS = 200`).
- `src/dsh/driver.ts:530-538` — `readEvents` → `sessionQuery.readSession(sessionId)`; the harness's `readSession` loads the corpus, replays a full `Session.create` validation, `structuredClone`s the header and snapshots every event, so each poll is O(log length), not incremental.
- `src/dsh/driver.ts:541-553` — `enqueueTurn` serializes per session only; N sessions → N loops.
- Contrast: `shell_run.timeoutMs` is unbounded in the schema (`tools.ts:361`) but the executor clamps it (`bash-local`: `maxTimeoutMs: 600_000`), and `file_read` is bounded by `maxReadBytes` (`driver.ts:577`).

**Concrete failure.** A token holder issues `session_prompt {sessionId, prompt, wait:true,
timeoutMs: 1e15}` against several sessions (or one long-lived session) and leaves the HTTP requests
open: each waiter replays and deep-clones the whole event log five times a second indefinitely, burning
CPU and allocation on the user's machine until the DSH process is restarted. A handful of callers is
enough on a long session. **Inferred** (the per-call cost is verified in harness source; the aggregate
load was not measured).

**Class.** Source defect (missing bound) plus an architectural cost that is a design choice.

**Fix.** Cap the schema (`.max(getConfig().session.promptTimeoutMs)` or a new `limits.maxPromptTimeoutMs`),
bound concurrent waits, and replace polling with an event subscription (`session/events`, `turn/end`) or a
cheap incremental reader instead of re-running `readSession` from scratch.

### F6 — `tokenMatches` returns true when both tokens are empty (Low)

**What it is.** The comparison has no empty-expected guard. `"".length === "".length` and the XOR loop
runs zero times, so an empty expected token admits an empty presentation (`?token=`). The only thing
preventing this from being an open endpoint is `resolveToken`'s non-empty invariant three modules away.

**Evidence.**
- `src/mcp/token.ts:86-94` — no `expected === ''` branch.
- Evaluated against the compiled artifact (`lib/index.js:1085-1091`): `tokenMatches("", "")` → **`true`** (verified by executing the function); `tokenMatches("", undefined)` → `false`; `tokenMatches("abc", "")` → `false`.
- `src/mcp/token.ts:41-65` — every return path of `resolveToken` yields a non-empty token (configured non-empty, file non-empty, 32 random bytes, or the same random bytes as `ephemeral`), and `src/index.ts:93-99` only ever returns a pinned token through `optional()` (which trims empty to `undefined`) or `fallbackToken`. So the empty case is currently unreachable.
- `tests/live-config.test.ts:151-162` asserts the right outcome ("an empty expected token must never mean admit everything") but passes because the *file* token is still the expectation, not because `''` is rejected — the comment describes a property the unit does not implement.

**Concrete failure.** None today. It becomes an unauthenticated endpoint the day any code path returns
`''` as the effective token (e.g. a future "explicitly disabled" state or a config-pinned empty value),
and the existing test would not catch it. **Verified** unreachable at this revision.

**Class.** Source defect (latent), hardening.

**Fix.** `if (expected === '') return false` as the first line of `tokenMatches`, plus a direct unit test
against it rather than only through the endpoint.

### F7 — `reconcile()` is not serialized and does not re-check disposal after its awaits (Low)

**What it is.** `reconcile` records the new signature, then awaits `previous.dispose()` and
`startListener(...)` before assigning `listener`. Two overlapping reconciles, or a dispose racing a
reconcile, can each assign a listener after the other's teardown, leaving a stale port and a leaked
bound server.

**Evidence.**
- `src/index.ts:146-184` — `boundSignature` set at `:150`; `listener = undefined` at `:155`; `await previous?.dispose()` at `:156`; `listener = await startListener(...)` at `:160`; `unmountFromWebServer` handled at `:152-153` and `:176`.
- `src/index.ts:79-81` — every settings change fires `void reconcile()`, so rapid saves overlap by construction.
- `src/index.ts:245-254` — dispose reads `listener` once (`:250`), sets it to `undefined` (`:251`) and awaits only that handle; a reconcile that assigns a new listener after line 251 leaks it, and `requestHandler.close()` follows regardless.
- Harness `webserver/src/index.ts:242-254` shows the normal port-release path this would sidestep.

**Concrete failure.** Two quick setting saves can leave the endpoint bound on the *previous* port while
`status()` reports the new one (a later save then fails with `EADDRINUSE`), and unloading/removing the
plugin row while a reconcile is mid-flight can leave a live listener on `:8790` that outlives the
plugin — the operator's "turn it off" does not take effect. Requests on a leaked listener after
`requestHandler.close()` fail rather than being served, so this is availability and lifecycle
correctness, not exposure. **Inferred** from the interleaving; not raced in practice.

**Class.** Source defect (lifecycle race).

**Fix.** Serialize reconciles through a promise chain (or a generation counter that late completions
check), and after every `await` inside `reconcile` re-read `disposed` and dispose anything started after
it. Have the dispose path await the in-flight reconcile rather than sampling `listener`.

### F8 — The plugin's own listener drops the handler promise without a catch (Low)

**What it is.** `startListener` invokes the async guard with `void handler(req, res)`; a rejection is
unhandled. DSH treats an unhandled rejection as fatal, so an escaping rejection exits the host process
rather than failing one request. The harness's own web server catches the same call and answers 400.

**Evidence.**
- `src/mcp/http.ts:117-124` — `void handler(req, res)`.
- Harness `host/webserver/src/index.ts:242-254` — `void handle(req, res).catch(err => { log; res.writeHead(400); res.end() })`, described in its own comment as "never a process exit".
- `boot/app-boot/src/index.ts:645-678` — the installed `unhandledRejection` handler writes `fatal load failure` and calls `proc.exit(1)` after release, for any rejection not in `assembledActivationRejections`.
- The pre-auth path is synchronous and exception-safe: `deny` (`http.ts:37-46`) only writes headers, and
  `getConfig()` cannot throw because `settings.ts:227-238` wraps the settings reader in `try/catch` and
  falls back to the composition entry. The post-auth path delegates to `toNodeHandler`, whose own error
  handling covers parsing and dispatch; only its response-writing tail (`lib`'s `toNodeHandler`) sits
  outside that try. **No reachable trigger was found.**

**Concrete failure.** None demonstrated. The pattern is unsafe for a long-lived listener in a host whose
rejection policy is "exit", and the fix is the harness's own.

**Class.** Hardening.

**Fix.** `handler(req, res).catch((error) => { log.error(...); if (!res.headersSent) deny(res, 500, 'internal error') })`.

---

## Hardening notes (no exploit path found)

- **A user-pinned token has no minimum entropy.** `config.ts:266-267` accepts `auth.token` as any string;
  `config.ts:257-260` validates `http.port` but nothing validates the token. `auth.token: "x"` plus the
  documented `http.host: 0.0.0.0` option is a one-character secret in front of `shell_run`. Consider
  requiring ≥16 characters (or a matching generated token) and warning loudly, and refusing a
  non-loopback `host` with a weak token.
- **No rate limiting or lockout on failed authentication.** Cheap and non-reflective, and a generated
  43-character base64url token is not guessable, so this only matters for pinned low-entropy tokens.
- **The stdio bridge will send the persisted token to any configured URL.** `bin/mcp-stdio.mjs:47-48`
  takes `DSH_AS_MCP_URL` verbatim and, when `DSH_AS_MCP_TOKEN` is unset, reads the loopback token file;
  `:92` attaches it. A copied or generated MCP client config with an off-host URL silently exfiltrates
  the token. Refuse a non-loopback URL when the token came from the file (require the env var to be set
  explicitly for a remote endpoint).
- **Token directory mode.** `token.ts:56` creates `~/.dsh/dsh-as-mcp` with `mkdirSync` defaults, so it is
  0755 (`drwxr-xr-x`, verified live) while the token file itself is 0600. Pass `mode: 0o700`.
- **The token file is trusted as-is.** `token.ts:47-49` follows whatever is at that path (symlink,
  foreign owner, group-readable). Harmless with the default 0700 `$DSH_HOME`, worth an `lstat`
  regular-file + uid check when `DSH_HOME` points into a shared or container-mounted path.
- **`?token=` puts the credential in request URLs** (`http.ts:48-54`), which land in proxy logs and shell
  history. It is documented as a fallback (`README.md:47-50`); it exists for header-less clients only.
- **`scripts/smoke.mjs` / `scripts/exercise.mjs` accept `--token <value>`**, visible in `ps` to any local
  user. Development-only, but they are the documented acceptance path.
- **`dsh_info` discloses the absolute token-file path** (`src/mcp/tools.ts:124`, e.g.
  `~/.dsh/dsh-as-mcp/token`; confirmed live). Only useful to someone who already holds the token, so it
  is a convenience for persistence rather than a disclosure.
- **`mountOnWebServer: true` is unreachable for ordinary clients on DSH Desktop.** An exact route is
  registered through `DesktopWebServer.register`, which wraps every route in `permits()`; with ordinary
  browser access disabled, any request lacking the renderer header gets 403 before the plugin's bearer
  check. Verified live: `/`, `/definitely-not-a-route`, `/api/dsh-as-mcp/status` and `/api/nope` all
  return 403 to curl on `:43120`. No hole — but the option silently does not work for a non-Electron MCP
  client, which the README does not say.

---

## Verified safe

- **Admission.** Every request is bearer-checked before dispatch (`http.ts:91-98`), including requests on
  the mounted route; failures are a fixed non-reflective body (`http.ts:37-46`, verified: `401 unauthorized`,
  `404 not found` for any other path). Live: no token → 401, wrong token → 401, `/other` → 404.
- **Token quality and comparison.** 32 CSPRNG bytes, base64url, 43 characters (`token.ts:54`); file
  written 0600 (`token.ts:57`, mode verified live); comparison is length-gated then XOR-accumulated
  (`token.ts:86-94`), so a wrong token reveals only that its length differs. Rotation via the settings
  panel takes effect on the next request (`index.ts:93-99`; `tests/live-config.test.ts:133-149`).
- **No token ever leaves the host in a payload.** `dsh_info` omits it by construction and by test
  (`tools.ts:118-124`; `tests/mcp-endpoint.test.ts`); the client half reads a redacted `describe()` mirror
  and never receives the value; `bin/mcp-stdio.mjs:158` prints `Token: set`, not the value.
- **Request-body bound.** The SDK caps bodies at 4 MiB by declared `Content-Length` *and* by streamed byte
  count. Verified live: a 5.4 MB body with a valid token returns `413` and
  `{"code":-32000,"message":"Payload Too Large: Request body must not exceed 4194304 bytes"}`, both with
  `Content-Length` and chunked. Error bodies do not echo the request id.
- **The status route is inside DSH's fence.** `connection.fetch.register` routes dispatch only through the
  `/api` prefix handler, whose `requestRejection` runs before route lookup
  (`client/connection/src/index.ts:124-140`, `rpc-host.ts:97`, `:169`). Verified live: anonymous GET
  returns 403 both with a loopback `Host` and with `Host: evil.example` (DNS-rebinding shape) and with
  cross-site markers; the same 403 comes back for an unregistered `/api` path, so the fence precedes
  dispatch. On Desktop it is additionally wrapped by the browser-access gate.
- **No CSRF/DNS-rebinding exposure on the plugin's own listener.** That listener is not browser-facing:
  authentication is a header (or query parameter) that a cross-origin page cannot set or read, no
  cookies are accepted, and responses carry no CORS headers. The mounted route has no Origin check of its
  own (`http.ts:232-246`) but sits behind the same bearer requirement, so the token remains the only gate
  — as the README says.
- **Approval answering cannot widen a session's policy.** The answerer returns `'allowed-once'` only when
  the policy is `allow` *and* `ownsSession(sessionId)`; otherwise it calls `next()`
  (`index.ts:260-272`). Where a session's own policy is `never`, the harness resolves `'rejected'` before
  the waterfall ever runs (`interaction/user-approval/src/index.ts:56-60`, `:131-144`), so
  `approval.policy: allow` is inert there — it cannot override a `never`, and it never touches a session
  the plugin did not create (`tests/apply.test.ts:387-435`).
- **`shell_run` cannot inject options or argv.** The command is passed as a single `command` string to the
  executor and `cwd` becomes the spawn `cwd`, not an argument (`driver.ts:653-658`; harness
  `shell/bash-local/src/index.ts:158`, `:180-198` — `argv` is built by the executor, not concatenated).
  Timeouts are clamped by the executor.
- **The caller's shell does not inherit the harness's credentials.** `shell_run` passes no `env`/`dshEnv`,
  and the subprocess service spawns children from `scrubbedParentEnv()`, which drops every name matching
  `/KEY|PASSWORD|SECRET|TOKEN/i` and every `DSH_*` (`subprocess/subprocess/src/index.ts:53`, `:64-81`).
  (The harness's *own* bash tool deliberately forwards an explicit `dshEnv` snapshot —
  `shell/tool-bash/src/index.ts:340-345` — so the plugin's tool is narrower here, not wider.)
- **Reads are bounded.** `file_read` requests `maxBytes + 1` through the windowed read and slices
  (`driver.ts:572-584`), so one call cannot allocate an unbounded buffer; `maxReadBytes` defaults to 1 MiB
  and is live-reconfigurable (`tests/live-config.test.ts:109-131`).
- **The plugin never writes policy.** It does not call `sandboxPolicy`, does not call approval `decide`,
  does not set env, and its only config write surface is its own settings namespace with strict
  unknown-key rejection and re-validation (`config.ts:253-315`, `settings.ts:221-238`).
- **Port release on unload.** `tests/apply.test.ts:437-453` and `tests/mcp-endpoint.test.ts:145-160`
  cover the ordinary dispose path (F7 covers the racy one).
- **Deployed token hygiene.** `~/.dsh` is 0700, the token file 0600, and `grep -rlF` over Desktop logs,
  sessions and `~/.dsh` found the literal only in the token file.

## Documented trade-offs (not findings)

- **The token is the whole boundary and the boundary is the user account.** With the token, `file_read`
  reaches anything the process can read — including `~/.dsh/.credentials.yaml` (present, 0600, 774 bytes),
  i.e. the user's stored provider credentials — and `shell_run` runs arbitrary commands as that user. The
  plugin's README states this explicitly (`README.md:131-150`) and this audit confirms the mechanism:
  `fs-sandbox` permits reads in every mode and `checkedTarget` only fences mutations.
- **`tools.*` toggles are discovery filters, not containment** (`README.md:145-150`). Confirmed: with
  `tools.shell: false` the `file_*` tools still write anywhere the deployment mode permits (F1/F6).
- **`approval.policy: allow` is a deliberate widening** of what a plugin-created session may execute
  unattended (`README.md:151-158`), and it is inert on a deployment whose preset is `danger-full-access`
  with `approval: never` — which is this machine's configuration.
- **`http.host: 0.0.0.0`** exposes the same power to the network behind whatever gateway the operator
  provides (`README.md:124-130`). Not tested; not a defect.

## Could not verify

- The direct symlink-escape variant of F1 (F1.2) and the end-to-end F2 chain were not executed: this audit
  was restricted to read-only actions. Both are inferred from source with the cited harness code.
- The aggregate CPU cost of F5 was not measured against a long session; only the per-call cost of
  `sessionQuery.readSession` was established from source.
- F7's race was not induced; the conclusion is from interleaving analysis, not observation.
- No trigger for F8's unhandled rejection was found, so its severity rests on the host's fatal policy.
- The Desktop browser-access gate's "ordinary browser enabled" branch was not observed (this machine has
  it disabled); the claim that a mounted route then reaches the plugin's bearer check is from source.
- Behavior under `DSH_PERMISSION_MODE` overrides and on non-macOS hosts was not exercised.
