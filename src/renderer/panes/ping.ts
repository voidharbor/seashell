/**
 * The attention ping.
 *
 * Synthesised with Web Audio rather than shipped as a sound file. The renderer
 * runs under `default-src 'none'` with no `media-src`, so an asset would mean
 * widening the CSP of a window that displays untrusted terminal bytes — a bad
 * trade for a notification noise. Two short sine tones cost nothing and need no
 * policy change.
 *
 * Deliberately quiet and short. This fires while the user is working in another
 * window; it needs to be noticeable when you are listening for it and ignorable
 * when you are not.
 */

/** Minimum gap between pings. Six panes finishing at once is one event to a
 *  human, not six, and six overlapping pings is just a noise. */
export const PING_MIN_GAP_MS = 1800

/**
 * Whether a ping may sound now. Pure so the rate limiting can be tested without
 * an audio context, which is the part with a rule worth getting right.
 */
export function shouldPing(now: number, lastAt: number | null, minGapMs = PING_MIN_GAP_MS): boolean {
  if (lastAt === null) return true
  // A clock that jumped backwards must not silence the ping until it catches up.
  if (now < lastAt) return true
  return now - lastAt >= minGapMs
}

let ctx: AudioContext | null = null
let lastPingAt: number | null = null

/**
 * Chromium refuses to start an AudioContext until the page has seen a real user
 * gesture, and a context created before that starts `suspended`. Resuming it on
 * the first interaction means the first ping actually sounds instead of being
 * silently dropped — which would read as "the setting does not work".
 */
export function unlockAudio(): void {
  const resume = (): void => {
    try {
      if (!ctx) ctx = new AudioContext()
      if (ctx.state === 'suspended') void ctx.resume()
    } catch {
      /* no audio device, or blocked — pings simply do not sound */
    }
  }
  window.addEventListener('pointerdown', resume, { once: true })
  window.addEventListener('keydown', resume, { once: true })
}

/**
 * Two descending tones, ~180 ms total. Rate limited internally so callers can
 * fire per pane without coordinating.
 */
export function playAttentionPing(now: number = Date.now()): boolean {
  if (!shouldPing(now, lastPingAt)) return false

  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()

    const start = ctx.currentTime
    // A major sixth down: distinct from a system alert, and reads as a
    // notification rather than an error.
    for (const [i, freq] of [880, 587.33].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq

      const at = start + i * 0.09
      // Ramped, never switched: a gain that jumps to zero clicks audibly.
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.06, at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.13)
    }

    lastPingAt = now
    return true
  } catch {
    // No audio device, or the context was refused. Never let a notification
    // sound take down the render path.
    return false
  }
}

/** Test seam — resets the module's rate-limit clock. */
export function resetPingClock(): void {
  lastPingAt = null
}
