// [pure] Readers for the bake-off results file. No fs here; callers pass text.
export function medianOf(numbers) {
  const s = [...numbers].sort((a, b) => a - b)
  if (s.length === 0) return NaN
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function parseResults(jsonl) {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const row = JSON.parse(l)
      if (typeof row.label !== 'string' || !row.label) throw new Error(`row ${i + 1}: missing label`)
      if (typeof row.wsMB !== 'number') throw new Error(`row ${i + 1}: wsMB is not a number`)
      return row
    })
}
