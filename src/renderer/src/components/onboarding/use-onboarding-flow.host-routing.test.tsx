// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { useOnboardingFlow } from './use-onboarding-flow'

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

function repo(path: string): Repo {
  return {
    id: 'repo-1',
    path,
    displayName: 'repo-1',
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git'
  }
}

describe('useOnboardingFlow host routing', () => {
  const scanNestedRepos = vi.fn()
  const addRepoPath = vi.fn()
  const importNestedRepos = vi.fn()
  const cancelNestedRepoScan = vi.fn()
  const pickFolder = vi.fn()
  const addLocalRepo = vi.fn()

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
      refreshDetectedAgents: vi.fn().mockResolvedValue([]),
      refreshPreflightStatus: vi.fn().mockResolvedValue(undefined)
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        repos: {
          pickFolder,
          add: addLocalRepo
        }
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
  })

  it('imports a nested review on the runtime that produced the scan', async () => {
    scanNestedRepos.mockResolvedValue(nestedScan('/srv/projects'))
    importNestedRepos.mockResolvedValue(null)
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
