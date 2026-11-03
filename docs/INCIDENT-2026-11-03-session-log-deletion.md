# Incident: a maintainer tool deleted real session logs (2026-11-03)

**Short version.** `tools/clean-probe-sessions.mjs` — written during the day to remove the
sessions the project's live checks leave behind — classified a session as a check artifact when
its log *contained* one of the prompts the checks send. Sessions that merely read
`tools/live-checks.mjs` (or the cleanup tool's own source) contain those strings in their tool
results, so they matched. Two real developer sessions were removed from `~/.dsh/sessions`,
one of them while the running app had it open, and the app then reported
`ENOENT: no such file or directory, open '…/session.v4.jsonl.zstd'`.

The tool now decides on positive evidence only and removal goes through a trash directory. This
page records what happened, what the evidence was, what survived, and the rule the tool must keep.

## What was lost

| Session | What it was | Figures | When it went |
| --- | --- | --- | --- |
| `session-c20a736c-bef1-4020-ab3f-c941b9562eaa` | The main development session of this repository, started 2026-11-02 15:33:36, unseeded (`cwd` `/Users/xiseliuli/test_code/dsh-plugins`) | 196 turns / 3556 steps; 10,051,671 uncached input + 1,926,259 output + 1,179,451,136 cache-read tokens; money projection **$7.156**; goal `goal-62d50b21-…` at round 193 | between 07:45 and 07:49 |
| `session-a02b3d5b-e204-472c-8c74-14673f373b7a` | A seeded fork of the session above (created 2026-11-02 19:48:10, `inheritedEventCount` 4282), auto-resumed as goal round 6 after the app restarted | 9 turns (8 inherited + 1 own), 654 steps; 3,591,298 uncached input + 404,261 output + 189,737,728 cache-read tokens; **$0.0801** (cost-meter ledger); its single own prompt “你搞出来一堆垃圾会话，记得清理哦” arrived mid-turn 9 at seq 4691 | ~09:09 |

`session-a02b3d5b` is the one whose missing file the user saw:

```
ENOENT: no such file or directory, open
'/Users/xiseliuli/.dsh/sessions/--Users-xiseliuli-test_code-dsh-plugins--/session-a02b3d5b-e204-472c-8c74-14673f373b7a/session.v4.jsonl.zstd'
```

## The mechanism

The harness keeps a session's log open while the session is loaded (it also holds
`session.lock`). If the session directory is removed underneath it, the next read or append that
has to reopen the path fails with `ENOENT`, which is what the user sees. The directory does not
come back, so the session can no longer be replayed: the store has no second copy.

The app process that was running at the time still held the removed lock file as an unlinked
inode when the incident was investigated:

```
$ lsof +L1 | grep a02b3d5b
DeepSeek  50839 … 37w REG 1,17 0 … /Users/xiseliuli/.dsh/sessions/--Users-xiseliuli-test_code-dsh-plugins--/session-a02b3d5b-…/session.lock
```

That is filesystem-level evidence that the directory was deleted externally — by a separate
process — not by the harness closing and cleaning up its own session.

## Why the tool could not tell a check session from a real one

The first version of `tools/clean-probe-sessions.mjs` was precise about *what it meant to keep*
but wrong about the signal:

- every workspace key under a throwaway profile or `/tmp` → check artifact (correct);
- otherwise, if the decompressed log contained any of 27 literal strings — `Reply with exactly:
  WINDOW DONE`, `"rpcId":"dsh-as-mcp-`, `padded title`, `live-cross-entry`, … — or an
  `rpcId` starting `dsh-as-mcp-` anywhere in it → check artifact (wrong).

A developer session of this repository reads `tools/live-checks.mjs`, which contains every one of
those prompts, and writes the tool that contains the marker list. Its transcript therefore quotes
the checks' own sources, which is indistinguishable from a session the checks drove.

The failure reproduces on the spot, against the live store, without deleting anything:

```
$ node tools/clean-probe-sessions.mjs.OLD         # the pre-fix version
     1  --Users-xiseliuli-test_code-dsh-plugins--
1 of 63 session(s) look like check artifacts (check prompt: 1).
```

The one selected session was `session-5e78d96b…` — the session that was running the check, kept
alive by having read the tool's own documentation. On a synthetic store the same version deleted
a human session that quoted one marker, and (through its second pass) any empty session in a
workspace where a check had ever run.

