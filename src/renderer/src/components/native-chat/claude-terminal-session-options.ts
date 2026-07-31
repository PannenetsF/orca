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

/** Extracts the displayed model name from Claude's descriptor row. */
function parseClaudeModelName(row: string | null): string | null {
  if (!row) {
    return null
  }
  // Require descriptor metadata so arbitrary buffer text is never a model.
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
  const descriptorRow = claudeModelDescriptorRow(lines, headerIndex)
  const reportedModel = parseClaudeModelName(descriptorRow)
  if (!reportedModel) {
    return null
  }
  const catalog = getAgentSessionOptionCatalog('claude')
  const model = catalog?.models.find(
    ({ label }) => label.toLowerCase() === reportedModel.toLowerCase()
  )
  if (!model) {
    return { model: reportedModel }
  }
  const result: Record<string, SessionOptionValue> = { model: model.id }
  const effortLabel = descriptorRow?.match(CLAUDE_MODEL_EFFORT)?.[1]
  const effort = effortLabel ? EFFORT_ID_BY_LABEL[effortLabel.toLowerCase()] : undefined
  if (effort && model.options.some((option) => option.id === 'effort')) {
    result.effort = effort
  }
  return result
}
