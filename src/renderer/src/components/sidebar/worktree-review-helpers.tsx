import { GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PullRequestIcon } from './WorktreeCardHelpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export function getReviewLabel(review: WorktreeCardPrDisplay): 'MR' | 'PR' {
  // Custom servers are GitLab-compatible in v1, so they use merge-request copy.
  return review.provider === 'gitlab' || review.provider === 'custom' ? 'MR' : 'PR'
}

export function getProviderName(review: WorktreeCardPrDisplay): string {
  if (review.provider === 'gitlab') {
    return 'GitLab'
  }
  if (review.provider === 'bitbucket') {
    return 'Bitbucket'
  }
  if (review.provider === 'azure-devops') {
    return 'Azure DevOps'
  }
  if (review.provider === 'gitea') {
    return 'Gitea'
  }
  if (review.provider === 'custom') {
    return 'Custom git server'
  }
  return 'GitHub'
}

export function ReviewIcon({
  review,
  className,
  variant = 'provider'
}: {
  review: WorktreeCardPrDisplay
  className?: string
  variant?: 'provider' | 'generic'
}): React.JSX.Element {
  const Icon =
    variant === 'provider' && (review.provider === 'gitlab' || review.provider === 'custom')
      ? GitMerge
      : PullRequestIcon
  const checkTone =
    review.state !== 'merged' && review.status === 'failure'
      ? 'text-rose-500/85'
      : review.state !== 'merged' && review.status === 'pending'
        ? 'text-amber-500/85'
        : review.state === 'open' && review.status === 'success'
          ? 'text-emerald-500/80'
          : null
  return (
    <Icon
      className={cn(
        className,
        checkTone,
        review.state === 'merged' && 'text-purple-600/70 dark:text-purple-400/70',
        !checkTone && review.state === 'open' && 'text-emerald-500/80',
        !checkTone && review.state === 'closed' && 'text-muted-foreground/60',
        !checkTone && review.state === 'draft' && 'text-muted-foreground/50',
        !checkTone &&
          (!review.state || !['merged', 'open', 'closed', 'draft'].includes(review.state)) &&
          'text-muted-foreground opacity-70'
      )}
    />
  )
}