The tool also had no guard against deleting the session that was invoking it: the deleting
session's own directory is just another match. Both lost sessions were this project's development
sessions, so both were eligible; `session-a02b3d5b` was deleted from inside its own turn 9, the
turn that asked for the cleanup.

## Timeline (from surviving evidence)

| Time (+08) | Event | Evidence |
| --- | --- | --- |
| 11-02 15:33 | `session-c20a736c` starts; becomes the main development session | projection cache `identity.createdAt` |
| 11-02 19:47 / 19:48 | two seeded forks are cut from it: `session-54f0c596` at 4258 events, `session-a02b3d5b` at 4282 | their log headers (`parentSession`, `isSeeded`) and projection caches |
| 11-03 07:43:53 | the user's “你搞了一堆垃圾会话出来，记得删掉” arrives **mid-turn 195** (4 human messages total; turns 4–196 were goal auto-continuations) | projection cache `titleInput.val.count/lastSeq` |
| 11-03 07:45–07:48 | `tools/clean-probe-sessions.mjs` is written; sweep helper follows | file birth/mtime |
| 11-03 ~07:49 | `session-c20a736c` disappears with a model call in flight (last message 07:49:07, cache flush 07:49:12); the app is relaunched at 08:21 | directory gone; `pendingCalls` at 07:49:07; app process start time |
| 11-03 08:22:10 | `session-a02b3d5b` auto-resumes as **goal round 6** when the app comes back (it is a fork of the dead session) | projection cache `goal.roundsStarted`, turn 9 at seq 4285 |
| 11-03 09:08:23 | the user's “你搞出来一堆垃圾会话，记得清理哦” arrives in it, also mid-turn (seq 4691); its last steps run 09:08:40–09:08:57, cache flush 09:08:59 | projection cache `titleInput`, `sessionStats.openStep` |
| 11-03 ~09:09 | `session-a02b3d5b` disappears while open; app reports ENOENT; user opens a new session at 09:43 | parent directory mtime 09:09; unlinked `session.lock`; new session dir 09:43 |

The exact command line that ran the tool was in the lost transcripts, so it is not quoted here.
What is certain: the tool's selection rule matches those sessions, the tool is the only thing on
this machine whose purpose was to delete session directories, and the deletion happened from a
separate process while the app had the log open. The alternative (“someone ran `rm -rf` by hand”)
would produce an identical filesystem result but has no motive, no tool, and no reproduction.

## What survives

There is **no snapshot and no backup** to restore from: `tmutil listlocalsnapshots /` lists
nothing, `~/.dsh/backups/` holds plugin tarballs only, and no other copy of either log exists on
disk. The deleted logs themselves are gone.

These survive and are worth keeping:

| What | Where | What it gives back |
| --- | --- | --- |
| `session-54f0c596-4c7a-4646-a3d1-7d5dcb30107e` | `~/.dsh/sessions/--Users-xiseliuli-test_code-dsh-plugins--/session-54f0c596-…/session.v4.jsonl.zstd` | The same conversation **through turn 8**, verbatim: it is a seeded fork whose events 0–4258 are the main session's events 0–4258 (turns start at seq 5, 2381, 2501, 2550, 3085, 3346, 3655, 4006). Its title is identical, so it is the usable continuation of the lost main session. |
| Projection caches | `~/.dsh/storages/session_projcache/sessions/session-c20a736c-….json` and `…session-a02b3d5b-….json` | the 196 and 9 turn prompts (`rows.turnOutline`), title, goal, model/preset, token totals, cost totals, step statistics, last draft |
| Cost ledger | `~/.dsh/storages/cost-meter/ledger.json` | per-session money and token rows for both ids |
| The work itself | this repository, `~/.dsh/packages/dsh-as-mcp-0.52.*.tgz` | every code change made in those sessions — the product was never at risk |

Permanently lost: the conversation content of the main session's turns 9–196 and of the fork's own
turn 9 — all assistant/tool transcripts after event 4258. The prompts are recoverable from the
projection cache; the reasoning and tool output behind them are not.

To get back to work: open `session-54f0c596…` in the app (it continues the same conversation at
turn 8) or point the plugin's `session_prompt` at that id. The 196 recovered prompts are a useful
outline of what the main session had discussed; they are not a substitution for it.

