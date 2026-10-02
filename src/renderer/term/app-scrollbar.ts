import type { Terminal } from '@xterm/xterm'
import {
  PAGE_NOTCHES,
  applyNotches,
  dragNotches,
  initialScroll,
  thumbGeometry,
  trackSide,
  type AppScrollState,
} from './app-scroll.js'

/** Wheel delta per notch sent, the size of one real mouse-wheel click. */
const NOTCH_DELTA = 120
/** Track press: first repeat after this, then one page per interval. */
const REPEAT_DELAY_MS = 350
const REPEAT_EVERY_MS = 90

/**
 * The scrollbar for a pane whose program keeps its own history (see
 * app-scroll.ts for the model and why it counts wheel notches).
 *
 * It only exists while the pane is on the alternate screen with mouse reporting
 * on, and it moves the program the same way the wheel does: every notch is a
 * real WheelEvent dispatched at xterm's screen, so xterm encodes it in whatever
 * mouse protocol the program asked for. Those events are untrusted, which is how
 * noteWheel() tells them from the user's own wheel and avoids counting twice.
 *
 * The element is appended to the terminal's host imperatively, next to xterm's
 * own, and nothing React renders lives in that node.
 */
export class AppScrollbar {
  private readonly el: HTMLDivElement
  private readonly thumb: HTMLDivElement
  private state: AppScrollState = initialScroll()
  private active = false
  private drag: { pointerId: number; startY: number; start: AppScrollState } | null = null
  private repeatTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLElement
  ) {
    this.el = document.createElement('div')
    this.el.className = 'app-scrollbar'
    this.thumb = document.createElement('div')
    this.thumb.className = 'app-scrollbar__thumb'
    this.el.appendChild(this.thumb)
    host.appendChild(this.el)

    this.el.addEventListener('pointerdown', this.onPointerDown)
    this.el.addEventListener('pointermove', this.onPointerMove)
    this.el.addEventListener('pointerup', this.onPointerUp)
    this.el.addEventListener('pointercancel', this.onPointerUp)
    // A press here must not become a click in the program or move focus off
    // the terminal's textarea.
    this.el.addEventListener('mousedown', swallow)
    this.el.addEventListener('wheel', this.onWheel, { passive: false })
  }

  /** True for events that started on the bar, which the terminal must ignore. */
  owns(target: EventTarget | null): boolean {
    return target instanceof Node && this.el.contains(target)
  }

  /** Re-check whether the program owns the scroll. Cheap; call on every write. */
  sync(): void {
    if (this.disposed) return
    const on = this.term.buffer.active.type === 'alternate' && this.term.modes.mouseTrackingMode !== 'none'
    if (on === this.active) return
    this.active = on
    this.state = initialScroll()
    this.host.classList.toggle('app-scroll', on)
    this.render()
  }

  /** The user's own wheel over the pane moved the program too. */
  noteWheel(ev: WheelEvent): void {
    if (!this.active || !ev.isTrusted || ev.deltaY === 0 || ev.shiftKey) return
    this.state = applyNotches(this.state, ev.deltaY < 0 ? 1 : -1)
    this.render()
  }

  /** A submitted line brings the program back to its live bottom. */
  noteSubmit(): void {
    if (!this.active || this.state.offset === 0) return
    this.state = initialScroll()
    this.render()
  }

  dispose(): void {
    this.disposed = true
    this.stopRepeat()
    this.host.classList.remove('app-scroll')
    this.el.remove()
  }

  private send(notches: number): void {
    const screen = this.term.element?.querySelector('.xterm-screen')
    if (!screen || notches === 0) return
    const r = screen.getBoundingClientRect()
    const init: WheelEventInit = {
      deltaY: notches > 0 ? -NOTCH_DELTA : NOTCH_DELTA,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
    }
    for (let i = 0; i < Math.abs(notches); i++) screen.dispatchEvent(new WheelEvent('wheel', init))
    this.state = applyNotches(this.state, notches)
    this.render()
  }

  private render(): void {
    if (!this.active) return
    const t = thumbGeometry(this.state, this.el.clientHeight)
    this.thumb.style.top = `${t.top}px`
    this.thumb.style.height = `${t.height}px`
  }

  private onWheel = (ev: WheelEvent): void => {
    // Over the bar the wheel does what it does over the text.
    ev.preventDefault()
    if (ev.deltaY !== 0) this.send(ev.deltaY < 0 ? 1 : -1)
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const y = ev.clientY - this.el.getBoundingClientRect().top
    const side = trackSide(this.state, this.el.clientHeight, y)
    this.el.setPointerCapture(ev.pointerId)
    if (side === 'thumb') {
      this.drag = { pointerId: ev.pointerId, startY: ev.clientY, start: this.state }
      this.el.classList.add('app-scrollbar--dragging')
      return
    }
    // Page toward the press, then keep paging while it is held, until the
    // thumb reaches the pointer: the Windows track behaviour.
    const step = side === 'above' ? PAGE_NOTCHES : -PAGE_NOTCHES
    const tick = (): void => {
      if (trackSide(this.state, this.el.clientHeight, y) !== side) return this.stopRepeat()
      this.send(step)
      this.repeatTimer = setTimeout(tick, REPEAT_EVERY_MS)
    }
    this.send(step)
    this.repeatTimer = setTimeout(tick, REPEAT_DELAY_MS)
  }

  private onPointerMove = (ev: PointerEvent): void => {
    const d = this.drag
    if (!d || ev.pointerId !== d.pointerId) return
    this.send(dragNotches(d.start, this.state, ev.clientY - d.startY, this.el.clientHeight))
  }

  private onPointerUp = (ev: PointerEvent): void => {
    this.stopRepeat()
    if (this.el.hasPointerCapture(ev.pointerId)) this.el.releasePointerCapture(ev.pointerId)
    this.drag = null
    this.el.classList.remove('app-scrollbar--dragging')
  }

  private stopRepeat(): void {
    if (this.repeatTimer) clearTimeout(this.repeatTimer)
    this.repeatTimer = null
  }
}

function swallow(ev: Event): void {
  ev.preventDefault()
  ev.stopPropagation()
}
