import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/types'
import type { TreeNode } from './file-explorer-types'

export type AddProjectFromFolderModalData = {
  folderPath: string
  connectionId?: string
  runtimeEnvironmentId?: string | null
}

export function canShowAddAsProjectAction(node: TreeNode, activeRepo: Repo | null): boolean {
  return node.isDirectory && Boolean(activeRepo && isFolderRepo(activeRepo))
}

export function buildAddProjectFromFolderModalData(
  node: TreeNode,
  activeRepo: Repo
): AddProjectFromFolderModalData {
  if (activeRepo.connectionId) {
    return { folderPath: node.path, connectionId: activeRepo.connectionId }
  }
  // Why: a subfolder lives on the active repo's host, so route by that host — not
  // the globally-active runtime, which can point elsewhere (e.g. a remote server
  // while this project is local).
  const host = parseExecutionHostId(getRepoExecutionHostId(activeRepo))
  return {
    folderPath: node.path,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
  }
}
