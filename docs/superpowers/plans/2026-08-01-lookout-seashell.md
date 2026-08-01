# Lookout (SeaShell side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship approval cards in SeaShell: the app notices a claude pane waiting on a question and raises a card whose buttons answer that pane; external tools can push richer cards through the control socket, and only an in-app click ever submits.

**Architecture:** Detection lives in the **renderer**, riding the existing attention machinery (`attention === 'waiting'` from `panes/attention.ts`) and reading the question out of the xterm buffer (`terminals` map in `PaneView.tsx`). Card state lives in the **main process** (`CardStore`), fed by the renderer's detections and by a new `card` command on the control socket. The only submit path is main's approve handler: click-time re-validation, then pty write of text + a single Enter.

**Tech Stack:** TypeScript, Electron (main/preload/renderer split), zod at the IPC boundary, vitest (`test/unit` node, `test/dom` jsdom), xterm.

**Spec:** `docs/superpowers/specs/2026-08-01-lookout-approval-cards-design.md` (as amended 2026-08-01: renderer-side detection riding attention; Windows named pipe deferred).

## Global Constraints

- Commit messages: **one line, no attribution, no trailers** (repo rule; a commit-msg hook enforces it).
- Never kill, quit, or restart a running SeaShell.app instance; dev testing uses `npm run dev` in a separate instance only if needed — unit tests need no app at all.
- Gate on every task: `npm run typecheck && npm test` both clean before commit.
- No new npm dependencies.
- The control socket never gains a submit command; the Enter is written only by the approve handler.
- Card text rules (shared with the socket): control characters (U+0000-U+001F, U+007F) rejected; question <= 2000 chars; draft/approve text <= 4000 chars.
- Version lands at **0.2.0** (currently 0.1.2) in the final task, not before.
- All paths below are relative to `~/Desktop/seashell`.

---

### Task 1: Shared card types + control protocol v2 (`card` command)

**Files:**
- Modify: `src/shared/ipc.ts` (add Lookout section + channel names + `SeashellApi.lookout`)
- Modify: `src/main/control/protocol.ts`
- Test: `test/unit/control-protocol.test.ts` (extend)

**Interfaces:**
- Consumes: existing `Result<T, C>` envelope, existing `parseControlRequest`.
- Produces (later tasks rely on these exact names):

```ts
// shared/ipc.ts — add to CH:
lookoutCards: 'lookout:cards',       // main -> renderer event
lookoutDetected: 'lookout:detected', // renderer -> main (send)
lookoutAction: 'lookout:action',     // renderer -> main (invoke)
lookoutGetState: 'lookout:getState', // renderer -> main (invoke)
lookoutSetEnabled: 'lookout:setEnabled', // renderer -> main (send)

// shared/ipc.ts — new types:
export interface LookoutCard {
  id: string
  paneId: string
  source: 'detector' | 'push'
  question: string
  draft: string | null
  state: 'active' | 'stale'
  createdAt: number
}
export interface LookoutCardsEvent { cards: LookoutCard[] }
export interface LookoutDetectedRequest { paneId: string; question: string }
export interface LookoutActionRequest {
  cardId: string
  action: 'approve' | 'dismiss'
  /** approve only: the exact text to send — canned word, draft, or edited draft. */
  text?: string
}
export type LookoutActionResponse = Result<
  { delivered: boolean },
  'ENOTFOUND' | 'ESTALE' | 'EGONE' | 'EFOREGROUND' | 'EINVALID'
>
export interface LookoutState { pluginInstalled: boolean; enabled: boolean }

// SeashellApi gains:
lookout: {
  onCards(cb: (e: LookoutCardsEvent) => void): () => void
  detected(req: LookoutDetectedRequest): void
  action(req: LookoutActionRequest): Promise<LookoutActionResponse>
  getState(): Promise<LookoutState>
  setEnabled(enabled: boolean): void
}

// control/protocol.ts — the request union becomes:
export interface TypeRequest { cmd: 'type'; paneId: string; text: string }
export interface CardRequest {
  cmd: 'card'
  paneId: string
  question: string
  draft: string | null
  validateOnly: boolean
}
export type ControlRequest = TypeRequest | CardRequest
export const MAX_QUESTION_LENGTH = 2000
// MAX_TEXT_LENGTH (4000) stays and also caps draft.
```

- [ ] **Step 1: Write the failing tests** — append to `test/unit/control-protocol.test.ts`:

```ts
describe('card command', () => {
  it('parses a minimal card', () => {
    const r = parseControlRequest(
      JSON.stringify({ cmd: 'card', paneId: 'p1', question: 'deploy now?' })
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.req.cmd === 'card') {
      expect(r.req.draft).toBeNull()
      expect(r.req.validateOnly).toBe(false)
    }
  })
  it('parses draft and validateOnly', () => {
    const r = parseControlRequest(
      JSON.stringify({ cmd: 'card', paneId: 'p1', question: 'ok?', draft: 'yes ship it', validateOnly: true })
    )
    expect(r.ok).toBe(true)
    if (r.ok && r.req.cmd === 'card') {
      expect(r.req.draft).toBe('yes ship it')
      expect(r.req.validateOnly).toBe(true)
    }
  })
  it('rejects control characters in question and draft', () => {
    expect(parseControlRequest(JSON.stringify({ cmd: 'card', paneId: 'p1', question: 'a\nb' })).ok).toBe(false)
    expect(parseControlRequest(JSON.stringify({ cmd: 'card', paneId: 'p1', question: 'ok?', draft: 'a\tb' })).ok).toBe(false)
  })
  it('rejects an over-long question', () => {
    const r = parseControlRequest(JSON.stringify({ cmd: 'card', paneId: 'p1', question: 'x'.repeat(2001) }))
    expect(r.ok).toBe(false)
  })
  it('rejects a non-string draft', () => {
    expect(parseControlRequest(JSON.stringify({ cmd: 'card', paneId: 'p1', question: 'ok?', draft: 7 })).ok).toBe(false)
  })
  it('still parses type exactly as before', () => {
    const r = parseControlRequest(JSON.stringify({ cmd: 'type', paneId: 'p1', text: 'hello' }))
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/control-protocol.test.ts` → FAIL (`unknown cmd`).
- [ ] **Step 3: Implement** — in `protocol.ts`, keep the existing `type` branch byte-for-byte; add the `card` branch:

