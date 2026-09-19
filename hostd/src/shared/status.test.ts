import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStatus, writeStatus, isHealthy, HEALTHCHECK_MAX_AGE_MS } from './status.ts'

const now = new Date('2026-09-20T00:00:00.000Z')

describe('buildStatus', () => {
    it('is ok with no warnings', () => {
        assert.deepEqual(buildStatus([], now), { ok: true, checkedAt: '2026-09-20T00:00:00.000Z', warnings: [] })
    })

    it('is not ok with any warning', () => {
        assert.equal(buildStatus(['project x is invalid'], now).ok, false)
    })
})

describe('writeStatus', () => {
    it('writes the status where the healthcheck reads it, leaving no temporary file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hostd-status-'))
        try {
            const path = join(dir, 'status.json')
            await writeStatus(path, buildStatus([], now))
            assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), buildStatus([], now))
            await assert.rejects(readFile(`${path}.tmp`, 'utf8'))
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})

describe('isHealthy', () => {
    const fresh = JSON.stringify(buildStatus([], now))

    it('is healthy when ok and recent', () => {
        assert.equal(isHealthy(fresh, now.getTime() + 1000), true)
    })

    // A process that has hung stops writing. Without an age limit the last ok: true would stand forever.
    it('is unhealthy when the status has gone stale', () => {
        assert.equal(isHealthy(fresh, now.getTime() + HEALTHCHECK_MAX_AGE_MS), false)
    })

    it('is unhealthy when not ok, or when the file is not a status at all', () => {
        assert.equal(isHealthy(JSON.stringify(buildStatus(['x'], now)), now.getTime()), false)
        assert.equal(isHealthy('not json', now.getTime()), false)
        assert.equal(isHealthy('{}', now.getTime()), false)
    })
})
