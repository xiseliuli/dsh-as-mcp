#!/usr/bin/env node
/**
 * Build the browser half of this DSH plugin with esbuild — a hand-rolled
 * replacement for the harness's internal `clientBundle()` preset, which is not
 * published and cannot be imported from outside the monorepo.
 *
 * The harness's web shell does not fetch plugin code as ESM modules. It fetches
 * one classic script per plugin and hands it a *registration*: the script calls
 * `window.__ModuleLoader__.load({ id, factory })`, and the shell stores the
 * factory without running it. The factory runs later ("materialization"), once,
 * and receives the synchronous `require` bound to the shell's frozen module
 * table — which is the only way a plugin can reach a shared platform singleton
 * such as React. Everything else in the bundle is inlined.
 *
 * Consequences this script exists to honour:
 *   - The factory must be SYNCHRONOUS and return its exports. The shell calls
 *     `factory(require)` and uses the return value directly
 *     (client/modules/src/client/system.ts: materialize), so returning a
 *     promise would hand the shell a Promise instead of `{ apply, inject }`.
 *   - A specifier the module table cannot answer throws at materialization.
 *     So every platform singleton must stay an `external` — and because those
 *     packages are not installed as dependencies, forgetting one is a build
 *     error rather than a silent inline.
 *   - CSS must be inlined into this one file. A separate `client.css` artifact
 *     is never fetched: the shell serves exactly `exports["./client"]`, and the
 *     sourcemap beside it.
 *   - The style tag must be appended at *factory execution* (module top level),
 *     not inside `apply()`. The shell inventories owned style tags immediately
 *     after the factory returns, and an untagged tag appearing later is never
 *     attributed to the plugin, which breaks HMR/unload bookkeeping.
 *
 * Usage:
 *   node scripts/build-client.mjs            # write lib/client.js (+ .map)
 *   node scripts/build-client.mjs --no-minify
 *   node scripts/build-client.mjs --check    # build, then validate the artifact
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = 'lib/client.js'

/**
 * Platform singletons the web shell seeds into its module table.
 *
 * Transcribed from `packages/client/web/src/platform.ts` (PLATFORM_MODULES) and
 * its projection `seed.ts` (getStaticModules). These strings are a wire
 * contract: the shell answers a `require()` only for exact keys, so a typo here
 * surfaces as a runtime "missed the module table" throw, not a build error.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Shell-preloaded external factories; empty in the current harness, kept for parity. */
const PRELOADED_CLIENT_EXTERNALS = []

/**
 * Load esbuild, resolving this package's own copy first.
 *
 * A plain `import 'esbuild'` would also pick up a hoisted copy, but naming the
 * failure keeps a missing devDependency from looking like a broken script.
 */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch (error) {
    throw new Error(
      `esbuild is required to build the client half but could not be resolved: ${error.message}\n`
      + '  Add it:  pnpm add -D esbuild',
    )
  }
}

/** The first existing client entry, or undefined. */
function findEntry() {
  for (const candidate of ['index.tsx', 'index.ts', 'index.jsx', 'index.js']) {
    const path = join(PACKAGE_ROOT, 'src', 'client', candidate)
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Inline one stylesheet as a tagged, self-injecting module.
 *
 * This mirrors the harness preset's virtual CSS loaders: the sheet becomes a
 * string plus a `<style data-plugin data-plugin-css>` append that runs when the
 * module is evaluated, i.e. during factory execution. The `querySelector` guard
 * makes re-execution (after an HMR invalidate) idempotent instead of stacking
 * duplicate tags. The `data-plugin-css` id is `<package>/<file>`, which is the
 * granularity HMR uses to identify one sheet.
 *
 * Note the loader does claim an *untagged* `<style>`, so the attributes are not
 * strictly required — but they are what the shipped ecosystem emits and what
 * makes per-sheet HMR possible.
 */
function cssInlinePlugin(id) {
  return {
    name: 'dsh-client-css-inline',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const css = await readFile(args.path, 'utf8')
        const tagId = `${id}/${basename(args.path)}`
        return {
          loader: 'js',
          // Keeps the real stylesheet in esbuild's watch graph.
          watchFiles: [args.path],
          contents: [
            `const css = ${JSON.stringify(css)};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
            '  const tag = document.createElement(\'style\');',
            `  tag.dataset.plugin = ${JSON.stringify(id)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            'export default {};',
          ].join('\n'),
        }
      })
    },
  }
}

