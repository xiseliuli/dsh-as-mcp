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

// --- panel select options match the host enums -------------------------------
//
// A `select` that offers a value the host refuses is worse than a free text field:
// it looks like the supported choice. This compares each panel select against the
// exported enum array the config schema validates with, and fails when a new select
// appears without a mapping here (so it cannot drift silently).

const selectEnumByPath = {
  'session.scope': 'SESSION_SCOPES',
  'approval.policy': 'APPROVAL_POLICIES',
}
const fieldsSource = read('src/client/fields.ts')
const enumConfigSource = read('src/config.ts')

function hostEnumValues(name) {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(enumConfigSource)
  if (match === null) return undefined
  return [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1])
}

for (const block of fieldsSource.matchAll(/kind: 'select',\s*path: \[([^\]]*)\]([\s\S]*?)\]/g)) {
  const path = [...block[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]).join('.')
  const expectedName = selectEnumByPath[path]
  if (expectedName === undefined) {
    problems.push(`panel select "${path}" has no host-enum mapping in tools/check-docs.mjs`)
    continue
  }
  const hostValues = hostEnumValues(expectedName)
  if (hostValues === undefined) {
    problems.push(`could not read ${expectedName} from src/config.ts`)
    continue
  }
  const offered = [...block[2].matchAll(/\{ value: '([^']*)'/g)].map((entry) => entry[1])
  if (offered.length !== hostValues.length || offered.some((value, index) => value !== hostValues[index])) {
    problems.push(
      `panel select "${path}" offers [${offered.join(', ')}], ${expectedName} is [${hostValues.join(', ')}]`,
    )
  }
}

// --- panel number minimums match the positive-integer rule -------------------
//
// The four positive-integer settings are the ones a user can mistype most easily (a
// `0` timeout looks plausible). The panel must not offer a value the host refuses, so
// each key the config validates with `positiveInt(...)` must declare `min: 1` in the
// panel. Parsing the validator calls keeps this in step when a new bounded number is
// added.

const panelNumbers = new Map()
for (const match of fieldsSource.matchAll(/\{\s*kind: 'number',\s*path: \[([^\]]*)\]([^}]*)\}/g)) {
  const path = [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]).join('.')
  const minimum = /min:\s*(-?\d+)/.exec(match[2])
  panelNumbers.set(path, minimum === null ? undefined : Number(minimum[1]))
}
for (const match of enumConfigSource.matchAll(/positiveInt\(\s*(\w+)\s*,\s*'([^']+)'/g)) {
  // The call names the section variable and the key; that pair is the config path.
  const section = match[1]
  const key = match[2]
  const path = `${section}.${key}`
  if (!panelNumbers.has(path)) {
    problems.push(`config bounds ${path} with positiveInt but the panel has no number field for it`)
    continue
  }
  if (panelNumbers.get(path) !== 1) {
    problems.push(`panel number "${path}" has min ${String(panelNumbers.get(path))}, but the host requires a positive integer (min 1)`)
  }
}

// --- option references are translated together -------------------------------
//
// A tool option documented in one README and not the other is how `probeSearch` drifted:
// it was in the zh `dsh_info` row and absent from the en one. The set of tool rows was
// equal, so nothing noticed. This compares, per tool, which schema option names each
// README mentions at least once (as a code span); the two sets must match. It does not
// demand every option be documented, only that coverage be symmetric.

function schemaOptionsOf(source) {
  const tools = []
  for (const match of source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)) {
    const start = match.index
    const next = source.indexOf('registerTool(', start + 1)
    const segment = source.slice(start, next === -1 ? source.length : next)
    const schemaAt = segment.indexOf('inputSchema: z.object(')
    if (schemaAt === -1) continue
    const object = balanced(segment, segment.indexOf('{', schemaAt))
    if (object === undefined) continue
    const keys = []
    let indent
    for (const line of object.text.split('\n')) {
      const key = /^(\s+)([A-Za-z][A-Za-z0-9]*):/.exec(line)
      if (key === null) continue
      const width = key[1].length
      if (indent === undefined || width < indent) {
        indent = width
        keys.length = 0
      }
      if (width === indent) keys.push(key[2])
    }
    tools.push({ name: match[1], keys })
  }
  return tools
}

