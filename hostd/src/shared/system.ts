// The machine's own figures: total and used memory, CPU load, and the filesystem the sites live on.
//
// These are measured and displayed, never judged. Nothing here produces a warning, and nothing here can
// make hostd unhealthy: a dedi sitting at 80% memory is busy, not degraded, and a health check that says
// otherwise teaches the operator to ignore it. A reading that cannot be taken is null with its reason
// beside it, collected rather than thrown, so one unreadable figure never costs the other two.

import { statfs } from 'node:fs/promises'
import { cpus, loadavg, totalmem } from 'node:os'
import { describeError } from './formats.ts'

export type MemoryUsage = { totalBytes: number, usedBytes: number, availableBytes: number }
// load1, load5 and load15 are the kernel's own three averages. cores is what they should be read
// against: a load of 4 is saturation on four cores and half idle on eight.
export type CpuUsage = { cores: number, load1: number, load5: number, load15: number }
// usedBytes and freeBytes do not add up to totalBytes, exactly as df reports it: the difference is the
// blocks the filesystem reserves for root, which are used by nobody and available to nobody.
export type DiskUsage = { path: string, totalBytes: number, usedBytes: number, freeBytes: number }
export type SystemUsage = {
    memory: MemoryUsage | null
    cpu: CpuUsage | null
    disk: DiskUsage | null
    // Why a null reading above is null. Deliberately not called warnings: these never reach status.json.
    problems: string[]
}

export type StatfsResult = { bsize: number, blocks: number, bfree: number, bavail: number }

// Every reading behind one injected adapter, so the tests need no /proc and no real filesystem.
export type SystemSource = {
    totalBytes: () => number
    availableBytes: () => number
    loadAverages: () => number[]
    cores: () => number
    statfs: (path: string) => Promise<StatfsResult>
}

// The filesystem the client sites live on, which on this dedi is the system disk. The agent bind-mounts
// /var/www from the host at the same path, so this is the one place a container can measure the host's
// own disk rather than its own overlay.
export const DEFAULT_SYSTEM_DISK_PATH = '/var/www'

export function systemSource(): SystemSource {
    return {
        totalBytes: totalmem,
        // process.availableMemory(), not os.freemem(): on Linux free excludes the page cache, so a
        // healthy machine reports almost nothing free and a panel built on it reads as 98% used for
        // ever. Available is the kernel's MemAvailable, what a new process could actually get.
        //
        // It is also cgroup-aware, while os.totalmem() is not, so the two only describe the same thing
        // while this container has no memory limit of its own. hostd's compose sets none, deliberately:
        // these figures are the machine's, and a limit here would quietly turn them into the container's.
        availableBytes: () => process.availableMemory(),
        loadAverages: loadavg,
        // cpus().length, not availableParallelism(): the load averages are the host's, so their
        // denominator has to be the host's logical CPUs too.
        cores: () => cpus().length,
        statfs,
    }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function readMemory(source: SystemSource, problems: string[]): MemoryUsage | null {
    try {
        const totalBytes = source.totalBytes()
        const availableBytes = source.availableBytes()
        if (!isCount(totalBytes) || totalBytes === 0 || !isCount(availableBytes)) {
            problems.push('memory could not be read: the kernel reported no total or available memory')
            return null
        }
        // Clamped rather than trusted: available can exceed total by a hair between two reads.
        return { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes) }
    } catch (error) {
        problems.push(`memory could not be read: ${describeError(error)}`)
        return null
    }
}

function readCpu(source: SystemSource, problems: string[]): CpuUsage | null {
    try {
        const [load1, load5, load15] = source.loadAverages()
        const cores = source.cores()
        if (!isCount(load1) || !isCount(load5) || !isCount(load15)) {
            problems.push('CPU load could not be read: the kernel reported no load averages')
            return null
        }
        // Zero cores is what os.cpus() returns when it cannot read them at all. The loads are still
        // true, so they are reported; only their denominator is missing.
        return { cores: isCount(cores) ? cores : 0, load1, load5, load15 }
    } catch (error) {
        problems.push(`CPU load could not be read: ${describeError(error)}`)
        return null
    }
}

async function readDisk(source: SystemSource, path: string, problems: string[]): Promise<DiskUsage | null> {
    try {
        const { bsize, blocks, bfree, bavail } = await source.statfs(path)
        if (!isCount(bsize) || !isCount(blocks) || !isCount(bfree) || !isCount(bavail) || bsize === 0) {
            problems.push(`the disk holding ${path} could not be read: the filesystem reported no block counts`)
            return null
        }
        return {
            path,
            totalBytes: blocks * bsize,
            // bfree counts the root-reserved blocks, bavail does not, so used is measured from bfree and
            // free from bavail. This is what df prints, and the two are not each other's complement.
            usedBytes: Math.max(0, (blocks - bfree) * bsize),
            freeBytes: bavail * bsize,
        }
    } catch (error) {
        problems.push(`the disk holding ${path} could not be read: ${describeError(error)}`)
        return null
    }
}

export async function readSystemUsage(source: SystemSource, path = DEFAULT_SYSTEM_DISK_PATH): Promise<SystemUsage> {
    const problems: string[] = []
    const memory = readMemory(source, problems)
    const cpu = readCpu(source, problems)
    const disk = await readDisk(source, path, problems)
    return { memory, cpu, disk, problems }
}
