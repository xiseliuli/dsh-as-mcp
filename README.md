# dsh-as-mcp

English | [中文](README.zh.md)

Expose a running **DeepSeek Harness** as an **MCP server**, so any other agent — Claude
Code, Codex, another DSH, a CI job, your own script — can drive it: create workspaces,
start sessions, hand the DSH agent a coding task, read and write files, run commands.

The endpoint runs *inside* the DSH host process, so a session created over MCP is a real
DSH session. It appears live in the DSH UI, runs inside the DSH sandbox, and is subject to
the same permission policy as anything you type yourself. Nothing about the agent is
reimplemented.

---

## Install

Three channels install this bundle into a profile; pick whichever matches where you got the
package from.

**From npm:**

```bash
dsh plugin --profile <name> add dsh-as-mcp
```

From a source checkout, the equivalent is `pnpm dsh plugin --profile <name> add dsh-as-mcp`.

**From GitHub:**

```bash
dsh plugin --profile <name> add github:xiseliuli/dsh-as-mcp
```

A git install fetches source, not the built `lib/`, so pnpm must run this package's `prepare`
script (`tsdown && node scripts/build-client.mjs`) to produce it. pnpm ≥10 refuses to run that
script — and the `esbuild` postinstall the build depends on — until the profile allows them, so
the first `add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`.