A recovery bundle was assembled during the incident (outside this repository, so this page does not
depend on it): `~/dsh-session-recovery-2026-11-03/` holds the 196-prompt export, the readable
transcript of turns 1–8, the usage/provenance JSON, the read-only source snapshots, and a
**format-valid replacement log for the main session** built from the surviving fork. That
replacement was validated with the harness's own v4 codecs
(`restoreReleasedV4Artifact` passes) and accepted by the store's decode/verify/restore path in a
throwaway `DSH_HOME`; it is not installed by default, and installing it is optional (the same
conversation is already reachable through `session-54f0c596`). One format detail worth writing down
for any future restore: the session log is a **multi-frame zstd file whose first frame is exactly
the header line** — a naive single-frame compression is rejected by the store — and the session
directory must sit under the workspace key derived from the header's `cwd`.

## The fix

`tools/clean-probe-sessions.mjs` now removes a session only on **positive evidence that the
checks own it**, refuses to touch a session with any human prompt, and removal is recoverable:

1. **No human prompt** — a prompt is a `user/message` event whose `source.kind` is `user`; a
   browser prompt carries a plain client uuid, the plugin's carries `rpcId` beginning
   `dsh-as-mcp-` (random id, or `dsh-as-mcp-idem-<key>` for idempotent calls). A `user/message`
   with no `rpcId` — and one with no source at all — counts as human, so a session containing one
   is kept outright. This test runs before the recognition rules, so no key and no content can
   override it.
2. **Throwaway workspace key** — a profile directory under `~/.dsh/profiles-*`, or a `cwd` under
   `/tmp` / `/private/tmp` / `/var/folders`; removable when the log holds no human prompt.
3. **Every prompt is the plugin's** — at least one plugin prompt and no human one: the checks
   drove the session. Content is never evidence.

One more brake sits in front of that rule: a session **written to within the last 10 minutes**
(`--fresh-mins`) is skipped — that covers the session running the command and any check still in
flight.

Symlinked workspace keys are not followed (`Dirent` is an lstat), so a session behind a link is
never moved out of another store.

`--yes` moves each removed directory to `$DSH_HOME/sessions-trash/<timestamp>/<workspace-key>/`,
which the app does not scan and a human can move back; `--purge` is the only permanent path.
The default remains a dry run.

`tests/clean-probe-sessions.test.ts` covers the contract with a synthetic store: a human session
whose transcript contains every marker is kept; a human session under a throwaway key is kept;
plugin-only sessions, throwaway keys without a human prompt, and `--purge` remove; a `user/message`
with no source is kept; empty sessions in real workspaces are kept; the freshness brake works and
can be disabled with `--fresh-mins 0`; a quoted prompt inside a `tool/result` is not a prompt;
symlinked workspace keys are not followed; `v3` logs and non-session entries are handled; a home
without a session store exits 2.

The conservative reading of "human" has one visible cost: a check's **subagent** sessions carry a
`user/message` with `source.kind: "user"` and no `rpcId`, so a handful of them under throwaway
keys are kept as noise. That is the intended direction — a misclassified subagent costs a few
kilobytes, a misclassified human session costs a day of work.

Verified on the real store after the fix (read-only dry run, 342 sessions):

```
3 of 342 session(s) are check artifacts (throwaway workspace key: 3).
kept: has a human prompt: 331, no plugin-prompt evidence: 8
```

The session that caused the incident (the one running the command) is kept, and nothing in the
user's real workspaces is selected.

## Lessons

- **Delete on proof of ownership, never on a match of content.** Transcripts quote everything:
  source files, other tools' documentation, this page. Any string rule about content is a rule
  about what the user has read, not about what created the session.
- **A destructive maintainer tool must be able to leave the store exactly as it was.** Trash by
  default is the difference between a bug and an incident: the same mistake with `--yes` moving
  directories would have cost nothing to undo.
- **Sessions are user data with no second copy.** The harness appends to one compressed log; there
  is no snapshot, no backup, no index that can rebuild it. Treat the directory as critical.
- **A tool that deletes sessions must exclude the live ones** — age and human prompts are cheap
  guards; “it looked like a check” is not.
- The unsafe draft was never committed, but its criteria were documented in the 0.52.80 changelog
  entry and are preserved in `/tmp/clean-probe-sessions.OLD.mjs` for reproducing the failure; the
  test suite now pins the corrected rule instead.
