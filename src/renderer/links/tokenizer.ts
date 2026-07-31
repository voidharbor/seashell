/**
 * Path-candidate tokenizer (spec §8.2), shared by the hover link provider
 * and the double-click handler so hover and open can never disagree about
 * what counts as a path.
 *
 * [pure] — operates on a plain string (the already-assembled logical line;
 * see cellmap.ts's `assembleLogicalLine` for how that string and its per-
 * character cell map get built from real xterm buffer rows). No DOM, no
 * xterm import, no Node builtin — testable in bare node.
 *
 * The design premise (stated in the spec, worth repeating here): this
 * tokenizer is deliberately permissive. It is expected to produce false
 * positives — a URL fragment that slips past the scheme check, a stray
 * word that happens to look like `name.ext` — because the *only* thing
 * that ultimately linkifies is a path that survives a real `stat` in main.
 * Erring toward over-extraction here is fine; erring toward under-extraction
 * would silently hide real paths.
 *
 * Spaces — the exact contract (spec §8.2):
 *   - Supported at hover and double-click: single- or double-quoted paths,
 *     and backslash-escaped spaces (`\ `).
 *   - NOT supported at hover: bare unquoted spaced paths. `/Users/j/My
 *     Docs/a.txt` typed unquoted is formally indistinguishable from prose,
 *     and probing every space boundary costs O(words) stats per token with
 *     confidently wrong results. This is a deliberate limitation, not an
 *     oversight — the bounded double-click-only fallback described in the
 *     spec (extend through following words while a directory listing shows
 *     the prefix is unique) needs `readdir`, so it lives with the (non-pure)
 *     resolution code that has filesystem access, not here.
 */

export type PathKind = 'absolute' | 'home' | 'relative' | 'bare'

export interface PathCandidate {
  /**
   * The path text after unescaping backslash-spaces, stripping surrounding
   * quotes/brackets/punctuation, and splitting off a trailing `:line[:col]`
   * or `(line,col)` suffix. Never resolved or `~`-expanded — expanding `~`
   * needs `os.homedir()`, and this module may import nothing but the bare
   * language plus (implicitly) string/regex builtins, to stay pure.
   */
  path: string
  kind: PathKind
  /**
   * Inclusive-start / exclusive-end index into the ORIGINAL line string,
   * spanning exactly the on-screen characters that produced `path` (the
   * suffix and any stripped punctuation/quotes are excluded). cellmap.ts
   * uses this to decide whether a clicked cell landed on the candidate.
   *
   * Note: when a backslash-escaped space was unescaped, this span is one
   * character longer than `path.length` for each escape (the backslash
   * still occupies a screen column), so `line.slice(start, end) === path`
   * only holds when no escaping occurred.
   */
  start: number
  end: number
  /** 1-based line number parsed from a `:line`, `:line:col`, or `(line,col)` suffix. */
  line?: number
  /** 1-based column number, present only when the suffix included one. */
  col?: number
}

/** Characters that split a run in Pass 2. A literal backslash-space is the
 *  one exception — handled specially so it never splits a run. */
const HARD = /[\s"'`<>|]/

/** Extensionless basenames the tokenizer accepts as bare tokens (spec §8.2). */
const BARE_BASENAMES: ReadonlySet<string> = new Set([
  'Makefile',
  'Dockerfile',
  'Justfile',
  'Rakefile',
  'Gemfile',
  'Brewfile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'NOTICE',
  'AUTHORS',
])

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const VERSION_RE = /^\d[\d.]*$/
const BARE_EXT_RE = /^[\w.@+-]+\.[A-Za-z0-9]{1,8}$/
const TSC_SUFFIX_RE = /^(.+?)\((\d{1,7}),(\d{1,7})\)$/
const GREP_SUFFIX_RE = /^(.+?):(\d{1,7})(?::(\d{1,7}))?$/
const TRAILING_PUNCT_RE = /[.,;:!?]/

const MAX_RUN_LEN = 1024
const MAX_RUNS_PER_LINE = 64

const BRACKET_PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' }
const BRACKET_OPENERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' }

/** Extracts every path candidate from one logical (already-unwrapped) line. */
export function tokenizeLine(line: string): PathCandidate[] {
  const out: PathCandidate[] = []

  // --- Pass 1: quoted spans, emitted verbatim -------------------------------
  // This is how spaced paths are supported. Interior content is masked out
  // of the string Pass 2 scans, so a spaced quoted path is never re-split
  // word-by-word by the HARD-character run scanner below.
  const QUOTED_RE = /'([^'\n]{1,1024})'|"([^"\n]{1,1024})"/g
  const scanChars = line.split('')
  let qm: RegExpExecArray | null
  while ((qm = QUOTED_RE.exec(line))) {
    const content = qm[1] ?? qm[2] ?? ''
    const contentStart = qm.index + 1
    const contentEnd = contentStart + content.length
    for (let k = qm.index; k < qm.index + qm[0].length; k++) scanChars[k] = ' '
    if (!isRejected(content)) {
      const cand = classify(content, contentStart, contentEnd)
      if (cand) out.push(cand)
    }
  }
  const scanLine = scanChars.join('')

  // --- Pass 2: HARD-delimited runs -------------------------------------------
  let i = 0
  let runCount = 0
  while (i < scanLine.length) {
    const ch = scanLine[i]
    if (ch === undefined) break
    if (HARD.test(ch)) {
      i++
      continue
    }
    if (runCount >= MAX_RUNS_PER_LINE) break // bail on pathological lines
    runCount++

    // Collect the run, treating "\ " as a literal path character. Track,
    // per emitted output character, the original-line index range it came
    // from — needed because unescaping "\ " -> " " shortens the text
    // relative to the span it occupies on screen.
    let text = ''
    const charStart: number[] = []
    const charEnd: number[] = []
    while (i < scanLine.length) {
      const c = scanLine[i]
      if (c === undefined) break
      if (c === '\\' && scanLine[i + 1] === ' ') {
        charStart.push(i)
        i += 2
        charEnd.push(i)
        text += ' '
        continue
      }
      if (HARD.test(c)) break
      charStart.push(i)
      i++
      charEnd.push(i)
      text += c
    }

    if (text.length === 0 || text.length > MAX_RUN_LEN) continue
    const cand = processRun(text, charStart, charEnd)
    if (cand) out.push(cand)
  }

  return out
}

