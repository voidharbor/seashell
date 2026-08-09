/**
 * [pure] — the drawer's pty id. No DOM, no react, no electron.
 *
 * The drawer is one shell per pane, and those ptys share the PtyManager map
 * with every pane's. A drawer id therefore has to be unmistakable in that map:
 * main reaps by id, the renderer routes pty output by id, and a collision
 * would send an agent's bytes into a scratch shell or the reverse.
 *
 * Kept in its own module so the ids can be tested without importing the
 * component, which drags in react and xterm.
 */

export const DRAWER_PTY_PREFIX = 'drawer:'

export function drawerPtyId(paneId: string): string {
  return `${DRAWER_PTY_PREFIX}${paneId}`
}
