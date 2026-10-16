import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countChanges, diffLines, hunks, splitLines } from '../../src/shared/line-diff.js'
import { claudeFileOps, contentBefore, opencodeFileOps, piFileOps } from '../../src/main/changes/records.js'
import { blobAt, diffTrees, measureTree, parseDiffTree, refuseDir, snapshot } from '../../src/main/changes/shadow.js'
import { ChangeTracker, jsonlRecord, REFUSAL_NOTES, type RecordSource } from '../../src/main/changes/tracker.js'

describe('line diff', () => {
  it('finds the smallest edit', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
    expect(ops.map((o) => `${o.op[0]}${o.text}`)).toEqual(['sa', 'db', 'ax', 'sc', 'sd', 'ae'])
    expect(countChanges('a\nb\nc\n', 'a\nc\nd\n')).toEqual({ added: 1, removed: 1 })
    expect(countChanges('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0 })
  })

  it('agrees with a brute-force LCS on random inputs', () => {
    let seed = 7
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n)
    for (let t = 0; t < 200; t += 1) {
      const a = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]!)
      const b = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]!)
      const ops = diffLines(a, b)
      expect(ops.filter((o) => o.op !== 'add').map((o) => o.text)).toEqual(a)
      expect(ops.filter((o) => o.op !== 'del').map((o) => o.text)).toEqual(b)
      const lcs = (() => {
        const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
        for (let i = a.length - 1; i >= 0; i -= 1)
          for (let j = b.length - 1; j >= 0; j -= 1) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
        return dp[0]![0]!
      })()
      expect(ops.filter((o) => o.op === 'same').length).toBe(lcs)
    }
  })

  it('groups changes into hunks with context and line numbers', () => {
    const a = splitLines(Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n'))
    const b = [...a]
    b[9] = 'changed'
    const h = hunks(diffLines(a, b), 2)
    expect(h).toHaveLength(1)
    expect(h[0]!.oldStart).toBe(8)
    expect(h[0]!.lines.map((l) => l.op)).toEqual(['same', 'same', 'del', 'add', 'same', 'same'])
    expect(h[0]!.lines[3]).toMatchObject({ newNo: 10, oldNo: null })
  })

  it('gives up cleanly past the distance cap', () => {
    const ops = diffLines(['a', 'b', 'c'], ['x', 'y', 'z'], 1)
    expect(ops.filter((o) => o.op === 'del')).toHaveLength(3)
    expect(ops.filter((o) => o.op === 'add')).toHaveLength(3)
  })
})

describe('agent records', () => {
  it('reads claude’s write and edit calls and what its replies say', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/home/user/proj/new.md', content: '# Hi\n' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] }, toolUseResult: { type: 'create', filePath: '/home/user/proj/new.md', content: '# Hi\n', originalFile: null } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/home/user/proj/a.ts', old_string: 'x', new_string: 'y' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] }, toolUseResult: { filePath: '/home/user/proj/a.ts', originalFile: 'const x = 1\n' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'MultiEdit', input: { file_path: 'rel.ts', edits: [{ old_string: 'a', new_string: 'b' }] } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'rm x' } }] } }),
      '{torn',
    ]
    const ops = claudeFileOps(lines)
    expect(ops.map((o) => [o.path, o.op, o.created, o.before])).toEqual([
      ['/home/user/proj/new.md', 'write', true, null],
      ['/home/user/proj/a.ts', 'edit', undefined, 'const x = 1\n'],
      ['rel.ts', 'edit', undefined, undefined],
    ])
    // A reply read after its call (a permission prompt in between) still lands.
    const late = claudeFileOps([lines[3]!])
    expect(late[0]).toMatchObject({ path: '/home/user/proj/a.ts', resultOnly: true, before: 'const x = 1\n' })
  })

  it('reads pi’s write and edit tool calls and ignores bash', () => {
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: '2026-10-15T00:00:00.000Z', cwd: '/home/user/proj' }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [
        { type: 'toolCall', name: 'write', arguments: { path: 'notes.md', content: 'hello\n' } },
        { type: 'toolCall', name: 'edit', arguments: { path: '/home/user/proj/a.ts', edits: [{ oldText: 'a', newText: 'b' }] } },
        { type: 'toolCall', name: 'bash', arguments: { command: 'sed -i s/a/b/ c.ts' } },
      ] } }),
    ]
    expect(piFileOps(lines).map((o) => [o.path, o.op, o.edits?.length])).toEqual([
      ['notes.md', 'write', undefined],
      ['/home/user/proj/a.ts', 'edit', 1],
    ])
  })

  it('reads opencode’s export', () => {
    const exp = { info: {}, messages: [{ parts: [
      { type: 'tool', tool: 'edit', state: { input: { filePath: '/home/user/proj/a.ts', oldString: 'a', newString: 'b' } } },
      { type: 'tool', tool: 'write', state: { input: { filePath: '/home/user/proj/b.ts', content: 'x' } } },
      { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } },
      { type: 'text', text: 'done' },
    ] }] }
    expect(opencodeFileOps(exp).map((o) => [o.path, o.op])).toEqual([
      ['/home/user/proj/a.ts', 'edit'],
      ['/home/user/proj/b.ts', 'write'],
    ])
    expect(opencodeFileOps(null)).toEqual([])
  })

  it('works out the content before the first change', () => {
    expect(contentBefore([{ path: 'a', op: 'edit', seq: 0, before: 'orig' }], 'now')).toBe('orig')
    expect(contentBefore([{ path: 'a', op: 'write', seq: 0, created: true }], 'now')).toBeNull()
    const ops = [
      { path: 'a', op: 'edit' as const, seq: 0, edits: [{ oldText: 'one', newText: 'ONE' }] },
      { path: 'a', op: 'edit' as const, seq: 1, edits: [{ oldText: 'two', newText: 'TWO' }] },
    ]
    expect(contentBefore(ops, 'ONE TWO three')).toBe('one two three')
    // An edit that no longer undoes cleanly gives no answer rather than a wrong one.
    expect(contentBefore(ops, 'something else')).toBeUndefined()
    expect(contentBefore([{ path: 'a', op: 'write', seq: 0 }], 'x')).toBeUndefined()
  })
})

