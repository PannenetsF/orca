import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const MIN_EXHAUSTED_ACK_BYTES = 400 * 1024
const PUBLICATION_DEADLINE_MS = 10_000
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-stalled-stream-'))
const fixturePath = path.join(scratch, 'stalled-stream-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "process.stdout.write('PAIRED_STALL_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const commands = pending.split(/\\r\\n|\\r|\\n/)',
    '  pending = commands.pop() ?? ""',
    '  for (const input of commands) {',
    "    if (input === 'GO') {",
    "      for (let row = 0; row < 16_000; row += 1) process.stdout.write(`flood-${row}-${'x'.repeat(80)}\\r\\n`)",
    "      process.stdout.write('HOST_FLOOD_COMPLETE\\r\\n')",
    '      continue',
    '    }',
    '    process.stdout.write(`LIVE:${input}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

type AppResourceProxies = {
  gpuCpuPercent: number
  gpuIdleWakeupsPerSecond: number
  processCount: number
  totalCpuPercent: number
  totalIdleWakeupsPerSecond: number
}

async function getAppResourceProxies(
  electronApp: ElectronApplication
): Promise<AppResourceProxies> {
  return electronApp.evaluate(({ app }) => {
    const metrics = app.getAppMetrics()
    const gpu = metrics.find((metric) => metric.type === 'GPU')
    return {
      gpuCpuPercent: gpu?.cpu.percentCPUUsage ?? 0,
      gpuIdleWakeupsPerSecond: gpu?.cpu.idleWakeupsPerSecond ?? 0,
      processCount: metrics.length,
      totalCpuPercent: metrics.reduce((total, metric) => total + metric.cpu.percentCPUUsage, 0),
      totalIdleWakeupsPerSecond: metrics.reduce(
        (total, metric) => total + metric.cpu.idleWakeupsPerSecond,
        0
      )
    }
  })
}

async function minimizeHeadedHost(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().includes('web-index')
    )
    if (!host) {
      throw new Error('Headed host window is unavailable')
    }
    host.minimize()
  })
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find(
          (window) => !window.webContents.getURL().includes('web-index')
        )
        return host?.isMinimized() ?? false
      })
    )
    .toBe(true)
  // Why: measure steady-state background publication, not the native minimize transition.
  await electronApp.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1_000)))
}

