import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import {
  areTaskSourceContextsEqual,
  normalizeStoredTaskSourceContext
} from '../../../shared/task-source-context'
import {
  areWorkspaceLinkedItemsEqual,
  normalizeWorkspaceLinkedItem
} from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { gcOrphanedWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'

// Why: worktrees deleted outside Orca orphan their worktreeMeta, so the map grew monotonically (63% dead on a heavy install).
// GC stays narrow: local-host entries only (a local existsSync would falsely condemn SSH/WSL remote paths) and only after a 30-day idle grace.
export const WORKTREE_META_GC_GRACE_MS = 30 * 24 * 60 * 60 * 1000
export const STALE_DURABLE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export function gcStaleWorktreeMeta(state: PersistedState): number {
  // Why: a hand-corrupted "worktreeMeta": null overrides the defaults merge; normalize here instead of throwing.
  // Companion lineage maps get the same guard because the deletes below index them directly.
  state.worktreeMeta ??= {}
  state.worktreeLineageById ??= {}
  state.workspaceLineageByChildKey ??= {}
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const projectIds = new Set((state.projects ?? []).map((project) => project.id))
  const now = Date.now()
  let removed = 0
  for (const key of Object.keys(state.worktreeMeta)) {
    // Why: folder-project workspace instances (keyed repoId::path::workspace:<uuid>) ARE the workspace record, not a checkout row; skip them.
    if (key.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
      continue
    }
    const separator = key.indexOf('::')
    if (separator === -1) {
      continue
    }
    const ownerId = key.slice(0, separator)
    const worktreePath = key.slice(separator + 2)
    const meta = state.worktreeMeta[key]
    const repo = repoById.get(ownerId)
    if (repo) {
      if (repo.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
        continue
      }
    } else if (projectIds.has(ownerId)) {
      // Project-owned metas keep their own project/host lifecycle; leave them alone.
      continue
    }
    // Unowned entries (repo removed before metas were pruned) fall through to the same missing-path + idle-grace gate.
    if (meta?.hostId && meta.hostId !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    if (!isAbsolute(worktreePath) || isWslUncPath(worktreePath)) {
      continue
    }
    // Why: WSL worktrees on Windows carry Linux-style paths that Windows existsSync can't probe and would falsely condemn.
    if (process.platform === 'win32' && !isWindowsAbsolutePathLike(worktreePath)) {
      continue
    }
    // Why keep timestamp-less entries: without timestamps we can't prove the 30-day grace elapsed (measured dead entries all had them).
    // Grace is checked before existsSync so active entries skip the stat fan-out (and its slow-NFS tail).
    const newestTouch = Math.max(meta?.lastActivityAt ?? 0, meta?.createdAt ?? 0)
    if (newestTouch === 0 || now - newestTouch < WORKTREE_META_GC_GRACE_MS) {
      continue
    }
    if (existsSync(worktreePath)) {
      continue
    }
    delete state.worktreeMeta[key]
    delete state.worktreeLineageById[key]
    delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(key)]
    removed++
  }
  return removed
}

// Owner identity is (repoId, executionHostId): the same repo id can exist on
// local and a remote host, so orphan detection must not collapse them.
function repoHostOwnerKey(repoId: string, hostId: ExecutionHostId): string {
  return `${repoId}\0${hostId}`
}

export function gcOrphanedRepoState(state: PersistedState): number {
  const liveOwnerIds = new Set([
    ...state.repos.map((repo) => repo.id),
    ...(state.projects ?? []).map((project) => project.id)
  ])
  // Why: an unexpectedly empty owner list must not turn one anomalous load into a full state wipe.
  if (liveOwnerIds.size === 0) {
    return 0
  }
  const liveProjectIds = new Set((state.projects ?? []).map((project) => project.id))
  // Why: repo ids are host-scoped here, so a live local repo1 must not keep a
  // removed SSH repo1's meta/session partition alive (and vice-versa).
  const liveRepoHostKeys = new Set(
    state.repos.map((repo) => repoHostOwnerKey(repo.id, getRepoExecutionHostId(repo)))
  )
  const ownerIdOf = (key: string): string | null => {
    const scope = parseWorkspaceKey(key)
    if (scope?.type === 'folder') {
      return null
    }
    const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : key
    const separator = worktreeId.indexOf('::')
    return separator === -1 ? null : worktreeId.slice(0, separator)
  }
  // Host-agnostic: owner absent from every host. Used for lineage, which carries
  // no host of its own, so its sweep stays as conservative as before.
  const isOrphanKeyAnyHost = (key: string): boolean => {
    const ownerId = ownerIdOf(key)
    return ownerId !== null && !liveOwnerIds.has(ownerId)
  }
  // Host-scoped: owner repo not live on `hostId`. Projects own workspaces across
  // hosts, so a live project id is never an orphan.
  const isOrphanKeyForHost = (key: string, hostId: ExecutionHostId): boolean => {
    const ownerId = ownerIdOf(key)
    if (ownerId === null || liveProjectIds.has(ownerId)) {
      return false
    }
    return !liveRepoHostKeys.has(repoHostOwnerKey(ownerId, hostId))
  }

  let removed = 0
  for (const [key, meta] of Object.entries(state.worktreeMeta)) {
    // Host-tagged metas (the SSH duplicate the bug is about) are scoped to their
    // host; host-less legacy metas stay on the conservative any-host check since
    // they can belong to a remote repo whose host isn't recorded here.
    const orphaned = meta?.hostId
      ? isOrphanKeyForHost(key, meta.hostId)
      : isOrphanKeyAnyHost(key)
    if (orphaned) {
      delete state.worktreeMeta[key]
      removed++
    }
  }
  for (const [childId, lineage] of Object.entries(state.worktreeLineageById)) {
    if (isOrphanKeyAnyHost(childId) || isOrphanKeyAnyHost(lineage.parentWorktreeId)) {
      delete state.worktreeLineageById[childId]
      removed++
    }
  }
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    const childScope = parseWorkspaceKey(childKey)
    const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (
      (childScope?.type === 'worktree' && isOrphanKeyAnyHost(childScope.worktreeId)) ||
      (parentScope?.type === 'worktree' && isOrphanKeyAnyHost(parentScope.worktreeId))
    ) {
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      removed++
    }
  }
  // Why any-host for the legacy blob: it predates host partitions and can hold a
  // remote repo's session, so scoping it to LOCAL would wrongly sweep it.
  const localSession = gcOrphanedWorkspaceSessionOwners(
    state.workspaceSession,
    liveOwnerIds,
    isOrphanKeyAnyHost
  )
  state.workspaceSession = localSession.session
  removed += localSession.removed
  for (const [partitionHostId, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    if (!session) {
      continue
    }
    // A partition's owners all belong to its host, so scope orphan detection to it.
    const host = partitionHostId as ExecutionHostId
    const partition = gcOrphanedWorkspaceSessionOwners(session, liveOwnerIds, (key) =>
      isOrphanKeyForHost(key, host)
    )
    state.workspaceSessionsByHostId![host] = partition.session
    removed += partition.removed
  }
  return removed
}

export function normalizeWorktreeLinkedItemMetadata(state: PersistedState): boolean {
  // Why: a hand-corrupted null lineage map would throw on the companion deletes below. The repair
  // itself is dirty state — without it the map stays null on disk and is repaired again every load.
  let changed =
    (state.worktreeLineageById as unknown) === null ||
    (state.workspaceLineageByChildKey as unknown) === null
  state.worktreeLineageById ??= {}
  state.workspaceLineageByChildKey ??= {}
  const rawWorktreeMeta = state.worktreeMeta as unknown
  if (
    typeof rawWorktreeMeta !== 'object' ||
    rawWorktreeMeta === null ||
    Array.isArray(rawWorktreeMeta)
  ) {
    const hadLineage =
      Object.keys(state.worktreeLineageById).length > 0 ||
      Object.keys(state.workspaceLineageByChildKey).length > 0
    state.worktreeMeta = {}
    // Companions go with the discarded map; a stranded lineage row would otherwise re-attach to a
    // worktree recreated at the same repoId::path.
    state.worktreeLineageById = {}
    state.workspaceLineageByChildKey = {}
    changed ||= rawWorktreeMeta !== undefined || hadLineage
  }
  for (const [key, meta] of Object.entries(state.worktreeMeta)) {
    // Why: hand-corrupted non-object entries are a real input class; drop them here because gcStaleWorktreeMeta
    // keeps timestamp-less keys forever and every downstream consumer trusts the Record<string, WorktreeMeta> type.
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      delete state.worktreeMeta[key]
      // Companions go with it, matching gcStaleWorktreeMeta/removeWorktreeMeta; a stranded lineage row would
      // otherwise re-attach to a worktree recreated at the same repoId::path.
      delete state.worktreeLineageById[key]
      delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(key)]
      changed = true
      continue
    }
    const linkedWorkItem = normalizeWorkspaceLinkedItem(meta.linkedWorkItem)
    const sourceContext = normalizeStoredTaskSourceContext(meta.linkedTaskSourceContext)
    const linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
      linkedWorkItem,
      sourceContext
    )
      ? sourceContext
      : null
    if (!areWorkspaceLinkedItemsEqual(meta.linkedWorkItem, linkedWorkItem)) {
      meta.linkedWorkItem = linkedWorkItem
      changed = true
    }
    if (!areTaskSourceContextsEqual(meta.linkedTaskSourceContext, linkedTaskSourceContext)) {
      meta.linkedTaskSourceContext = linkedTaskSourceContext
      changed = true
    }
  }
  return changed
}