describe('the shadow snapshot', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('refuses home, roots and the folders right under one', () => {
    expect(refuseDir('/home/user', '/home/user')).toBe('home')
    expect(refuseDir('/home/user/', '/home/user')).toBe('home')
    expect(refuseDir('/', '/home/user')).toBe('root')
    expect(refuseDir('/home', '/home/user')).toBe('root')
    expect(refuseDir('/mnt/c', '/home/user')).toBe('root')
    expect(refuseDir('/home/user/proj', '/home/user')).toBeNull()
  })

  it('counts a tree and stops at the cap, skipping what is never watched', async () => {
    const dir = path.join(root, 'w')
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'gen'), { recursive: true })
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, 'src', `f${i}.ts`), 'x')
    for (let i = 0; i < 50; i += 1) fs.writeFileSync(path.join(dir, 'node_modules', 'x', `f${i}.js`), 'x')
    for (let i = 0; i < 50; i += 1) fs.writeFileSync(path.join(dir, 'gen', `f${i}.js`), 'x')
    fs.writeFileSync(path.join(dir, '.gitignore'), 'gen/\n')
    expect(await measureTree(dir)).toMatchObject({ files: 6, over: false })
    expect((await measureTree(dir, 3)).over).toBe(true)
  })

  it('sees files created, edited and deleted by anything, and leaves the user’s repo alone', async () => {
    const work = path.join(root, 'proj')
    const gitDir = path.join(root, 'shadow')
    fs.mkdirSync(path.join(work, '.git'), { recursive: true })
    fs.writeFileSync(path.join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(work, 'keep.txt'), 'same\n')
    fs.writeFileSync(path.join(work, 'edit.txt'), 'a\nb\n')
    fs.writeFileSync(path.join(work, 'gone.txt'), 'bye\n')
    fs.writeFileSync(path.join(work, '.gitignore'), 'ignored.log\n')
    const before = fs.readdirSync(path.join(work, '.git'))
    const base = await snapshot(gitDir, work)
    expect(base).toMatch(/^[0-9a-f]{40}$/)

    fs.writeFileSync(path.join(work, 'edit.txt'), 'a\nB\nc\n')
    fs.rmSync(path.join(work, 'gone.txt'))
    fs.writeFileSync(path.join(work, 'new file.md'), '# new\n')
    fs.writeFileSync(path.join(work, 'ignored.log'), 'noise\n')
    const now = await snapshot(gitDir, work)
    const changes = await diffTrees(gitDir, work, base!, now!)
    expect(changes?.sort((x, y) => x.rel.localeCompare(y.rel))).toEqual([
      { rel: 'edit.txt', status: 'M', added: 2, removed: 1, binary: false },
      { rel: 'gone.txt', status: 'D', added: 0, removed: 1, binary: false },
      { rel: 'new file.md', status: 'A', added: 1, removed: 0, binary: false },
    ])
    expect((await blobAt(gitDir, work, base!, 'gone.txt'))?.toString()).toBe('bye\n')
    expect(await blobAt(gitDir, work, base!, 'new file.md')).toBeNull()
    expect(fs.readdirSync(path.join(work, '.git'))).toEqual(before)
  })

  it('parses diff-tree output', () => {
    expect(parseDiffTree('M\0a.ts\0A\0b c.ts\0X\0odd\0', '1\t2\ta.ts\0-\t-\tb c.ts\0')).toEqual([
      { rel: 'a.ts', status: 'M', added: 1, removed: 2, binary: false },
      { rel: 'b c.ts', status: 'A', added: 0, removed: 0, binary: true },
    ])
  })
})

