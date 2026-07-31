/**
 * Pane colour tags.
 *
 * Panes are told apart by position and label, which stops working the moment
 * you have six of them running similar things — three agents in three repos all
 * read as "a pane with green text". A colour is the fastest possible way to
 * mean "that one".
 *
 * The set is a fixed palette rather than a free colour picker. Two reasons:
 * arbitrary hex from a picker regularly lands on something invisible against
 * this chrome, and a stored colour has to keep meaning the same thing if the
 * theme ever changes — a key survives that, a literal does not.
 *
 * Hues are chosen to stay distinguishable against `--chrome-bg` (#0a0f0a) and
 * to be distinct from Homebrew's foreground green, so a tagged pane never reads
 * as though its terminal text has changed colour.
 */

export type PaneColorKey =
  | 'red'
  | 'amber'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'pink'

export interface PaneColor {
  key: PaneColorKey
  /** Shown in the swatch picker and as the pane's accent. */
  hex: string
  /** Menu/tooltip label. */
  label: string
}

export const PANE_COLORS: readonly PaneColor[] = [
  { key: 'red', hex: '#FF5F56', label: 'Red' },
  { key: 'amber', hex: '#E5A83C', label: 'Amber' },
  { key: 'green', hex: '#35D06B', label: 'Green' },
  { key: 'cyan', hex: '#33BBC8', label: 'Cyan' },
  { key: 'blue', hex: '#5A8DEE', label: 'Blue' },
  { key: 'purple', hex: '#B57BFF', label: 'Purple' },
  { key: 'pink', hex: '#F06CB0', label: 'Pink' },
]

const BY_KEY = new Map(PANE_COLORS.map((c) => [c.key, c]))

/**
 * Resolves a stored key to its colour. Returns null for an untagged pane and
 * for any key the palette no longer contains, so a value left over from an
 * older build degrades to "no tag" instead of rendering nothing at all.
 */
export function paneColorHex(key: string | undefined): string | null {
  if (!key) return null
  return BY_KEY.get(key as PaneColorKey)?.hex ?? null
}

export function isPaneColorKey(value: unknown): value is PaneColorKey {
  return typeof value === 'string' && BY_KEY.has(value as PaneColorKey)
}