```ts
if (o['cmd'] === 'card') {
  const paneId = o['paneId']
  if (typeof paneId !== 'string' || paneId === '') return { ok: false, error: 'missing paneId' }
  const question = o['question']
  if (typeof question !== 'string' || question === '') return { ok: false, error: 'missing or empty question' }
  if (question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `question too long (max ${MAX_QUESTION_LENGTH} chars)` }
  }
  if (CONTROL_CHARS.test(question)) return { ok: false, error: 'control characters rejected' }
  const draftRaw = o['draft']
  let draft: string | null = null
  if (draftRaw !== undefined && draftRaw !== null) {
    if (typeof draftRaw !== 'string' || draftRaw === '') return { ok: false, error: 'draft must be a non-empty string when present' }
    if (draftRaw.length > MAX_TEXT_LENGTH) return { ok: false, error: `draft too long (max ${MAX_TEXT_LENGTH} chars)` }
    if (CONTROL_CHARS.test(draftRaw)) return { ok: false, error: 'control characters rejected' }
    draft = draftRaw
  }
  const validateOnly = o['validateOnly'] === true
  return { ok: true, req: { cmd: 'card', paneId, question, draft, validateOnly } }
}
```

Update the module docstring: the socket now has two commands, and neither can submit. Add the shared types + channels to `ipc.ts` exactly as in the Interfaces block (the `SeashellApi.lookout` member compiles against the preload in Task 6; until then only the type exists — that is fine, `ipc.ts` is types + constants only). NOTE: adding `lookout` to `SeashellApi` makes `preload/index.ts` fail typecheck until it implements the member — so in THIS task also add the preload implementation stub wired to the real channels (it is 15 lines, not a placeholder):

```ts
// preload/index.ts — inside `api`, after `app`:
lookout: {
  onCards: (cb: (e: LookoutCardsEvent) => void) => subscribe<LookoutCardsEvent>(CH.lookoutCards, cb),
  detected: (req: LookoutDetectedRequest): void => ipcRenderer.send(CH.lookoutDetected, req),
  action: (req: LookoutActionRequest): Promise<LookoutActionResponse> =>
    ipcRenderer.invoke(CH.lookoutAction, req),
  getState: (): Promise<LookoutState> => ipcRenderer.invoke(CH.lookoutGetState),
  setEnabled: (enabled: boolean): void => ipcRenderer.send(CH.lookoutSetEnabled, enabled),
},
```

- [ ] **Step 4: Run** — `npx vitest run test/unit/control-protocol.test.ts` → PASS; `npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add card command to control protocol and Lookout IPC types"`

---

### Task 2: CardStore (main)

**Files:**
- Create: `src/main/lookout/card-store.ts`
- Test: `test/unit/lookout-card-store.test.ts`

**Interfaces:**
- Consumes: `LookoutCard` from `shared/ipc.ts`.
- Produces:

```ts
export const STALE_OUTPUT_BYTES = 256  // grace for DA/CPR replies and redraws
export interface CardStoreDeps {
  /** Monotonic pty output counter for the pane, or null when the pane is gone. */
  bytesOut(paneId: string): number | null
  /** Push the full card list to the renderer. */
  emit(cards: LookoutCard[]): void
  now(): number
}
export class CardStore {
  constructor(deps: CardStoreDeps)
  setEnabled(enabled: boolean): void
  enabled(): boolean
  cards(): LookoutCard[]
  /** One card per pane; a push replaces a detector card, never vice versa
   *  while the push card is active. Returns false when disabled or the pane
   *  is gone or the question was just dismissed on this pane. */
  createFromDetector(paneId: string, question: string): boolean
  createFromPush(paneId: string, question: string, draft: string | null): boolean
  dismiss(cardId: string): void
  get(cardId: string): LookoutCard | undefined
  /** True while the pane's output has advanced < STALE_OUTPUT_BYTES since creation. */
  isFresh(card: LookoutCard): boolean
  markStale(cardId: string): void
  remove(cardId: string): void
  /** Re-checks every active card; flips stale / drops gone panes; emits on change.
   *  The store owns no timer: the index.ts wiring (Task 4) calls this on a
   *  short interval armed only while cards exist, ensureFlushLoop-style. */
  sweep(): void
}
```

Behavior details the tests pin down: `createFromDetector` records `bytesOut` at creation on the card (private field beside the public shape); a second detector create for the same pane while an active card exists replaces it only if the question differs; `dismiss` remembers `(paneId, question)` and `createFromDetector` with that same pair returns false (a different question cards again); `createFromPush` replaces whatever card the pane had; every mutation calls `emit(cards())`; `sweep()` flips `active → stale` when `bytesOut` advanced ≥ `STALE_OUTPUT_BYTES` or the pane is gone (gone panes are removed outright). Card ids: `card-${n}` from a private counter.

