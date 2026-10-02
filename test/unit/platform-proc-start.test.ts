import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { linux } from '../../src/main/platform/linux.js'
import { win32 } from '../../src/main/platform/win32.js'
import { procStartFromStat } from '../../src/main/state/session-lookup.js'

describe('processStartTokens', () => {
  it.runIf(process.platform === 'linux')('reads the live start token claude records, on Linux', async () => {
    const expected = procStartFromStat(fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
    const tokens = await linux.processStartTokens([process.pid, 999999999])
    expect(expected).toMatch(/^\d+$/)
    expect(tokens.get(process.pid)).toBe(expected)
    expect(tokens.has(999999999)).toBe(false)
  })

  it('reports nothing on Windows rather than guess', async () => {
    expect((await win32.processStartTokens([process.pid])).size).toBe(0)
  })
})
