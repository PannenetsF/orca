import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' }))
}))

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args) } }))

const upsertAddedRepo = vi.fn()
vi.mock('@/components/sidebar/add-repo-store-upsert', () => ({
  upsertAddedRepoWithProjectHostSetup: (repo: Repo) => upsertAddedRepo(repo)
}))

const clone = vi.fn()
const cloneRemote = vi.fn()
const cloneAbort = vi.fn()
const notificationsDispatch = vi.fn().mockResolvedValue({ delivered: true })

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-clone',
    path: '/dest/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function seedCloneStore() {
  const store = createTestStore()
  // Why: the slice runs the authoritative worktree fetch before marking success;
  // stub it so the test doesn't reach into the worktree IPC path.
  store.setState({ fetchWorktrees: vi.fn().mockResolvedValue(undefined) } as never)
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      repos: { clone, cloneRemote, cloneAbort },
      notifications: { dispatch: notificationsDispatch }
    }
  })
})

describe('clone-tasks slice', () => {
  it('runs a local clone to success and upserts the repo', async () => {
    const repo = makeRepo()
    clone.mockResolvedValue(repo)
    const store = seedCloneStore()

    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/repo.git',
      destination: '/dest',
      backend: 'local'
    })

    expect(store.getState().cloneTasksById[taskId]?.status).toBe('cloning')
    expect(store.getState().cloneTasksById[taskId]?.displayName).toBe('repo')

    await vi.waitFor(() => {
      expect(store.getState().cloneTasksById[taskId]?.status).toBe('success')
    })
    expect(clone).toHaveBeenCalledWith({
      url: 'https://example.com/repo.git',
      destination: '/dest'
    })
    expect(upsertAddedRepo).toHaveBeenCalledWith(repo)
    expect(store.getState().cloneTasksById[taskId]?.repoId).toBe(repo.id)
    expect(store.getState().cloneTasksById[taskId]?.percent).toBe(100)
  })

  it('routes an environment clone through repo.clone RPC', async () => {
    const repo = makeRepo({ id: 'env-repo' })
    vi.mocked(callRuntimeRpc).mockResolvedValue({ repo } as never)
    const store = seedCloneStore()

    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/env.git',
      destination: '/home/user/projects',
      backend: 'environment',
      environmentId: 'env-1'
    })

    await vi.waitFor(() => {
      expect(store.getState().cloneTasksById[taskId]?.status).toBe('success')
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'repo.clone',
      { url: 'https://example.com/env.git', destination: '/home/user/projects' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
  })

  it('records an error when the clone fails', async () => {
    clone.mockRejectedValue(new Error('network down'))
    const store = seedCloneStore()

    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/repo.git',
      destination: '/dest',
      backend: 'local'
    })

    await vi.waitFor(() => {
      expect(store.getState().cloneTasksById[taskId]?.status).toBe('error')
    })
    expect(store.getState().cloneTasksById[taskId]?.error).toContain('network down')
  })

  it('matches local/ssh progress to the single active non-environment task', () => {
    clone.mockReturnValue(new Promise(() => {}))
    const store = seedCloneStore()
    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/repo.git',
      destination: '/dest',
      backend: 'local'
    })

    store
      .getState()
      .updateCloneTaskProgress({ localOrSsh: true }, { phase: 'Receiving', percent: 40 })

    expect(store.getState().cloneTasksById[taskId]?.phase).toBe('Receiving')
    expect(store.getState().cloneTasksById[taskId]?.percent).toBe(40)
  })

  it('matches environment progress by backend + destination', () => {
    vi.mocked(callRuntimeRpc).mockReturnValue(new Promise(() => {}) as never)
    const store = seedCloneStore()
    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/env.git',
      destination: '/home/user/projects',
      backend: 'environment',
      environmentId: 'env-1'
    })

    store
      .getState()
      .updateCloneTaskProgress(
        { backend: 'environment', destination: '/home/user/projects' },
        { phase: 'Resolving deltas', percent: 88 }
      )

    expect(store.getState().cloneTasksById[taskId]?.percent).toBe(88)
  })

  it('cancels a running local clone via cloneAbort and removes the task', () => {
    clone.mockReturnValue(new Promise(() => {}))
    const store = seedCloneStore()
    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/repo.git',
      destination: '/dest',
      backend: 'local'
    })

    store.getState().cancelCloneTask(taskId)

    expect(cloneAbort).toHaveBeenCalledTimes(1)
    expect(store.getState().cloneTasksById[taskId]).toBeUndefined()
  })

  it('cancels a running environment clone via repo.cloneAbort RPC', () => {
    vi.mocked(callRuntimeRpc).mockReturnValue(new Promise(() => {}) as never)
    const store = seedCloneStore()
    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/env.git',
      destination: '/home/user/projects',
      backend: 'environment',
      environmentId: 'env-1'
    })

    store.getState().cancelCloneTask(taskId)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'repo.cloneAbort',
      { destination: '/home/user/projects' }
    )
    expect(store.getState().cloneTasksById[taskId]).toBeUndefined()
  })

  it('only backgrounds a still-running task', () => {
    clone.mockReturnValue(new Promise(() => {}))
    const store = seedCloneStore()
    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/repo.git',
      destination: '/dest',
      backend: 'local'
    })

    store.getState().backgroundCloneTask(taskId)
    expect(store.getState().cloneTasksById[taskId]?.backgrounded).toBe(true)
  })

  it('fires the completion notification only when the finished clone was backgrounded', async () => {
    const repo = makeRepo()
    clone.mockResolvedValue(repo)
    const store = seedCloneStore()
    const taskId = store.getState().startCloneTask({
      url: 'https://example.com/repo.git',
      destination: '/dest',
      backend: 'local'
    })
    store.getState().backgroundCloneTask(taskId)

    await vi.waitFor(() => {
      expect(store.getState().cloneTasksById[taskId]?.status).toBe('success')
    })
    expect(notificationsDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'clone-complete' })
    )
  })
})
