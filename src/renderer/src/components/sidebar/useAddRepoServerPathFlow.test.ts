import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { Repo } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  stateIndex: 0,
  addRepoPath: vi.fn(),
  closeModal: vi.fn(),
  fetchWorktrees: vi.fn(),
  getNestedRepoRuntimeKind: vi.fn(),
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

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      activeRuntimeEnvironmentId: 'env-1',
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddServerPath('folder')

    expect(mocks.addRepoPath).toHaveBeenCalledWith('/server/docs', 'folder', {
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.scanNestedRepos).not.toHaveBeenCalled()
    expect(mocks.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.onGitRepoReady).not.toHaveBeenCalled()
    expect(mocks.markOnboardingProjectAdded).toHaveBeenCalledWith('addedFolder')
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('routes the Git scan and add to the selected runtime host', async () => {
    // Why: the Add Project host selector picks a runtime host without flipping
    // the global active environment. Regression guard for the "Open as Git"
    // failure where a server repo was probed locally ("checked locally").
    mocks.getNestedRepoRuntimeKind.mockReturnValue('local')
    mocks.scanNestedRepos.mockResolvedValue({
      selectedPath: '/workspace/torch',
      selectedPathKind: 'git_repo',
      repos: [],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 1,
      maxDepth: 1,
      maxRepos: 1,
      timeoutMs: 1
    })
    mocks.addRepoPath.mockResolvedValue(
      makeRepo({ id: 'torch', path: '/workspace/torch', kind: 'git' })
    )
    mocks.stateValues = ['/workspace/torch', false]
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      activeRuntimeEnvironmentId: 'env-1',
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddServerPath('git')

    // A runtime host can't stream scans, so no scanId/onProgress is supplied.
    expect(mocks.scanNestedRepos).toHaveBeenCalledWith('/workspace/torch', undefined, {
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.addRepoPath).toHaveBeenCalledWith('/workspace/torch', 'git', {
      runtimeEnvironmentId: 'env-1'
    })
    expect(mocks.onGitRepoReady).toHaveBeenCalledWith('torch', 'runtime_server_path')
  })

  it('treats an all-whitespace runtime id as local for both the scan and the add', async () => {
    // Why: a whitespace-only id must resolve to null so the scan and add route
    // as local, not forward whitespace to the RPC selector.
    mocks.getNestedRepoRuntimeKind.mockReturnValue('local')
    mocks.scanNestedRepos.mockResolvedValue({
      selectedPath: '/workspace/torch',
      selectedPathKind: 'git_repo',
      repos: [],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 1,
      maxDepth: 1,
      maxRepos: 1,
      timeoutMs: 1
    })
    mocks.addRepoPath.mockResolvedValue(
      makeRepo({ id: 'torch', path: '/workspace/torch', kind: 'git' })
    )
    mocks.stateValues = ['/workspace/torch', false]
    const { useAddRepoServerPathFlow } = await import('./useAddRepoServerPathFlow')

    const result = useAddRepoServerPathFlow({
      addRepoPath: mocks.addRepoPath,
      activeRuntimeEnvironmentId: '   ',
      closeModal: mocks.closeModal,
      fetchWorktrees: mocks.fetchWorktrees,
      getNestedRepoRuntimeKind: mocks.getNestedRepoRuntimeKind,
      scanNestedRepos: mocks.scanNestedRepos,
      setActiveNestedScanId: mocks.setActiveNestedScanId,
      setNestedScanInProgress: mocks.setNestedScanInProgress,
      showNestedRepoReview: mocks.showNestedRepoReview,
      onGitRepoReady: mocks.onGitRepoReady,
      setAddProjectBusyLabel: mocks.setAddProjectBusyLabel
    })
    await result.handleAddServerPath('git')

    // Local routing supplies a streaming scanId and a null RPC selector.
    const scanArgs = mocks.scanNestedRepos.mock.calls[0]
    expect(scanArgs[0]).toBe('/workspace/torch')
    expect(scanArgs[2].runtimeEnvironmentId).toBeNull()
    expect(typeof scanArgs[2].scanId).toBe('string')
    expect(mocks.addRepoPath).toHaveBeenCalledWith('/workspace/torch', 'git', {
      runtimeEnvironmentId: null
    })
  })
})