describe('ChangeTracker', () => {
  let root: string
  let work: string
  let clock = 1_000_000
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-'))
    work = path.join(root, 'proj')
    fs.mkdirSync(work)
    clock = 1_000_000
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const tracker = (record: RecordSource | null, home = '/home/nobody') =>
    new ChangeTracker({ userData: path.join(root, 'ud'), home, now: () => (clock += 2000), recordFor: () => record })

  it('merges the record and the folder, newest first, with counts and sources', async () => {
    fs.writeFileSync(path.join(work, 'a.ts'), 'one\ntwo\n')
    fs.writeFileSync(path.join(work, 'old.ts'), 'x\n')
    const outside = path.join(root, 'outside.md')
    let batch: Array<Record<string, unknown>> = []
    const record: RecordSource = { read: async () => ({ ops: batch.splice(0) as never, whole: false }) }
    const t = tracker(record)
    t.watch('p1', { kind: 'jarvis', sid: '01a13d10-dbe9-7514-819f-26fe33fe4b2a', cwd: work })
    expect((await t.list('p1'))?.entries).toEqual([])

    fs.writeFileSync(path.join(work, 'a.ts'), 'one\nTWO\n')
    fs.rmSync(path.join(work, 'old.ts'))
    fs.writeFileSync(path.join(work, 'made-by-bash.sh'), 'echo\n')
    fs.writeFileSync(outside, 'outside\nfile\n')
    batch = [
      { path: 'a.ts', op: 'edit', seq: 0, edits: [{ oldText: 'two', newText: 'TWO' }] },
      { path: outside, op: 'write', seq: 1, content: 'outside\nfile\n' },
    ]
    const list = await t.list('p1')
    const byRel = Object.fromEntries(list!.entries.map((e) => [e.rel, e]))
    expect(byRel['a.ts']).toMatchObject({ change: 'edited', added: 1, removed: 1, source: 'both' })
    expect(byRel['old.ts']).toMatchObject({ change: 'deleted', removed: 1, source: 'fs' })
    expect(byRel['made-by-bash.sh']).toMatchObject({ change: 'created', added: 1, source: 'fs' })
    expect(byRel[outside]).toMatchObject({ change: 'created', added: 2, source: 'agent' })
    expect(list!.note).toBeNull()

    const edited = await t.file('p1', path.join(work, 'a.ts'))
    expect(edited).toMatchObject({ ok: true, before: 'one\ntwo\n', after: 'one\nTWO\n', change: 'edited' })
    const gone = await t.file('p1', path.join(work, 'old.ts'))
    expect(gone).toMatchObject({ ok: true, before: 'x\n', after: null, change: 'deleted' })
    // Only files in the list can be read through it.
    expect((await t.file('p1', '/etc/passwd')).ok).toBe(false)
  })

  it('falls back to the record alone, and says so, for a folder it will not watch', async () => {
    const t = tracker(null, work)
    t.watch('p1', { kind: 'claude', cwd: work })
    expect(await t.list('p1')).toMatchObject({ entries: [], note: REFUSAL_NOTES.home, agentLabel: 'Claude Code' })
  })

  it('a pane without a watched session has no list', async () => {
    const t = tracker(null)
    expect(await t.list('nope')).toBeNull()
    t.watch('p1', { kind: 'opencode', cwd: work })
    t.release('p1')
    expect(await t.list('p1')).toBeNull()
  })

  it('reads a jsonl record incrementally and only whole lines', async () => {
    const file = path.join(root, 's.jsonl')
    const line = (p: string): string =>
      JSON.stringify({ type: 'message', message: { content: [{ type: 'toolCall', name: 'write', arguments: { path: p, content: 'x' } }] } })
    fs.writeFileSync(file, `${line('a')}\n${line('b').slice(0, 20)}`)
    const rec = jsonlRecord(async () => file, piFileOps)
    expect((await rec.read()).ops.map((o) => o.path)).toEqual(['a'])
    fs.writeFileSync(file, `${line('a')}\n${line('b')}\n`)
    expect((await rec.read()).ops.map((o) => o.path)).toEqual(['b'])
    expect((await rec.read()).ops).toEqual([])
  })
})
