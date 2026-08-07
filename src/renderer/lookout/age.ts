/**
 * How long a card has been waiting, in the fewest characters that still say
 * something true.
 *
 * A rail with four cards in it is a rail you came back to, and the first
 * question about each one is "how long has this been sitting there" — a
 * question that was two minutes ago is the one still worth answering, and one
 * from an hour ago usually means the pane moved on without you. The card
 * already carries `createdAt`; this turns it into the one word that fits
 * beside a pane name.
 *
 * Deliberately coarse. Seconds would demand a per-second re-render of a panel
 * that is otherwise idle, and this app has spent real effort on staying quiet
 * when nothing is happening — minute granularity lets the caller tick once a
 * minute, and only while cards exist.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * @param createdAt card creation time, in main's wall clock (Date.now)
 * @param now       current wall clock
 * @returns e.g. `now`, `3m`, `1h`, `2h 5m` — or null when the value is not
 *          usable, so the caller renders nothing rather than a wrong number.
 */
export function ageLabel(createdAt: number, now: number): string | null {
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) return null
  const ms = now - createdAt
  // A negative age means the two clocks disagree (main stamped the card a
  // moment ahead of this render). "in the future" is never information the
  // user wants, so say nothing rather than "-1m".
  if (ms < 0) return null
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  const hours = Math.floor(ms / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  // Past a day the exact hour count stops mattering and starts taking space
  // from the pane name; anything this old is stale in every sense.
  if (hours >= 24) return '1d+'
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
