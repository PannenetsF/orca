// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installPreviewTerminalLinks } from './preview-terminal-links'

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function (this: { handler?: unknown }, handler: unknown) {
    this.handler = handler
  })
}))

type FakeTerminal = {
  loadAddon: ReturnType<typeof vi.fn>
  registerLinkProvider: ReturnType<typeof vi.fn>
  options: Record<string, unknown>
  clearSelection: ReturnType<typeof vi.fn>
}

function createFakeTerminal(): FakeTerminal {
  return {
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(),
    options: {},
    clearSelection: vi.fn()
  }
}

function webLinksHandler(): (event: MouseEvent | undefined, uri: string) => void {
  const instance = vi.mocked(WebLinksAddon).mock.instances.at(-1) as { handler?: unknown }
  return instance.handler as (event: MouseEvent | undefined, uri: string) => void
}

describe('installPreviewTerminalLinks', () => {
  const openUrl = vi.fn(async () => {})
  let terminal: FakeTerminal

  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    Object.assign(window, { api: { shell: { openUrl } } })
    terminal = createFakeTerminal()
    installPreviewTerminalLinks(terminal as unknown as Terminal)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('routes OSC 8 hyperlinks through the system browser on Mod+click', () => {
    const linkHandler = terminal.options.linkHandler as {
      activate: (event: MouseEvent, text: string) => void
    }
    linkHandler.activate(new MouseEvent('click', { metaKey: true }), 'https://example.com/docs')
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
    expect(terminal.clearSelection).toHaveBeenCalledOnce()
  })

  it('ignores OSC 8 hyperlink activation without the Mod gesture', () => {
    const linkHandler = terminal.options.linkHandler as {
      activate: (event: MouseEvent, text: string) => void
    }
    linkHandler.activate(new MouseEvent('click'), 'https://example.com/docs')
    expect(openUrl).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()
  })

  it('lets xterm core filter non-http OSC 8 protocols instead of confirming', () => {
    const linkHandler = terminal.options.linkHandler as { allowNonHttpProtocols?: boolean }
    expect(linkHandler.allowNonHttpProtocols).toBe(false)
  })

  it('still opens plain-text URLs through the WebLinksAddon handler on Mod+click', () => {
    webLinksHandler()(new MouseEvent('click', { metaKey: true }), 'https://example.com')
    expect(openUrl).toHaveBeenCalledWith('https://example.com')
  })

  it('still ignores plain-text URL clicks without the Mod gesture', () => {
    webLinksHandler()(new MouseEvent('click'), 'https://example.com')
    expect(openUrl).not.toHaveBeenCalled()
  })
})