/**
 * Emit the bundle.
 *
 * The `banner`/`footer` pair is the whole wrapper. esbuild has no `intro`
 * option, so the preset's separate `intro` line is folded into the banner; the
 * emitted bytes are identical to the harness preset's output options.
 *
 * `banner` and `footer` text is never minified, which is what protects the
 * `require` parameter name that the generated `require("react")` calls bind to.
 */
async function buildClient({ minify }) {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const id = manifest.name
  if (typeof id !== 'string' || id === '') {
    throw new Error('package.json has no name — the bundle id must equal the package name')
  }

  const entry = findEntry()
  if (entry === undefined) {
    throw new Error(
      'no client entry found. Create src/client/index.tsx (or .ts/.jsx/.js) exporting:\n'
      + '  export const inject = [\'slots\', …]   // cordis SERVICES (not package names)\n'
      + '  export function apply(ctx) { … }      // runs when those services are ready\n',
    )
  }

  const declared = manifest.dsh?.client?.external ?? []
  if (!Array.isArray(declared) || declared.some((item) => typeof item !== 'string')) {
    throw new Error('package.json dsh.client.external must be a string array')
  }
  const externals = [...new Set([...PLATFORM_MODULES, ...PRELOADED_CLIENT_EXTERNALS, ...declared])]

  const esbuild = await loadEsbuild()
  const result = await esbuild.build({
    entryPoints: { client: entry },
    outfile: join(PACKAGE_ROOT, OUT_FILE),
    bundle: true,
    // CJS: the shell's module model is lazy CJS. The banner supplies the
    // `module`/`exports` pair this format assigns to, and the footer returns it.
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    // Automatic runtime keeps JSX behind `react/jsx-runtime`, a platform word,
    // instead of injecting a classic `React` global the shell never provides.
    jsx: 'automatic',
    sourcemap: true,
    sourcesContent: true,
    minify,
    logLevel: 'warning',
    external: externals,
    // Browser bundles inline deps that probe node idioms (zustand/immer read
    // process.env.NODE_ENV). Without these, the factory throws ReferenceError at
    // materialization. The bare `process.env` key is required alongside the
    // precise one: a truthiness probe on `process.env` would otherwise survive.
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [cssInlinePlugin(id)],
    banner: {
      // The harness preset splits this across `banner` + `intro`; esbuild has no
      // `intro`, so both lines go here. Omitting the `module`/`exports` pair lets
      // the generated CJS body assign to an undefined `module`: the build still
      // succeeds and the factory throws ReferenceError at materialization in the
      // browser. `validateArtifact` checks the preamble for exactly that reason.
      js: `// This file is generated by \`node scripts/build-client.mjs\` (esbuild). Do not edit directly.\n`
        + `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n`
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  })

  for (const warning of result.warnings) {
    process.stdout.write(`[dsh-as-mcp] esbuild: ${warning.text}\n`)
  }
  return { id, entry, externals }
}

/**
 * Fail the build when the artifact could not possibly load.
 *
 * These are the checks a reviewer would otherwise do by hand against a running
 * shell, and each one corresponds to a silent-failure mode above.
 */
function validateArtifact(id) {
  const outPath = join(PACKAGE_ROOT, OUT_FILE)
  const text = readFileSync(outPath, 'utf8')
  const problems = []

  const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
  if (!text.startsWith('//') || !text.includes(banner)) {
    problems.push(`the wrapper does not register id ${JSON.stringify(id)} via window.__ModuleLoader__.load`)
  }
  // Without this preamble the generated CJS body assigns to an undefined
  // `module`: the build succeeds and every boot throws ReferenceError.
  if (!text.includes('var module = { exports: {} }; var exports = module.exports;')) {
    problems.push('the banner is missing the `var module = { exports: {} }` preamble, so the factory throws ReferenceError')
  }
  // esbuild appends the sourcemap comment after the footer, so compare the body.
  const body = text.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '')
  if (!body.trimEnd().endsWith('return module.exports; } });')) {
    problems.push('the footer is missing, so the factory returns undefined instead of its exports')
  }
  if (/(^|[^.\w])import\s*\(/.test(text)) {
    problems.push('the bundle contains a dynamic import(), which the module table cannot answer')
  }
  if (/\bfrom\s*["'](?:\.|\/)/.test(text)) {
    problems.push('the bundle still contains a static relative import — it is not bundled')
  }
  // A stray stylesheet artifact is the classic silent CSS loss: the shell only
  // ever fetches exports["./client"] and its .map.
  const libDir = join(PACKAGE_ROOT, 'lib')
  if (existsSync(libDir)) {
    const strays = readdirSync(libDir).filter((name) => name.endsWith('.css'))
    if (strays.length > 0) {
      problems.push(`lib/ contains ${strays.join(', ')} — the shell never fetches a separate stylesheet; inline it`)
    }
  }

  // Declared module-table requests must be real platform words: the shell throws
  // at materialization for anything it cannot answer.
  return problems
}

/** Confirm every declared external is one the shell can actually answer. */
function validateExternals(id, externals, manifest) {
  const declared = manifest.dsh?.client?.external ?? []
  const unknown = declared.filter((spec) => !PLATFORM_MODULES.includes(spec) && !PRELOADED_CLIENT_EXTERNALS.includes(spec))
  if (unknown.length === 0) return []
  // Not fatal on its own: another plugin row may publish the specifier. Warn so a
  // typo is visible before it becomes a runtime "missed the module table" throw.
  return [
    `dsh.client.external declares ${unknown.map((s) => JSON.stringify(s)).join(', ')} — `
    + 'not a platform word, so it must be published by another plugin row or the shell will throw at materialization',
  ]
}

async function main() {
  const argv = process.argv.slice(2)
  const minify = !argv.includes('--no-minify')
  const checkOnly = argv.includes('--check')

  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  const { id, entry, externals } = await buildClient({ minify })

  const bytes = readFileSync(join(PACKAGE_ROOT, OUT_FILE))
  const where = entry.slice(PACKAGE_ROOT.length + 1)
  process.stdout.write(`[dsh-as-mcp] client bundle ${OUT_FILE}  ${bytes.length} bytes (gzip ~${Math.round(bytes.length / 3)}) from ${where}\n`)
  process.stdout.write(`[dsh-as-mcp] externals: ${externals.length} platform words, rest inlined\n`)

  const problems = [...validateArtifact(id), ...validateExternals(id, externals, manifest)]
  for (const problem of problems) process.stdout.write(`[dsh-as-mcp] WARN ${problem}\n`)

  if (checkOnly && problems.length > 0) {
    process.exitCode = 1
    return
  }
  if (!manifest.dsh?.client) {
    process.stdout.write(
      '[dsh-as-mcp] NOTE package.json declares no dsh.client — the shell will not load this bundle yet.\n'
      + '          Add:  "dsh": { "client": { "platform": "web" } }\n'
      + '                "exports": { "./client": "./lib/client.js" }\n',
    )
  }
  if (!existsSync(join(PACKAGE_ROOT, 'lib', 'client.js.map'))) {
    process.stdout.write('[dsh-as-mcp] WARN lib/client.js.map missing; browser stack frames will not map to source\n')
  }
}

main().catch((error) => {
  process.stderr.write(`[dsh-as-mcp] client build failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
