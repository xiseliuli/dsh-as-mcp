#!/usr/bin/env node
/**
 * Documentation drift check.
 *
 * Every item here is a drift this project actually shipped at least once: the
 * tool table listed 26 of 27 tools (a row that looked applied but was not), the
 * zh table had 24 rows and a duplicated `session_create`, and a changelog heading
 * could disagree with `package.json`. Instructions that are only prose drift
 * silently; this makes the check executable so a mismatch fails the release.
 *
 * It is intentionally strict about *sets* and lenient about wording: a row may
 * say anything, but the set of rows must equal the set of tools the code
 * registers, with no duplicate rows in either language.
 *
 * @module dsh-as-mcp/tools/check-docs
 */

import { existsSync, readFileSync } from 'node:fs'

const problems = []
const notes = []

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    problems.push(`missing file: ${path}`)
    return ''
  }
}

// --- tools registered by the code -----------------------------------------

const toolsSource = read('src/mcp/tools.ts')
const registered = [...new Set(
  [...toolsSource.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((match) => match[1]),
)].sort()
if (registered.length === 0) problems.push('could not read any registerTool() names from src/mcp/tools.ts')

// --- every input-schema option reaches the driver --------------------------
//
// Shipped three times: a new option was added to `inputSchema` and the handler
// never passed it on, so the call accepted the argument and ignored it (0.46.0's
// turn range, 0.50.0's read hash, 0.51.0's listing hash). The schema is the
// contract a caller reads; an option that does not reach `args.<name>` in the
// handler body is dead. This parses each registerTool block and checks exactly
// that, so the mistake fails the release instead of the acceptance run.

/** The text between the first `{`/`(` after `from` and its match. */
function balanced(source, from) {
  let depth = 0
  let started = false
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(' || char === '{' || char === '[') {
      depth += 1
      started = true
    } else if (char === ')' || char === '}' || char === ']') {
      depth -= 1
      if (started && depth === 0) return { text: source.slice(from, index + 1), end: index }
    }
  }
  return undefined
}

const toolBlocks = [...toolsSource.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((match) => ({
  name: match[1],
  start: match.index,
  end: toolsSource.indexOf('registerTool(', match.index + 1) === -1
    ? toolsSource.length
    : toolsSource.indexOf('registerTool(', match.index + 1),
}))
for (const block of toolBlocks) {
  const text = toolsSource.slice(block.start, block.end)
  const schemaAt = text.indexOf('inputSchema: z.object(')
  if (schemaAt === -1) continue
  const object = balanced(text, text.indexOf('{', schemaAt))
  if (object === undefined) continue
  // Top-level keys: the lines with the smallest indentation inside the object.
  const keys = []
  let keyIndent
  for (const line of object.text.split('\n')) {
    const match = /^(\s+)([A-Za-z][A-Za-z0-9]*):/.exec(line)
    if (match === null) continue
    const indent = match[1].length
    if (keyIndent === undefined || indent < keyIndent) {
      keyIndent = indent
      keys.length = 0
    }
    if (indent === keyIndent) keys.push(match[2])
  }
  const guardAt = text.indexOf(`guard('${block.name}'`)
  if (guardAt === -1) {
    problems.push(`${block.name}: has an inputSchema but no guard() body to inspect`)
    continue
  }
  const body = text.slice(guardAt)
  for (const key of keys) {
    if (!body.includes(`args.${key}`)) {
      problems.push(
        `${block.name}: inputSchema option "${key}" never reaches the driver (no args.${key} in its guard body)`,
      )
    }
  }
}

// --- the probe count in docs/CAPABILITY-GAPS.md -----------------------------
//
// That page's appendix states how many capability probes `dsh_info.harnessServices`
// reports. The number drifted once already (a probe was added and the table was not),
// and a stale count there is a claim about the code that no other check owns.

const driverSource = read('src/dsh/driver.ts')
const describeAt = driverSource.indexOf('describeCapabilities(): Record<string, boolean> {')
if (describeAt === -1) {
  problems.push('could not find describeCapabilities() in src/dsh/driver.ts')
} else {
  const returnAt = driverSource.indexOf('return {', describeAt)
  const probeObject = returnAt === -1 ? undefined : balanced(driverSource, driverSource.indexOf('{', returnAt))
  if (probeObject === undefined) {
    problems.push('could not read the probe object of describeCapabilities()')
  } else {
    const probes = []
    let indent
    for (const line of probeObject.text.split('\n')) {
      const match = /^(\s+)([A-Za-z][A-Za-z0-9]*):/.exec(line)
      if (match === null) continue
      if (indent === undefined || match[1].length < indent) {
        indent = match[1].length
        probes.length = 0
      }
      if (match[1].length === indent) probes.push(match[2])
    }
    const claim = read('docs/CAPABILITY-GAPS.md')
      .match(/Services the plugin probes \(`dsh_info\.harnessServices`\) \| (\d+) \|/)
    if (claim === null) {
      problems.push('docs/CAPABILITY-GAPS.md no longer states the capability-probe count')
    } else if (Number(claim[1]) !== probes.length) {
      problems.push(
        `docs/CAPABILITY-GAPS.md says ${claim[1]} capability probes, describeCapabilities() reports ${probes.length}`,
      )
    } else {
      notes.push(`capability probes: ${probes.length} (matches docs/CAPABILITY-GAPS.md)`)
    }
  }
}

// --- the tool tables in both READMEs --------------------------------------

function tableRows(path, heading) {
  const text = read(path)
  const start = text.indexOf(heading)
  if (start === -1) {
    problems.push(`${path}: no "${heading}" section`)
    return []
  }
  const end = text.indexOf('\n## ', start + heading.length)
  const section = text.slice(start, end === -1 ? undefined : end)
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1])
  return rows
}

for (const [path, heading] of [['README.md', '## Tools'], ['README.zh.md', '## 工具']]) {
  const rows = tableRows(path, heading)
  const seen = new Set()
  const duplicates = []
  for (const name of rows) {
    if (seen.has(name)) duplicates.push(name)
    seen.add(name)
  }
  if (duplicates.length > 0) problems.push(`${path}: duplicate tool rows: ${duplicates.join(', ')}`)
  const missing = registered.filter((tool) => !seen.has(tool))
  const extra = [...seen].filter((name) => !registered.includes(name))
  if (missing.length > 0) problems.push(`${path}: tools documented nowhere in the table: ${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`${path}: table names tools the code does not register: ${extra.join(', ')}`)
  notes.push(`${path}: ${seen.size} tool row(s)`)
}

// --- configuration keys: code vs README sample vs settings panel -----------

const configSource = read('src/config.ts')
const known = new Map()
for (const match of configSource.matchAll(/rejectUnknown\(\s*\w+,\s*\[([^\]]*)\],\s*'([A-Za-z0-9]+)'/g)) {
  // The root call guards the section list itself; the plugin has no `config.x` setting.
  if (match[2] === 'config') continue
  const keys = [...match[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((entry) => entry[1])
  known.set(match[2], new Set(keys))
}
if (known.size === 0) problems.push('could not read any rejectUnknown() sections from src/config.ts')

/**
 * Leaf paths in the YAML-ish configuration sample (auth.token may be absent).
 *
 * The configuration sample is the yaml block inside the Configuration section that
 * actually contains `config:`; a README has other yaml blocks (install commands,
 * client configs) and the first one is not the settings table.
 */
function sampleKeys(path, heading) {
  const text = read(path)
  const start = text.indexOf(heading)
  if (start === -1) {
    problems.push(`${path}: no "${heading}" section`)
    return new Set()
  }
  const end = text.indexOf('\n## ', start + heading.length)
  const section = text.slice(start, end === -1 ? undefined : end)
  const block = [...section.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((candidate) => candidate.includes('config:'))
  if (block === undefined) {
    problems.push(`${path}: no yaml configuration sample with "config:" in "${heading}"`)
    return new Set()
  }
  const paths = new Set()
  const stack = []
  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const match = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.*)$/)
    if (match === null) continue
    const depth = Math.floor(match[1].length / 2)
    stack.length = depth
    stack[depth] = match[2]
    // `config:` and the section names have no value; leaves do.
    if (match[1].length >= 4 && match[3] !== '' && depth >= 2) {
      // The sample nests every setting under `config:`; strip that level so the
      // paths match the config's own section names.
      const path = stack.slice(1, depth + 1).join('.')
      paths.add(path.startsWith('config.') ? path.slice('config.'.length) : path)
    }
  }
  return paths
}

const configOptional = new Set(['auth.token'])
for (const [path, heading] of [['README.md', '## Configuration'], ['README.zh.md', '## 配置']]) {
  const sample = sampleKeys(path, heading)
  const sampleLeaves = [...sample].filter((key) => key.includes('.'))
  for (const key of sampleLeaves) {
    const [section, leaf] = key.split('.')
    if (known.get(section)?.has(leaf) !== true) problems.push(`${path}: sample sets ${key}, which the config does not accept`)
  }
  for (const [section, leaves] of known) {
    for (const leaf of leaves) {
      const key = `${section}.${leaf}`
      if (configOptional.has(key)) continue
      if (!sampleLeaves.includes(key)) problems.push(`${path}: sample omits the ${key} setting`)
    }
  }
  for (const key of [...sampleLeaves]) {
    if (!known.has(key.split('.')[0])) problems.push(`${path}: sample has an unknown section in ${key}`)
  }
  notes.push(`${path}: ${sampleLeaves.length} configuration key(s)`)
}

// The settings panel must expose every non-secret setting; a config key with no
// field silently disappears from the panel, and a field for a key the config does
// not accept writes nothing.
const fieldSource = read('src/client/fields.ts')
const panel = new Set(
  [...fieldSource.matchAll(/path:\s*\['([A-Za-z0-9]+)',\s*'([A-Za-z0-9_]+)'\]/g)]
    .map((match) => `${match[1]}.${match[2]}`),
)
if (panel.size === 0) problems.push('could not read any settings-panel paths from src/client/fields.ts')
for (const [section, leaves] of known) {
  for (const leaf of leaves) {
    const key = `${section}.${leaf}`
    if (configOptional.has(key)) continue
    if (!panel.has(key)) problems.push(`settings panel has no field for ${key}`)
  }
}
for (const key of panel) {
  const [section, leaf] = key.split('.')
  if (known.get(section)?.has(leaf) !== true) problems.push(`settings panel has a field for ${key}, which the config does not accept`)
}
notes.push(`settings panel: ${panel.size} field path(s)`)

// --- version, changelog, and the files that ship --------------------------

const pkg = JSON.parse(read('package.json'))
const changelog = read('CHANGELOG.md')
const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((match) => match[1])
if (headings.length === 0) {
  problems.push('CHANGELOG.md: no "## x.y.z" headings')
} else {
  if (headings[0] !== pkg.version) {
    problems.push(`CHANGELOG.md: newest heading is ${headings[0]}, package.json is ${pkg.version}`)
  }
  if (!headings.includes(pkg.version)) problems.push(`CHANGELOG.md: no entry for ${pkg.version}`)
}

const files = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of files) {
  // These are maintainer-only; shipping any of them makes the package larger and
  // exposes test doubles as if they were API.
  if (['tools', 'src', 'tests'].some((dir) => entry === dir || entry.startsWith(`${dir}/`))) {
    problems.push(`package.json files: "${entry}" is maintainer-only`)
  }
  if (!existsSync(entry)) problems.push(`package.json files: "${entry}" does not exist`)
}
for (const required of ['lib', 'bin', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md']) {
  if (!files.includes(required)) problems.push(`package.json files is missing "${required}"`)
}

// --- settings panel localization ------------------------------------------

const localesSource = read('src/client/locales.ts')
const dictionaryOf = (name) => {
  const start = localesSource.indexOf(`export const ${name}`)
  if (start === -1) {
    problems.push(`src/client/locales.ts: no ${name} dictionary`)
    return new Set()
  }
  // One dictionary per `export const`; slicing to the next export keeps the zh
  // scan from swallowing the en block (which made a missing zh key invisible).
  const next = localesSource.indexOf('export const ', start + 1)
  const rest = localesSource.slice(start, next === -1 ? undefined : next)
  const block = rest.indexOf('{')
  const end = rest.lastIndexOf('}')
  const text = rest.slice(block, end)
  return new Set(
    [...text.matchAll(/(?:^|\n)\s*'?([A-Za-z][A-Za-z0-9_.]*)'?\s*:/g)].map((match) => match[1]),
  )
}
const zhKeys = dictionaryOf('zh')
const enKeys = dictionaryOf('en')
if (zhKeys.size === 0 || enKeys.size === 0) {
  problems.push('src/client/locales.ts: could not read both dictionaries')
} else {
  for (const key of zhKeys) {
    if (!enKeys.has(key)) problems.push(`locales: "${key}" is translated only to Chinese`)
  }
  for (const key of enKeys) {
    if (!zhKeys.has(key)) problems.push(`locales: "${key}" is translated only to English`)
  }
}

const clientSources = [
  'src/client/fields.ts',
  'src/client/section.tsx',
  'src/client/index.tsx',
  'src/client/snippet.ts',
  'src/client/contract.ts',
].map((path) => ({ path, source: existsSync(path) ? read(path) : '' }))
const referenced = new Set()
const templatePrefixes = new Set()
for (const { source } of clientSources) {
  for (const match of source.matchAll(/'((?:nav|intro|group|field|client|state)(?:\.[A-Za-z0-9_]+)+)'/g)) {
    referenced.add(match[1])
  }
  // A few keys are composed at runtime, e.g. t(`client.tokenSource.${source}`):
  // treat every dictionary key under that prefix as referenced.
  for (const match of source.matchAll(/`([A-Za-z0-9_.]+)\.\$\{/g)) templatePrefixes.add(match[1])
}
for (const key of zhKeys) {
  for (const prefix of templatePrefixes) {
    if (key === prefix || key.startsWith(`${prefix}.`)) referenced.add(key)
  }
}
if (referenced.size === 0) problems.push('could not read any localized key references from src/client')
const unusual = [...referenced].filter((key) => key.startsWith('field.') || key.startsWith('client.') || key.startsWith('group.'))
for (const key of unusual) {
  if (!zhKeys.has(key)) problems.push(`settings panel uses "${key}", which the dictionaries do not define`)
}
const dead = [...zhKeys].filter((key) => !referenced.has(key) && !['nav', 'intro'].includes(key))
if (dead.length > 0) notes.push(`unreferenced dictionary keys: ${dead.join(', ')}`)
notes.push(`localization: ${zhKeys.size} key(s) in each dictionary, ${referenced.size} referenced`)

// --- changelog shape and cross-document version claims --------------------

if (headings.length > 1) {
  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1]
    const current = headings[index]
    if (!(previous.localeCompare(current, undefined, { numeric: true }) > 0)) {
      problems.push(`CHANGELOG.md: ${previous} is not newer than the entry after it (${current})`)
      break
    }
  }
  const duplicates = headings.filter((version, index) => headings.indexOf(version) !== index)
  if (duplicates.length > 0) problems.push(`CHANGELOG.md: duplicate version headings: ${[...new Set(duplicates)].join(', ')}`)
}
// Live-verification rows cite the version that shipped each behaviour. A cited
// version that has no changelog entry is either a typo or a behaviour described
// against a release that never happened; both are worth failing on.
const released = new Set([...headings, pkg.version])
const verification = read('docs/LIVE-VERIFICATION.md')
if (verification !== '') {
  const cited = new Set(
    [...verification.matchAll(/(?<![\w.-])(\d+\.\d+\.\d+)(?![\w.-])/g)].map((match) => match[1]),
  )
  for (const version of cited) {
    if (!released.has(version)) problems.push(`docs/LIVE-VERIFICATION.md cites ${version}, which has no changelog entry`)
  }
  notes.push(`LIVE-VERIFICATION cites ${cited.size} version(s)`)
}
// The capability audit restates the tool count; restating it by hand is exactly
// how "25 tools" survived three releases.
const gaps = read('docs/CAPABILITY-GAPS.md')
const countClaim = gaps.match(/12 \((\d+) as of plugin ([0-9.]+)\)/)
if (countClaim !== null) {
  if (Number(countClaim[1]) !== registered.length) {
    problems.push(`docs/CAPABILITY-GAPS.md says ${countClaim[1]} tools, the code registers ${registered.length}`)
  }
  if (!released.has(countClaim[2])) problems.push(`docs/CAPABILITY-GAPS.md says "as of plugin ${countClaim[2]}", which has no changelog entry`)
}

// --- doc links resolve ----------------------------------------------------

for (const path of ['README.md', 'README.zh.md']) {
  const text = read(path)
  for (const match of text.matchAll(/`(docs\/[A-Za-z0-9._-]+\.md)`/g)) {
    if (!existsSync(match[1])) problems.push(`${path}: links ${match[1]}, which does not exist`)
  }
  // The scripts the README tells people to run must exist too.
  for (const match of text.matchAll(/node (tools\/[A-Za-z0-9._-]+\.mjs|scripts\/[A-Za-z0-9._-]+\.mjs)/g)) {
    if (!existsSync(match[1])) problems.push(`${path}: tells readers to run ${match[1]}, which does not exist`)
  }
}

// --- report ---------------------------------------------------------------

for (const note of notes) process.stdout.write(`  ok: ${note}\n`)
if (problems.length === 0) {
  process.stdout.write(`docs consistent: ${registered.length} tools, version ${pkg.version}\n`)
  process.exit(0)
}
for (const problem of problems) process.stderr.write(`  DRIFT: ${problem}\n`)
process.exit(1)
