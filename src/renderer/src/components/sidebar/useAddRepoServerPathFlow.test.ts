import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  addRepoPath: vi.fn(),
  closeModal: vi.fn(),
  fetchWorktrees: vi.fn(),
  scanNestedRepos: vi.fn(),
  setActiveNestedScanId: vi.fn(),
  setNestedScanInProgress: vi.fn(),
  showNestedRepoReview: vi.fn(),
  onGitRepoReady: vi.fn(),
  setAddProjectBusyLabel: vi.fn(),
  markOnboardingProjectAdded: vi.fn(),
  track: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useRef: <T>(value: T) => ({ current: value }),
    useState: <T>(initial: T | (() => T)) => {
      const index = mocks.stateIndex++
      const value =
        index in mocks.stateValues
          ? mocks.stateValues[index]
          : typeof initial === 'function'
            ? (initial as () => T)()
            : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value as T, setter]
    }
  }
})

vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: mocks.markOnboardingProjectAdded
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'server-folder',
    path: '/server/docs',
    displayName: 'docs',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

function makeNonGitScan(selectedPath: string, repoPaths: string[]): NestedRepoScanResult {
  return {
    selectedPath,
    selectedPathKind: 'non_git_folder',
    repos: repoPaths.map((path, depth) => ({
      path,
      displayName: path.split('/').pop() ?? path,
      depth
    })),
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 0,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: null
  }
}

function makeFlowProps(activeRuntimeEnvironmentId: string | null | undefined) {
  return {
    activeRuntimeEnvironmentId,
    addRepoPath: mocks.addRepoPath,
    closeModal: mocks.closeModal,
    fetchWorktrees: mocks.fetchWorktrees,
    scanNestedRepos: mocks.scanNestedRepos,
    setActiveNestedScanId: mocks.setActiveNestedScanId,
    setNestedScanInProgress: mocks.setNestedScanInProgress,
    showNestedRepoReview: mocks.showNestedRepoReview,
    onGitRepoReady: mocks.onGitRepoReady,
    setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
  }
}

describe('useAddRepoServerPathFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.stateValues = ['/server/docs', false]
  })

  it('marks onboarding folder progress before closing server folder adds', async () => {
    const repo = makeRepo()
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow(makeFlowProps('runtime-1'))
    await result.handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder', {
      runtimeEnvironmentId: 'runtime-1'
    })
    expect(mocks.scanNestedRepos).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('routes the server add to the selected runtime, not the global active runtime', async () => {
    // Why: the server-path step is only reached with a runtime host selected. Routing
    // must follow that selection so the add can't be captured by a divergent global.
    const repo = makeRepo({ id: 'server-git', kind: 'git' })
    mocks.addRepoPath.mockResolvedValue(repo)
    mocks.scanNestedRepos.mockResolvedValue(null)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow(makeFlowProps('runtime-selected'))
    await result.handleAddServerPath('git')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'git', {
      runtimeEnvironmentId: 'runtime-selected'
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith('server-git', 'runtime_server_path')
  })

  it('routes the pre-add git scan to the selected runtime, not the global active runtime', async () => {
    // Why: the git scan runs before the add and can early-exit into the nested review,
    // so it must target the selected runtime — a divergent global would scan the wrong
    // host. Runtime scans are non-streaming (scanId omitted).
    const repo = makeRepo({ id: 'server-git', kind: 'git' })
    mocks.addRepoPath.mockResolvedValue(repo)
    mocks.scanNestedRepos.mockResolvedValue(null)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow(makeFlowProps('runtime-selected'))
    await result.handleAddServerPath('git')

    expect(mocks.scanNestedRepos).toHaveBeenCalledWith('/server/docs', undefined, {
      runtimeEnvironmentId: 'runtime-selected'
    })
  })

  it('shows the nested review on the selected runtime when the git scan finds nested repos', async () => {
    // Why: an early-exit into the nested review must carry the runtime kind derived
    // from the selection, not the global — the review and any import target that host.
    const scan = makeNonGitScan('/server/monorepo', ['/server/monorepo/a', '/server/monorepo/b'])
    mocks.scanNestedRepos.mockResolvedValue(scan)
    mocks.stateValues = ['/server/monorepo', false]
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow(makeFlowProps('runtime-selected'))
    await result.handleAddServerPath('git')

    expect(mocks.showNestedRepoReview).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeKind: 'runtime', inProgress: false })
    )
    // Early-exits into the review; the add never runs.
    expect(mocks.addRepoPath).not.toHaveBeenCalled()
  })

  it('routes to local when no runtime is selected', async () => {
    const repo = makeRepo()
    mocks.addRepoPath.mockResolvedValue(repo)
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow(makeFlowProps(null))
    await result.handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder', {
      runtimeEnvironmentId: null
    })
  })
})
