import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AGENTS, isAgentKind, isValidAgentSessionId, type AgentKind } from '../../shared/agents.js'
import { countChanges } from '../../shared/line-diff.js'
import type { ChangeEntry, ChangesFileResponse, ChangesListResponse } from '../../shared/ipc.js'
import { claudeFileOps, contentBefore, opencodeFileOps, piFileOps, type FileOp } from './records.js'
import { blobAt, diffTrees, measureTree, refuseDir, snapshot, type SnapshotRefusal, type TreeChange } from './shadow.js'

/**
 * What each agent session in a pane has created, edited and deleted.
 *
 * Two sources, merged per file:
 *  - **agent**: the agent's own record of its write and edit calls
 *    (records.ts): exact attribution, files outside the cwd included.
 *  - **fs**: a shadow git snapshot of the session's cwd taken when SeaShell
 *    first sees the session (the baseline), diffed against a fresh snapshot
 *    on every refresh (shadow.ts): catches what shell commands did.
 *
 * Refreshing costs a snapshot and a record read, so it only happens when the
 * panel asks (`list`), at most once a second per session. Watching a session
 * costs one snapshot, once. File contents never leave here except through
 * `file`, one file at a time.
 */

/** Where a session's record lives and how to read it; injected for tests. */
export interface RecordSource {
  /** New file ops since the last call (incremental), or the whole list when `whole`. */
  read(): Promise<{ ops: FileOp[]; whole: boolean }>
}

export interface TrackerDeps {
  /** Shadow repositories go under `<userData>/changes/`. */
  userData: string
  /** The home the agent sessions and the refusal rule are relative to. */
  home: string
  now(): number
  /** The record of one session, or null when there is none to read. */
  recordFor(session: TrackedSession): RecordSource | null
  /** Overrides for tests. */
  measure?: typeof measureTree
}

export interface TrackedSession {
  kind: AgentKind
  /** Unknown when the lookup could not tell it without guessing. */
  sid?: string
  cwd: string
}

/** One file's history so far, folded from the record. */
interface AgentFile {
  path: string
  firstSeq: number
  lastSeq: number
  firstOp: 'write' | 'edit'
  before: string | null | undefined
  created: boolean | undefined
  /** Every edit in order, while the file has only ever been edited. */
  edits: Array<{ oldText: string; newText: string }> | null
}

interface Session {
  key: string
  session: TrackedSession
  gitDir: string
  baseline: string | null
  refusal: SnapshotRefusal | null
  ready: Promise<void>
  record: RecordSource | null
  files: Map<string, AgentFile>
  seqBase: number
  /** When each path was first seen changed, for the order. */
  firstSeen: Map<string, number>
  entries: ChangeEntry[]
  fsChanges: Map<string, TreeChange>
  refreshing: Promise<void> | null
  refreshedAt: number
  touchedAt: number
}

/** Text larger than this is cut for the preview. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024
/** Images larger than this are not inlined. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** How often a session refreshes at most. */
const REFRESH_MIN_MS = 1000

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
}

export const REFUSAL_NOTES: Readonly<Record<SnapshotRefusal, string>> = {
  home: 'Only files the agent wrote directly are listed: this session runs in your home folder, which is too big to watch.',
  root: 'Only files the agent wrote directly are listed: this session runs at the top of a drive, which is too big to watch.',
  'too-big': 'Only files the agent wrote directly are listed: this folder is too big to watch.',
  missing: 'Only files the agent wrote directly are listed: the session folder could not be read.',
  'no-git': 'Only files the agent wrote directly are listed: git was not found, so the folder cannot be watched.',
}

function sessionKey(s: TrackedSession, paneId: string): string {
  const id = s.sid ?? `pane:${paneId}`
  return createHash('sha1').update(`${s.kind}\0${id}\0${s.cwd}`).digest('hex').slice(0, 20)
}

