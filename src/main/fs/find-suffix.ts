import path from 'node:path'
import type {
  FindBySuffixRequest,
  FindBySuffixResponse,
  FsReadDirRequest,
  FsReadDirResponse,
} from '../../shared/ipc.js'
import { readDir as realReadDir } from './tree.js'

export type { FindBySuffixRequest, FindBySuffixResponse }

/** Bounds on the walk. A reveal is user-initiated and rare; these keep a
 *  monorepo from turning one double-click into a filesystem census. */
export const MAX_DEPTH = 12
export const MAX_VISITED = 50_000

/**
 * Breadth-first over the explorer's own directory reader, so gitignored and
 * always-hidden directories are skipped exactly as the tree skips them.
 */
export async function findBySuffix(
  req: FindBySuffixRequest,
  readDirFn: (r: FsReadDirRequest) => Promise<FsReadDirResponse> = realReadDir
): Promise<FindBySuffixResponse> {
  const root = path.resolve(req.root)
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const paths: string[] = []
  let visited = 0
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    const res = await readDirFn({ path: dir, respectGitignore: true })
    if (!res.ok) continue
    for (const e of res.entries) {
      visited += 1
      if (visited > MAX_VISITED) return { paths, truncated: true }
      const full = path.join(dir, e.name)
      if (full.endsWith(req.suffix)) {
        paths.push(full)
        if (paths.length >= req.limit) return { paths, truncated: true }
      }
      // Descending into a gitignored directory spends the visit budget on
      // build output and caches, which is where a truncated path never points.
      // The entries themselves are still matched, the same way the explorer
      // still lists an ignored file rather than hiding it.
      if (e.isDir && !e.ignored && depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 })
    }
  }
  return { paths, truncated: false }
}
