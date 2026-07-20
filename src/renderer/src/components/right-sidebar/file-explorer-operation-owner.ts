import { getConnectionIdFromState } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getSettingsForWorktreeRuntimeOwner
} from '@/lib/worktree-runtime-owner'
import type { FileExplorerOperationOwner } from './file-explorer-types'

export type FileExplorerOperationRoute = {
  settings: { activeRuntimeEnvironmentId: string | null }
  connectionId?: string
}

type FileExplorerOwnerState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function getFileExplorerOperationOwnerFromState(
  state: FileExplorerOwnerState,
  worktreeId: string | null | undefined,
  // Why: a browser web client has no local host, so a `local`-owned worktree on
  // a headless `orca serve` must be operated through the connected server runtime
  // instead of the (nonexistent) browser-local host. Injected for testability;
  // the store-backed getFileExplorerOperationOwner passes isWebClientLocation().
  isWebClient: boolean = false
): FileExplorerOperationOwner {
  const parsedWorkspace = worktreeId ? parseWorkspaceKey(worktreeId) : null
  if (worktreeId && parsedWorkspace?.type !== 'folder') {
    const exactHostIds = getExactWorktreeHostIds(state, worktreeId)
    if (exactHostIds.size > 1) {
      return { kind: 'unresolved' }
    }
    const exactHostId = exactHostIds.values().next().value
    if (exactHostId) {
      return operationOwnerFromHostId(exactHostId, state, isWebClient)
    }

    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const repoHostIds = new Set(
      state.repos.filter((repo) => repo.id === repoId).map(getRepoExecutionHostId)
    )
    if (repoHostIds.size > 1) {
      return { kind: 'unresolved' }
    }
  }

  const connectionId = getConnectionIdFromState(state, worktreeId ?? null)
  const explicitRuntimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why: global runtime focus is not ownership evidence while SSH/local
  // metadata is unresolved; destructive actions must wait for explicit provenance.
  if (connectionId === undefined && explicitRuntimeEnvironmentId === null) {
    return { kind: 'unresolved' }
  }
  const settings = getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  // Why: inferred SSH ownership outranks global runtime focus, but an explicit
  // workspace runtime still owns its files.
  const runtimeEnvironmentId =
    connectionId && explicitRuntimeEnvironmentId === null
      ? null
      : settings.activeRuntimeEnvironmentId?.trim()
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', environmentId: runtimeEnvironmentId }
  }
  if (connectionId === undefined) {
    return { kind: 'unresolved' }
  }
  return connectionId
    ? { kind: 'ssh', connectionId }
    : localOrConnectedRuntimeOwner(state, isWebClient)
}

export function getFileExplorerOperationOwner(
  worktreeId: string | null | undefined
): FileExplorerOperationOwner {
  return getFileExplorerOperationOwnerFromState(
    useAppStore.getState(),
    worktreeId,
    isWebClientLocation()
  )
}

export function getFileExplorerOperationRoute(
  owner: FileExplorerOperationOwner
): FileExplorerOperationRoute | null {
  switch (owner.kind) {
    case 'local':
      return { settings: { activeRuntimeEnvironmentId: null } }
    case 'ssh':
      return {
        settings: { activeRuntimeEnvironmentId: null },
        connectionId: owner.connectionId
      }
    case 'runtime':
      return { settings: { activeRuntimeEnvironmentId: owner.environmentId } }
    case 'unresolved':
      return null
  }
}

export function getFileExplorerOwnerUnresolvedMessage(): string {
  return translate(
    'auto.components.right.sidebar.fileExplorerOperationOwner.unresolved',
    "Couldn't determine which host owns this workspace. Check the connection and try again."
  )
}

function getExactWorktreeHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
): Set<ExecutionHostId> {
  const hostIds = new Set<ExecutionHostId>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (worktree.id === worktreeId && worktree.hostId) {
        hostIds.add(worktree.hostId)
      }
    }
  }
  for (const result of Object.values(state.detectedWorktreesByRepo)) {
    for (const worktree of result.worktrees) {
      if (worktree.id === worktreeId && worktree.hostId) {
        hostIds.add(worktree.hostId)
      }
    }
  }
  return hostIds
}

function operationOwnerFromHostId(
  hostId: ExecutionHostId,
  state: FileExplorerOwnerState,
  isWebClient: boolean
): FileExplorerOperationOwner {
  const parsed = parseExecutionHostId(hostId)
  switch (parsed?.kind) {
    case 'local':
      return localOrConnectedRuntimeOwner(state, isWebClient)
    case 'ssh':
      return { kind: 'ssh', connectionId: parsed.targetId }
    case 'runtime':
      return { kind: 'runtime', environmentId: parsed.environmentId }
    case undefined:
      return { kind: 'unresolved' }
  }
}

// Why: on a browser web client there is no local host, so a `local`-owned
// worktree can only be operated through the server the client is connected to.
// The connected server's runtime env is the client's activeRuntimeEnvironmentId
// (set to the connected environment id on web startup). Resolving to it lets
// file listing, deletion, and terminals work for local worktrees on a headless
// `orca serve`, and it is per-connection so different browsers/devices each use
// their own server. On desktop (isWebClient=false) behavior is unchanged.
function localOrConnectedRuntimeOwner(
  state: FileExplorerOwnerState,
  isWebClient: boolean
): FileExplorerOperationOwner {
  if (isWebClient) {
    const connectedEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
    if (connectedEnvironmentId) {
      return { kind: 'runtime', environmentId: connectedEnvironmentId }
    }
  }
  return { kind: 'local' }
}
