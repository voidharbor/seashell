/**
 * What an agent's own record says it did to files. [pure]
 *
 * Each agent logs its tool calls; the file-writing ones name the file outright,
 * which gives exact attribution, files outside the working directory included.
 * They cannot see a change made through a shell command (`rm`, `mv`,
 * `sed -i`, a build), which is what the filesystem snapshot is for
 * (shadow.ts); tracker.ts puts the two together.
 *
 *  - claude: `tool_use` blocks named Write, Edit, MultiEdit and NotebookEdit,
 *    and the `toolUseResult` claude stamps on the reply (`type` create or
 *    update, `originalFile`: the content before the call).
 *  - pi (jarvis, ultron): `toolCall` parts named `write` and `edit`.
 *  - opencode: `tool` parts named `write` and `edit` in `opencode export`.
 */

export interface FileOp {
  /** Absolute when the agent gave an absolute path; resolved against the
   *  session cwd by the caller otherwise. */
  path: string
  op: 'write' | 'edit'
  /** Order within the record. */
  seq: number
  /** The content a write put there, when the record carries it. */
  content?: string
  /** The replacements an edit made, when the record carries them. */
  edits?: Array<{ oldText: string; newText: string }>
  /** The file before this call, when the record carries it (claude). */
  before?: string | null
  /** The call created the file (claude says so; for the others unknown). */
  created?: boolean
  /** claude's reply to a call read in an earlier batch: only `before` and
   *  `created` mean anything, for the file's first call. */
  resultOnly?: true
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function asEdits(raw: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((e: unknown) => {
    const x = e as Record<string, unknown> | null
    const oldText = str(x?.oldText) ?? str(x?.old_string) ?? str(x?.oldString)
    const newText = str(x?.newText) ?? str(x?.new_string) ?? str(x?.newString)
    return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : []
  })
}

/** Parses JSONL text one line at a time; torn lines are skipped. */
function eachJson(lines: readonly string[], fn: (e: Record<string, unknown>) => void): void {
  for (const line of lines) {
    if (!line || line[0] !== '{') continue
    try {
      const e = JSON.parse(line) as unknown
      if (e && typeof e === 'object') fn(e as Record<string, unknown>)
    } catch {
      /* torn */
    }
  }
}

/** claude transcript lines to file ops. `seq0` continues numbering across incremental reads. */
export function claudeFileOps(lines: readonly string[], seq0 = 0): FileOp[] {
  const ops: FileOp[] = []
  const byToolId = new Map<string, FileOp>()
  let seq = seq0
  eachJson(lines, (e) => {
    const msg = e.message as { content?: unknown } | undefined
    const content = Array.isArray(msg?.content) ? (msg!.content as unknown[]) : []
    if (e.type === 'assistant') {
      for (const c of content) {
        const b = c as { type?: unknown; name?: unknown; id?: unknown; input?: Record<string, unknown> }
        if (b?.type !== 'tool_use' || !b.input) continue
        const name = b.name
        const path = str(b.input.file_path) ?? str(b.input.notebook_path)
        if (!path) continue
        let op: FileOp | null = null
        if (name === 'Write') op = { path, op: 'write', seq: seq++, ...(str(b.input.content) !== undefined ? { content: str(b.input.content)! } : {}) }
        else if (name === 'Edit') {
          const oldText = str(b.input.old_string)
          const newText = str(b.input.new_string)
          op = { path, op: 'edit', seq: seq++, edits: oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [] }
        } else if (name === 'MultiEdit') op = { path, op: 'edit', seq: seq++, edits: asEdits(b.input.edits) }
        else if (name === 'NotebookEdit') op = { path, op: 'edit', seq: seq++, edits: [] }
        if (!op) continue
        ops.push(op)
        if (typeof b.id === 'string') byToolId.set(b.id, op)
      }
    } else if (e.type === 'user') {
      // The reply carries what claude saw: the file before, and whether the
      // call created it. Matched to its call by the tool_use id.
      const r = e.toolUseResult as Record<string, unknown> | undefined
      if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return
      const result = content.find((c) => (c as { type?: unknown })?.type === 'tool_result') as { tool_use_id?: unknown } | undefined
      let op = typeof result?.tool_use_id === 'string' ? byToolId.get(result.tool_use_id) : undefined
      if (!op) {
        // The call was in an earlier read (it waited on a permission prompt).
        op = { path: r.filePath, op: 'edit', seq: seq++, resultOnly: true }
        ops.push(op)
      }
      if (typeof r.originalFile === 'string') op.before = r.originalFile
      else if (r.originalFile === null) op.before = null
      if (r.type === 'create') {
        op.created = true
        op.before = null
      } else if (r.type === 'update') op.created = false
    }
  })
  return ops
}

/** pi session lines (jarvis, ultron) to file ops. */
export function piFileOps(lines: readonly string[], seq0 = 0): FileOp[] {
  const ops: FileOp[] = []
  let seq = seq0
  eachJson(lines, (e) => {
    if (e.type !== 'message') return
    const msg = e.message as { role?: unknown; content?: unknown } | undefined
    if (!Array.isArray(msg?.content)) return
    for (const c of msg!.content as unknown[]) {
      const part = c as { type?: unknown; name?: unknown; arguments?: Record<string, unknown> }
      if (part?.type !== 'toolCall' || !part.arguments) continue
      const path = str(part.arguments.path) ?? str(part.arguments.file_path)
      if (!path) continue
      if (part.name === 'write') {
        const content = str(part.arguments.content)
        ops.push({ path, op: 'write', seq: seq++, ...(content !== undefined ? { content } : {}) })
      } else if (part.name === 'edit') {
        const single =
          str(part.arguments.oldText) !== undefined && str(part.arguments.newText) !== undefined
            ? [{ oldText: str(part.arguments.oldText)!, newText: str(part.arguments.newText)! }]
            : []
        ops.push({ path, op: 'edit', seq: seq++, edits: [...asEdits(part.arguments.edits), ...single] })
      }
    }
  })
  return ops
}

/** `opencode export <id>` JSON to file ops. */
export function opencodeFileOps(exported: unknown): FileOp[] {
  const ops: FileOp[] = []
  let seq = 0
  const messages = (exported as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return ops
  for (const m of messages) {
    const parts = (m as { parts?: unknown } | null)?.parts
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      const part = p as { type?: unknown; tool?: unknown; state?: { input?: Record<string, unknown>; status?: unknown } }
      if (part?.type !== 'tool' || !part.state?.input) continue
      const input = part.state.input
      const path = str(input.filePath) ?? str(input.path)
      if (!path) continue
      if (part.tool === 'write') {
        const content = str(input.content)
        ops.push({ path, op: 'write', seq: seq++, ...(content !== undefined ? { content } : {}) })
      } else if (part.tool === 'edit') {
        const oldText = str(input.oldString)
        const newText = str(input.newString)
        ops.push({ path, op: 'edit', seq: seq++, edits: oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [] })
      }
    }
  }
  return ops
}

/**
 * The content of a file before the agent's first recorded change to it, from
 * the record alone: the `before` claude stamped on the first call, else the
 * current content with the recorded edits undone in reverse (only when every
 * one of them undoes cleanly, and never across a write, which loses what was
 * there). Null when the record shows the file was created; undefined when it
 * cannot be told.
 */
export function contentBefore(ops: readonly FileOp[], current: string | null): string | null | undefined {
  if (ops.length === 0) return undefined
  const first = ops[0]!
  if (first.before !== undefined) return first.before
  if (first.created === true) return null
  if (current === null) return undefined
  let text = current
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i]!
    if (op.op === 'write' || !op.edits || op.edits.length === 0) return undefined
    for (let j = op.edits.length - 1; j >= 0; j -= 1) {
      const { oldText, newText } = op.edits[j]!
      const at = newText === '' ? -1 : text.lastIndexOf(newText)
      if (at < 0) return undefined
      text = text.slice(0, at) + oldText + text.slice(at + newText.length)
    }
  }
  return text
}
