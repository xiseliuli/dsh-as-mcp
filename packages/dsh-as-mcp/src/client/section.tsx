import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { Config } from '../config.js'
import type { EndpointStatus } from '../status.js'
import type { SettingsPathOp, SettingsScopeSnapshot } from './contract.js'
import { GROUPS, pathKey, readPath, type FieldSpec, type GroupSpec } from './fields.js'

/** The bound settings namespace, as the section consumes it. */
export interface SectionStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): SettingsScopeSnapshot<Config>
  mutate(ops: readonly SettingsPathOp[], revision?: number): Promise<void>
  /** Whether a token is pinned. The literal never leaves the host. */
  secretIsSet(): boolean
  /** Live endpoint state, or `undefined` when the host route is not reachable. */
  readStatus(): Promise<EndpointStatus | undefined>
}

/** Props the slot hands this component. */
export interface SectionProps {
  t(key: string): string
  store: SectionStore
  /** Where the generated token lives, for the copyable client configuration. */
  tokenFile: string
}

/**
 * Commit on blur, not on every keystroke.
 *
 * A settings write is a round trip through the host document, so writing per
 * character would queue a request per character. Holding a local draft also
 * means a value arriving from another surface cannot overwrite what the user is
 * currently typing.
 */
function DraftInput({
  value,
  disabled,
  placeholder,
  type,
  min,
  max,
  onCommit,
}: {
  value: string
  disabled: boolean
  placeholder?: string
  type: 'text' | 'number' | 'password'
  min?: number
  max?: number
  onCommit(next: string): void
}) {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)

  useEffect(() => {
    if (!editing.current) setDraft(value)
  }, [value])

  return (
    <input
      className="dshmcp_input"
      type={type}
      value={draft}
      disabled={disabled}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      onFocus={() => {
        editing.current = true
      }}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
      onBlur={() => {
        editing.current = false
        if (draft !== value) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'Escape' && editing.current) {
          editing.current = false
          setDraft(value)
          ;(event.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

/** One labelled control. */
function FieldRow({
  t,
  field,
  value,
  disabled,
  onWrite,
}: {
  t(key: string): string
  field: FieldSpec
  value: unknown
  disabled: boolean
  onWrite(next: unknown): void
}) {
  const stacked = field.kind === 'text' || field.kind === 'number'
  return (
    <label className={`dshmcp_row${stacked ? ' dshmcp_rowStack' : ''}`} data-field={pathKey(field.path)}>
      <span className="dshmcp_rowMain">
        <span className="dshmcp_label">{t(field.label)}</span>
        {field.hint !== undefined && <span className="dshmcp_hint">{t(field.hint)}</span>}
      </span>
      <span className="dshmcp_control">
        {field.kind === 'toggle' && (
          <input
            className="dshmcp_check"
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => {
              onWrite(event.target.checked)
            }}
          />
        )}
        {(field.kind === 'text' || field.kind === 'number') && (
          <DraftInput
            type={field.kind === 'number' ? 'number' : 'text'}
            value={value === undefined || value === null ? '' : String(value)}
            disabled={disabled}
            {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
            {...(field.min === undefined ? {} : { min: field.min })}
            {...(field.max === undefined ? {} : { max: field.max })}
            onCommit={(next) => {
              if (field.kind === 'text') {
                onWrite(next)
                return
              }
              // A number input can hold an empty or half-typed value; neither is
              // a number the host would accept, so a draft like "1" on the way to
              // "1000" must not become a write.
              const parsed = Number(next)
              if (next.trim() === '' || !Number.isFinite(parsed)) return
              if (field.min !== undefined && parsed < field.min) return
              if (field.max !== undefined && parsed > field.max) return
              onWrite(parsed)
            }}
          />
        )}
        {field.kind === 'select' && (
          <select
            className="dshmcp_input"
            value={value === undefined || value === null ? '' : String(value)}
            disabled={disabled}
            onChange={(event) => {
              onWrite(event.target.value)
            }}
          >
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        )}
      </span>
    </label>
  )
}

/** One titled group. */
function Group({
  t,
  group,
  value,
  disabled,
  onWrite,
}: {
  t(key: string): string
  group: GroupSpec
  value: unknown
  disabled: boolean
  onWrite(field: FieldSpec, next: unknown): void
}) {
  return (
    <section className="dshmcp_group">
      <h3 className="dshmcp_groupTitle">{t(group.title)}</h3>
      <p className="dshmcp_groupDesc">{t(group.description)}</p>
      <div className="dshmcp_rows">
        {group.fields.map((field) => (
          <FieldRow
            key={pathKey(field.path)}
            t={t}
            field={field}
            value={readPath(value, field.path)}
            disabled={disabled}
            onWrite={(next) => {
              onWrite(field, next)
            }}
          />
        ))}
      </div>
    </section>
  )
}

/** The write-only token control. */
function TokenRow({
  t,
  isSet,
  disabled,
  onWrite,
  onClear,
}: {
  t(key: string): string
  isSet: boolean
  disabled: boolean
  onWrite(value: string): void
  onClear(): void
}) {
  const [draft, setDraft] = useState('')
  return (
    <label className="dshmcp_row dshmcp_rowStack" data-field="auth.token">
      <span className="dshmcp_rowMain">
        <span className="dshmcp_label">
          {t('field.auth.token')}{' '}
          <span className={`dshmcp_badge${isSet ? ' dshmcp_badgeOk' : ''}`}>
            {isSet ? t('field.auth.token.set') : t('field.auth.token.unset')}
          </span>
        </span>
        <span className="dshmcp_hint">{t('field.auth.token.hint')}</span>
      </span>
      <span className="dshmcp_control">
        <input
          className="dshmcp_input"
          type="password"
          value={draft}
          disabled={disabled}
          placeholder={t('field.auth.token.placeholder')}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onBlur={() => {
            // An empty box means "I did not type anything", never "clear it" —
            // clearing is its own button, because it cannot be undone from here.
            if (draft !== '') {
              onWrite(draft)
              setDraft('')
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        {isSet && (
          <button
            className="dshmcp_btn"
            type="button"
            disabled={disabled}
            onClick={onClear}
          >
            {t('field.auth.token.clear')}
          </button>
        )}
      </span>
    </label>
  )
}

/** The read-only pane: where to point a client, and whether the endpoint is up. */
function ClientConfig({
  t,
  url,
  mounted,
  tokenFile,
  status,
  statusRead,
}: {
  t(key: string): string
  url: string
  mounted: boolean
  tokenFile: string
  status: EndpointStatus | undefined
  statusRead: boolean
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const snippet = JSON.stringify(
    {
      mcpServers: {
        dsh: {
          type: 'http',
          url,
          headers: { Authorization: 'Bearer <token>' },
        },
      },
    },
    null,
    2,
  )

  return (
    <section className="dshmcp_group">
      <h3 className="dshmcp_groupTitle">{t('client.title')}</h3>
      <p className="dshmcp_groupDesc">{t('client.description')}</p>
      <pre className="dshmcp_code">{snippet}</pre>
      <div className="dshmcp_control">
        <button
          className="dshmcp_btn"
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(snippet)
              .then(() => {
                setCopied('ok')
              })
              .catch(() => {
                setCopied('failed')
              })
          }}
        >
          {copied === 'ok' ? t('client.copied') : copied === 'failed' ? t('client.copyFailed') : t('client.copy')}
        </button>
        {statusRead && (
          <span className={`dshmcp_badge${status?.listening === true ? ' dshmcp_badgeOk' : ''}`}>
            {status?.listening === true ? t('client.listening') : t('client.notListening')}
          </span>
        )}
        {mounted && <span className="dshmcp_badge">{t('client.mounted')}</span>}
      </div>
      <p className="dshmcp_note">
        {t('field.auth.token.hint')} → <code>{tokenFile}</code>
      </p>
      {status !== undefined && status.enabledToolGroups.length > 0 && (
        <p className="dshmcp_note">
          {t('client.toolsLabel')}
          {status.enabledToolGroups.join(', ')}
        </p>
      )}
      {status?.error != null && (
        <p className="dshmcp_error">
          {t('client.errorLabel')}
          {status.error}
        </p>
      )}
    </section>
  )
}

/**
 * The MCP section.
 *
 * Every control writes one path, and the snapshot it renders comes from the same
 * namespace the host registers — so what this panel shows is what the endpoint
 * will read on its next request, with no second copy to fall out of step.
 */
export function McpSection({ t, store, tokenFile }: SectionProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [writeError, setWriteError] = useState(false)
  const [status, setStatus] = useState<EndpointStatus>()
  const [statusRead, setStatusRead] = useState(false)

  const value = snapshot.value
  const writable = snapshot.writable && snapshot.status === 'ready' && value !== undefined

  // The status route is polled rather than subscribed: it reports state that
  // changes outside the settings document (a port taken by someone else, a bind
  // that failed), and a slow poll is enough to answer "is it up right now?".
  useEffect(() => {
    let live = true
    const read = () => {
      void store.readStatus().then((next) => {
        if (!live) return
        setStatusRead(true)
        setStatus(next)
      })
    }
    read()
    const timer = setInterval(read, 5_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [store])

  const write = useCallback(
    (path: readonly string[], next: unknown) => {
      setWriteError(false)
      void store.mutate([{ op: 'set', path: [...path], value: next }], snapshot.revision).catch(() => {
        setWriteError(true)
      })
    },
    [store, snapshot.revision],
  )

  const clear = useCallback(
    (path: readonly string[]) => {
      setWriteError(false)
      void store.mutate([{ op: 'unset', path: [...path] }], snapshot.revision).catch(() => {
        setWriteError(true)
      })
    },
    [store, snapshot.revision],
  )

  const host = readPath(value, ['http', 'host'])
  const port = readPath(value, ['http', 'port'])
  const path = readPath(value, ['http', 'path'])
  const hostText = typeof host === 'string' && host !== '' ? host : '127.0.0.1'
  const url = `http://${hostText === '0.0.0.0' ? '127.0.0.1' : hostText}:${String(port ?? '')}${String(path ?? '')}`

  return (
    <div className="dshmcp">
      <p className="dshmcp_intro">{t('intro')}</p>

      {snapshot.status === 'loading' && <p className="dshmcp_note">{t('state.loading')}</p>}
      {snapshot.status === 'unavailable' && <p className="dshmcp_error">{t('state.unavailable')}</p>}
      {snapshot.status === 'ready' && !snapshot.writable && <p className="dshmcp_note">{t('state.readonly')}</p>}
      {writeError && <p className="dshmcp_error">{t('state.writeFailed')}</p>}

      {GROUPS.map((group) => (
        <Group
          key={group.id}
          t={t}
          group={group}
          value={value}
          disabled={!writable}
          onWrite={(field, next) => {
            write(field.path, next)
          }}
        />
      ))}

      <section className="dshmcp_group">
        <h3 className="dshmcp_groupTitle">{t('group.auth.title')}</h3>
        <p className="dshmcp_groupDesc">{t('group.auth.description')}</p>
        <div className="dshmcp_rows">
          <TokenRow
            t={t}
            isSet={store.secretIsSet()}
            disabled={!writable}
            onWrite={(next) => {
              write(['auth', 'token'], next)
            }}
            onClear={() => {
              clear(['auth', 'token'])
            }}
          />
        </div>
      </section>

      <ClientConfig
        t={t}
        url={url}
        mounted={readPath(value, ['http', 'mountOnWebServer']) === true}
        tokenFile={status?.tokenFile ?? tokenFile}
        status={status}
        statusRead={statusRead}
      />
    </div>
  )
}