- [ ] **Step 1: Write the failing tests** — `test/unit/lookout-card-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CardStore, STALE_OUTPUT_BYTES } from '../../src/main/lookout/card-store.js'

function makeStore(overrides: Partial<{ bytes: Map<string, number | null> }> = {}) {
  const bytes = overrides.bytes ?? new Map<string, number | null>([['p1', 1000]])
  const emitted: number[] = []
  const store = new CardStore({
    bytesOut: (id) => bytes.get(id) ?? null,
    emit: (cards) => emitted.push(cards.length),
    now: () => 42,
  })
  return { store, bytes, emitted }
}

describe('CardStore', () => {
  it('creates a detector card and emits', () => {
    const { store, emitted } = makeStore()
    expect(store.createFromDetector('p1', 'deploy?')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]).toMatchObject({ paneId: 'p1', source: 'detector', draft: null, state: 'active' })
    expect(emitted.length).toBe(1)
  })
  it('push replaces detector for the same pane', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    expect(store.createFromPush('p1', 'deploy?', 'yes go')).toBe(true)
    expect(store.cards()).toHaveLength(1)
    expect(store.cards()[0]?.source).toBe('push')
    expect(store.cards()[0]?.draft).toBe('yes go')
  })
  it('a dismissed question does not re-card; a new question does', () => {
    const { store } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    store.dismiss(store.cards()[0]!.id)
    expect(store.cards()).toHaveLength(0)
    expect(store.createFromDetector('p1', 'deploy?')).toBe(false)
    expect(store.createFromDetector('p1', 'other thing?')).toBe(true)
  })
  it('freshness follows the output counter', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    const card = store.cards()[0]!
    expect(store.isFresh(card)).toBe(true)
    bytes.set('p1', 1000 + STALE_OUTPUT_BYTES)
    expect(store.isFresh(card)).toBe(false)
    store.sweep()
    expect(store.get(card.id)?.state).toBe('stale')
  })
  it('sweep drops cards whose pane is gone', () => {
    const { store, bytes } = makeStore()
    store.createFromDetector('p1', 'deploy?')
    bytes.set('p1', null)
    store.sweep()
    expect(store.cards()).toHaveLength(0)
  })
  it('disabled store refuses creates', () => {
    const { store } = makeStore()
    store.setEnabled(false)
    expect(store.createFromDetector('p1', 'deploy?')).toBe(false)
    expect(store.createFromPush('p1', 'q?', null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/lookout-card-store.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `card-store.ts`** to satisfy exactly those tests. Keep it pure of Electron imports (deps-injected, same style as `control/server.ts`). The internal card record extends `LookoutCard` with `bytesOutAtCreate: number`; `cards()` returns the public shape only (`{ id, paneId, source, question, draft, state, createdAt }`).
- [ ] **Step 4: Run** — `npx vitest run test/unit/lookout-card-store.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout card store"`

---

### Task 3: Question extraction from a pane tail (renderer, pure)

**Files:**
- Create: `src/renderer/lookout/extract.ts`
- Test: `test/unit/lookout-extract.test.ts`

**Interfaces:**
- Consumes: nothing (pure strings in, structured result out).
- Produces: `export interface Extraction { kind: 'input' | 'selector'; question: string }`, `export function extractQuestion(lines: string[]): Extraction | null`, and `export const TAIL_LINES = 60` (how many buffer lines callers should read).

Chrome facts, verified 2026-08-01 against the claude CLI binary (2.1.220) and a live pseudo-tty capture: the input box is ink's `round` border style — `topLeft "╭"`, `top "─"`, `topRight "╮"`, sides `"│"`, `bottomLeft "╰"`, `bottomRight "╯"` — and the idle footer contains the literal `? for shortcuts`. Selection screens (AskUserQuestion widgets, the trust-folder prompt) render **without any input box**: numbered options with a `❯` cursor and a footer containing `Enter to confirm`. Do NOT attempt your own live `script`/pty capture — a headless claude hangs waiting for input (this was tried; it times out) and the capture mangles spacing.

The heuristic, exactly — two signatures, checked in this order:

**Input-box signature** (kind `'input'`): (1) from the bottom, within the last 8 non-empty-scanned lines, find the box bottom border (`╰─`); (2) walk up ≤ 8 lines to its top border (`╭─`), requiring a `│ >` prompt row in between — that trio is the "claude is idle at its input box" signature, and it doubles as the claude-pane check (no process-name gate; see spec amendment); (3) collect the contiguous message block above the box, skipping noise lines (blank, `? for shortcuts`, `⏵`, token/esc status), stopping at the first blank after real content, cap 40 lines; (4) if no line in the block contains `?` and none matches an options pattern (`/^\s*(\d+[.)]|❯|◯|- \[ \])\s/`), return null; (5) question = the last ≤ 6 lines of the block joined with a space, whitespace collapsed, capped at 500 chars.

**Selector signature** (kind `'selector'`, checked only when no input box matched): within the last 15 non-empty lines, a footer line containing `Enter to confirm`, and above it at least one option line matching `/^\s*❯?\s*\d+[.)]\s/` with a `❯` present on at least one of them. Question = the contiguous non-option block above the first option line (last ≤ 6 lines, joined, collapsed) + `' — options: '` + the first ≤ 4 option lines (stripped of `❯`, joined with `' / '`), capped at 500 chars total. Selector screens are precisely where typed-text-plus-Enter would blind-confirm the highlighted option, so downstream (Task 7) renders their cards without any send buttons — the kind field is what makes that possible.

If both signatures somehow match, the input box wins (it renders below the transcript).