A bare package name in `allowBuilds` works for `esbuild` (a registry dependency) but never for
`dsh-as-mcp` here: pnpm only approves a git-hosted build by its exact resolved key, never by
name alone ([pnpm docs](https://pnpm.io/settings/build#allowbuilds)). The failed `add` prints
that exact key in its error; copy it verbatim into the profile's `pnpm-workspace.yaml`
(`~/.dsh/profiles/<name>/pnpm-workspace.yaml`) and re-run the `add`. Don't rely on pnpm having
written a placeholder entry for you — on this failure path it does not. The result looks like:

```yaml
allowBuilds:
  '<the exact git spec pnpm wrote, including its commit hash>': true
  esbuild: true
```

Treat that allowance as permission to run this package's code on your machine at install time;
pin a commit (`github:xiseliuli/dsh-as-mcp#<sha>`) so a later push cannot silently change what runs.
`dsh plugin add` runs the pnpm version DSH pins (v11.7.0 as of DSH 0.1.7-rc.2 — its output ends
with `using pnpm v…`), so the following applies only once DSH ships a newer pnpm. If the
profile's pnpm is ≥11.19.0 (≥11.11.0 for a cloned, non-`github:` git dependency), you can instead
approve the repository itself — `'dsh-as-mcp@git+https://github.com/xiseliuli/dsh-as-mcp.git': true`, with
no `#<sha>` — so a later commit on the same repo keeps building without re-approval; on an older
pnpm the exact-commit key is your only option and needs re-approving after every update
([pnpm 11.11 release notes](https://pnpm.io/blog/releases/11.11-11.14),
[pnpm/pnpm#12367](https://github.com/pnpm/pnpm/issues/12367)).

**From a tarball:**

```bash
pnpm pack
dsh plugin --profile <name> add /abs/path/to/dsh-as-mcp-<version>.tgz
```

Reinstalling from the *same* tarball path silently keeps the previous build — see the warning
under "Installing into DSH Desktop" below for why, and give each rebuild a unique filename.

---

`dsh plugin add` records the package in the profile's `dsh.profile.bundles`, and the
bundle's `cordis.patch.yml` supplies the plugin row and its defaults. **Restart DSH
afterwards**: bundle patches are read at boot, not hot-reloaded.

Confirm the layer composed:

```bash
dsh --profile <name> --dump-config | grep -A 30 '# == dsh-as-mcp'
```

**For publishers:** tag the GitHub repository with the topic `dsh-plugin` — that is what plugin
discovery keys on — and keep npm's `latest` dist-tag pointed at an exact, stable version (no
prerelease, no range), since that is what `dsh plugin add dsh-as-mcp` resolves.

## Connect a client

Every request needs a bearer token. It is resolved in this order:

1. `auth.token` in the plugin config;
2. `$DSH_HOME/dsh-as-mcp/token`;
3. otherwise generated and persisted there on first run, with mode `0600`.

The default endpoint is `http://127.0.0.1:8790/mcp`.

A client that cannot set a header may pass `?token=<token>` instead. Prefer the header: a
credential in a URL is one your shell history, a reverse proxy's access log, or a browser's
history may keep. DSH itself does not log query strings (`webserver/src/index.ts:224`) and the
plugin does not log the token, so this is a habit worth keeping rather than a leak this code
introduces.

**HTTP-capable client** (Streamable HTTP):

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8790/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**stdio-only client** — use the bundled bridge, which forwards each JSON-RPC message to the
endpoint over HTTP:

```json
{
  "mcpServers": {
    "dsh": {
      "command": "npx",
      "args": ["-y", "dsh-as-mcp"],
      "env": { "DSH_AS_MCP_TOKEN": "<token>" }
    }
  }
}
```

`dsh-as-mcp --help` prints the endpoint and token state it will use. The bridge sends a token
read from the token file to loopback endpoints only; pointing `DSH_AS_MCP_URL` off-host requires
setting `DSH_AS_MCP_TOKEN` explicitly, so a copied client config cannot quietly exfiltrate the
machine-local credential. "Loopback" means an exact match — `localhost`, `::1`, or a literal
`127.x.x.x` address — so a name such as `127.0.0.1.example.com` is treated as the remote host it
is. A scheme is optional: `127.0.0.1:8790/mcp` is accepted and understood.

Start with **`dsh_info`**. It reports the endpoint, where its token comes from, which tool groups are enabled,
and — importantly — which harness services the current profile actually provides, so a client
can tell "this profile has no shell" from "the command failed".

## Tools

| Tool | What it does |
| --- | --- |
| `dsh_info` | Endpoint, token source, enabled groups, available harness services. |
| `workspace_create` | Register a directory as a DSH workspace (creating it if needed). |
| `workspace_list` | Every registered workspace with id, path, title, session count, directory status. |
| `session_create` | Start a DSH agent session bound to a workspace or bare directory. |
| `session_list` | Live session summaries, most recently updated first. |
| `session_prompt` | Send one task to a DSH session; by default waits for the turn and returns the reply plus every tool call the agent made. |
| `session_messages` | Read a session's user/assistant transcript. |
| `session_cancel` | Ask the agent to stop its current turn. |
| `file_read` | Read a UTF-8 file through DSH's filesystem service. |
| `file_write` | Create or replace a file through DSH's filesystem service. |
| `file_list` | List a directory through DSH's filesystem service. |
| `shell_run` | Run one command through DSH's shell service. |
| `dsh_tool_list` | The agent tools this endpoint permits, with the schema DSH's own agent sees. |
| `dsh_tool_call` | Run one of them directly, through the same pipeline the agent uses. |

The typical coding flow:

```
workspace_create { path: "/Users/me/project" }
  -> session_create { workspaceId: "..." }
  -> session_prompt { sessionId: "...", prompt: "Add a --verbose flag to the CLI and a test for it." }
```

`session_prompt` is how you get work done *by* DSH: the DSH agent plans, edits files, runs
its own tools, and can spawn subagents. `file_*` and `shell_run` are for when you want to do
something yourself without involving the agent.

`dsh_tool_call` is the third option: it runs one of DSH's *own* tools without spending a model
turn to decide to call it. Call `dsh_tool_list` first — it reports exactly what is permitted, and
a name it does not report is refused. Both require a `sessionId`, because that session's agent
*is* the policy: it is what makes the harness apply a sandbox, run guards, and file the call under
a transcript.

There is deliberately no session-less form. DSH registers a tool into the scope of the context
that registers it, and every tool package ships inside an agent preset, so the global layer is
empty — an unscoped listing really does return zero tools, and an unscoped call answers
`unknown tool`. A `dsh_tool_list` without a session therefore **fails loudly** rather than
reporting an empty toolbox, which would read as "nothing is permitted". For the agentless path
use `file_read` / `file_write` / `file_list` / `shell_run`, which resolve the deployment policy
directly and need no session.

The permitted set is an **allow-list**, and it is deliberately narrow. Everything absent is
refused *and* hidden from `dsh_tool_list`. The omissions that matter:

- **`run_code`** is DSH's programmatic-tool-calling entry point: one call runs a program that
  can invoke *any other tool by name*. Exposing it would void the list entirely.
- **`cordis_run`, `cordis_define`, …** execute arbitrary plugin code. No shipped bundle mounts
  them, so a deny-list written against today's profile would be blind in exactly the profile
  that adds them — which is why this is an allow-list.
- **`ask_user_question` and `present`** reach the human at the keyboard.
- **`workflow`, `ralph`, `send_message`, `spawn_teammate`, `schedule_create`** start work that
  outlives the call; **`create_goal` and `update_goal`** sustain unattended execution.

An operator can widen this deliberately with the `agentTools.allow` setting, or subtract from
the default with `agentTools.deny`.

## Security

This endpoint is remote control of a coding agent that has shell access. Treat the token like
an SSH key — and note that the plugin does too: no tool returns its value. `dsh_info` reports
where the token comes from (a file path or the composition), never the literal, so a calling
agent's transcript never accumulates the credential. A pinned token shorter than 16 characters
draws a warning at boot, and a generated one is 43 characters of CSPRNG output.

- The listener binds to `127.0.0.1` and every request is bearer-checked, including requests on
  a route mounted on DSH's own web server. That check is the *only* gate there: an exact route
  registered on the web server is matched **before** DSH's authorization fence — anything
  unmatched is handed to that fence as a fallback (`webserver/src/index.ts:222-227`) — so with
  `http.mountOnWebServer: true` the endpoint does not inherit your browser session's
  protection, it enforces its own. One caveat on DSH Desktop: when ordinary browser access is
  disabled there, the web server additionally refuses requests that do not carry the renderer
  header, so the mounted path is unreachable for a plain MCP client — use the plugin-owned
  listener. Setting `http.host: 0.0.0.0` exposes that same power to your network; the plugin
  warns at bind time, and you should do it only behind your own gateway.
- **The token is the entire security boundary, and that boundary is your user account.** There
  is no path sandbox. Once a caller holds the token, `file_read`/`file_write`/`file_list` reach
  anything the DSH process can reach, and `shell_run` runs arbitrary commands as you — because
  that is exactly what the harness's own `fs` and `shell` services do for DSH's own agent. Both
  properties were verified against a live instance: `file_read` returned `/etc/passwd`,
  `~/.dsh/settings.yaml`, and this plugin's own token file; `file_write` created a file outside
  every registered workspace. A workspace sets where a *session's* agent starts; it does not
  fence these tools.
- **The bridge is instance-wide, not per-caller.** `session_list` enumerates every session in
  this DSH instance and `session_messages` reads any of their transcripts — verified reading a
  session this plugin did not create. Those are the sessions you have been talking to DSH in, so
  a token holder sees your conversation history, and a calling agent's context accumulates it.
  This is not an escalation (the same bytes are in `$DSH_HOME/sessions`, reachable through
  `shell_run`), but it is a privacy consequence worth knowing before you hand out a token.
- Consequently the `tools` toggles **narrow what a client can discover and call; they are not
  containment.** `tools.shell: false` removes the shell tool, but `file_write` still writes your
  shell startup files and `file_read` still reads your credentials, so a profile with the shell
  tool switched off is not safe to hand to a caller you would not give a login to. For real
  containment, run the whole DSH instance inside an OS-level sandbox or as a dedicated
  unprivileged account, and treat the token as that account's password.
- `approval.policy` decides what happens when the DSH agent wants to run something the harness
  would normally ask a human about:
  - `inherit` (default) — the plugin does not answer. With no browser attached, an
    approval-requiring tool resolves `unavailable` and the agent's action fails closed.
  - `allow` — the plugin approves every request raised by a session **it created**, and stays
    out of the waterfall for every other session, so your own interactive sessions keep their
    policy. This is what makes unattended agent runs work; it is a real widening of what the
    agent may execute.
- `file_write` and `shell_run` are the *caller's* actions, not the agent's. They run through
  the harness's own filesystem and shell services, so the sandbox and policy configured for
  this DSH instance still apply.

## Installing into DSH Desktop (restart required)

Electron reserves the `desktop` profile, so `dsh plugin --profile desktop add` is refused from a
plain terminal and the install is manual. DSH Desktop must then be **restarted**.

### Why a restart is required

`patchReload: live` in the profile manifest only governs the **CLI launcher**. The no-restart
recompose is implemented by `watchUserPatches()`, which lives in the CLI's `runProfile()`
(`apps/cli/src/profile-boot.ts`). DSH Desktop takes a different path: it calls `boot()` from
`@deepseek-ai/dsh-app-boot` with the patch list computed once at startup, and the shipping app
contains no such watcher at all:

```bash
grep -rn watchUserPatches <dsh-desktop>/dsh-plugin-desktop/src/    # no matches
```

Measured behaviour agrees: after editing the profile's `cordis.patch.yml`, the app log gained not
one line and the port never opened.

So: **a CLI-launched profile (`dsh --profile xxx`) applies patch edits immediately; DSH Desktop
must be restarted.** On either path the watcher only recomposes config rather than replacing
loaded modules, so editing `lib/` needs a restart regardless.

### If the app will not start afterwards

Reset `~/.dsh/profiles/desktop/cordis.patch.yml` to `[]` and the plugin takes no part in startup.
To remove it entirely: `cd ~/.dsh/profiles/desktop && pnpm remove dsh-as-mcp`.

### 1. Pack it and install into the desktop profile

```bash
cd /path/to/dsh-as-mcp && pnpm pack --pack-destination /tmp

# raw pnpm, bypassing the CLI's reserved-profile guard
cd ~/.dsh/profiles/desktop && pnpm add /tmp/dsh-as-mcp-0.1.0.tgz
```

> **Reinstalling over an existing install: change the tarball path.**
> `pnpm` keys a `file:` dependency on the *path*, and a reinstall from the same path
> reports `added 0` while leaving the previous content linked — a silently stale
> build that still boots and still runs the old code. Give each build a unique
> filename and the spec string changes with it:
>
> ```bash
> TARBALL=/tmp/dsh-as-mcp-$(date +%s).tgz
> cd /path/to/dsh-as-mcp && pnpm pack --pack-destination "$(dirname $TARBALL)"
> mv /tmp/dsh-as-mcp-0.1.0.tgz "$TARBALL"
> cd ~/.dsh/profiles/desktop && pnpm remove dsh-as-mcp && pnpm add "$TARBALL"
> ```
>
> Then confirm the bytes actually match, or you are testing the old build:
>
> ```bash
> wc -c ~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/lib/index.js \
>       /path/to/dsh-as-mcp/lib/index.js
> ```

### 2. Put the plugin row in the profile's own patch layer

Edit `~/.dsh/profiles/desktop/cordis.patch.yml` (replace the `[]`):

```yaml
- insert:
    - id: dsh-as-mcp
      name: dsh-as-mcp
      config:
        http:
          enabled: true
          host: 127.0.0.1
          port: 8790
          path: /mcp
        tools:
          workspace: true
          session: true
          files: true
          shell: true
```

Then **restart DSH Desktop** to mount the plugin.

> ⚠️ **Do not also add `dsh-as-mcp` to `dsh.profile.bundles`.** The bundle contributes its own
> row, so the composed result carries **two rows sharing one id** (`dsh --profile <name>
> --dump-config` shows both). Use the patch layer or the bundle list, never both. Switch to the
> bundle route via `dsh plugin add` when you want it to persist across restarts.

### 3. Smoke-test it

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/scripts/smoke.mjs
```

It reads `<DSH_HOME>/dsh-as-mcp/token`, shakes hands, lists tools, calls `dsh_info` to report which
harness services this profile actually mounted, then calls `workspace_list`. The last line is `OK`
on success and the exit status is non-zero on failure.

For one real round trip (temp workspace → session → hand the DSH agent a task → print the reply and
tool calls):

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/scripts/smoke.mjs \
  --prompt "In the current workspace create hello.txt containing hi, then read it back to confirm"
```

### 4. Uninstall

Reset `~/.dsh/profiles/desktop/cordis.patch.yml` to `[]` and restart, and the plugin no longer
mounts. To remove it entirely: `cd ~/.dsh/profiles/desktop && pnpm remove dsh-as-mcp`.

## Configuration

Defaults ship in `cordis.patch.yml`. A profile's own `cordis.patch.yml` overrides the row by
`id`, and an override **replaces the row's whole `config` object** rather than deep-merging
it — restate every key you still want. Unknown keys are rejected at boot with the offending
key named, because a silently ignored typo means your override is not being applied.

```yaml
- id: dsh-as-mcp
  name: dsh-as-mcp
  config:
    http:
      enabled: true          # plugin-owned listener
      host: 127.0.0.1
      port: 8790             # 0 asks the OS for a free port
      path: /mcp
      mountOnWebServer: false # also serve at http://<dsh host>:<dsh web port>/mcp
    auth:
      token: ''              # empty: read/generate $DSH_HOME/dsh-as-mcp/token
    tools:
      workspace: true
      session: true
      files: true
      shell: true
    session:
      agentPreset: ''        # empty: harness default
      provider: ''           # must be paired with model
      model: ''
      promptTimeoutMs: 900000
    limits:
      maxReadBytes: 1048576
      shellTimeoutMs: 120000
      agentToolTimeoutMs: 120000
    approval:
      policy: inherit        # inherit | allow
```

## Settings panel

Where the host mounts a settings service — DSH Desktop and `dsh web` both do — the plugin
contributes an **MCP server** section to the settings panel. It edits the same `dsh-as-mcp`
namespace the configuration above fills, so the panel and the file are two views of one
value, not two copies.

The panel covers every setting including the `agentTools.allow` and `agentTools.deny` lists,
which are edited as comma-separated text. Both are ordinary `string[]` values, so an entry with a
comma in it cannot be expressed here; use the configuration file for that.

Every change applies **live**:

| Change | Effect |
| --- | --- |
| a tool toggle | the group leaves or joins the very next `tools/list`; a disabled tool is genuinely absent, so calling it reports an unknown tool rather than running and being refused |
| a limit, or a session default | read at the start of the next call |
| the token | the new value is required by the next request; the old one stops working immediately |
| `enabled`, `host`, `port`, `path`, `mountOnWebServer` | the listener is moved |

Changing the port is the case worth stating plainly: the plugin stops the old listener and
starts the new one, so the endpoint really does move. If the new port is taken, the bind error
is shown in the panel and in `dsh_info` rather than being swallowed.

The token is rendered **write-only**. Its literal never leaves the host process, so the panel
shows only whether one is set, and a "clear" button. The copyable client configuration uses a
`<token>` placeholder and points at the token file. Live endpoint state (listening, bind error,
enabled tool groups) is served by a read-only route on DSH's connection layer — inside that
layer's Host/Origin and browser-cookie fence, so it inherits DSH's own authorization and is
never exposed on a bare port.

The panel needs `@deepseek-ai/schemastery` to register a settings namespace; there is no
schemastery-free path in DSH. It is declared as an **optional** peer and loaded by dynamic
import, so a host that cannot supply it loses the section and nothing else — the endpoint keeps
running from the configuration file. `dsh_info` and the smoke script both report which of the
two you have.

## Compatibility

- **Harness** ≥ `0.1.5-rc.1` (developed and verified against `dsh-v0.1.5-rc.1`, the version
  bundled with DSH Desktop 2.0.9), declared as `peerDependencies["@deepseek-ai/dsh"]:
  ">=0.1.5-rc.1"` with no upper bound. DSH's plugin loader reads that range straight from the
  manifest and semver-checks it against the single running runtime version (prereleases
  included) *before* the plugin is imported; an incompatible install is refused unless the host
  grants an exact-version exemption (`dsh plugin allow-version`).
- **Node** `^22.19.0 || >=24.0.0`.
- The `@deepseek-ai/dsh` peer is declared **optional**, purely so `dsh plugin add` does not pull
  a full harness install into every profile just to satisfy it. Optional only changes
  installation — DSH's compatibility gate reads `peerDependencies` regardless of
  `peerDependenciesMeta`, so the version check above still applies in full.
- **No other hard `@deepseek-ai/*` dependency.** This package resolves every other capability
  structurally through `ctx.get(name)`, and its config schema is a hand-written
  [Standard Schema](https://standardschema.dev) rather than a schemastery schema — which is all
  Cordis's `resolveConfig` actually consumes. The one exception is `@deepseek-ai/schemastery`,
  also declared as an **optional** peer: DSH offers no schemastery-free path to registering a
  settings namespace, so wanting the panel means declaring it — but optional means a host
  without it loses only the panel. This is the same stance the installed third-party
  `dsh-tokenledger` takes.

## Design notes

- **Capability detection, not `inject`.** The plugin loads in a bare CLI profile that has no
  web server, no session service, and no filesystem seam, and each tool then reports exactly
  which service is missing and which bundle provides it. Declaring `inject` would make the
  loader refuse to mount the plugin instead, which is a worse answer for a capability bridge.
- **Waiting for a turn.** The harness exposes no per-message "await this turn" call —
  `sessionController.prompt()` returns as soon as the message is queued. So `session_prompt` polls
  the durable session log for a `user/message` whose `source.rpcId` equals the `requestId` it
  passed to `prompt()` — the same correlation the session controller's own idempotency check uses
  — and then waits for *that* turn to close. Attribution is what makes this correct rather than
  plausible: a queued prompt's log entry sits inside the span of the turn that was already
  running, so a `turn/end` appearing after our message is usually someone else's turn, not ours.
  Turns on one session are additionally serialized, so two concurrent callers cannot interleave
  prompts and then disagree about which reply is theirs. The serialization covers the whole wait,
  not just the submission: a second `session_prompt` to a session whose first wait is still open
  does not even submit its message until that wait settles (up to its timeout), and a `steer` sent
  while another MCP wait is in flight is deferred until it, which turns it into a queued prompt.
  Callers that only want to queue a message should prefer `session_messages` polling over holding
  a long wait open.
- **Filesystem.** Only `workspace_create` touches `node:fs` `mkdir` — the directory it creates
  *is* the new sandbox root, so by definition it sits outside every root that exists before it,
  which is why the call cannot go through the filesystem seam and is instead gated on the
  read-only policy. The harness filesystem service deliberately exposes no `mkdir`; `file_write`
  relies on the seam's atomic write, which creates parents inside the fence. Every read and
  write goes through `ctx.fs`, so the same path rules and sandboxing the DSH agent lives
  under apply to the caller.
- **No session deletion.** The harness offers `archiveSession`/`unarchiveSession` but no
  delete, so neither does this plugin.

## Development

```bash
pnpm install
pnpm build       # tsdown -> lib/
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
```

The test suite runs real HTTP against a real listener, spawns the real `bin/mcp-stdio.mjs`,
and loads the plugin into a real `@deepseek-ai/cordis` context — with `resolveConfig` doing the
config validation — so the wire protocol, the bridge, and the loader contract are all
exercised rather than mocked.

Two scripts run against a **live** endpoint, which is a different thing. Both resolve it the
same way — the `--url`/`--token` flag wins, then `DSH_AS_MCP_URL`/`DSH_AS_MCP_TOKEN`, then the
loopback default — and both print the endpoint they resolved and where it came from (`arg` /
`env` / `default`) to stderr before sending anything, so a stray run cannot silently land on
whatever DSH instance happens to be listening on the default port:

```bash
node scripts/smoke.mjs       # handshake, tools/list, dsh_info — is the wire up?
node scripts/exercise.mjs    # ~40 checks: create a workspace, start a session, have the
                             # DSH agent write code, read it back off disk, run it, check
                             # the transcript, and confirm the failure paths are legible
```

`smoke.mjs` answers "does this speak MCP". `exercise.mjs` answers "can an outside agent
actually drive a DSH instance through it" — and to answer that it hands a real prompt to a real
DSH agent, making real LLM calls and costing real money against whatever endpoint it resolved
to, so read the endpoint line it prints before letting it run. It is the only check that catches
a whole class of bug a green unit suite misses — a test stub more forgiving than the harness
service it stands in for. That class produced four real failures here, three in a primary use
case, so run it after any change to the driver. `docs/STUB-FIDELITY-AUDIT.md` is the audit that
enumerated the class; it is worth reading before writing a double for a harness service.

Two rules this codebase learned the hard way:

- **A double must enforce the service's real preconditions.** A stub that returns `undefined`
  where the real call *rejects*, or that accepts both arguments where the real one rejects the
  pair, converts a production failure into a green test. Where a double cannot model a service,
  the missing double is itself the finding — the filesystem and shell seams had none, and the
  worst bug lived there.
- **A test can lock a bug in.** One asserted that a `turn/start` *before* our message meant the
  turn was not ours; a real session log showed that is exactly the ordinary shape, and the
  assertion kept every waiting `session_prompt` timing out on turns that had completed.

## Publishing (maintainers)

**One-time setup**, once the GitHub repo exists:

1. Replace every `xiseliuli/dsh-as-mcp` placeholder in this repo (package.json's `repository`,
   `homepage`, and `bugs`, plus both READMEs) with the real `xiseliuli/dsh-as-mcp` — a single global
   find-and-replace works, since every occurrence uses the identical spelling.
2. Tag the repo with the topic plugin discovery keys on:
   `gh repo edit xiseliuli/dsh-as-mcp --add-topic dsh-plugin`.
3. Trusted Publishing cannot perform a package's *first* publish — npm requires the package to
   already exist on the registry before a Trusted Publisher can be attached to it (the
   [`npm trust` docs](https://docs.npmjs.com/cli/v11/commands/npm-trust/) state the prerequisite
   outright: "Package must exist: The package you're configuring must already exist on the npm
   registry."). So the first release has to go out by hand: `npm publish --access public` from a
   checkout (or `npm login --auth-type=web` first, if you'd rather not touch a long-lived
   credential at all). Only after that publish succeeds does the package have a Settings page to
   configure.
4. On npmjs.com, open the package → **Settings** → **Trusted Publisher**, and add a GitHub
   Actions publisher with this repo's owner, repo name, and the exact workflow filename
   `release.yml`. Every release after this one goes out through
   `.github/workflows/release.yml`'s OIDC flow — no `NPM_TOKEN` involved.

**Every release:**

```bash
npm version patch   # or minor / major
git push --follow-tags
```

The pushed tag triggers `release.yml`, which verifies the tag matches `package.json`'s version,
builds, tests, and publishes — under the `next` dist-tag instead of `latest` if the version is a
prerelease.

**After a release, verify it actually installs:**

```bash
dsh plugin --profile <name> add dsh-as-mcp
dsh --profile <name> --dump-config | grep -A 30 '# == dsh-as-mcp'
```

That is the same install/verify pair from "Install" above, run against the version that just
shipped.

## License

MIT
