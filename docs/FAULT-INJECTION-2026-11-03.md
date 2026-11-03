# Fault-injection verification: failure reporting (0.52.81)

Date: 2026-11-03. Run by the maintainer against a **throwaway** profile, not the operator's app.

This is the experiment record behind the "Failure reporting (fault injection)" rows in
`docs/LIVE-VERIFICATION.md`. It closes the evidence gap those rows used to describe: before this run, the
normalization of abnormal `turn/end` reasons was unit-tested only.

## Setup

- Throwaway `DSH_HOME` (`/tmp/fault-inject/work/dsh-home`) with profile
  `fault-probe --from-default-profile web`; plugin tarball `dsh-as-mcp-0.52.81.tgz` added with
  `dsh plugin add`; the profile patch enables every tool group on a random port with
  `mountOnWebServer: false` and opens the session-query index (`:memory:`, `openAt: first-search`).
- Headless harness on random ports with `DSH_PERMISSION_MODE=danger-full-access`.
- Credentials copied from `~/.dsh/.credentials.yaml` (0600) into the throwaway home; the real file was
  never modified. Only the throwaway copy was corrupted for one experiment.
- Probes are MCP JSON-RPC over Streamable HTTP (`initialize` + `tools/call`), i.e. the same path a real
  upstream uses. Scripts: `/tmp/fault-inject/probe.mjs`, `/tmp/fault-inject/harness.sh` (throwaway).

## 1. `error` ending (provider auth failure) — PASS

Edited only the throwaway credentials copy (`refs.DEEPSEEK_API_KEY = sk-invalid-fault-injection`), booted,
then created a session on `deepseek-official/deepseek-flash` and prompted it. Reply:

```json
{
  "turn": {
    "reply": "",
    "replyChars": 0,
    "models": [],
    "turn": 1,
    "turnEndReason": {
      "kind": "error",
      "error": { "message": "Authentication Fails, Your api key: ****tion is invalid (request_id: …)", "code": "AUTH", "status": 401 }
    },
    "aborted": false,
    "timedOut": false,
    "failure": { "kind": "error", "message": "Authentication Fails, Your api key: ****tion is invalid (request_id: …)" }
  }
}
```

`elapsedMs: 478`. `session_status` on the same session afterwards:

```json
{
  "running": false,
  "lastTurn": { "turn": 1, "reason": { "kind": "error", "error": { "code": "AUTH", "status": 401 } } },
  "failure": { "kind": "error", "message": "Authentication Fails, Your api key: ****tion is invalid (request_id: …)" }
}
```

The point of the check: the reply is not an ordinary success with an empty message, and the caller is not
left waiting for the timeout.

## 2. `error` ending (log disappears mid-turn) — PASS

Long turn (`bash: sleep 12; echo …`); 3 s in, the session directory was renamed away
(`<session-id>` → `<session-id>.moved-by-fault-injection`). The harness closed the turn itself:

```json
{
  "turn": {
    "reply": "",
    "models": ["deepseek-official/deepseek-flash"],
    "toolCalls": [{ "name": "bash" }],
    "turnEndReason": { "kind": "error", "error": { "message": "ENOENT: no such file or directory, open '…/session.v4.jsonl.zstd'" } },
    "timedOut": false,
    "failure": { "kind": "error", "message": "ENOENT: no such file or directory, open '…/session.v4.jsonl.zstd'" }
  }
}
```

`elapsedMs: 13759` — reported as a failure, not as a 120 s timeout. Because the harness resolves this
case first, it does *not* exercise the driver's own `unreadable` branch (see §4).

## 3. `interrupted` ending (crash mid-turn) — PASS

`session_prompt { wait: false }` with `bash: sleep 45; echo …`; `session_status` showed `running: true`.
The harness host was then `kill -9`'d and a new harness was booted against the **same** `DSH_HOME`. A cold
`session_status` on that session (no prompt sent first) answered:

```json
{
  "running": false,
  "openTurn": null,
  "lastEventSeq": 6,
  "lastTurn": { "turn": 1, "reason": { "kind": "interrupted" } },
  "failure": { "kind": "interrupted", "message": "the turn was closed without an ending by the harness (crash-orphaned)" },
  "stalled": false,
  "logReadable": true,
  "idleMs": 22804
}
```

So a session that died mid-turn is reported as a failure on the next read, not as "still running".

## 4. `stalled` on a quiet running turn — PASS

A real turn sleeping in a tool call (`bash: sleep 90`). Polling `session_status` every 5 s: `running: true`,
`openTurn: 1`, `failure: null`, `idleMs` growing; at `idleMs = 62 861 ms` it flipped `stalled: true`
(at 60 s: `idleMs = 58 847 ms`, `stalled: false`). That is the documented meaning — running and silent for
a minute is a symptom worth reporting, not a verdict.

## 5. `unreadable` and `vanished` (wait-side detections) — INCONCLUSIVE / not reachable live

- `unreadable`: when the log was removed while a wait was open, the harness closed the turn with `error`
  (ENOENT) first, so the wait settled through the ordinary `error` path (§2). The driver's own branch
  remains a defensive, unit-tested path (`tests/driver.test.ts`, "reports an unreadable session log
  instead of surfacing a bare error"). Related real observation: while a session directory was in the
  moved state, `session_status` answered `logReadable: false` with `lastTurn: null` instead of throwing.
- `vanished` (open turn, agent idle, no `turn/end`): not reachable without faulting the agent loop
  in-process; the crash case is synthesised as an `interrupted` ending on the cold read (§3) before
  "vanished" can apply. Remains unit-tested (`tests/driver.test.ts`, "reports a turn that vanished
  without a turn/end instead of waiting out the timeout").

## 6. Notes and hazards found

- Credential precedence: exporting `DEEPSEEK_API_KEY` or `DEEPSEEK_BASE_URL` does not override a stored
  credential — `llm-deepseek-api-key` resolves through the credentials service first
  (`packages/llm/llm-deepseek-api-key/src/index.ts`), and the account route ignores both. Corrupting the
  throwaway credentials *file* before boot was the working lever.
- Renaming a session directory leaves a sibling the persistence listing treats as a corrupt session log
  (`header id … and cwd identify …`), which then fails `session_messages` for the whole store until it is
  removed or restored. It does not affect the moved session after restore.
- All harness processes started for the experiment were killed afterwards. The throwaway `DSH_HOME`
  (including its credentials copy) was removed; only this record and the probe scripts remain.
