/**
 * Reading GitHub's "latest release" JSON. [pure]
 *
 * Nothing here fetches or writes anything: it turns whatever JSON came back
 * into either one exact asset the updater is allowed to download, or null.
 */

export const RELEASE_ORIGIN = 'https://github.com/voidharbor/seashell/releases/download/'

/**
 * Which build's asset a release is read for: the Mac's universal zip, or the
 * native Windows shell's zip. Each build sees only its own, so a release that
 * carries just the Mac zip is no update at all to the Windows build.
 */
export type UpdateChannel = 'universal' | 'win-native'

/** The one asset name a channel accepts for `version`. */
export function assetNameFor(version: string, channel: UpdateChannel): string {
  return `SeaShell-${version}-${channel}.zip`
}

export interface ReleaseInfo {
  version: string
  zipUrl: string
  zipBytes: number
  pageUrl: string
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

function triple(v: string): [number, number, number] | null {
  const m = VERSION_RE.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Strictly newer, numerically. Anything unparseable is never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = triple(candidate)
  const b = triple(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!
  }
  return false
}

/**
 * Reads GitHub's releases/latest JSON down to the one asset the updater may
 * fetch: the channel's zip, named exactly for the version, hosted on the
 * release download origin. Anything else is null, which means "no update".
 *
 * `origin` is a parameter only so a smoke test can point the whole path at a
 * local server. Production always passes the real release origin.
 */
export function parseRelease(
  json: unknown,
  origin: string = RELEASE_ORIGIN,
  channel: UpdateChannel = 'universal'
): ReleaseInfo | null {
  if (typeof json !== 'object' || json === null) return null
  const r = json as { tag_name?: unknown; html_url?: unknown; assets?: unknown }
  if (typeof r.tag_name !== 'string' || !r.tag_name.startsWith('v')) return null
  const version = r.tag_name.slice(1)
  if (!VERSION_RE.test(version)) return null
  if (!Array.isArray(r.assets)) return null
  const want = assetNameFor(version, channel)
  const asset = r.assets.find(
    (a): a is { name: string; size: number; browser_download_url: string } =>
      typeof a === 'object' && a !== null && (a as { name?: unknown }).name === want
  )
  if (!asset || typeof asset.size !== 'number' || typeof asset.browser_download_url !== 'string') {
    return null
  }
  if (!asset.browser_download_url.startsWith(origin)) return null
  const pageUrl =
    typeof r.html_url === 'string'
      ? r.html_url
      : `https://github.com/voidharbor/seashell/releases/tag/v${version}`
  return { version, zipUrl: asset.browser_download_url, zipBytes: asset.size, pageUrl }
}
