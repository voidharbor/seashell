import { describe, expect, it } from 'vitest'
import { tokenizeLine, type PathCandidate } from '../../src/renderer/links/tokenizer.js'

/** Convenience: the single candidate whose `path` equals `expected`, or throws. */
function only(cands: PathCandidate[]): PathCandidate {
  expect(cands).toHaveLength(1)
  const c = cands[0]
  if (c === undefined) throw new Error('unreachable')
  return c
}

describe('tokenizeLine — classification', () => {
  it('classifies an absolute path', () => {
    const line = 'error in /a/b/c.ts here'
    const c = only(tokenizeLine(line))
    expect(c.path).toBe('/a/b/c.ts')
    expect(c.kind).toBe('absolute')
    expect(line.slice(c.start, c.end)).toBe('/a/b/c.ts')
  })

  it('classifies a home-relative path', () => {
    const line = 'see ~/a/b for details'
    const c = only(tokenizeLine(line))
    expect(c.path).toBe('~/a/b')
    expect(c.kind).toBe('home')
    expect(line.slice(c.start, c.end)).toBe('~/a/b')
  })

  it('classifies bare ~ alone as home', () => {
    const line = 'cd ~ now'
    const c = only(tokenizeLine(line))
    expect(c.path).toBe('~')
    expect(c.kind).toBe('home')
  })

  it('classifies explicit relative paths ./x and ../x', () => {
    const [a, b] = tokenizeLine('run ./x then ../x')
    expect(a?.path).toBe('./x')
    expect(a?.kind).toBe('relative')
    expect(b?.path).toBe('../x')
    expect(b?.kind).toBe('relative')
  })

  it('classifies a bare relative path containing a slash but no ./ prefix', () => {
    const c = only(tokenizeLine('open src/foo.ts please'))
    expect(c.path).toBe('src/foo.ts')
    expect(c.kind).toBe('relative')
  })

  it('classifies a bare token matching name.ext', () => {
    const c = only(tokenizeLine('touch a.txt'))
    expect(c.path).toBe('a.txt')
    expect(c.kind).toBe('bare')
  })

  it('classifies known extensionless basenames as bare', () => {
    for (const name of ['Makefile', 'Dockerfile', 'README', 'LICENSE']) {
      const c = only(tokenizeLine(`edit ${name} now`))
      expect(c.path).toBe(name)
      expect(c.kind).toBe('bare')
    }
  })

  it('drops a bare token that is neither name.ext nor a known basename', () => {
    expect(tokenizeLine('hello world')).toHaveLength(0)
  })

  it('drops a tilde-prefixed token that is not exactly ~ or ~/...', () => {
    expect(tokenizeLine('~root is not a path')).toHaveLength(0)
  })
})

describe('tokenizeLine — trailing punctuation and wrapping', () => {
  it('strips trailing prose punctuation repeatedly', () => {
    const c = only(tokenizeLine('see /a/b.ts.,;:!? now'))
    expect(c.path).toBe('/a/b.ts')
  })

  it('strips balanced wrapping parens/brackets/braces', () => {
    expect(only(tokenizeLine('config (/a/b.json) loaded')).path).toBe('/a/b.json')
    expect(only(tokenizeLine('list [/a/b.json] loaded')).path).toBe('/a/b.json')
    expect(only(tokenizeLine('map {/a/b.json} loaded')).path).toBe('/a/b.json')
  })

  it('strips nested balanced wrapping', () => {
    expect(only(tokenizeLine('nested ((/a/b.json)) done')).path).toBe('/a/b.json')
  })

  it('strips a lone trailing unbalanced closing paren', () => {
    // "(see /a/b.ts)" splits on the space into two runs: "(see" and "/a/b.ts)".
    // The second run's ")" has no matching "(" within it.
    const c = only(tokenizeLine('(see /a/b.ts)'))
    expect(c.path).toBe('/a/b.ts')
  })

  it('does not strip a trailing closing paren that is balanced within the run', () => {
    // Unlike the bare-token case, a relative path's classification doesn't
    // restrict which characters are allowed, so the parens survive intact
    // and step 2 must leave them alone (they ARE balanced within the run).
    const c = only(tokenizeLine('run src/helper(a).ts now'))
    expect(c.path).toBe('src/helper(a).ts')
  })

  it('strips surrounding quotes and backticks via quoted-pass / HARD split', () => {
    expect(only(tokenizeLine('run `/a/b.sh` now')).path).toBe('/a/b.sh')
    expect(only(tokenizeLine('run \'/a/b.sh\' now')).path).toBe('/a/b.sh')
    expect(only(tokenizeLine('run "/a/b.sh" now')).path).toBe('/a/b.sh')
  })
})

