// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import { TooltipProvider } from '../ui/tooltip'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'

// A hostname with no hyphen, slash, or dot break opportunity: `truncate`
// (white-space: nowrap) makes its min-content width the whole string, which is
// what pushed the dialog box past `max-w-sm`.
const UNBREAKABLE_ENDPOINT =
  'wss://averylonghostnamewithnobreakopportunitiesatallexample:8443/runtimesocketendpoint'

const ENVIRONMENT = {
  id: 'env-1',
  name: 'MyExtremelyLongServerNameWithNoBreakOpportunitiesWhatsoever',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ep-1', kind: 'websocket' as const, label: 'primary', endpoint: UNBREAKABLE_ENDPOINT }],
  preferredEndpointId: 'ep-1'
}

const mockStoreState = {
  settingsSearchQuery: '',
  remoteServerUpdates: new Map(),
  remoteServerUpdatesChecking: false,
  remoteServerUpdatesRunning: false,
  refreshRemoteServerUpdates: vi.fn(),
  setRemoteServerUpdateDialogOpen: vi.fn(),
  setRuntimeEnvironments: vi.fn(),
  setRuntimeEnvironmentStatus: vi.fn(),
  recordFeatureInteraction: vi.fn()
}

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

// Not under test; it owns its own ephemeral-VM data loading.
vi.mock('./EphemeralVmRuntimesSection', () => ({
  EphemeralVmRuntimesSection: () => null
}))

// Radix Select never opens in a layout-free DOM; this stub exposes each option
// as a button so picking a server can drive the Switch confirmation dialog.
vi.mock('../ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({})

  return {
    Select: ({
      onValueChange,
      children
    }: {
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return <SelectContext.Provider value={contextValue}>{children}</SelectContext.Provider>
    },
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button type="button" data-select-item={value} onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      )
    }
  }
})

const roots: Root[] = []

const settings = {
  activeRuntimeEnvironmentId: null
} as unknown as GlobalSettings

async function renderPane(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <RuntimeEnvironmentsPane
          settings={settings}
          setActiveRuntimeEnvironmentPreference={vi.fn().mockResolvedValue(true)}
        />
      </TooltipProvider>
    )
  })
  return container
}

/** The endpoint/name box rendered inside the confirmation dialogs. */
function findDialogDetailBox(): HTMLElement {
  const box = [...document.querySelectorAll('[data-slot="dialog-content"] div')].find((node) =>
    node.className.includes('rounded-md') && node.className.includes('bg-muted/35')
  )
  if (!box) {
    throw new Error('dialog detail box not found')
  }
  return box as HTMLElement
}

describe('RuntimeEnvironmentsPane confirmation dialogs with a long endpoint', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    Object.assign(globalThis.window, {
      api: {
        runtimeEnvironments: {
          list: vi.fn().mockResolvedValue([ENVIRONMENT]),
          getStatus: vi.fn().mockResolvedValue({ ok: false }),
          remove: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => act(() => root.unmount()))
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('lets the Remove Server dialog wrap a long endpoint instead of forcing the box wider', async () => {
    const container = await renderPane()
    await vi.waitFor(() => expect(container.textContent).toContain(ENVIRONMENT.name))

    const removeButton = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Remove ')
    )
    expect(removeButton).toBeDefined()
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const box = findDialogDetailBox()
    // Without this the grid item's automatic minimum is its min-content width.
    expect(box.className).toContain('min-w-0')

    const [nameLine, endpointLine] = [...box.children] as HTMLElement[]
    expect(endpointLine.textContent).toBe(UNBREAKABLE_ENDPOINT)
    // `truncate` sets nowrap, which is exactly what inflates min-content width.
    for (const line of [nameLine, endpointLine]) {
      expect(line.className).toContain('break-all')
      expect(line.className).not.toContain('truncate')
    }
  })

  it('lets the Remove Server dialog wrap an error message with a long token', async () => {
    const failure = `remove failed for ${UNBREAKABLE_ENDPOINT}`
    window.api.runtimeEnvironments.remove = vi.fn().mockRejectedValue(new Error(failure))

    const container = await renderPane()
    await vi.waitFor(() => expect(container.textContent).toContain(ENVIRONMENT.name))

    const removeButton = [...container.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Remove ')
    )
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const confirmButton = [...document.querySelectorAll('[data-slot="dialog-content"] button')].find(
      (button) => button.textContent?.trim() === 'Remove'
    )
    expect(confirmButton).toBeDefined()
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const error = await vi.waitFor(() => {
      const node = [...document.querySelectorAll('[data-slot="dialog-content"] p')].find((p) =>
        p.textContent?.includes(UNBREAKABLE_ENDPOINT)
      )
      if (!node) {
        throw new Error('error message not rendered')
      }
      return node
    })
    // The error <p> is its own grid item, so an unbreakable token in the
    // message widens the dialog just like the endpoint box did.
    expect(error.className).toContain('break-all')
  })

  it('lets the Switch Server dialog wrap a long server label', async () => {
    const container = await renderPane()
    await vi.waitFor(() => expect(container.textContent).toContain(ENVIRONMENT.name))

    const option = container.querySelector(`[data-select-item="${ENVIRONMENT.id}"]`)
    expect(option).not.toBeNull()
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const box = findDialogDetailBox()
    expect(box.className).toContain('min-w-0')

    const labelLine = box.children[1] as HTMLElement
    expect(labelLine.textContent).toBe(ENVIRONMENT.name)
    expect(labelLine.className).toContain('break-all')
    expect(labelLine.className).not.toContain('truncate')
  })
})
