/**
 * The section's stylesheet, injected once at factory execution.
 *
 * Injected at module scope rather than inside `apply()`: the loader's
 * `claimStyles` runs immediately after the factory returns, so a style tag added
 * later is never attributed to this plugin and its unload bookkeeping breaks.
 *
 * Colours are DSH tokens so the panel follows whatever theme the user runs.
 *
 * @module dsh-as-mcp/client/styles
 */

/** The plugin's id, used to attribute the injected style tag. */
export const CLIENT_ID = 'dsh-as-mcp'

/** Panel stylesheet. */
export const CSS = `
.dshmcp{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.dshmcp_intro{margin:0;color:var(--dsw-alias-label-secondary)}
.dshmcp_group{display:flex;flex-direction:column;gap:10px}
.dshmcp_groupTitle{margin:0;font-size:13px;font-weight:600}
.dshmcp_groupDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dshmcp_rows{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.dshmcp_row{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--dsw-alias-bg-base)}
.dshmcp_row+.dshmcp_row{border-top:1px solid var(--dsw-alias-border-l1)}
.dshmcp_rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dshmcp_label{font-weight:500}
.dshmcp_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.dshmcp_control{flex:none;display:flex;align-items:center;gap:8px}
.dshmcp_rowStack{flex-direction:column;align-items:stretch}
.dshmcp_rowStack .dshmcp_control{width:100%}
input[type=text].dshmcp_input,input[type=number].dshmcp_input{box-sizing:border-box;width:100%;max-width:280px;height:30px;padding:0 8px;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px}
input.dshmcp_input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
input[type=number].dshmcp_input{max-width:140px;font-variant-numeric:tabular-nums}
select.dshmcp_input{height:30px;padding:0 6px;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px}
input[type=checkbox].dshmcp_check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
button.dshmcp_btn{height:28px;padding:0 10px;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;cursor:pointer}
button.dshmcp_btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
button.dshmcp_btn[disabled]{opacity:.5;cursor:default}
.dshmcp_badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;font-size:11px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshmcp_badgeOk{background:var(--dsw-alias-bg-success,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-success,var(--dsw-alias-label-secondary))}
.dshmcp_code{box-sizing:border-box;width:100%;margin:0;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2,var(--dsw-alias-interactive-bg-hover));border:1px solid var(--dsw-alias-border-l1);border-radius:8px;white-space:pre;overflow-x:auto;resize:vertical}
.dshmcp_error{margin:0;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-error,var(--dsw-alias-label-primary));background:var(--dsw-alias-bg-error,var(--dsw-alias-interactive-bg-hover));border-radius:8px}
.dshmcp_note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
`

/**
 * Inject the stylesheet once.
 *
 * The `querySelector` guard makes a second materialization (an HMR reload, or
 * two rows) a no-op instead of a duplicate tag.
 */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="' + CLIENT_ID + '"]') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = CLIENT_ID
  style.dataset.pluginCss = CLIENT_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

injectStyles()