- [ ] **Step 1: Write the failing tests** — `test/unit/lookout-extract.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { extractQuestion } from '../../src/renderer/lookout/extract.js'

const BOX = ['╭──────────────────────╮', '│ >                    │', '╰──────────────────────╯']

// Captured from a real claude 2.1.220 trust-folder screen via pseudo-tty
// (respaced by hand after ANSI stripping): no input box, ❯-cursor options,
// Enter-to-confirm footer.
const SELECTOR = [
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
  '',
  'Enter to confirm · Esc to cancel',
]

describe('extractQuestion', () => {
  it('finds the question above an idle input box', () => {
    const lines = [
      '⏺ I compared both options.',
      'Want me to lock in option 2 and keep going?',
      '',
      ...BOX,
      '  ? for shortcuts',
    ]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toContain('lock in option 2')
  })
  it('returns null when there is neither box nor selector', () => {
    expect(extractQuestion(['just some output', 'no box here?'])).toBeNull()
  })
  it('returns null for a statement-only tail', () => {
    const lines = ['⏺ All done. Committed as abc123.', '', ...BOX]
    expect(extractQuestion(lines)).toBeNull()
  })
  it('accepts numbered options without a question mark above the box', () => {
    const lines = ['Pick one:', '  1. keep both', '  2. delete the old one', '', ...BOX]
    const r = extractQuestion(lines)
    expect(r?.kind).toBe('input')
    expect(r?.question).toMatch(/delete the old one/)
  })
  it('classifies a selector screen and carries its options', () => {
    const r = extractQuestion(SELECTOR)
    expect(r?.kind).toBe('selector')
    expect(r?.question).toContain('trust this folder')
    expect(r?.question).toContain('options:')
    expect(r?.question).toContain('No, exit')
  })
  it('input box wins when both signatures are present', () => {
    const r = extractQuestion([...SELECTOR, '', ...BOX])
    expect(r?.kind).toBe('input')
  })
  it('caps the result at 500 chars on one line', () => {
    const long = 'why? '.repeat(300)
    const lines = [long, '', ...BOX]
    const r = extractQuestion(lines)
    expect(r).not.toBeNull()
    expect(r!.question.length).toBeLessThanOrEqual(500)
    expect(r!.question).not.toContain('\n')
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/lookout-extract.test.ts` → FAIL.
- [ ] **Step 3: Implement `extract.ts`** per the two-signature heuristic. Regexes as module constants with one comment each stating what real screen artifact they match (cite the binary-verified chrome facts above). No xterm import — strings only.
- [ ] **Step 4: Run** — PASS, plus `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout question extraction heuristic"`

