import { useCallback } from 'react'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { destroyWorkspaceWebviews } from '../../store/slices/browser-webview-cleanup'
import { requestEditorFileClose } from '../editor/editor-autosave'
import {
  closeWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '../../runtime/web-runtime-session'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'
import { guardTabClose, resolveTabLabel } from '../../store/tab-close-guard'

export function useTabGroupTabCloseCommands({
  worktreeId,
  groupTabs
}: {
  worktreeId: string
  groupTabs: Tab[]
}) {
  const closeUnifiedTab = useAppStore((state) => state.closeUnifiedTab)
  const closeTab = useAppStore((state) => state.closeTab)
  const closeFile = useAppStore((state) => state.closeFile)
  const closeBrowserTab = useAppStore((state) => state.closeBrowserTab)
  const setActiveWorktree = useAppStore((state) => state.setActiveWorktree)

  const closeEditorIfUnreferenced = useCallback(
    (entityId: string, closingTabId: string) => {
      const otherReference = (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).some(
        (item) =>
          item.id !== closingTabId &&
          item.entityId === entityId &&
          (item.contentType === 'editor' ||
            item.contentType === 'diff' ||
            item.contentType === 'conflict-review' ||
            item.contentType === 'check-details')
      )
      if (!otherReference) {
        const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === entityId)
        if (file?.isDirty) {
          // Why: route through Terminal.tsx so the unsaved-confirmation save/discard queue stays centralized across all close paths.
          requestEditorFileClose(entityId)
          return false
        }
        closeFile(entityId)
      }
      return true
    },
    [closeFile, worktreeId]
  )

  const leaveWorktreeIfEmpty = useCallback(() => {
    const state = useAppStore.getState()
    if (state.activeWorktreeId !== worktreeId) {
      return
    }
    // Why: split-group closes bypass legacy Terminal.tsx; deselect the emptied worktree here or the window goes blank instead of landing.
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (renderableTabCount === 0) {
      setActiveWorktree(null)
    }
  }, [setActiveWorktree, worktreeId])

  const closeItem = useCallback(
    (itemId: string, opts?: { skipEmptyCheck?: boolean; userInitiated?: boolean }) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      if (item.isPinned) {
        return
      }
      // Why: single-tab close gestures default to user-initiated; only these open
      // the confirm-any-tab dialog. Bulk callers (close-all, empty-group) opt out.
      const userInitiated = opts?.userInitiated ?? true
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
        useAppStore.getState(),
        worktreeId
      )
      if (item.contentType === 'terminal') {
        // Why: closeTerminalTab owns the pinned/confirm-any/running-process guards and can
        // defer behind a dialog, so the empty check runs on the actual close, never on cancel.
        closeTerminalTab(item.entityId, {
          userInitiated,
          ...(opts?.skipEmptyCheck ? {} : { onClosed: leaveWorktreeIfEmpty })
        })
        return
      }
      const performClose = (): void => {
        if (item.contentType === 'browser') {
          const browserState = useAppStore.getState()
          const hasLocalPages = (browserState.browserPagesByWorkspace[item.entityId] ?? []).length > 0
          // Why: host-close a remote-owned browser or a pageless host-mirror (else un-closable); local fallbacks have pages so stay local.
          const shouldCloseOnHost =
            isWebRuntimeSessionActive(runtimeEnvironmentId) &&
            (browserWorkspaceHasRemoteOwner(browserState, item.entityId, runtimeEnvironmentId) ||
              !hasLocalPages)
          if (shouldCloseOnHost) {
            void closeWebRuntimeSessionTab({
              worktreeId,
              tabId: item.id,
              environmentId: runtimeEnvironmentId,
              reason: 'user'
            })
          }
          closeBrowserTab(item.entityId)
          destroyWorkspaceWebviews(browserState.browserPagesByWorkspace, item.entityId)
          closeUnifiedTab(item.id)
        } else if (item.contentType === 'simulator') {
          closeUnifiedTab(item.id)
        } else {
          const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
          if (!canCloseTab) {
            return
          }
          closeUnifiedTab(item.id)
        }
        if (!opts?.skipEmptyCheck) {
          leaveWorktreeIfEmpty()
        }
      }
      // Why: dirty editors already prompt via the save/discard dialog, so don't double-prompt.
      const isDirtyEditor =
        item.contentType !== 'browser' &&
        item.contentType !== 'simulator' &&
        (useAppStore.getState().openFiles.find((file) => file.id === item.entityId)?.isDirty ??
          false)
      if (
        userInitiated &&
        !isDirtyEditor &&
        (useAppStore.getState().settings?.confirmCloseAnyTab ?? false)
      ) {
        guardTabClose({
          isPinned: false,
          tabLabel: resolveTabLabel(useAppStore.getState(), worktreeId, item.id),
          userInitiated: true,
          onClose: performClose
        })
        return
      }
      performClose()
    },
    [
      closeBrowserTab,
      closeEditorIfUnreferenced,
      closeUnifiedTab,
      groupTabs,
      leaveWorktreeIfEmpty,
      worktreeId
    ]
  )

  const closeMany = useCallback(
    (itemIds: string[]) => {
      for (const itemId of itemIds) {
        const item = groupTabs.find((candidate) => candidate.id === itemId)
        if (!item || item.isPinned) {
          continue
        }
        const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
          useAppStore.getState(),
          worktreeId
        )
        if (item.contentType === 'terminal' && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
          // Why: revoke local resume + hook authority before the host removes its canonical tab.
          // No running-process prompt: a bulk close of N busy tabs would be a modal storm.
          closeTerminalTab(item.entityId, { skipRunningProcessConfirm: true })
          continue
        }
        if (item.contentType === 'browser') {
          // Why: see closeItem — host-close a remote-owned browser or pageless host-mirror; always remove the visible tab.
          const browserState = useAppStore.getState()
          const hasLocalPages =
            (browserState.browserPagesByWorkspace[item.entityId] ?? []).length > 0
          const shouldCloseOnHost =
            isWebRuntimeSessionActive(runtimeEnvironmentId) &&
            (browserWorkspaceHasRemoteOwner(browserState, item.entityId, runtimeEnvironmentId) ||
              !hasLocalPages)
          if (shouldCloseOnHost) {
            void closeWebRuntimeSessionTab({
              worktreeId,
              tabId: item.id,
              environmentId: runtimeEnvironmentId,
              reason: 'user'
            })
          }
          closeBrowserTab(item.entityId)
          destroyWorkspaceWebviews(browserState.browserPagesByWorkspace, item.entityId)
          closeUnifiedTab(item.id)
        } else if (item.contentType === 'terminal') {
          closeTab(item.entityId)
        } else if (item.contentType === 'simulator') {
          closeUnifiedTab(item.id)
        } else {
          const canCloseTab = closeEditorIfUnreferenced(item.entityId, item.id)
          if (canCloseTab) {
            closeUnifiedTab(item.id)
          }
        }
      }
    },
    [closeBrowserTab, closeEditorIfUnreferenced, closeTab, closeUnifiedTab, groupTabs, worktreeId]
  )

  return { closeItem, closeMany, leaveWorktreeIfEmpty }
}
