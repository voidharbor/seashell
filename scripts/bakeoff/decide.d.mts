// Types for decide.mjs, so the unit tests typecheck.
import type { ResultRow } from '../win/measure-ram-parse.mjs'
export interface Decision { rule: 'R1' | 'R2' | 'R3'; chosen: string; bPlusC: number; bPlus25: number }
export function decide(rows: readonly ResultRow[]): Decision
export function table(rows: readonly ResultRow[]): string
