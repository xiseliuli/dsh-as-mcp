/**
 * The section's fields, declared once.
 *
 * Rendering and writing both read this list, so a field cannot be displayed
 * with one path and written to another — the class of bug that a hand-written
 * form makes easy and that a reviewer cannot see.
 *
 * @module dsh-as-mcp/client/fields
 */

/**
 * How a field is edited.
 *
 * `list` is a comma-separated editor for a host `string[]` field. It exists
 * because a settings namespace holds JSON values but the panel's controls are
 * deliberately few, and an array otherwise has no way to be displayed at all —
 * which is how the allow-list shipped configurable only by hand-editing YAML.
 */
export type FieldKind = 'toggle' | 'text' | 'number' | 'select' | 'list'

/** One editable setting. */
export interface FieldSpec {
  /** Path inside the settings namespace, e.g. `['http','port']`. */
  readonly path: readonly string[]
  /** Locale key for the label. */
  readonly label: string
  /** Locale key for the explanatory line under the control. */
  readonly hint?: string
  readonly kind: FieldKind
  /** Only for `select`. */
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  /** Only for `number`: the inclusive range the host schema accepts. */
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly placeholder?: string
}

/** A titled group of fields. */
export interface GroupSpec {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly fields: readonly FieldSpec[]
}

/**
 * Every field, grouped for display.
 *
 * Bounds mirror the host schema in `src/config.ts`; the host remains the
 * authority and the panel merely avoids offering a value that would be refused.
 */
export const GROUPS: readonly GroupSpec[] = [
  {
    id: 'endpoint',
    title: 'group.endpoint.title',
    description: 'group.endpoint.description',
    fields: [
      { kind: 'toggle', path: ['http', 'enabled'], label: 'field.http.enabled', hint: 'field.http.enabled.hint' },
      { kind: 'text', path: ['http', 'host'], label: 'field.http.host', hint: 'field.http.host.hint' },
      { kind: 'number', path: ['http', 'port'], label: 'field.http.port', hint: 'field.http.port.hint', min: 0, max: 65535 },
      { kind: 'text', path: ['http', 'path'], label: 'field.http.path', hint: 'field.http.path.hint' },
      {
        kind: 'toggle',
        path: ['http', 'mountOnWebServer'],
        label: 'field.http.mountOnWebServer',
        hint: 'field.http.mountOnWebServer.hint',
      },
    ],
  },
  {
    id: 'tools',
    title: 'group.tools.title',
    description: 'group.tools.description',
    fields: [
      { kind: 'toggle', path: ['tools', 'workspace'], label: 'field.tools.workspace', hint: 'field.tools.workspace.hint' },
      { kind: 'toggle', path: ['tools', 'session'], label: 'field.tools.session', hint: 'field.tools.session.hint' },
      { kind: 'toggle', path: ['tools', 'files'], label: 'field.tools.files', hint: 'field.tools.files.hint' },
      { kind: 'toggle', path: ['tools', 'shell'], label: 'field.tools.shell', hint: 'field.tools.shell.hint' },
      {
        kind: 'toggle',
        path: ['tools', 'agentTools'],
        label: 'field.tools.agentTools',
        hint: 'field.tools.agentTools.hint',
      },
    ],
  },
  {
    id: 'agentTools',
    title: 'group.agentTools.title',
    description: 'group.agentTools.description',
    fields: [
      {
        kind: 'list',
        path: ['agentTools', 'allow'],
        label: 'field.agentTools.allow',
        hint: 'field.agentTools.allow.hint',
        placeholder: 'read, write, bash',
      },
      {
        kind: 'list',
        path: ['agentTools', 'deny'],
        label: 'field.agentTools.deny',
        hint: 'field.agentTools.deny.hint',
        placeholder: 'bash, pwsh',
      },
    ],
  },
  {
    id: 'session',
    title: 'group.session.title',
    description: 'group.session.description',
    fields: [
      { kind: 'text', path: ['session', 'agentPreset'], label: 'field.session.agentPreset', hint: 'field.session.agentPreset.hint' },
      { kind: 'text', path: ['session', 'provider'], label: 'field.session.provider', hint: 'field.session.provider.hint' },
      { kind: 'text', path: ['session', 'model'], label: 'field.session.model', hint: 'field.session.model.hint' },
      {
        kind: 'number',
        path: ['session', 'promptTimeoutMs'],
        label: 'field.session.promptTimeoutMs',
        hint: 'field.session.promptTimeoutMs.hint',
        min: 0,
      },
    ],
  },
  {
    id: 'limits',
    title: 'group.limits.title',
    description: 'group.limits.description',
    fields: [
      { kind: 'number', path: ['limits', 'maxReadBytes'], label: 'field.limits.maxReadBytes', hint: 'field.limits.maxReadBytes.hint', min: 1 },
      { kind: 'number', path: ['limits', 'shellTimeoutMs'], label: 'field.limits.shellTimeoutMs', hint: 'field.limits.shellTimeoutMs.hint', min: 0 },
      {
        kind: 'number',
        path: ['limits', 'agentToolTimeoutMs'],
        label: 'field.limits.agentToolTimeoutMs',
        hint: 'field.limits.agentToolTimeoutMs.hint',
        min: 0,
      },
    ],
  },
  {
    id: 'approval',
    title: 'group.approval.title',
    description: 'group.approval.description',
    fields: [
      {
        kind: 'select',
        path: ['approval', 'policy'],
        label: 'field.approval.policy',
        hint: 'field.approval.policy.hint',
        options: [
          { value: 'inherit', label: 'field.approval.policy.inherit' },
          { value: 'allow', label: 'field.approval.policy.allow' },
        ],
      },
    ],
  },
]

/** Read one path out of a resolved settings value. */
export function readPath(value: unknown, path: readonly string[]): unknown {
  let node: unknown = value
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** The dotted form, used as a stable React key and as the copyable path. */
export function pathKey(path: readonly string[]): string {
  return path.join('.')
}

/**
 * Render a `string[]` field for the comma-separated editor.
 *
 * Joining with ", " rather than "," keeps the value readable when the operator
 * reopens the panel, and both separators are accepted on the way back in, so a
 * paste of one-name-per-line works.
 */
export function formatList(value: unknown): string {
  return Array.isArray(value) ? value.map((entry) => String(entry)).join(', ') : ''
}

/** Parse the editor's text back into the `string[]` the host stores. */
export function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}
