/**
 * Velocity-ramped wheel scrolling. [pure]
 *
 * Measures how fast the wheel is moving (an exponential moving average of
 * pixels per millisecond) and returns a multiplier for xterm's
 * `scrollSensitivity`. Below `onset` the multiplier is exactly 1, so a slow,
 * deliberate trackpad scroll is untouched. Above it the multiplier rises
 * linearly with `gain` and is clamped at `ceiling`. A pause longer than
 * `decayMs` resets everything, so the next scroll starts precise again.
 *
 * The constants were validated with synthetic wheel events dispatched over
 * CDP (deltaY 4 every 16 ms for "slow", deltaY 120 every 8 ms for "flick"),
 * not a live trackpad: slow stayed at multiplier 1 moving a few lines per
 * event, flick reached the ceiling of 8 moving hundreds of lines per burst,
 * and the alternate buffer forced 1x throughout. See the 0.5 spec, section 3,
 * and task-6-report.md for the recorded numbers. Open to a live trackpad
 * adjustment; change onset and gain together, not one at a time.
 */
export interface WheelRampOptions {
  /** Largest multiplier ever returned. */
  ceiling: number
  /** px/ms below which the ramp stays at 1. */
  onset: number
  /** Multiplier gained per px/ms above onset. */
  gain: number
  /** Idle gap that resets the ramp. */
  decayMs: number
  /** EMA weight of the newest sample, 0..1. */
  smoothing: number
}

export const WHEEL_RAMP_DEFAULTS: WheelRampOptions = {
  ceiling: 8,
  onset: 1.5,
  gain: 1.2,
  decayMs: 200,
  smoothing: 0.3,
}

/** Pixels per unit for WheelEvent.deltaMode 1 (line) and 2 (page). */
const LINE_PX = 16
const PAGE_PX = 400

export class WheelRamp {
  private readonly o: WheelRampOptions
  private velocity = 0
  private lastAt = -1

  constructor(opts: Partial<WheelRampOptions> = {}) {
    this.o = { ...WHEEL_RAMP_DEFAULTS, ...opts }
  }

  feed(deltaY: number, deltaMode: number, now: number): number {
    const px = Math.abs(deltaY) * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1)
    if (this.lastAt < 0 || now - this.lastAt > this.o.decayMs) {
      this.velocity = 0
      this.lastAt = now
      return 1
    }
    const dt = Math.max(1, now - this.lastAt)
    this.lastAt = now
    const inst = px / dt
    this.velocity += (inst - this.velocity) * this.o.smoothing
    if (this.velocity <= this.o.onset) return 1
    return Math.min(this.o.ceiling, 1 + (this.velocity - this.o.onset) * this.o.gain)
  }

  reset(): void {
    this.velocity = 0
    this.lastAt = -1
  }
}