(Former fixture-capture step removed 2026-08-01: the chrome is now verified directly against the claude binary's ink border-style table and a real pseudo-tty capture — the SELECTOR fixture above IS the captured screen. Do not attempt live captures in this task.)

---

### Task 4: Socket v2 routing + shared foreground check (main)

**Files:**
- Create: `src/main/control/foreground-check.ts`
- Modify: `src/main/control/server.ts`
- Modify: `src/main/index.ts`
- Test: `test/unit/control-server.test.ts` (extend)

**Interfaces:**
- Consumes: `parseControlRequest` (Task 1), `CardStore` (Task 2).
- Produces:

```ts
// control/foreground-check.ts — the execFile('ps') wrapper that index.ts
// currently builds inline for the socket, extracted so the approve path
// (Task 5) uses the identical check:
export function checkTtyForeground(ttyName: string): Promise<boolean>

// control/server.ts — ControlServerDeps gains one member:
/** Create a pushed card. Returns null on success, else a refusal message. */
postCard(req: { paneId: string; question: string; draft: string | null }): string | null
```

Server `handle()` for `cmd === 'card'`: same guard order as `type` (paneTty → checkForeground), then if `validateOnly` return `{ ok: true }` without calling `postCard`; else `postCard(...)` → `{ ok: true }` or `{ ok: false, error }`. In `index.ts`: build the `CardStore` (deps: `bytesOut` from a new `PtyManager.bytesOutOf(paneId): number | null` — a 4-line sibling of `paneTty` returning `rec.bytesOut`; `emit` sends `CH.lookoutCards` to the window; `now: Date.now`), pass `postCard` through to `startControlServer`, and replace the inline `checkForeground` promise with `checkTtyForeground`.

- [ ] **Step 1: Write the failing tests** — extend `test/unit/control-server.test.ts` following its existing fake-deps pattern (real socket, recording fakes). New cases:

```ts
it('routes a card to postCard after the foreground check', async () => { /* postCard recorded, ok:true */ })
it('validateOnly runs every check but creates nothing', async () => { /* postCard NOT called, ok:true */ })
it('card for an unknown pane is refused before postCard', async () => { /* error: unknown or exited pane */ })
it('card is refused when foreground is not claude', async () => { /* error mentions foreground */ })
it('postCard refusal surfaces as the error', async () => { /* postCard: () => 'lookout disabled' */ })
```

Write them concretely against the file's existing helper that boots `startControlServer` with fakes — copy its connect/send/response helper verbatim from the `type` cases.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/control-server.test.ts` → FAIL (deps type + routing missing).
- [ ] **Step 3: Implement** — `foreground-check.ts` (move the `execFile('ps', ['-t', ttyName, '-o', 'stat=,command='])` + `foregroundIsClaude` composition out of `index.ts`); server routing; `PtyManager.bytesOutOf`; `index.ts` wiring (CardStore construction + deps + `postCard: (r) => cardStore.createFromPush(r.paneId, r.question, r.draft) ? null : 'lookout disabled or pane not eligible'`). The store's sweep timer: arm a 2s `setInterval` inside `index.ts` only while `cardStore.cards().length > 0` — mirror the `ensureFlushLoop` start/stop idiom from `pty/manager.ts`, calling `cardStore.sweep()`.
- [ ] **Step 4: Run** — full `npm test` (protocol, server, card-store all green) + `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "Route card pushes through the control socket"`

---

### Task 5: Approve path + Lookout IPC handlers (main)

**Files:**
- Create: `src/main/lookout/approve.ts`
- Create: `src/main/lookout/plugin-detect.ts`
- Modify: `src/main/ipc-router.ts`
- Modify: `src/main/index.ts`
- Test: `test/unit/lookout-approve.test.ts`

**Interfaces:**
- Consumes: `CardStore` (Task 2), `checkTtyForeground` (Task 4), `LookoutActionRequest/Response` (Task 1).
- Produces:

```ts
// lookout/approve.ts
export interface ApproveDeps {
  store: CardStore
  paneTty(paneId: string): string | null
  checkForeground(ttyName: string): Promise<boolean>
  writeIfLive(paneId: string, data: string): boolean
}
export async function approveCard(
  deps: ApproveDeps,
  req: { cardId: string; text: string }
): Promise<LookoutActionResponse>

// lookout/plugin-detect.ts
export async function lookoutPluginInstalled(): Promise<boolean>

// ipc-router.ts — signature change (update the call in index.ts):
export interface LookoutIpc {
  store: CardStore
  approve(req: { cardId: string; text: string }): Promise<LookoutActionResponse>
  pluginInstalled(): Promise<boolean>
}
export function registerIpc(ptyManager: PtyManager, lookout: LookoutIpc): void
```

`approveCard` order (each failure returns its code and never writes): trim `text`; empty / control chars / > 4000 → `EINVALID`. `store.get` misses → `ENOTFOUND`. `!store.isFresh(card)` → `store.markStale`, `ESTALE`. `paneTty` null → `EGONE`. foreground false → `store.markStale`, `EFOREGROUND`. `writeIfLive(paneId, text)` false → `EGONE`. Then `writeIfLive(paneId, '\r')` — **the only Enter in the system** — `store.remove(cardId)`, return `{ ok: true, delivered: true }`.

`lookoutPluginInstalled`: read `~/.claude/plugins/installed_plugins.json`, return `Array.isArray(parsed.plugins?.['c-assistant@voidharbor']) && parsed.plugins['c-assistant@voidharbor'].length > 0`; any error → false.

Router additions (zod, matching the file's style): `LookoutDetectedReq = z.object({ paneId: PaneId, question: z.string().min(1).max(500) })` handled with `ipcMain.on` → `lookout.store.createFromDetector`; `LookoutActionReq = z.object({ cardId: z.string().min(1).max(64), action: z.enum(['approve','dismiss']), text: z.string().max(4000).optional() })` handled with `ipcMain.handle` → dismiss: `store.dismiss`, `{ ok: true, delivered: false }`; approve: require `text` else `EINVALID`, then `lookout.approve`; `CH.lookoutGetState` handle → `{ pluginInstalled: await lookout.pluginInstalled(), enabled: lookout.store.enabled() }`; `CH.lookoutSetEnabled` on → `z.boolean()` → `store.setEnabled`.

- [ ] **Step 1: Write the failing tests** — `test/unit/lookout-approve.test.ts`, driving `approveCard` with a real `CardStore` over fake bytes and a recording fake pty:

```ts
import { describe, expect, it } from 'vitest'
import { CardStore, STALE_OUTPUT_BYTES } from '../../src/main/lookout/card-store.js'
import { approveCard } from '../../src/main/lookout/approve.js'

function setup(opts: { foreground?: boolean; tty?: string | null } = {}) {
  const bytes = new Map<string, number | null>([['p1', 500]])
  const store = new CardStore({ bytesOut: (id) => bytes.get(id) ?? null, emit: () => {}, now: () => 1 })
  store.createFromPush('p1', 'ship it?', 'yes ship')
  const writes: string[] = []
  const deps = {
    store,
    paneTty: () => (opts.tty === undefined ? 'ttys009' : opts.tty),
    checkForeground: async () => opts.foreground ?? true,
    writeIfLive: (_id: string, data: string) => { writes.push(data); return true },
  }
  return { store, deps, writes, bytes, cardId: store.cards()[0]!.id }
}

describe('approveCard', () => {
  it('writes text then a single Enter and removes the card', async () => {
    const { deps, writes, cardId, store } = setup()
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(true)
    expect(writes).toEqual(['yes ship', '\r'])
    expect(store.cards()).toHaveLength(0)
  })
  it('refuses a stale card without writing', async () => {
    const { deps, writes, cardId, bytes, store } = setup()
    bytes.set('p1', 500 + STALE_OUTPUT_BYTES)
    const res = await approveCard(deps, { cardId, text: 'yes ship' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ESTALE')
    expect(writes).toHaveLength(0)
    expect(store.get(cardId)?.state).toBe('stale')
  })
  it('refuses when foreground is not claude', async () => {
    const { deps, writes, cardId } = setup({ foreground: false })
    const res = await approveCard(deps, { cardId, text: 'ok' })
    if (!res.ok) expect(res.code).toBe('EFOREGROUND')
    expect(writes).toHaveLength(0)
  })
  it('refuses control characters and over-long text', async () => {
    const { deps, cardId } = setup()
    const a = await approveCard(deps, { cardId, text: 'a\nb' })
    if (!a.ok) expect(a.code).toBe('EINVALID')
    const b = await approveCard(deps, { cardId, text: 'x'.repeat(4001) })
    if (!b.ok) expect(b.code).toBe('EINVALID')
  })
  it('refuses a gone pane', async () => {
    const { deps, cardId } = setup({ tty: null })
    const res = await approveCard(deps, { cardId, text: 'ok' })
    if (!res.ok) expect(res.code).toBe('EGONE')
  })
})
```

- [ ] **Step 2: Run to verify they fail** — FAIL (module not found).
- [ ] **Step 3: Implement** `approve.ts` + `plugin-detect.ts` + router extension + `index.ts` wiring (`registerIpc(ptyManager, { store: cardStore, approve: (r) => approveCard({ store: cardStore, paneTty: (id) => pm.paneTty(id), checkForeground: checkTtyForeground, writeIfLive: (id, d) => pm.writeIfLive(id, d) }, r), pluginInstalled: lookoutPluginInstalled })`).
- [ ] **Step 4: Run** — `npm test && npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout approve path and IPC handlers"`

---

### Task 6: Renderer detection effect

**Files:**
- Create: `src/renderer/lookout/detect.ts`
- Modify: `src/renderer/app.tsx`
- Test: `test/unit/lookout-detect.test.ts`

**Interfaces:**
- Consumes: `extractQuestion` (Task 3), `terminals` map from `panes/PaneView.tsx`, `window.seashell.lookout.detected` (Task 1), app state shape from `renderer/store.ts`.
- Produces:

```ts
// renderer/lookout/detect.ts — pure planner, so the React effect stays 10 lines:
export interface DetectPane {
  paneId: string
  attention: 'waiting' | 'done' | null | undefined
  focused: boolean
}
/** Which panes should be read + reported this pass, and the next reported-set. */
export function planDetections(
  panes: DetectPane[],
  reported: ReadonlySet<string>
): { toScan: string[]; nextReported: Set<string> }
```

Rules: a pane enters `toScan` when `attention === 'waiting'`, not focused, and not already in `reported`; `nextReported` = every currently-waiting pane that was reported before plus the ones in `toScan`; panes no longer waiting drop out of `nextReported` (so the next waiting run re-cards).

- [ ] **Step 1: Write the failing tests** — `test/unit/lookout-detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { planDetections } from '../../src/renderer/lookout/detect.js'

describe('planDetections', () => {
  it('scans a newly waiting unfocused pane once', () => {
    const one = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], new Set())
    expect(one.toScan).toEqual(['p1'])
    const two = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], one.nextReported)
    expect(two.toScan).toEqual([])
  })
  it('never scans the focused pane', () => {
    const r = planDetections([{ paneId: 'p1', attention: 'waiting', focused: true }], new Set())
    expect(r.toScan).toEqual([])
  })
  it('re-arms after the pane stops waiting', () => {
    const a = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], new Set())
    const b = planDetections([{ paneId: 'p1', attention: null, focused: false }], a.nextReported)
    expect(b.nextReported.has('p1')).toBe(false)
    const c = planDetections([{ paneId: 'p1', attention: 'waiting', focused: false }], b.nextReported)
    expect(c.toScan).toEqual(['p1'])
  })
})
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement `detect.ts`**, then wire the effect in `app.tsx`. Locate the settings state (`grep -n "loadSettings()" src/renderer/app.tsx` — it is a `useState` near the top) and the imports of `terminals` (`import { terminals } from './panes/PaneView.js'` already exists for other uses; add if absent). Add, near the metrics subscription (~line 206):

```tsx
const lookoutReported = useRef<Set<string>>(new Set())
useEffect(() => {
  if (!settings.lookoutCards) return
  const panes = state.tabs.flatMap((t) =>
    Object.values(t.panes)
      .filter((p) => p.kind === 'term')
      .map((p) => ({
        paneId: p.id,
        attention: p.attention ?? null,
        focused: t.id === state.activeTabId && t.focusedPaneId === p.id,
      }))
  )
  const plan = planDetections(panes, lookoutReported.current)
  lookoutReported.current = plan.nextReported
  for (const paneId of plan.toScan) {
    const term = terminals.get(paneId)?.term
    if (!term) continue
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = Math.max(0, buf.length - TAIL_LINES); i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    }
    const extraction = extractQuestion(lines)
    if (extraction) window.seashell.lookout.detected({ paneId, question: extraction.question })
  }
}, [state.tabs, state.activeTabId, settings.lookoutCards])
```

Both kinds report (a selector's question text already carries its options from Task 3); the kind itself is not sent over IPC — Task 7 re-derives the pane's live screen mode at render/click time, which is the value that actually matters for button safety.

(`settings.lookoutCards` compiles after Task 8 adds the setting — to keep this task green on its own, reference the setting only if Task 8 landed first; otherwise gate on `true` and swap in the setting in Task 8. Prefer implementing Task 8's `settings.ts` two-line change *in this task* if executing in order matters less than compiling — either order is fine as long as both land before Task 9.)

- [ ] **Step 4: Run** — `npm test && npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git commit -am "Detect waiting claude panes and report questions"`

---

### Task 7: Card UI — stack, badge, empty state

**Files:**
- Create: `src/renderer/lookout/CardStack.tsx`
- Modify: `src/renderer/app.tsx` (mount + card state)
- Modify: `src/renderer/status/StatusBar.tsx` (badge)
- Modify: `src/renderer/styles.css`
- Test: `test/dom/lookout-cards.test.tsx`

**Interfaces:**
- Consumes: `LookoutCard`, `window.seashell.lookout.*` (Task 1), existing `dispatch` for `pane.focus` / `tab.select`.
- Produces:

```tsx
export interface CardStackProps {
  cards: LookoutCard[]
  /** Pane ids the stack must not show cards for (the focused pane). */
  suppressedPaneId: string | null
  pluginInstalled: boolean
  open: boolean            // badge toggles the (possibly empty) stack
  /** Live screen mode of a pane, re-derived from its xterm buffer via
   *  extractQuestion at render and click time. 'selector' means typed text +
   *  Enter would blind-confirm the highlighted option — no send buttons. */
  screenMode(paneId: string): 'input' | 'selector' | null
  onAction(req: { cardId: string; action: 'approve' | 'dismiss'; text?: string }): void
  onGotoPane(paneId: string): void
  onClose(): void
}
export function CardStack(props: CardStackProps): React.JSX.Element
```

**Selector safety rule (added 2026-08-01, from the real-capture finding):** every send affordance — canned `[Continue]/[Yes]/[No]`, `[Approve ✓]`, and Edit-send — renders ONLY when `screenMode(card.paneId) === 'input'`. When it returns `'selector'`, the card shows the question (and draft, greyed, as reference text) with `[Go to pane] [✕]` and the literal hint `answer in the pane — it's showing a picker`. When it returns `null` (pane unreadable), treat as `'selector'` — never guess toward sending. `app.tsx` passes an implementation that reads `terminals.get(paneId)` and runs `extractQuestion` on the tail (same TAIL_LINES read as Task 6).

Card rendering: title = short pane id line + `question`; when `draft !== null` show the draft in a `<textarea>` (single-row, value in local state seeded from the draft) with buttons `Approve ✓` (sends the current textarea value), `Deny ✕` (dismiss); when `draft === null` and `source === 'push'` show the question with only `Go to pane` / `✕` (a draft-less brain card — money/legal/irreversible never one-clicks); detector cards get `[Continue] [Yes] [No]` buttons sending exactly the lowercase words `continue` / `yes` / `no`, plus `Go to pane` and `✕`. Stale cards render with a `card--stale` class, every SEND affordance disabled, and the literal label `session moved on` — but `[Go to pane]` and `[✕]` stay enabled (they fire nothing into the conversation, and a stale card you cannot dismiss is permanent clutter). Empty open stack: `nothing needs you` when `pluginInstalled`, else the two literal lines `/plugin marketplace add voidharbor/claude-plugins` and `/plugin install c-assistant@voidharbor` under the heading `smart cards need the c-assistant plugin:`.

In `app.tsx`: `const [lookoutCards, setLookoutCards] = useState<LookoutCard[]>([])`, `const [lookoutOpen, setLookoutOpen] = useState(false)`, `const [lookoutPlugin, setLookoutPlugin] = useState(false)`; subscribe once (`useEffect`, empty deps): `window.seashell.lookout.onCards((e) => setLookoutCards(e.cards))` and `void window.seashell.lookout.getState().then((s) => setLookoutPlugin(s.pluginInstalled))`. Mount `<CardStack …>` next to `<StatusBar …>`; `onGotoPane` dispatches `tab.select` (find the tab owning the pane by scanning `state.tabs`) then `pane.focus`. Badge: give `StatusBar` two new optional props `lookoutCount?: number` and `onLookoutClick?: () => void`; render `🔭 {count}` as a clickable span before the hint span; count = ALL active cards including the focused pane's (the spec's "it gets the badge only" — suppression is a stack-visibility rule, never a count rule). Compute it in a pure `lookoutBadgeCount(cards: LookoutCard[]): number` helper in `src/renderer/lookout/` with a unit test asserting a suppressed-but-active card counts and a stale card does not.