function relTo(cwd: string, abs: string): string {
  const r = path.posix.relative(cwd, abs)
  return r === '' || r.startsWith('..') || path.posix.isAbsolute(r) ? abs : r
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

async function readCapped(abs: string, max: number): Promise<{ buf: Buffer; truncated: boolean } | null> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(abs, 'r')
    const st = await handle.stat()
    if (!st.isFile()) return null
    const len = Math.min(st.size, max)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await handle.read(buf, 0, len, 0)
    return { buf: buf.subarray(0, bytesRead), truncated: st.size > max }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export class ChangeTracker {
  private readonly deps: TrackerDeps
  private readonly sessions = new Map<string, Session>()
  private readonly panes = new Map<string, string>()

  constructor(deps: TrackerDeps) {
    this.deps = deps
  }

  /**
   * The pane runs this session: start watching it (a baseline snapshot of its
   * cwd, once per session) and point the pane at it. Idempotent.
   */
  watch(paneId: string, session: TrackedSession): void {
    if (!isAgentKind(session.kind) || !session.cwd.startsWith('/')) return
    const s: TrackedSession = {
      kind: session.kind,
      cwd: session.cwd.replace(/\/+$/, '') || '/',
      ...(session.sid !== undefined && isValidAgentSessionId(session.kind, session.sid) ? { sid: session.sid } : {}),
    }
    const key = sessionKey(s, paneId)
    this.panes.set(paneId, key)
    const existing = this.sessions.get(key)
    if (existing) {
      existing.touchedAt = this.deps.now()
      return
    }
    const gitDir = path.join(this.deps.userData, 'changes', key)
    const state: Session = {
      key,
      session: s,
      gitDir,
      baseline: null,
      refusal: null,
      ready: Promise.resolve(),
      record: this.deps.recordFor(s),
      files: new Map(),
      seqBase: 0,
      firstSeen: new Map(),
      entries: [],
      fsChanges: new Map(),
      refreshing: null,
      refreshedAt: 0,
      touchedAt: this.deps.now(),
    }
    state.ready = this.takeBaseline(state)
    this.sessions.set(key, state)
  }

  /** The pane closed or stopped running an agent. Its session's shadow stays on disk for a later look. */
  release(paneId: string): void {
    const key = this.panes.get(paneId)
    this.panes.delete(paneId)
    if (key && ![...this.panes.values()].includes(key)) this.sessions.delete(key)
  }

  /** Whether the pane has a session being watched. */
  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  private async takeBaseline(s: Session): Promise<void> {
    const refused = refuseDir(s.session.cwd, this.deps.home)
    if (refused) {
      s.refusal = refused
      return
    }
    try {
      const st = await fs.stat(s.session.cwd)
      if (!st.isDirectory()) throw new Error('not a directory')
    } catch {
      s.refusal = 'missing'
      return
    }
    const size = await (this.deps.measure ?? measureTree)(s.session.cwd)
    if (size.over) {
      s.refusal = 'too-big'
      return
    }
    // A shadow left by an earlier run of this session keeps its first baseline.
    try {
      const kept = (await fs.readFile(path.join(s.gitDir, 'seashell-baseline'), 'utf8')).trim()
      if (/^[0-9a-f]{40,64}$/.test(kept)) {
        s.baseline = kept
        return
      }
    } catch {
      /* a new one */
    }
    const tree = await snapshot(s.gitDir, s.session.cwd)
    if (!tree) {
      s.refusal = 'no-git'
      return
    }
    s.baseline = tree
    await fs.writeFile(path.join(s.gitDir, 'seashell-baseline'), `${tree}\n`).catch(() => undefined)
  }

  /** The pane's changes, refreshed when the last refresh is over a second old. */
  async list(paneId: string): Promise<ChangesListResponse | null> {
    const key = this.panes.get(paneId)
    const s = key ? this.sessions.get(key) : undefined
    if (!s) return null
    await s.ready
    if (this.deps.now() - s.refreshedAt >= REFRESH_MIN_MS) {
      s.refreshing ??= this.refresh(s).finally(() => {
        s.refreshing = null
        s.refreshedAt = this.deps.now()
      })
      await s.refreshing
    }
    return {
      paneId,
      agent: s.session.kind,
      agentLabel: AGENTS[s.session.kind].label,
      cwd: s.session.cwd,
      entries: s.entries,
      note: s.refusal ? REFUSAL_NOTES[s.refusal] : null,
    }
  }

  private foldOps(s: Session, ops: readonly FileOp[], whole: boolean): void {
    if (whole) s.files.clear()
    for (const op of ops) {
      const abs = path.posix.isAbsolute(op.path) ? path.posix.normalize(op.path) : path.posix.join(s.session.cwd, op.path)
      const seq = s.seqBase + op.seq
      const f = s.files.get(abs)
      if (op.resultOnly) {
        // Only meaningful for a file whose one call so far it answers.
        if (f && f.firstSeq === f.lastSeq && f.before === undefined) {
          if (op.before !== undefined) f.before = op.before
          if (op.created !== undefined) f.created = op.created
        }
        continue
      }
      if (!f) {
        s.files.set(abs, {
          path: abs,
          firstSeq: seq,
          lastSeq: seq,
          firstOp: op.op,
          before: op.before,
          created: op.created,
          edits: op.op === 'edit' && op.edits && op.edits.length > 0 ? [...op.edits] : null,
        })
        continue
      }
      f.lastSeq = seq
      if (f.edits && op.op === 'edit' && op.edits && op.edits.length > 0) f.edits.push(...op.edits)
      else f.edits = null
    }
    if (!whole) s.seqBase += ops.length
  }

  private async refresh(s: Session): Promise<void> {
    if (s.record) {
      try {
        const { ops, whole } = await s.record.read()
        this.foldOps(s, ops, whole)
      } catch {
        /* the record is optional evidence */
      }
    }
    if (s.baseline) {
      const tree = await snapshot(s.gitDir, s.session.cwd)
      const changes = tree ? await diffTrees(s.gitDir, s.session.cwd, s.baseline, tree) : null
      if (changes) s.fsChanges = new Map(changes.map((c) => [path.posix.join(s.session.cwd, c.rel), c]))
    }
    const now = this.deps.now()
    const entries: ChangeEntry[] = []
    const seenNow = new Set<string>()
    const stamp = async (abs: string): Promise<number> => {
      seenNow.add(abs)
      let at = s.firstSeen.get(abs)
      try {
        at = (await fs.stat(abs)).mtimeMs
      } catch {
        /* deleted: when it was first seen gone */
      }
      if (at === undefined) at = now
      if (!s.firstSeen.has(abs)) s.firstSeen.set(abs, at)
      return at
    }
    for (const [abs, c] of s.fsChanges) {
      const agent = s.files.has(abs)
      entries.push({
        path: abs,
        rel: c.rel,
        change: c.status === 'A' ? 'created' : c.status === 'D' ? 'deleted' : 'edited',
        added: c.added,
        removed: c.removed,
        source: agent ? 'both' : 'fs',
        at: await stamp(abs),
      })
    }
    for (const f of s.files.values()) {
      if (s.fsChanges.has(f.path)) continue
      const cur = await readCapped(f.path, PREVIEW_MAX_BYTES)
      const exists = cur !== null
      const text = cur && !isBinary(cur.buf) ? cur.buf.toString('utf8') : null
      const before = this.agentBefore(f, text)
      const change: ChangeEntry['change'] = !exists
        ? 'deleted'
        : f.created === true || before === null || (before === undefined && f.firstOp === 'write')
          ? 'created'
          : 'edited'
      let added = 0
      let removed = 0
      if (text !== null && typeof before === 'string') ({ added, removed } = countChanges(before, text))
      else if (text !== null && change === 'created') added = countChanges('', text).added
      else if (!exists && typeof before === 'string') removed = countChanges(before, '').removed
      entries.push({ path: f.path, rel: relTo(s.session.cwd, f.path), change, added, removed, source: 'agent', at: await stamp(f.path) })
    }
    for (const k of [...s.firstSeen.keys()]) if (!seenNow.has(k)) s.firstSeen.delete(k)
    entries.sort((a, b) => b.at - a.at || a.rel.localeCompare(b.rel))
    s.entries = entries
  }

  private agentBefore(f: AgentFile, current: string | null): string | null | undefined {
    const ops: FileOp[] = [
      {
        path: f.path,
        op: f.firstOp,
        seq: f.firstSeq,
        ...(f.before !== undefined ? { before: f.before } : {}),
        ...(f.created !== undefined ? { created: f.created } : {}),
        ...(f.edits ? { edits: f.edits } : {}),
      },
    ]
    // contentBefore undoes every edit; with the edits folded into one op it
    // needs them all there, and a write anywhere makes it unknowable.
    if (f.before !== undefined || f.created === true) return contentBefore(ops, current)
    if (!f.edits) return undefined
    return contentBefore(ops, current)
  }

  /** One changed file's before and after, for the preview. */
  async file(paneId: string, abs: string): Promise<ChangesFileResponse> {
    const key = this.panes.get(paneId)
    const s = key ? this.sessions.get(key) : undefined
    const entry = s?.entries.find((e) => e.path === abs)
    if (!s || !entry) return { ok: false, code: 'ENOENT', message: 'That file is not in this pane’s changes' }

    const ext = path.posix.extname(abs).toLowerCase()
    const imageMime = IMAGE_MIME[ext]
    const afterRaw = entry.change === 'deleted' ? null : await readCapped(abs, imageMime ? IMAGE_MAX_BYTES : PREVIEW_MAX_BYTES)

    let beforeRaw: Buffer | null | undefined
    const fsc = s.fsChanges.get(abs)
    if (fsc && s.baseline) beforeRaw = fsc.status === 'A' ? null : await blobAt(s.gitDir, s.session.cwd, s.baseline, fsc.rel)
    else {
      const f = s.files.get(abs)
      const text = afterRaw && !isBinary(afterRaw.buf) ? afterRaw.buf.toString('utf8') : null
      const b = f ? this.agentBefore(f, text) : undefined
      beforeRaw = b === undefined ? undefined : b === null ? null : Buffer.from(b, 'utf8')
    }

    const shown = afterRaw?.buf ?? beforeRaw ?? null
    if (imageMime && shown) {
      return {
        ok: true,
        path: abs,
        rel: entry.rel,
        change: entry.change,
        before: null,
        after: null,
        beforeKnown: beforeRaw !== undefined,
        binary: true,
        truncated: false,
        image: { mime: imageMime, base64: shown.subarray(0, IMAGE_MAX_BYTES).toString('base64') },
      }
    }
    const binary = (afterRaw !== null && isBinary(afterRaw.buf)) || (beforeRaw instanceof Buffer && isBinary(beforeRaw))
    const cut = (b: Buffer | null | undefined): string | null =>
      b ? b.subarray(0, PREVIEW_MAX_BYTES).toString('utf8') : null
    return {
      ok: true,
      path: abs,
      rel: entry.rel,
      change: entry.change,
      before: binary ? null : cut(beforeRaw),
      after: binary ? null : cut(afterRaw?.buf),
      beforeKnown: beforeRaw !== undefined,
      binary,
      truncated: (afterRaw?.truncated ?? false) || (beforeRaw instanceof Buffer && beforeRaw.length > PREVIEW_MAX_BYTES),
    }
  }
}

// ---------------------------------------------------------------------------
// Reading records off disk
// ---------------------------------------------------------------------------

/** Lines a transcript reader keeps: the ones that can name a file. */
function mentionsFile(line: string): boolean {
  return line.includes('"file_path"') || line.includes('"filePath"') || line.includes('"notebook_path"') || line.includes('"toolCall"')
}

/**
 * A JSONL record read incrementally: each call parses only the complete lines
 * appended since the last one. A file that shrank (rewritten) is read again
 * from the top, and the caller told so.
 */
export function jsonlRecord(locate: () => Promise<string | null>, parse: (lines: string[], seq0: number) => FileOp[]): RecordSource {
  let file: string | null = null
  let offset = 0
  let seq = 0
  return {
    async read() {
      file ??= await locate()
      if (!file) return { ops: [], whole: false }
      let handle: fs.FileHandle | null = null
      try {
        handle = await fs.open(file, 'r')
        const { size } = await handle.stat()
        let whole = false
        if (size < offset) {
          offset = 0
          seq = 0
          whole = true
        }
        if (size === offset) return { ops: [], whole }
        const buf = Buffer.alloc(size - offset)
        await handle.read(buf, 0, buf.length, offset)
        const end = buf.lastIndexOf(0x0a)
        if (end < 0) return { ops: [], whole }
        offset += end + 1
        const lines = buf.subarray(0, end).toString('utf8').split('\n').filter(mentionsFile)
        const ops = parse(lines, seq)
        seq += ops.length
        // Sequence numbers are local to this read; the tracker offsets them.
        return { ops: ops.map((o, i) => ({ ...o, seq: i })), whole }
      } catch {
        file = null
        return { ops: [], whole: false }
      } finally {
        await handle?.close().catch(() => undefined)
      }
    },
  }
}

export { claudeFileOps, opencodeFileOps, piFileOps }
