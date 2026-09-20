import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readSystemUsage, systemSource, type StatfsResult, type SystemSource } from './system.ts'

const KIB = 1024
// A filesystem of 100 blocks: 10 free, of which 6 are available to anyone but root.
const statfsResult: StatfsResult = { bsize: KIB, blocks: 100, bfree: 10, bavail: 6 }

function source(overrides: Partial<SystemSource> = {}): SystemSource {
    return {
        totalBytes: () => 8 * KIB,
        availableBytes: () => 3 * KIB,
        loadAverages: () => [1.5, 1.25, 1],
        cores: () => 4,
        statfs: async () => statfsResult,
        ...overrides,
    }
}

describe('readSystemUsage', () => {
    it('reports memory, CPU load and the disk holding the given path', async () => {
        assert.deepEqual(await readSystemUsage(source(), '/var/www'), {
            memory: { totalBytes: 8 * KIB, usedBytes: 5 * KIB, availableBytes: 3 * KIB },
            cpu: { cores: 4, load1: 1.5, load5: 1.25, load15: 1 },
            disk: {
                path: '/var/www',
                totalBytes: 100 * KIB,
                // 90 blocks are in use, and only 6 are available, because the 4 blocks between bfree and
                // bavail are reserved for root. used and free are not each other's complement, and df
                // prints the same pair.
                usedBytes: 90 * KIB,
                freeBytes: 6 * KIB,
            },
            problems: [],
        })
    })

    it('keeps the other figures when one cannot be read', async () => {
        const usage = await readSystemUsage(source({ statfs: async () => { throw new Error('ENOENT') } }), '/gone')
        assert.equal(usage.disk, null)
        assert.deepEqual(usage.problems, ['the disk holding /gone could not be read: ENOENT'])
        assert.deepEqual(usage.memory, { totalBytes: 8 * KIB, usedBytes: 5 * KIB, availableBytes: 3 * KIB })
        assert.deepEqual(usage.cpu, { cores: 4, load1: 1.5, load5: 1.25, load15: 1 })
    })

    it('never throws, whatever the machine says', async () => {
        const broken = source({
            totalBytes: () => { throw new Error('no meminfo') },
            loadAverages: () => [Number.NaN, Number.NaN, Number.NaN],
            statfs: async () => ({ ...statfsResult, bsize: 0 }),
        })
        const usage = await readSystemUsage(broken, '/var/www')
        assert.deepEqual([usage.memory, usage.cpu, usage.disk], [null, null, null])
        assert.equal(usage.problems.length, 3)
    })

    it('reports the load even when the core count is unreadable', async () => {
        const usage = await readSystemUsage(source({ cores: () => 0 }), '/var/www')
        assert.deepEqual(usage.cpu, { cores: 0, load1: 1.5, load5: 1.25, load15: 1 })
        assert.deepEqual(usage.problems, [])
    })

    it('clamps used memory rather than reporting a negative figure', async () => {
        // Two reads a moment apart, so available can be a hair above total.
        const usage = await readSystemUsage(source({ availableBytes: () => 9 * KIB }), '/var/www')
        assert.equal(usage.memory?.usedBytes, 0)
    })
})

describe('systemSource', () => {
    it('reads this machine without throwing, on whatever platform the suite runs', async () => {
        const usage = await readSystemUsage(systemSource(), process.cwd())
        assert.ok(usage.memory && usage.memory.totalBytes > 0)
        assert.ok(usage.memory.usedBytes <= usage.memory.totalBytes)
        assert.ok(usage.disk && usage.disk.totalBytes > 0)
        // Windows has no load averages (os.loadavg reports zeroes there), so only the shape is asserted.
        assert.ok(usage.cpu && usage.cpu.cores > 0)
    })
})
