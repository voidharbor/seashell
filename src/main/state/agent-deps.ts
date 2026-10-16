import os from 'node:os'
import { parsePsOutput } from '../monitor/sweep-parse.js'
import {
  darwinProcInfo,
  linuxProcInfo,
  listOpencodeSessions,
  listPiSessions,
  type AgentLookupDeps,
} from './agents.js'

/**
 * The real deps for the agent lanes on this platform, fed from one `ps`
 * sweep, or undefined where processes cannot be read from here (win32: the
 * panes live inside WSL). The native Windows build runs main inside WSL, so
 * it is Linux here.
 */
export function agentDepsFor(
  platformId: NodeJS.Platform,
  sweep: () => Promise<string>,
  home: string = os.homedir()
):
  | (Omit<AgentLookupDeps, 'parents' | 'childrenOf' | 'commOf'> & {
      processTable: () => Promise<{ parents: ReadonlyMap<number, number>; comm: ReadonlyMap<number, string> } | null>
    })
  | undefined {
  if (platformId === 'win32') return undefined
  return {
    home,
    platform: platformId,
    procInfo: platformId === 'linux' ? linuxProcInfo : darwinProcInfo,
    listPi: (dir, cwd) => listPiSessions(dir, cwd),
    listOpencode: (dir, cwd, exe) => listOpencodeSessions(dir, cwd, exe),
    processTable: async () => {
      const stdout = await sweep()
      if (!stdout) return null
      const { rows } = parsePsOutput(stdout)
      return {
        parents: new Map([...rows.values()].map((r) => [r.pid, r.ppid])),
        comm: new Map([...rows.values()].map((r) => [r.pid, r.comm])),
      }
    },
  }
}
