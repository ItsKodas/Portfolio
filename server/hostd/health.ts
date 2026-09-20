// hostd's own health: the machine's figures, plus the checks it was already reporting. Admin only in
// hostd, which answers a client with a 403 rather than a thinner document, so that refusal arrives here
// as an ordinary failed result like any other.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

// These mirror hostd/src/shared/system.ts. A reading that could not be taken is null with its reason in
// problems, so one unreadable figure never costs the other two: nothing below may be assumed present.
export type MemoryUsage = {
    totalBytes: number
    // total minus available, so the page cache counts as free rather than used
    usedBytes: number
    availableBytes: number
}

// load1, load5 and load15 are the kernel's own three averages, and cores is what they should be read
// against: a load of 4 is saturation on four cores and half idle on eight. cores is 0 when hostd could
// not count them, in which case the loads are still true and only their denominator is missing.
export type CpuUsage = {
    cores: number
    load1: number
    load5: number
    load15: number
}

// usedBytes and freeBytes do not add up to totalBytes, exactly as df reports it: the difference is the
// blocks the filesystem reserves for root, which are used by nobody and available to nobody.
export type DiskUsage = {
    path: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
}

export type SystemUsage = {
    memory: MemoryUsage | null
    cpu: CpuUsage | null
    disk: DiskUsage | null
    // Why a null reading above is null. Deliberately not warnings: a figure hostd could not take is not
    // a machine in trouble, and nothing here makes hostd unhealthy.
    problems: string[]
}

export type Health = {
    warnings: string[]
    // Project id to the reason its registry entry could not be read
    invalid: Record<string, string>
    system: SystemUsage
}

export async function getHealth(
    config: HostdConfig,
    caller: Caller,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Health>> {
    const result = await hostdRequest<Health>(config, caller, '/health', {}, fetchImpl)
    if (!result.ok) return result
    // Rebuilt rather than passed through, so hostd's own envelope flag does not travel inside the value
    // of a result that already carries one of its own.
    const { warnings, invalid, system } = result.value
    return { ok: true, value: { warnings, invalid, system } }
}
