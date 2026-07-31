import { describe, expect, it, vi } from 'vitest'
import {
  RemoteClientRendererThrottle,
  type BackgroundThrottleTarget
} from './remote-client-renderer-throttle'

function createTarget(): BackgroundThrottleTarget & {
  calls: boolean[]
  destroyed: boolean
} {
  const calls: boolean[] = []
  return {
    calls,
    destroyed: false,
    setBackgroundThrottling(allowed: boolean) {
      calls.push(allowed)
    },
    isDestroyed() {
      return this.destroyed
    }
  }
}

describe('RemoteClientRendererThrottle', () => {
  it('unthrottles the renderer on the first client and restores throttling on the last', () => {
    const target = createTarget()
    const throttle = new RemoteClientRendererThrottle(() => target)

    throttle.onRemoteClientConnected()
    throttle.onRemoteClientConnected()
    throttle.onRemoteClientDisconnected()
    throttle.onRemoteClientDisconnected()

    // Why: one unthrottle at the leading edge, one throttle at the trailing edge — not per client.
    expect(target.calls).toEqual([false, true])
    expect(throttle.activeClientCount).toBe(0)
  })

  it('keeps the renderer unthrottled while any client remains connected', () => {
    const target = createTarget()
    const throttle = new RemoteClientRendererThrottle(() => target)

    throttle.onRemoteClientConnected()
    throttle.onRemoteClientConnected()
    throttle.onRemoteClientDisconnected()

    expect(target.calls).toEqual([false])
    expect(throttle.activeClientCount).toBe(1)
  })

  it('ignores an unbalanced disconnect without going negative or re-toggling', () => {
    const target = createTarget()
    const throttle = new RemoteClientRendererThrottle(() => target)

    throttle.onRemoteClientDisconnected()

    expect(target.calls).toEqual([])
    expect(throttle.activeClientCount).toBe(0)
  })

  it('reapply reinstalls the serving state onto the current target', () => {
    const target = createTarget()
    const throttle = new RemoteClientRendererThrottle(() => target)

    throttle.onRemoteClientConnected()
    target.calls.length = 0
    throttle.reapply()

    expect(target.calls).toEqual([false])
  })

  it('reapply restores the throttled default when no client is connected', () => {
    const target = createTarget()
    const throttle = new RemoteClientRendererThrottle(() => target)

    throttle.reapply()

    expect(target.calls).toEqual([true])
  })

  it('does not touch a destroyed or missing target', () => {
    const target = createTarget()
    let current: BackgroundThrottleTarget | null = target
    const throttle = new RemoteClientRendererThrottle(() => current)

    current = null
    throttle.onRemoteClientConnected()
    current = target
    target.destroyed = true
    throttle.onRemoteClientDisconnected()

    expect(target.calls).toEqual([])
  })

  it('lazily resolves the target so window promotion is picked up', () => {
    const target = createTarget()
    let current: BackgroundThrottleTarget | null = null
    const getTarget = vi.fn(() => current)
    const throttle = new RemoteClientRendererThrottle(getTarget)

    throttle.onRemoteClientConnected()
    expect(target.calls).toEqual([])

    // Why: a window attaches after the client connected; reapply must use it.
    current = target
    throttle.reapply()

    expect(target.calls).toEqual([false])
  })
})
