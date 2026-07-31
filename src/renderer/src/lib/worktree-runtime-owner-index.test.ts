import { describe, expect, it } from 'vitest'
import { findIndexedWorktreeOwnerForHost } from './worktree-runtime-owner-index'

describe('worktree runtime owner index', () => {
  it('indexes paired worktrees by both runtime owner and physical host', () => {
    const paired = {
      id: 'repo-1::same-id',
      repoId: 'repo-1',
      hostId: 'ssh:private-target' as const,
      runtimeOwnerEnvironmentId: 'hub-a'
    }
    const directSsh = {
      id: 'repo-1::direct',
      repoId: 'repo-1',
      hostId: 'ssh:direct-target' as const
    }
    const worktreesByRepo = { 'repo-1': [paired, directSsh] }

    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, paired.id, 'runtime:hub-a')).toBe(
      paired
    )
    expect(findIndexedWorktreeOwnerForHost(worktreesByRepo, paired.id, 'ssh:private-target')).toBe(
      paired
    )
    expect(
      findIndexedWorktreeOwnerForHost(worktreesByRepo, directSsh.id, 'ssh:direct-target')
    ).toBe(directSsh)
    expect(
      findIndexedWorktreeOwnerForHost(worktreesByRepo, directSsh.id, 'runtime:hub-a')
    ).toBeNull()
  })
})
