# dsh-plugins

Plugin development workspace for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

## Packages

| Package | What it is |
| --- | --- |
| [`dsh-as-mcp`](packages/dsh-as-mcp) | Exposes a running DSH instance as an MCP server, so other agents can create workspaces, start sessions, write code through DSH, read and write files, and run commands. |

## Layout

```
packages/<name>/
  src/              TypeScript sources
  tests/            vitest suites
  bin/              executables shipped with the package
  cordis.patch.yml  the bundle patch layer this plugin contributes to a profile
  lib/              build output (git-ignored)
```

A DSH plugin is a Cordis plugin: it exports `name`, optionally `inject` and a `Config` schema,
and an `apply(ctx, config)`. Packaging it as a **bundle** — `dsh.bundle.patch` in
`package.json` pointing at `cordis.patch.yml` — is what lets `dsh plugin add <pkg>` install it
and have its plugin row and defaults appear in the target profile with no manual editing.

## Working on a plugin

```bash
pnpm install
pnpm build       # tsdown, all packages
pnpm typecheck
pnpm test
pnpm check       # typecheck + test
```

Then mount it into a profile and confirm the layer composed:

```bash
dsh plugin add ./packages/<name>
dsh --profile <name> --dump-config | grep -A 30 '# == <name>'
```

Bundle patches and the bundle list are snapshotted at boot, so **restart DSH** to pick up code
or patch changes. Only the profile's own `cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml`
are hot-reloaded.

## Conventions

- **Declare no `@deepseek-ai/*` peer dependency unless you must.** DSH checks every declared
  `@deepseek-ai/dsh-*` range against the single running runtime version, so a peer range is a
  compatibility gate, and an optional peer that fails to install becomes a load-time import
  error. Resolve capabilities structurally through `ctx.get(name)` instead, and report a
  missing service as one clear tool error.
- **`@deepseek-ai/schemastery` is not required for config.** Cordis validates a plugin's
  `Config` through [Standard Schema](https://standardschema.dev)
  (`config["~standard"].validate(raw)`), so any Standard Schema implementation works — and so
  does a hand-written one.
- **Verify against the harness that actually ships.** The `@deepseek-ai/dsh-*` packages on npm
  lag the harness bundled inside the Desktop app; check the installed runtime before trusting
  published types.
- TypeScript: `target`/`module` `es2024`/`esnext`, `moduleResolution: bundler`,
  `noUncheckedIndexedAccess`, `noUnusedLocals`. Build with `tsdown`.
