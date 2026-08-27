import { useAppStore } from '@/store'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import { queuePaneFocus } from './pending-pane-focus'

let pendingFocusPaneFrameId: number | null = null

function cancelPendingFocusPaneFrame(): void {
  if (pendingFocusPaneFrameId !== null) {
    cancelAnimationFrame(pendingFocusPaneFrameId)
    pendingFocusPaneFrameId = null
  }
}

export function activateTabAndFocusPane(
  tabId: string,
  leafId: string | null,
  opts?: {
    ackPaneKeyOnSuccess?: string
    flashFocusedPane?: boolean
    scrollToBottomIfOutputSinceLastView?: boolean
  }
): void {
  const { setActiveTab, setActiveTabType } = useAppStore.getState()
  // Why: selecting a terminal tab is independent from the visible surface;
  // force Terminal first so tab-only activation reveals the full log.
  setActiveTabType('terminal')
  setActiveTab(tabId)
  cancelPendingFocusPaneFrame()
  if (leafId === null) {
    return
  }
  // Why: defer one frame so the new TerminalPane has mounted its
  // FOCUS_TERMINAL_PANE_EVENT listener before we dispatch.
  pendingFocusPaneFrameId = requestAnimationFrame(() => {
    pendingFocusPaneFrameId = null
    const detail: FocusTerminalPaneDetail = {
      tabId,
      leafId,
      ...(opts?.ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess: opts.ackPaneKeyOnSuccess } : {}),
      ...(opts?.flashFocusedPane ? { flashFocusedPane: true } : {}),
      ...(opts?.scrollToBottomIfOutputSinceLastView
        ? { scrollToBottomIfOutputSinceLastView: true }
        : {})
    }
    // Why: park the detail too — a cold-parked pane mounts its listener after
    // this frame and would otherwise miss the dispatch entirely.
    queuePaneFocus(tabId, detail)
    window.dispatchEvent(
      new CustomEvent<FocusTerminalPaneDetail>(FOCUS_TERMINAL_PANE_EVENT, {
        detail
      })
    )
  })
}