const enReadme = read('README.md')
const zhReadme = read('README.zh.md')
for (const tool of schemaOptionsOf(toolsSource)) {
  for (const key of tool.keys) {
    const inEn = enReadme.includes(`\`${key}\``)
    const inZh = zhReadme.includes(`\`${key}\``)
    if (inEn !== inZh) {
      problems.push(
        `README.md ${inEn ? 'documents' : 'never mentions'} option "${key}" of ${tool.name}, while README.zh.md ${inZh ? 'does' : 'does not'}`,
      )
    }
  }
}

// --- each README configuration sample matches the shipped defaults ----------
//
// The sample block is what an operator copies into a profile patch, and a patch
// *replaces* the row's config. A sample whose value differs from the default silently
// changes behaviour for everyone who copied it, so the scalars must agree with
// src/defaults.ts — in both languages. `agentTools.allow/deny: []` are excluded on
// purpose: the sample documents that empty means "use the built-in allow-list", which is
// not the default array's literal value.

const defaultsSource = read('src/defaults.ts')
const defaultsBlock = (name) => {
  const at = defaultsSource.indexOf(`export const ${name} = {`)
  return at === -1 ? undefined : balanced(defaultsSource, defaultsSource.indexOf('{', at))?.text
}
const renderDefault = (value) => (typeof value === 'string' ? value : String(value))
const sampleExpectations = [
  ['http.enabled', 'DEFAULT_HTTP'], ['http.host', 'DEFAULT_HTTP'], ['http.port', 'DEFAULT_HTTP'],
  ['http.path', 'DEFAULT_HTTP'], ['http.mountOnWebServer', 'DEFAULT_HTTP'],
  ['tools.workspace', 'DEFAULT_TOOLS'], ['tools.session', 'DEFAULT_TOOLS'], ['tools.files', 'DEFAULT_TOOLS'],
  ['tools.shell', 'DEFAULT_TOOLS'], ['tools.agentTools', 'DEFAULT_TOOLS'], ['tools.usage', 'DEFAULT_TOOLS'],
  ['session.agentPreset', 'DEFAULT_SESSION'], ['session.provider', 'DEFAULT_SESSION'],
  ['session.model', 'DEFAULT_SESSION'], ['session.promptTimeoutMs', 'DEFAULT_SESSION'],
  ['session.scope', 'DEFAULT_SESSION'],
  ['limits.maxReadBytes', 'DEFAULT_LIMITS'], ['limits.shellTimeoutMs', 'DEFAULT_LIMITS'],
  ['limits.agentToolTimeoutMs', 'DEFAULT_LIMITS'],
  ['approval.policy', 'DEFAULT_APPROVAL'],
]
for (const readmePath of ['README.md', 'README.zh.md']) {
  const sampleMatch = /```yaml\n(- id: dsh-as-mcp[\s\S]*?)```/.exec(read(readmePath))
  if (sampleMatch === null) {
    problems.push(`${readmePath} has no yaml configuration sample beginning with "- id: dsh-as-mcp"`)
    continue
  }
  const sample = new Map()
  let section
  for (const line of sampleMatch[1].split('\n')) {
    const sectionMatch = /^ {4}([a-zA-Z]+):\s*$/.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1]
      continue
    }
    const keyMatch = /^ {6}([a-zA-Z]+):\s*(.*)$/.exec(line)
    if (keyMatch === null || section === undefined) continue
    const raw = keyMatch[2].replace(/\s+#.*$/, '').trim()
    sample.set(`${section}.${keyMatch[1]}`, raw)
  }
  for (const [path, constantName] of sampleExpectations) {
    const [, leaf] = path.split('.')
    const block = defaultsBlock(constantName)
    if (block === undefined) {
      problems.push(`could not read ${constantName} from src/defaults.ts`)
      continue
    }
    const declared = new RegExp(`^\\s+${leaf}:\\s*(.+?),?$`, 'm').exec(block)
      ?? new RegExp(`\\b${leaf}:\\s*([^,}\\n]+)`).exec(block)
    if (declared === null) {
      problems.push(`could not find ${leaf} in ${constantName}`)
      continue
    }
    let value
    try {
      value = new Function(`return (${declared[1].replaceAll('_', '')})`)()
    } catch {
      problems.push(`could not evaluate ${constantName}.${leaf} = ${declared[1]}`)
      continue
    }
    const claimedRaw = sample.get(path)
    if (claimedRaw === undefined) {
      problems.push(`${readmePath} sample omits ${path}`)
      continue
    }
    // YAML writes an empty string as `''`; the value it denotes is the empty string.
    const claimed = claimedRaw === "''" ? '' : claimedRaw
    if (claimed !== renderDefault(value)) {
      problems.push(`${readmePath} sample says ${path}: ${claimedRaw}, the default is ${JSON.stringify(renderDefault(value))}`)
    }
  }
  for (const leaf of ['allow', 'deny']) {
    if (sample.get(`agentTools.${leaf}`) !== '[]') {
      problems.push(`${readmePath} sample must show agentTools.${leaf}: [] (empty means the built-in allow-list)`)
    }
  }
}

