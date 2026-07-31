// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import type { NestedRepoScanResult, Repo, Worktree } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { useOnboardingFlow } from './use-onboarding-flow'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  openProjectDefaultCheckout: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('../sidebar/project-added-default-checkout', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openProjectDefaultCheckout: mocks.openProjectDefaultCheckout
}))

function nestedScan(path: string): NestedRepoScanResult {
  return {
    selectedPath: path,
    selectedPathKind: 'non_git_folder',
    repos: [{ path: `${path}/child`, displayName: 'child', depth: 1 }],
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 3,
    maxRepos: 100,
    timeoutMs: null
  }
}

function gitScan(path: string): NestedRepoScanResult {
  return { ...nestedScan(path), selectedPathKind: 'git_repo', repos: [] }
}

function repo(path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path,
    displayName: 'repo-1',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

function worktree(id: string, hostId: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/srv/${id}`,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    hostId
  }
}

describe('useOnboardingFlow host routing', () => {
  const scanNestedRepos = vi.fn()
  const addRepoPath = vi.fn()
  const importNestedRepos = vi.fn()
  const cancelNestedRepoScan = vi.fn()
  const pickFolder = vi.fn()
  const addLocalRepo = vi.fn()
  const fetchRepos = vi.fn().mockResolvedValue(undefined)
  const fetchWorktrees = vi.fn().mockResolvedValue(undefined)
  const onboardingUpdate = vi.fn().mockResolvedValue(getDefaultOnboardingState())
  const onboardingCompleted = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'runtime-a'
      },
      scanNestedRepos,
      addRepoPath,
      importNestedRepos,
      cancelNestedRepoScan,
      fetchRepos,
      fetchWorktrees,
      repos: [
        repo('/srv/a', { executionHostId: 'runtime:runtime-a' }),
        repo('/srv/b', { executionHostId: 'runtime:runtime-b' })
      ],
      worktreesByRepo: {
        'repo-1': [
          worktree('runtime-b-worktree', 'runtime:runtime-b'),
          worktree('runtime-a-worktree', 'runtime:runtime-a')
        ]
      },
      refreshDetectedAgents: vi.fn().mockResolvedValue([]),
      refreshPreflightStatus: vi.fn().mockResolvedValue(undefined)
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        repos: {
          pickFolder,
          add: addLocalRepo
        },
        onboarding: { update: onboardingUpdate },
        starNag: { onboardingCompleted }
      }
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(useAppStore.getInitialState(), true)
    delete (window as unknown as { api?: unknown }).api
  })

  it('keeps the selected runtime for the add after the global selection changes mid-scan', async () => {
    let resolveScan: (scan: NestedRepoScanResult) => void = () => {}
    scanNestedRepos.mockReturnValue(
      new Promise<NestedRepoScanResult>((resolve) => {
        resolveScan = resolve
      })
    )
    addRepoPath.mockImplementation(async (path: string) => repo(path))
    const { result } = renderHook(() => useOnboardingFlow(getDefaultOnboardingState(), vi.fn()))

    act(() => result.current.setServerPath('/srv/repo'))
    let openPromise: Promise<void> = Promise.resolve()
    act(() => {
      openPromise = result.current.openFolder('git')
    })
    await vi.waitFor(() =>
      expect(scanNestedRepos).toHaveBeenCalledWith('/srv/repo', undefined, {
        runtimeEnvironmentId: 'runtime-a'
      })
    )

    act(() => {
      useAppStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, activeRuntimeEnvironmentId: 'runtime-b' }
          : state.settings
      }))
      resolveScan(gitScan('/srv/repo'))
    })
    await act(async () => openPromise)

    expect(scanNestedRepos).toHaveBeenCalledTimes(1)
    expect(addRepoPath).toHaveBeenCalledTimes(1)
    expect(addRepoPath).toHaveBeenCalledWith('/srv/repo', 'git', {
      runtimeEnvironmentId: 'runtime-a'
    })
    expect(fetchRepos).toHaveBeenCalledWith({ runtimeEnvironmentId: 'runtime-a' })
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'runtime:runtime-a'
    })
    expect(mocks.openProjectDefaultCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-1',
        executionHostId: 'runtime:runtime-a'
      })
    )
  })

  it('imports a nested review on the runtime that produced the scan', async () => {
    scanNestedRepos.mockResolvedValue(nestedScan('/srv/projects'))
    importNestedRepos.mockResolvedValue({
      projects: [{ path: '/srv/projects/child', projectId: 'repo-1', status: 'imported' as const }],
      importedCount: 1,
      alreadyKnownCount: 0,
      failedCount: 0
    })
    const { result } = renderHook(() => useOnboardingFlow(getDefaultOnboardingState(), vi.fn()))

    act(() => result.current.setServerPath('/srv/projects'))
    await act(async () => result.current.openFolder('git'))
    act(() => {
      useAppStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, activeRuntimeEnvironmentId: 'runtime-b' }
          : state.settings
      }))
    })
    await act(async () => result.current.importNested())

    expect(scanNestedRepos).toHaveBeenCalledTimes(1)
    expect(importNestedRepos).toHaveBeenCalledTimes(1)
    expect(importNestedRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPath: '/srv/projects',
        projectPaths: ['/srv/projects/child'],
        runtimeEnvironmentId: 'runtime-a'
      })
    )
    expect(fetchRepos).toHaveBeenCalledWith({ runtimeEnvironmentId: 'runtime-a' })
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenNthCalledWith(1, 'repo-1', {
      requireAuthoritative: true,
      executionHostId: 'runtime:runtime-a'
    })
    expect(fetchWorktrees).toHaveBeenNthCalledWith(2, 'repo-1', {
      requireAuthoritative: true,
      executionHostId: 'runtime:runtime-a'
    })
    expect(mocks.openProjectDefaultCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'runtime:runtime-a' })
    )
  })

  it('activates a non-git folder on the captured runtime after selection changes', async () => {
    let resolveAdd: (value: Repo) => void = () => {}
    addRepoPath.mockReturnValue(
      new Promise<Repo>((resolve) => {
        resolveAdd = resolve
      })
    )
    const { result } = renderHook(() => useOnboardingFlow(getDefaultOnboardingState(), vi.fn()))

    act(() => result.current.setServerPath('/srv/folder'))
    let openPromise: Promise<void> = Promise.resolve()
    act(() => {
      openPromise = result.current.openFolder('folder')
    })
    await vi.waitFor(() =>
      expect(addRepoPath).toHaveBeenCalledWith('/srv/folder', 'folder', {
        runtimeEnvironmentId: 'runtime-a'
      })
    )
    act(() => {
      useAppStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, activeRuntimeEnvironmentId: 'runtime-b' }
          : state.settings
      }))
      resolveAdd(repo('/srv/folder', { kind: 'folder' }))
    })
    await act(async () => openPromise)

    expect(fetchRepos).toHaveBeenCalledWith({ runtimeEnvironmentId: 'runtime-a' })
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      executionHostId: 'runtime:runtime-a'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      'runtime-a-worktree',
      expect.objectContaining({ executionHostId: 'runtime:runtime-a' })
    )
  })

  it('cancels a local scan locally after the global selection changes', async () => {
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: null }
        : state.settings
    }))
    pickFolder.mockResolvedValue('/Users/me/projects')
    addLocalRepo.mockResolvedValue({ error: 'Not a valid git repository' })
    let resolveScan: (scan: NestedRepoScanResult) => void = () => {}
    scanNestedRepos.mockReturnValue(
      new Promise<NestedRepoScanResult>((resolve) => {
        resolveScan = resolve
      })
    )
    const { result } = renderHook(() => useOnboardingFlow(getDefaultOnboardingState(), vi.fn()))

    let openPromise: Promise<void> = Promise.resolve()
    act(() => {
      openPromise = result.current.openFolder('git')
    })
    await vi.waitFor(() => expect(scanNestedRepos).toHaveBeenCalled())
    const controls = scanNestedRepos.mock.calls[0]?.[2] as { scanId?: string } | undefined
    expect(controls).toEqual(
      expect.objectContaining({ runtimeEnvironmentId: null, scanId: expect.any(String) })
    )

    act(() => {
      useAppStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, activeRuntimeEnvironmentId: 'runtime-b' }
          : state.settings
      }))
    })
    act(() => result.current.stopNestedScan())

    expect(scanNestedRepos).toHaveBeenCalledTimes(1)
    expect(cancelNestedRepoScan).toHaveBeenCalledTimes(1)
    expect(cancelNestedRepoScan).toHaveBeenCalledWith(controls?.scanId, {
      runtimeEnvironmentId: null
    })
    act(() => resolveScan(nestedScan('/Users/me/projects')))
    await act(async () => openPromise)
  })
})
