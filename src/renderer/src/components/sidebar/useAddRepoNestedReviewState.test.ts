import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

const mocks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refIndex: 0,
  cancelNestedRepoScan: vi.fn(),
  setStep: vi.fn()
}))

// Why: stub React hooks so the hook body runs synchronously and refs persist
// across calls within a test (mirrors the sibling add-repo flow hook tests).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useState: <T>(initial: T | (() => T)) => {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial
      return [value, vi.fn()]
    },
    useRef: <T>(value: T) => {
      const index = mocks.refIndex++
      if (!(index in mocks.refs)) {
        mocks.refs[index] = { current: value }
      }
      return mocks.refs[index] as { current: T }
    }
  }
})

const props = {
  activeRuntimeEnvironmentId: 'global-runtime' as string | null | undefined,
  cancelNestedRepoScan: mocks.cancelNestedRepoScan,
  setStep: mocks.setStep
}

describe('useAddRepoNestedReviewState cancellation routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refs = []
    mocks.refIndex = 0
  })

  it('cancels a scan on its owning runtime, not the divergent global', async () => {
    const { useAddRepoNestedReviewState } = await import('./useAddRepoNestedReviewState')
    const state = useAddRepoNestedReviewState(props)
    // Scan started on a runtime host; the global later points elsewhere.
    state.setActiveNestedScanId('scan-1', 'owning-runtime')

    state.handleStopNestedScan()

    expect(mocks.cancelNestedRepoScan).toHaveBeenCalledWith('scan-1', {
      runtimeEnvironmentId: 'owning-runtime'
    })
  })

  it('cancels a local scan explicitly local even while a runtime is globally active', async () => {
    const { useAddRepoNestedReviewState } = await import('./useAddRepoNestedReviewState')
    const state = useAddRepoNestedReviewState(props)
    // A local scan (no owning runtime) must cancel locally, not on the global runtime.
    state.setActiveNestedScanId('scan-2')

    state.handleStopNestedScan()

    expect(mocks.cancelNestedRepoScan).toHaveBeenCalledWith('scan-2', {
      runtimeEnvironmentId: null
    })
  })

  it('routes cancellation from reset by the owning runtime', async () => {
    const { useAddRepoNestedReviewState } = await import('./useAddRepoNestedReviewState')
    const state = useAddRepoNestedReviewState(props)
    state.setActiveNestedScanId('scan-3', 'owning-runtime')

    state.resetNestedRepoReviewState()

    expect(mocks.cancelNestedRepoScan).toHaveBeenCalledWith('scan-3', {
      runtimeEnvironmentId: 'owning-runtime'
    })
  })
})