// --- documented caps match the constants they describe ----------------------
//
// These numbers are stated in prose and enforced in code. A cap raised in one place and
// not the other is a lie in documentation that no other check owns.

const readmeText = read('README.md')
const claimChecks = [
  { file: 'src/dsh/driver.ts', name: 'MAX_IMAGE_BYTES', readme: /Capped at (\d+) MiB/, compute: (value) => value / (1024 * 1024), unit: 'MiB image cap' },
  { file: 'src/mcp/http.ts', name: 'MAX_REQUEST_BYTES', readme: /over (\d+) MiB/, compute: (value) => value / (1024 * 1024), unit: 'MiB request-body cap' },
  { file: 'src/dsh/driver.ts', name: 'MAX_PROMPT_IMAGES', readme: /at most (\d+);/, compute: (value) => value, unit: 'prompt images' },
  { file: 'src/dsh/driver.ts', name: 'MAX_SHELL_JOBS', readme: /At most (\d+) jobs/, compute: (value) => value, unit: 'background jobs' },
  { file: 'src/dsh/ownership.ts', name: 'MAX_OWNED_SESSIONS', readme: /newest (\d+) ids/, compute: (value) => value, unit: 'remembered owned ids' },
]
for (const spec of claimChecks) {
  const source = read(spec.file)
  const declaration = new RegExp(`const ${spec.name} = ([0-9_* ()]+)`).exec(source)
  if (declaration === null) {
    problems.push(`could not find ${spec.name} in ${spec.file}`)
    continue
  }
  let value
  try {
    value = Number(new Function(`return ${declaration[1].replaceAll('_', '')}`)())
  } catch {
    problems.push(`could not evaluate ${spec.name} = ${declaration[1]}`)
    continue
  }
  const expected = spec.compute(value)
  const claimed = spec.readme.exec(readmeText)
  if (claimed === null) {
    problems.push(`README.md no longer states the ${spec.unit}`)
  } else if (Number(claimed[1]) !== expected) {
    problems.push(`README.md claims ${claimed[1]} for the ${spec.unit}, the code says ${expected}`)
  }
}

// --- the tool count in docs/CAPABILITY-GAPS.md's opening line ----------------
//
// The appendix count is checked above; the sentence that introduces the page carried a
// stale 25 for several releases because nothing compared it with the code.

