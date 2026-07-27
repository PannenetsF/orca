import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

const EFFORT_ID_BY_LABEL: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max'
}

function normalizedScreenLines(screen: string): string[] {
  return stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
}

const CLAUDE_MODEL_EFFORT = /\bwith\s+(low|medium|high|extra high|xhigh|max)\s+effort\b/i

/** The model descriptor row Claude prints directly under the `Claude Code vX`
 * header — either appended to the header line (xterm serialization can join
 * them) or on the next row, both prefixed with box-drawing chrome. */
function claudeModelDescriptorRow(lines: string[], headerIndex: number): string | null {
  const headerLine = lines[headerIndex] ?? ''
  const afterVersion = headerLine.replace(/^.*?\bClaude Code\s*v?\d+(?:\.\d+){1,2}\b/i, '').trim()
  const candidate = afterVersion || (lines[headerIndex + 1] ?? '')
  const cleaned = candidate.replace(/^[^A-Za-z0-9]+/, '').trim()
  return cleaned || null
}

/** Why: the catalog only names the built-in models. A custom model (env or
 * `--model <slug>`) still renders Claude's standard `<name>[ with <effort>
 * effort] · <billing>` row, so recover its name to track and offer it instead
 * of leaving the picker stuck on the four built-ins with no selection. */
function parseCustomClaudeModel(row: string | null): string | null {
  if (!row) {
    return null
  }
  // Require Claude's header chrome so arbitrary buffer text is never a "model".
  if (!row.includes('·') && !CLAUDE_MODEL_EFFORT.test(row)) {
    return null
  }
  const beforeBilling = row.split('·')[0] ?? row
  const effort = beforeBilling.match(CLAUDE_MODEL_EFFORT)
  const name = (effort ? beforeBilling.slice(0, effort.index) : beforeBilling).trim()
  return name || null
}

export function readClaudeSessionOptionsFromTerminalScreen(
  screen: string | null | undefined
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = normalizedScreenLines(screen)
  const headerIndex = lines.findIndex((line) =>
    // xterm serialization can remove cursor-positioning cells between the
    // product name and version, producing `Claude Codev2.1.211`.
    /\bClaude Code\s*v?\d+(?:\.\d+){1,2}\b/i.test(line)
  )
  if (headerIndex < 0) {
    return null
  }
  // Why: only Claude's fixed header rows describe live state; conversation
  // text and old command confirmations elsewhere in the buffer can be stale.
  const header = lines.slice(headerIndex, headerIndex + 3).join(' ')
  const catalog = getAgentSessionOptionCatalog('claude')
  const model = [...(catalog?.models ?? [])]
    .sort((left, right) => right.label.length - left.label.length)
    .find(({ label }) => header.toLowerCase().includes(label.toLowerCase()))
  if (!model) {
    // A custom model (env/config or `--model <slug>`) is not in the catalog but
    // still prints a standard descriptor row; recover its name so it can be
    // tracked and shown as selected instead of leaving the picker unselected.
    // Effort is intentionally omitted: a custom model has no catalog options, so
    // a tracked effort value could never be rendered or changed.
    const customModel = parseCustomClaudeModel(claudeModelDescriptorRow(lines, headerIndex))
    return customModel ? { model: customModel } : null
  }
  const result: Record<string, SessionOptionValue> = { model: model.id }
  const effortLabel = header.match(CLAUDE_MODEL_EFFORT)?.[1]
  const effort = effortLabel ? EFFORT_ID_BY_LABEL[effortLabel.toLowerCase()] : undefined
  if (effort && model.options.some((option) => option.id === 'effort')) {
    result.effort = effort
  }
  return result
}
