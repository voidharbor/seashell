/**
 * Reads system-wide memory pressure by parsing `vm_stat` and `sysctl`.
 *
 * Not [pure]: it shells out via `execFile` (argv array, never a shell
 * string — `exec` is never used here, so nothing from process output can be
 * interpreted as a shell command). The parsing functions are exported
 * separately from the process-spawning entry point so the parsing logic
 * itself can still be exercised against fixture text without actually
 * running these commands.
 *
 * macOS compresses memory, so plain "used" is misleading (spec §10.3): the
 * kernel's own `memorystatus_level` can claim "57% free" while free RAM is
 * effectively zero and swap is deep in use, because most of what would be
 * "used" is sitting compressed. This module follows the spec's formula,
 * built from the same fields Activity Monitor uses, which is why it closes
 * exactly against `hw.memsize`:
 *
 *   app  = (internal_page_count - purgeable_count) * pagesize
 *   used = app + wire_count * pagesize + compressor_page_count * pagesize
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SystemMetrics } from '../../shared/ipc.js'

const execFileAsync = promisify(execFile)

/** Fields pulled out of `vm_stat`'s text report, already page-size-scaled where noted. */
export interface VmStatSample {
  pageSizeBytes: number
  wiredPages: number
  purgeablePages: number
  /** `vm_stat`'s "Anonymous pages" line — `vm_statistics64.internal_page_count`. */
  internalPages: number
  /** "Pages occupied by compressor" — actual pages spent holding compressed data. */
  compressorOccupiedPages: number
  /** "Pages stored in compressor" — pre-compression page count; ratio vs occupied is the compressor's effectiveness. */
  compressorStoredPages: number
}

function extractPageSize(text: string): number {
  const m = /page size of (\d+) bytes/.exec(text)
  const raw = m?.[1]
  return raw !== undefined ? Number(raw) : 4096
}

function extractField(text: string, label: string): number {
  const re = new RegExp(`^${label}:\\s+([\\d,]+)\\.?\\s*$`, 'm')
  const m = re.exec(text)
  const raw = m?.[1]
  if (raw === undefined) return 0
  return Number(raw.replace(/,/g, ''))
}

/** Parses `vm_stat`'s stdout. Missing/unrecognized lines default to 0 rather than throwing. */
export function parseVmStat(text: string): VmStatSample {
  return {
    pageSizeBytes: extractPageSize(text),
    wiredPages: extractField(text, 'Pages wired down'),
    purgeablePages: extractField(text, 'Pages purgeable'),
    internalPages: extractField(text, 'Anonymous pages'),
    compressorOccupiedPages: extractField(text, 'Pages occupied by compressor'),
    compressorStoredPages: extractField(text, 'Pages stored in compressor'),
  }
}

/** Fields pulled out of `sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`. */
export interface SysctlSample {
  totalBytes: number
  swapTotalBytes: number
  swapUsedBytes: number
  pressureLevel: SystemMetrics['pressureLevel']
}

function toBytes(numStr: string, unit: string): number {
  const n = Number(numStr)
  const mult = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : 1024
  return Math.round(n * mult)
}

/** Parses combined `sysctl` stdout for the three keys this module needs. */
export function parseSysctl(text: string): SysctlSample {
  const totalMatch = /^hw\.memsize:\s*(\d+)/m.exec(text)
  const totalRaw = totalMatch?.[1]
  const totalBytes = totalRaw !== undefined ? Number(totalRaw) : 0

  const swapMatch = /^vm\.swapusage:.*total\s*=\s*([\d.]+)([KMG])\s+used\s*=\s*([\d.]+)([KMG])/m.exec(text)
  const swapTotalBytes =
    swapMatch?.[1] !== undefined && swapMatch[2] !== undefined ? toBytes(swapMatch[1], swapMatch[2]) : 0
  const swapUsedBytes =
    swapMatch?.[3] !== undefined && swapMatch[4] !== undefined ? toBytes(swapMatch[3], swapMatch[4]) : 0

  const levelMatch = /^kern\.memorystatus_vm_pressure_level:\s*(\d+)/m.exec(text)
  const levelRaw = levelMatch?.[1]
  const level = levelRaw !== undefined ? Number(levelRaw) : 1
  // XNU reports 1 = normal, 2 = warn, 4 = critical. Any other value is treated
  // as normal rather than propagating an unrecognized level as an alarm.
  const pressureLevel: SystemMetrics['pressureLevel'] = level === 4 ? 'critical' : level === 2 ? 'warn' : 'normal'

  return { totalBytes, swapTotalBytes, swapUsedBytes, pressureLevel }
}

/**
 * Combines a `vm_stat` sample and a `sysctl` sample into the shared
 * `SystemMetrics` shape, per the spec's closed-form memory accounting.
 */
export function computeSystemMetrics(vm: VmStatSample, sys: SysctlSample): SystemMetrics {
  const appBytes = (vm.internalPages - vm.purgeablePages) * vm.pageSizeBytes
  const usedBytes = appBytes + vm.wiredPages * vm.pageSizeBytes + vm.compressorOccupiedPages * vm.pageSizeBytes

  return {
    usedBytes: Math.max(0, usedBytes),
    totalBytes: sys.totalBytes,
    compressorBytes: vm.compressorOccupiedPages * vm.pageSizeBytes,
    swapUsedBytes: sys.swapUsedBytes,
    swapTotalBytes: sys.swapTotalBytes,
    pressureLevel: sys.pressureLevel,
  }
}

/**
 * Runs `vm_stat` and `sysctl` and returns the current system memory picture.
 * Both calls use `execFile` with an argv array — never `exec` with an
 * interpolated shell string — since `sysctl`'s key names here are static
 * literals, not user input, but the argv-array discipline is the point:
 * nothing this module ever shells out to should be able to become a command
 * injection vector by construction.
 */
export async function readSystemMemory(): Promise<SystemMetrics> {
  const [vmStatResult, sysctlResult] = await Promise.all([
    execFileAsync('/usr/bin/vm_stat', []),
    execFileAsync('/usr/sbin/sysctl', ['hw.memsize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
  ])

  const vm = parseVmStat(vmStatResult.stdout)
  const sys = parseSysctl(sysctlResult.stdout)
  return computeSystemMetrics(vm, sys)
}