/** Runs steps 1-4 of the Pass-2 pipeline on one already-collected run. */
function processRun(text: string, charStart: number[], charEnd: number[]): PathCandidate | null {
  let lo = 0
  let hi = text.length

  // Step 1: strip balanced wrapping (), [], {} — possibly nested.
  for (;;) {
    if (hi - lo < 2) break
    const open = text[lo]
    if (open === undefined) break
    const close = BRACKET_PAIRS[open]
    if (close === undefined || text[hi - 1] !== close) break
    let depth = 0
    let balanced = true
    for (let k = lo; k < hi; k++) {
      const c = text[k]
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0 && k !== hi - 1) {
          balanced = false
          break
        }
      }
    }
    if (!balanced || depth !== 0) break
    lo++
    hi--
  }

  // Step 2: strip ONE trailing ) ] } only when it has no matching opener
  // within the run (a markdown-link artifact like "(see src/x.ts)" splits,
  // on whitespace, into a run "src/x.ts)" whose ")" is unmatched).
  if (hi - lo > 0) {
    const last = text[hi - 1]
    const open = last === undefined ? undefined : BRACKET_OPENERS[last]
    if (open !== undefined && last !== undefined) {
      let opens = 0
      let closes = 0
      for (let k = lo; k < hi; k++) {
        if (text[k] === open) opens++
        else if (text[k] === last) closes++
      }
      if (closes > opens) hi--
    }
  }

  // Step 3: strip trailing prose punctuation repeatedly.
  while (hi > lo) {
    const c = text[hi - 1]
    if (c === undefined || !TRAILING_PUNCT_RE.test(c)) break
    hi--
  }
  if (hi <= lo) return null

  const core = text.slice(lo, hi)
  if (isRejected(core)) return null

  // Step 4: split off a line/col suffix — tsc/MSBuild "(line,col)" first,
  // then grep/eslint/stack-trace ":line[:col]".
  let pathText = core
  let lineNo: number | undefined
  let colNo: number | undefined
  const tsc = TSC_SUFFIX_RE.exec(core)
  if (tsc) {
    const [, p, l, c] = tsc
    if (p !== undefined && l !== undefined && c !== undefined) {
      pathText = p
      lineNo = Number(l)
      colNo = Number(c)
    }
  } else {
    const grep = GREP_SUFFIX_RE.exec(core)
    if (grep) {
      const [, p, l, c] = grep
      if (p !== undefined && l !== undefined) {
        pathText = p
        lineNo = Number(l)
        colNo = c === undefined ? undefined : Number(c)
      }
    }
  }
  if (pathText.length === 0) return null

  const startOrig = charStart[lo]
  const endOrig = charEnd[lo + pathText.length - 1]
  if (startOrig === undefined || endOrig === undefined) return null

  const cand = classify(pathText, startOrig, endOrig)
  if (!cand) return null
  if (lineNo !== undefined) {
    cand.line = lineNo
    if (colNo !== undefined) cand.col = colNo
  }
  return cand
}

/** Reject rules shared by both passes (spec §8.2 "Reject"). Run-count and
 *  length-of-run bailouts are handled by the callers; this covers the
 *  content-shape checks. */
function isRejected(text: string): boolean {
  if (text.length === 0 || text.length > MAX_RUN_LEN) return true
  if (SCHEME_RE.test(text)) return true
  if (VERSION_RE.test(text)) return true
  return false
}

/** Classifies a cleaned path string into a PathCandidate, or returns null
 *  if it matches none of the accepted shapes (spec §8.2 "Classify"). */
function classify(text: string, start: number, end: number): PathCandidate | null {
  let kind: PathKind
  if (text.startsWith('/')) kind = 'absolute'
  else if (text === '~' || text.startsWith('~/')) kind = 'home'
  else if (text.startsWith('./') || text.startsWith('../') || text.includes('/')) kind = 'relative'
  else if (BARE_EXT_RE.test(text) || BARE_BASENAMES.has(text)) kind = 'bare'
  else return null
  return { path: text, kind, start, end }
}
