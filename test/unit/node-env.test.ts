import { describe, expect, it } from 'vitest'
import { scrubNodeLib } from '../../src/core/node-env.js'

const LIB = '/root/.cache/seashell-win/core/0.6.0/node/lib'

describe('scrubNodeLib', () => {
  it('drops the bundled node lib folder and its marker', () => {
    const env: NodeJS.ProcessEnv = { SEASHELL_NODE_LIB: LIB, LD_LIBRARY_PATH: LIB, PATH: '/usr/bin' }
    scrubNodeLib(env)
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('keeps any other entry', () => {
    const env: NodeJS.ProcessEnv = { SEASHELL_NODE_LIB: LIB, LD_LIBRARY_PATH: `${LIB}:/opt/x/lib::` }
    scrubNodeLib(env)
    expect(env).toEqual({ LD_LIBRARY_PATH: '/opt/x/lib' })
  })

  it('leaves the env alone without the marker', () => {
    const env: NodeJS.ProcessEnv = { LD_LIBRARY_PATH: LIB }
    scrubNodeLib(env)
    expect(env).toEqual({ LD_LIBRARY_PATH: LIB })
  })
})
