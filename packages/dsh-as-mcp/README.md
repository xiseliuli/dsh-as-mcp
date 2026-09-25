# dsh-as-mcp

Expose a running **DeepSeek Harness** as an **MCP server**, so any other agent — Claude
Code, Codex, another DSH, a CI job, your own script — can drive it: create workspaces,
start sessions, hand the DSH agent a coding task, read and write files, run commands.

The endpoint runs *inside* the DSH host process, so a session created over MCP is a real
DSH session. It appears live in the DSH UI, runs inside the DSH sandbox, and is subject to
the same permission policy as anything you type yourself. Nothing about the agent is
reimplemented.

---

## Install

```bash
dsh plugin add dsh-as-mcp
```

From a checkout or a tarball:

```bash
dsh plugin add /path/to/dsh-as-mcp
dsh plugin add ./dsh-as-mcp-0.1.0.tgz
```

`dsh plugin add` records the package in the profile's `dsh.profile.bundles`, and the
bundle's `cordis.patch.yml` supplies the plugin row and its defaults. **Restart DSH
afterwards**: bundle patches are read at boot, not hot-reloaded.

Confirm the layer composed:

```bash
dsh --profile <name> --dump-config | grep -A 30 '# == dsh-as-mcp'
```

## Connect a client

Every request needs a bearer token. It is resolved in this order:

1. `auth.token` in the plugin config;
2. `$DSH_HOME/dsh-as-mcp/token`;
3. otherwise generated and persisted there on first run, with mode `0600`.

The default endpoint is `http://127.0.0.1:8790/mcp`.

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

`dsh-as-mcp --help` prints the endpoint and token state it will use.

Start with **`dsh_info`**. It reports the endpoint, the token, which tool groups are enabled,
and — importantly — which harness services the current profile actually provides, so a client
can tell "this profile has no shell" from "the command failed".

## Tools

| Tool | What it does |
| --- | --- |
| `dsh_info` | Endpoint, token, enabled groups, available harness services. |
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

The typical coding flow:

```
workspace_create { path: "/Users/me/project" }
  -> session_create { workspaceId: "..." }
  -> session_prompt { sessionId: "...", prompt: "Add a --verbose flag to the CLI and a test for it." }
```

`session_prompt` is how you get work done *by* DSH: the DSH agent plans, edits files, runs
its own tools, and can spawn subagents. `file_*` and `shell_run` are for when you want to do
something yourself without involving the agent.

## Security

This endpoint is remote control of a coding agent that has shell access. Treat the token like
an SSH key.

- The listener binds to `127.0.0.1` and every request is bearer-checked, including requests on
  a route mounted on DSH's own web server. Setting `http.host: 0.0.0.0` exposes that same
  power to your network — do it only behind your own gateway.
- Narrow the surface with the `tools` toggles. A profile that should never run commands sets
  `tools.shell: false`; the tool is then not registered at all, so a client cannot even
  discover it.
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
    approval:
      policy: inherit        # inherit | allow
```

## Compatibility

- **Harness** ≥ `0.1.5-rc.1` (developed and verified against `dsh-v0.1.5-rc.1`, the version
  bundled with DSH Desktop 2.0.9).
- **Node** `^22.19.0 || >=24.0.0`.
- **Zero `@deepseek-ai/*` dependencies.** DSH gates a plugin on each declared
  `@deepseek-ai/dsh-*` peer range against the single running runtime version, so this package
  declares none: it resolves every capability structurally through `ctx.get(name)`, and its
  config schema is a hand-written [Standard Schema](https://standardschema.dev) rather than a
  schemastery schema — which is all Cordis's `resolveConfig` actually consumes. The result
  installs and loads with no version gate, and cannot fail at import time because a peer was
  not installed.

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
  prompts and then disagree about which reply is theirs.
- **Filesystem.** `workspace_create` and `file_write` use `node:fs` `mkdir` for parent
  directories only; the harness filesystem service deliberately exposes no `mkdir`. Every read
  and write goes through `ctx.fs`, so the same path rules and sandboxing the DSH agent lives
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

## License

MIT
