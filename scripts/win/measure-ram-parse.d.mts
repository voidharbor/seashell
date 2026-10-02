// Types for measure-ram-parse.mjs, so the unit tests typecheck.
export interface ResultRow {
  label: string
  wsMB: number
  privateMB?: number
  processes?: number
  [key: string]: unknown
}
export function medianOf(numbers: readonly number[]): number
export function parseResults(jsonl: string): ResultRow[]