const gapsIntro = read('docs/CAPABILITY-GAPS.md')
const introCount = /MCP server with \*\*(\d+) tools\*\* today/.exec(gapsIntro)
if (introCount === null) {
  problems.push('docs/CAPABILITY-GAPS.md no longer states its tool count in the opening line')
} else if (Number(introCount[1]) !== registered.length) {
  problems.push(
    `docs/CAPABILITY-GAPS.md opens by claiming ${introCount[1]} tools, the code registers ${registered.length}`,
  )
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
for (const required of ['lib', 'bin', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'CHANGELOG.zh.md']) {
  if (!files.includes(required)) problems.push(`package.json files is missing "${required}"`)
}

// --- the git-install build approval matches the package's own identity -----
//
// A git install has to build `lib/` (it is gitignored), and pnpm only runs that
// build for an exact `allowBuilds` key: `<name>@<repository url>`, with no
// `#<ref>`. The README that hands readers that key is prose; renaming the
// package or the repository would leave it matching nothing, and every reader
// copying it would hit the same ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED the text
// exists to resolve. Issue #1 was exactly this failure reaching a reader without
// that key. Both languages must carry it, and the warning must disappear
// together with the condition that causes it: drop the `prepare` script and
// commit `lib/`, and this check stops demanding the paragraph.
const gitignore = read('.gitignore')
const prepareScript = typeof pkg.scripts?.prepare === 'string' && pkg.scripts.prepare !== ''
const buildOutputIgnored = /^lib\/$/m.test(gitignore)
if (prepareScript && buildOutputIgnored) {
  const allowBuildsKey = `${pkg.name}@${pkg.repository?.url ?? ''}`
  for (const [path, text] of [['README.md', enReadme], ['README.zh.md', zhReadme]]) {
    if (!text.includes(allowBuildsKey)) {
      problems.push(`${path}: git installs run prepare (lib/ is gitignored), so it must carry the allowBuilds key "${allowBuildsKey}"`)
    }
    if (!text.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED')) {
      problems.push(`${path}: git installs run prepare (lib/ is gitignored), so it must name ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED and how to clear it`)
    }
  }
  notes.push(`git-install build approval: ${allowBuildsKey}`)
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
  // `page.*` is the panel's own heading, asked for only by the Plugins-page cell
  // (the settings shell titles its page in the nav). The rest are the section's
  // long-standing namespaces; the scan needs to know every one, or a live key
  // looks unreferenced.
  for (const match of source.matchAll(/'((?:nav|intro|page|group|field|client|state)(?:\.[A-Za-z0-9_]+)+)'/g)) {
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
// --- the Chinese changelog mirrors the same versions -------------------------
//
// `CHANGELOG.zh.md` is a summary, not a translation: what must match is the set
// and the order of version headings, because a release that forgets its Chinese
// entry would otherwise leave Chinese readers a version behind with no signal.
// Bullet counts deliberately do not match — the summary may collapse detail.
const changelogZh = read('CHANGELOG.zh.md')
if (changelogZh === '') {
  problems.push('CHANGELOG.zh.md is missing (the Chinese summary of this changelog)')
} else {
  const zhHeadings = [...changelogZh.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map((match) => match[1])
  if (zhHeadings.length === 0) problems.push('CHANGELOG.zh.md: no "## x.y.z" headings')
  const missingVersions = headings.filter((version) => !zhHeadings.includes(version))
  const extraVersions = zhHeadings.filter((version) => !headings.includes(version))
  if (missingVersions.length > 0) {
    problems.push(`CHANGELOG.zh.md is missing ${missingVersions.length} version(s): ${missingVersions.slice(0, 5).join(', ')}`)
  }
  if (extraVersions.length > 0) {
    problems.push(`CHANGELOG.zh.md has version heading(s) this changelog does not: ${extraVersions.slice(0, 5).join(', ')}`)
  }
  if (zhHeadings.join(',') !== headings.join(',')) {
    problems.push('CHANGELOG.zh.md: version headings are not in the same newest-first order')
  }
  // Every version must carry at least one bullet — a bare heading is a slot the
  // release filled in without saying anything.
  const sections = changelogZh.split(/^## /m).slice(1)
  const emptySections = sections.filter((section) => !/^- /m.test(section))
  if (emptySections.length > 0) {
    problems.push(`CHANGELOG.zh.md: ${emptySections.length} version(s) have no Chinese bullet`)
  }
  notes.push(`CHANGELOG.zh.md mirrors ${zhHeadings.length} version(s)`)
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
