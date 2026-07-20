import type { ForgeProvider, ForgeProviderRepositoryContext } from './forge-provider'
import { getCustomGitServerFlavorClient } from '../custom-git-server/api-flavor'
import { getCustomGitServerRepoRef } from '../custom-git-server/repository-ref'
import { getHostedReviewLocalGitOptions } from './hosted-review-git-options'

// User-configured self-hosted servers (e.g. git.example.com). Claims a repo only
// when its origin host matches a saved server; dispatches to the server's
// configured API flavor (GitLab-compatible, extensible). Native REST — no CLI.
async function resolveCustomGitServerRef(
  context: ForgeProviderRepositoryContext
): ReturnType<typeof getCustomGitServerRepoRef> {
  return getCustomGitServerRepoRef(
    context.repoPath,
    context.connectionId,
    getHostedReviewLocalGitOptions(context)
  )
}

function customGitServerToken(serverId: string): Promise<string | null> {
  // Lazy so the electron-backed token store stays out of the static import graph;
  // only reached once a repo actually matches a custom server.
  return import('../custom-git-server/token-store')
    .then((mod) => {
      try {
        return mod.getCustomGitServerToken(serverId)
      } catch {
        // Undecryptable token — treat as unauthenticated rather than throwing.
        return null
      }
    })
    .catch(() => null)
}

export const customForgeProvider = {
  id: 'custom',
  supportsReviewCreation: true,
  resolveRepository: (context) => resolveCustomGitServerRef(context),
  async getReviewForBranch(input) {
    const ref = await resolveCustomGitServerRef(input)
    if (!ref) {
      return null
    }
    return getCustomGitServerFlavorClient(ref.server.apiFlavor).getReviewForBranch(
      ref,
      await customGitServerToken(ref.server.id),
      input.branch,
      input.linkedReviewNumber ?? null
    )
  },
  async getReviewByNumber(input) {
    const ref = await resolveCustomGitServerRef(input)
    if (!ref) {
      return null
    }
    return getCustomGitServerFlavorClient(ref.server.apiFlavor).getReviewByNumber(
      ref,
      await customGitServerToken(ref.server.id),
      input.number
    )
  },
  async createReview(repoPath, input, connectionId, options) {
    const ref = await resolveCustomGitServerRef({ repoPath, connectionId, ...options })
    if (!ref) {
      return {
        ok: false,
        code: 'unsupported_provider',
        error: 'Creating reviews requires a configured custom git server for this remote.'
      }
    }
    return getCustomGitServerFlavorClient(ref.server.apiFlavor).createReview(
      ref,
      await customGitServerToken(ref.server.id),
      input,
      repoPath,
      connectionId
    )
  }
} satisfies ForgeProvider
