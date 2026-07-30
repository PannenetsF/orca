// Why: the host renderer publishes new terminal surfaces and tab snapshots to a
// paired client through setTimeout-coalesced graph syncs (see
// src/renderer/src/runtime/sync-runtime-graph.ts). Electron background-throttles
// a hidden/occluded window's renderer on every platform, so a remote host left
// in the background stalls session open/close for its paired client — the 10s
// "Timed out waiting for terminal surface after creation" host deadline — even
// though main-process PTY I/O (live keystrokes) stays fast. Keep the renderer
// unthrottled while at least one remote client is connected, and restore the
// throttled default once the last one disconnects so an unattended host still
// saves power.

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
