// Why: a backgrounded host renderer is Electron-throttled, stalling the
// setTimeout-coalesced graph syncs that publish terminal surfaces to a paired
// client (its create/close deadline) while main-process PTY I/O stays fast.
// Keep the renderer unthrottled while a remote client is connected; restore the
// power-saving default once the last one leaves.

export type BackgroundThrottleTarget = {
  setBackgroundThrottling: (allowed: boolean) => void
  isDestroyed: () => boolean
}

export class RemoteClientRendererThrottle {
  private connectedClients = 0

  // Why: resolve the target lazily so the controller survives window promotion
  // (headless serve → desktop window) and destruction without holding a stale
  // webContents reference.
  constructor(private readonly getTarget: () => BackgroundThrottleTarget | null) {}

  get activeClientCount(): number {
    return this.connectedClients
  }

  onRemoteClientConnected(): void {
    this.connectedClients += 1
    if (this.connectedClients === 1) {
      // Why: first client — the renderer must stay responsive while serving.
      this.applyThrottling(false)
    }
  }

  onRemoteClientDisconnected(): void {
    if (this.connectedClients === 0) {
      return
    }
    this.connectedClients -= 1
    if (this.connectedClients === 0) {
      // Why: last client left — restore Electron's power-saving default.
      this.applyThrottling(true)
    }
  }

  // Why: a freshly attached or promoted window must inherit the serving state
  // decided by clients that authenticated before that window existed.
  reapply(): void {
    this.applyThrottling(this.connectedClients === 0)
  }

  private applyThrottling(allowed: boolean): void {
    const target = this.getTarget()
    if (!target || target.isDestroyed()) {
      return
    }
    target.setBackgroundThrottling(allowed)
  }
}