- [ ] **Step 1: Write the failing dom test** — `test/dom/lookout-cards.test.tsx`, following `test/dom/tutorial.test.tsx` setup idiom:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CardStack } from '../../src/renderer/lookout/CardStack.js'

const card = {
  id: 'card-1', paneId: 'p1', source: 'push' as const,
  question: 'ship the release?', draft: 'yes ship it', state: 'active' as const, createdAt: 1,
}

describe('CardStack', () => {
  it('approve sends the edited textarea text', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[card]} suppressedPaneId={null} pluginInstalled open={false}
      screenMode={() => 'input'} onAction={onAction} onGotoPane={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yes ship it tonight' } })
    fireEvent.click(screen.getByText(/approve/i))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'yes ship it tonight' })
  })
  it('suppresses the focused pane but keeps others', () => {
    render(<CardStack cards={[card]} suppressedPaneId="p1" pluginInstalled open={false}
      screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/ship the release/)).toBeNull()
  })
  it('stale cards disable their buttons', () => {
    render(<CardStack cards={[{ ...card, state: 'stale' as const }]} suppressedPaneId={null}
      pluginInstalled open={false} screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/session moved on/i)).toBeTruthy()
    expect((screen.getByText(/approve/i) as HTMLButtonElement).disabled).toBe(true)
  })
  it('empty open stack shows install commands when the plugin is absent', () => {
    render(<CardStack cards={[]} suppressedPaneId={null} pluginInstalled={false} open
      screenMode={() => 'input'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/plugin install c-assistant@voidharbor/)).toBeTruthy()
  })
  it('detector cards send canned lowercase words', () => {
    const onAction = vi.fn()
    render(<CardStack cards={[{ ...card, source: 'detector' as const, draft: null }]}
      suppressedPaneId={null} pluginInstalled open={false} screenMode={() => 'input'}
      onAction={onAction} onGotoPane={() => {}} onClose={() => {}} />)
    fireEvent.click(screen.getByText('Continue'))
    expect(onAction).toHaveBeenCalledWith({ cardId: 'card-1', action: 'approve', text: 'continue' })
  })
  it('selector screens get no send buttons at all', () => {
    render(<CardStack cards={[card]} suppressedPaneId={null} pluginInstalled open={false}
      screenMode={() => 'selector'} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/approve/i)).toBeNull()
    expect(screen.queryByText('Continue')).toBeNull()
    expect(screen.getByText(/showing a picker/i)).toBeTruthy()
  })
  it('an unreadable pane is treated like a selector', () => {
    render(<CardStack cards={[card]} suppressedPaneId={null} pluginInstalled open={false}
      screenMode={() => null} onAction={() => {}} onGotoPane={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/approve/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/dom/lookout-cards.test.tsx` → FAIL.
- [ ] **Step 3: Implement** `CardStack.tsx`, the `app.tsx` mounting + wiring above, the `StatusBar` badge props, and styles (`.lookout-stack` fixed bottom-right above the status bar, `.card`, `.card--stale { opacity: .55 }`, buttons in the app's existing button classes — copy class usage from `SettingsPanel.tsx`).
- [ ] **Step 4: Run** — `npm test && npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout card stack, status-bar badge, and empty state"`

---

### Task 8: Settings toggle

**Files:**
- Modify: `src/renderer/settings/settings.ts`
- Modify: `src/renderer/settings/SettingsPanel.tsx`
- Modify: `src/renderer/app.tsx`
- Test: `test/unit/settings.test.ts` (extend)

**Interfaces:**
- Consumes: `Settings` / `DEFAULT_SETTINGS` / `coerceSettings`.
- Produces: `Settings.lookoutCards: boolean`, default `true`.

- [ ] **Step 1: Write the failing test** — extend `test/unit/settings.test.ts`:

```ts
it('defaults lookoutCards on and coerces junk back to it', () => {
  expect(DEFAULT_SETTINGS.lookoutCards).toBe(true)
  expect(coerceSettings({ lookoutCards: 'nope' }).lookoutCards).toBe(true)
  expect(coerceSettings({ lookoutCards: false }).lookoutCards).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (property missing).
- [ ] **Step 3: Implement** — add to the `Settings` interface with the doc comment `/** Raise approval cards when an agent pane stops on a question. */`, add `lookoutCards: true` to `DEFAULT_SETTINGS` (the `coerceSettings` key loop picks it up automatically). Add a SettingsPanel row copying the `attentionGlow` row exactly, label **"Approval cards"**, help text **"Raise a card when an agent pane stops on a question"**. In `app.tsx`: gate the detection effect on `settings.lookoutCards` (it already references it if Task 6 chose that path — reconcile now) and mirror changes to main: `useEffect(() => { window.seashell.lookout.setEnabled(settings.lookoutCards) }, [settings.lookoutCards])`.
- [ ] **Step 4: Run** — `npm test && npm run typecheck` → clean.
- [ ] **Step 5: Commit** — `git commit -am "Add Lookout settings toggle"`

---

### Task 9: Version, README, tutorial, and the mac E2E checklist

**Files:**
- Modify: `package.json` (version `0.2.0`)
- Modify: `README.md` (new "Lookout" feature section)
- Modify: `src/renderer/tutorial/Tutorial.tsx` (new Lookout step)
- Test: `test/dom/tutorial.test.tsx` (extend)
- Create: `docs/superpowers/plans/2026-08-01-lookout-e2e-checklist.md`

- [ ] **Step 1: Bump** `"version": "0.2.0"` and write the README section: what cards are, the two lanes, and the one-sentence safety model (external tools propose; only your click submits). Companion-plugin wording (added 2026-08-01, Josh's request) — the section must state all three of these, in this order:
  1. Smart drafted cards **require the c-assistant companion plugin**:
     `/plugin marketplace add voidharbor/claude-plugins` then `/plugin install c-assistant@voidharbor`.
  2. **Recommend the voidharbor bundle** for the full skill set: `/plugin install voidharbor@voidharbor` installs all of voidharbor's skills at once.
  3. The Lookout hooks ship in the standalone c-assistant plugin specifically — the bundle carries the c-assistant commands but not the hooks, so cards need c-assistant installed even if you also have the bundle.
- [ ] **Step 1b: Tutorial step (added 2026-08-01, Josh's request).** Read `Tutorial.tsx` and add one step following the existing steps structure exactly (same shape, same voice, positioned after whatever step covers pane attention/glow, else last). Copy, verbatim: title **"Lookout"**, body **"When an agent pane stops to ask you something, a card appears in the corner — Approve answers the pane without leaving the one you're in. Smart drafted replies come from the c-assistant plugin."** Extend `test/dom/tutorial.test.tsx` in its existing pattern: TDD order — add a failing assertion that stepping through the tutorial reaches a step containing "Lookout", run it (FAIL), add the step, run it (PASS).
- [ ] **Step 2: Write the checklist file** with exactly these manual steps (checked off during release, not now):

```markdown
# Lookout mac E2E checklist
- [ ] npm run dev; open a claude pane; ask it something that makes it ask back
- [ ] pane glows → within one metrics tick a card appears bottom-right with the question
- [ ] focused pane never shows a card; badge still counts it
- [ ] [Continue]/[Yes]/[No] on a detector card types the word + submits in the pane
- [ ] type into the pane by hand → card greys to "session moved on"; send buttons dead, Go to pane + dismiss still work
- [ ] dismiss a card → same question does not re-card; a new question does
- [ ] push a card over the socket (echo JSON via nc -U to the control.sock) with validateOnly:true → ok, no card
- [ ] same without validateOnly → card with draft; Approve submits it verbatim; Edit-then-Approve submits the edit
- [ ] settings toggle off → no new cards; socket card push returns "lookout disabled"
- [ ] quit SeaShell with cards open → clean quit, socket file gone
- [ ] Windows/Linux build: cards + detector visible; no socket expectations
```

- [ ] **Step 3: Run** — `npm run typecheck && npm test` one final time, then `npm run build` to prove the bundle compiles.
- [ ] **Step 4: Commit** — `git commit -am "Bump to 0.2.0 and document Lookout"`

## Plan self-review notes

Spec coverage: card shape/lifecycle (T2, T7), detector lane (T3, T6), socket v2 + validateOnly (T1, T4), approve/Enter boundary (T5), plugin detection + empty state (T5, T7), settings (T8), staleness (T2, T4 sweep, T5), focus suppression (T6 plan + T7 render), platform note (detector is renderer-only so it ships everywhere; socket unchanged on Windows = absent, per amended spec), version/README (T9). The brain lane itself is the companion plan `2026-08-01-lookout-plugin.md`.