test('restarts one ACK-starved paired terminal stream without replacing its PTY @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(120_000)
  const liveMarker = `PAIRED_STALL_RECOVERED_${Date.now()}`
  const worktree = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    const active = state?.allWorktrees().find((candidate) => candidate.id === id)
    if (!active) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    return { id: active.id }
  })
  const noClientResources = await getAppResourceProxies(electronApp)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer, {
    disableRemoteTerminalStallRecovery:
      process.env.ORCA_E2E_DISABLE_REMOTE_TERMINAL_STALL_RECOVERY === '1'
  })
  let observer: Awaited<ReturnType<typeof launchPairedWebClient>> | null = null
  let terminal: string | null = null
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (worktreeId) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === worktreeId),
            worktree.id
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const observerOffer = await createRuntimeDesktopPairingOffer(orcaPage)
    observer = await launchPairedWebClient(electronApp, observerOffer)
    await expect
      .poll(
        () =>
          observer?.page.evaluate(
            (worktreeId) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === worktreeId),
            worktree.id
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const connectedIdleResources = await getAppResourceProxies(electronApp)
    await minimizeHeadedHost(electronApp)
    const createStartedAt = performance.now()
    const created = await callRuntime<{
      tab: { id: string; parentTabId: string; terminal: string | null }
    }>(client.page, 'session.tabs.createTerminal', {
      worktree: `id:${worktree.id}`,
      command: fixtureCommand(),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    const createLatencyMs = performance.now() - createStartedAt
    expect(createLatencyMs).toBeLessThan(PUBLICATION_DEADLINE_MS)
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Paired runtime did not publish the stalled-stream fixture')
    }
    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          observer?.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: created.tab.parentTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    const originalPtyId = await waitForActivePanePtyId(client.page, 30_000)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('PAIRED_STALL_READY')
    await observer.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const observerTab = observer.page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`
    )
    await expect(observerTab).toBeVisible({ timeout: 30_000 })
    await observerTab.click()
    const observerOriginalPtyId = await waitForActivePanePtyId(observer.page, 30_000)
    expect(observerOriginalPtyId.split('@@').at(-1)).toBe(originalPtyId.split('@@').at(-1))
    await expect
      .poll(() => getTerminalContent(observer.page), { timeout: 30_000 })
      .toContain('PAIRED_STALL_READY')

    await client.page.evaluate((target) => {
      const gate = (
        window as typeof window & {
          __remoteTerminalMultiplexAckGate?: { hold: (terminals: string[]) => void }
        }
      ).__remoteTerminalMultiplexAckGate
      if (!gate) {
        throw new Error('Remote terminal multiplex ACK gate is unavailable')
      }
      gate.hold([target])
    }, terminal)
    const textarea = client.page.locator('.xterm-helper-textarea:visible').first()
    await textarea.focus()
    await client.page.keyboard.type('GO')
    await client.page.keyboard.press('Enter')

    await expect
      .poll(
        () =>
          client.page.evaluate(() => {
            const gate = (
              window as typeof window & {
                __remoteTerminalMultiplexAckGate?: {
                  snapshot: () => { heldAckChars: number }
                }
              }
            ).__remoteTerminalMultiplexAckGate
            return gate?.snapshot().heldAckChars ?? 0
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(MIN_EXHAUSTED_ACK_BYTES)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return result.terminal.tail.join('\n').includes('HOST_FLOOD_COMPLETE')
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    const beforeInput = await callRuntime<{ terminal: RuntimeTerminalRead }>(
      client.page,
      'terminal.read',
      { terminal }
    )
    const sent = await callRuntime<{ send: { accepted: boolean } }>(client.page, 'terminal.send', {
      terminal,
      text: liveMarker,
      enter: true,
      client: { id: 'paired-stalled-stream-e2e', type: 'desktop' }
    })
    expect(sent.send.accepted).toBe(true)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return Number(result.terminal.latestCursor)
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(Number(beforeInput.terminal.latestCursor))
    expect(await getTerminalContent(client.page)).not.toContain(liveMarker)
    expect(
      await client.page.evaluate(
        ({ target, text }) => {
          const gate = (
            window as typeof window & {
              __remoteTerminalMultiplexAckGate?: {
                sendInput: (terminal: string, text: string) => number
              }
            }
          ).__remoteTerminalMultiplexAckGate
          return gate?.sendInput(target, text) ?? 0
        },
        { target: terminal, text: '\r' }
      )
    ).toBe(1)

    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
    expect(await waitForActivePanePtyId(client.page, 30_000)).toBe(originalPtyId)
    await expect(tab).toHaveAttribute('data-active', 'true')
    await expect
      .poll(() => getTerminalContent(observer.page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
    expect(await waitForActivePanePtyId(observer.page, 30_000)).toBe(observerOriginalPtyId)

    const authoritativeInventory = await callRuntime<{
      tabs: { id: string; parentTabId?: string; terminal?: string | null }[]
    }>(client.page, 'session.tabs.list', { worktree: `id:${worktree.id}` })
    const authoritativeTab = authoritativeInventory.tabs.find(
      (candidate) => candidate.terminal === terminal
    )
    if (!authoritativeTab) {
      throw new Error('Paired terminal was absent from authoritative inventory before close')
    }
    const closeStartedAt = performance.now()
    await callRuntime(client.page, 'session.tabs.close', {
      worktree: `id:${worktree.id}`,
      tabId: authoritativeTab.id,
      reason: 'user',
      navigation: 'caller'
    })
    const closeLatencyMs = performance.now() - closeStartedAt
    expect(closeLatencyMs).toBeLessThan(PUBLICATION_DEADLINE_MS)
    await expect
      .poll(
        () =>
          Promise.all([
            orcaPage.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (candidate) => candidate.id === tabId
                ),
              { tabId: created.tab.parentTabId, worktreeId: worktree.id }
            ),
            client.page.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (candidate) => candidate.id === tabId
                ),
              { tabId: webTabId, worktreeId: worktree.id }
            ),
            observer.page.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (candidate) => candidate.id === tabId
                ),
              { tabId: webTabId, worktreeId: worktree.id }
            )
          ]),
        { timeout: 30_000 }
      )
      .toEqual([false, false, false])
    terminal = null

    const afterPublicationResources = await getAppResourceProxies(electronApp)
    const evidencePath = test.info().outputPath('publication-evidence.json')
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          afterPublicationResources,
          closeLatencyMs,
          connectedIdleResources,
          createLatencyMs,
          hostMinimized: true,
          noClientResources
        },
        null,
        2
      )}\n`
    )
    await test.info().attach('publication-evidence', {
      contentType: 'application/json',
      path: evidencePath
    })
  } finally {
    await client.page
      .evaluate(() => {
        ;(
          window as typeof window & {
            __remoteTerminalMultiplexAckGate?: { release: () => void }
          }
        ).__remoteTerminalMultiplexAckGate?.release()
      })
      .catch(() => undefined)
    await observer?.dispose()
    if (terminal) {
      await callRuntime(client.page, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
  }
})
