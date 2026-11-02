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
