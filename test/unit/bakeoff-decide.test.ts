import { describe, expect, it } from 'vitest'
import { decide, table } from '../../scripts/bakeoff/decide.mjs'

const row = (label: string, wsMB: number) => ({ label, wsMB, privateMB: wsMB, processes: 1 })
describe('decision rule (spec 3)', () => {
  it('R1 when B + C is under 200', () => {
    expect(decide([row('A-electron', 500), row('B-webview2', 120), row('C-sidecar', 60), row('D-native', 20)]).rule).toBe('R1')
  })
  it('R2 when B + C is 200 or more but B + 25 is under 200', () => {
    expect(decide([row('B-webview2', 160), row('C-sidecar', 60), row('D-native', 20)]).rule).toBe('R2')
  })
  it('R3 otherwise', () => {
    expect(decide([row('B-webview2', 190), row('C-sidecar', 60), row('D-native', 20)]).rule).toBe('R3')
  })
  it('throws when B or C is missing', () => {
    expect(() => decide([row('A-electron', 500)])).toThrow(/B-webview2/)
  })
  it('the table says no rule applied when nothing was measured', () => {
    const t = table([])
    expect(t).toContain('| B-webview2 | not measured | | |')
    expect(t).toContain('Rule applied: none')
  })
})