describe('tokenizeLine — line/col suffixes', () => {
  it('parses a grep-style :line suffix', () => {
    const c = only(tokenizeLine('src/foo.ts:42: something failed'))
    expect(c.path).toBe('src/foo.ts')
    expect(c.line).toBe(42)
    expect(c.col).toBeUndefined()
  })

  it('parses a grep-style :line:col suffix', () => {
    const c = only(tokenizeLine('src/foo.ts:42:7 something failed'))
    expect(c.path).toBe('src/foo.ts')
    expect(c.line).toBe(42)
    expect(c.col).toBe(7)
  })

  it('parses a tsc/MSBuild-style (line,col) suffix', () => {
    const c = only(tokenizeLine('src/foo.ts(10,5): error TS2322'))
    expect(c.path).toBe('src/foo.ts')
    expect(c.line).toBe(10)
    expect(c.col).toBe(5)
  })

  it('the returned start/end span only the path, excluding the suffix', () => {
    const line = 'at src/foo.ts:42:7'
    const c = only(tokenizeLine(line))
    expect(line.slice(c.start, c.end)).toBe('src/foo.ts')
  })
})

describe('tokenizeLine — spaces', () => {
  it('supports a double-quoted spaced absolute path', () => {
    const line = 'open "/Users/j/My Docs/a.txt" now'
    const c = only(tokenizeLine(line))
    expect(c.path).toBe('/Users/j/My Docs/a.txt')
    expect(c.kind).toBe('absolute')
    expect(line.slice(c.start, c.end)).toBe('/Users/j/My Docs/a.txt')
  })

  it('supports a single-quoted spaced path', () => {
    const line = "open '/Users/j/My Docs/a.txt' now"
    const c = only(tokenizeLine(line))
    expect(c.path).toBe('/Users/j/My Docs/a.txt')
  })

  it('supports a backslash-escaped space in an unquoted path', () => {
    const line = 'edit /Users/j/My\\ Docs/a.txt now'
    const c = only(tokenizeLine(line))
    expect(c.path).toBe('/Users/j/My Docs/a.txt')
    expect(c.kind).toBe('absolute')
    // The escaped span is one char longer per escape than the unescaped
    // path text (the backslash still occupies a screen column) — this is
    // documented as a deliberate property of start/end, not a bug.
    const rawSpan = line.slice(c.start, c.end)
    expect(rawSpan).toBe('/Users/j/My\\ Docs/a.txt')
    expect(rawSpan.length).toBe(c.path.length + 1)
  })

  it('does NOT join a bare unquoted spaced path into one candidate', () => {
    // "/Users/j/My" and "Docs/a.txt" are two separate runs; "My" fails
    // classification (no slash, no extension match) and is dropped, while
    // "/Users/j/My" and "Docs/a.txt" both survive as their own candidates.
    const cands = tokenizeLine('open /Users/j/My Docs/a.txt now')
    const paths = cands.map((c) => c.path)
    expect(paths).toContain('/Users/j/My')
    expect(paths).toContain('Docs/a.txt')
    expect(paths).not.toContain('/Users/j/My Docs/a.txt')
  })

  it('does not re-split the interior of a quoted spaced path in Pass 2', () => {
    // If quoted content were not masked out before Pass 2 ran, "Docs/a.txt"
    // would also show up as its own extra candidate from splitting on the
    // interior space of the (unmasked) quoted text.
    const cands = tokenizeLine('open "/Users/j/My Docs/a.txt" now')
    expect(cands).toHaveLength(1)
  })
})

describe('tokenizeLine — rejects', () => {
  it('rejects a bare version number', () => {
    expect(tokenizeLine('upgraded to 1.2.3 today')).toHaveLength(0)
  })

  it('rejects a URL with a scheme', () => {
    expect(tokenizeLine('see https://example.com/a for info')).toHaveLength(0)
  })

  it('rejects http and other schemes case-insensitively', () => {
    expect(tokenizeLine('HTTPS://example.com/a')).toHaveLength(0)
  })

  it('bails after 64 runs on a pathological line', () => {
    const tokens = Array.from({ length: 100 }, (_, i) => `f${i}.txt`)
    const line = tokens.join(' ')
    const cands = tokenizeLine(line)
    expect(cands.length).toBeLessThanOrEqual(64)
    expect(cands.length).toBe(64)
    expect(cands[0]?.path).toBe('f0.txt')
  })

  it('rejects a run longer than 1024 characters', () => {
    const long = 'a'.repeat(1030) + '.txt'
    expect(tokenizeLine(`open ${long} now`)).toHaveLength(0)
  })
})

describe('tokenizeLine — multiple candidates on one line', () => {
  it('extracts several distinct candidates with correct spans', () => {
    const line = 'diff /a/b.ts src/c.ts'
    const cands = tokenizeLine(line)
    expect(cands.map((c) => c.path)).toEqual(['/a/b.ts', 'src/c.ts'])
    for (const c of cands) {
      expect(line.slice(c.start, c.end)).toBe(c.path)
    }
  })
})
