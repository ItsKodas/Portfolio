import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readdir, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog, monthFile, filesToPrune, type AuditEvent } from './audit.ts'

function event(ts: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
    return { ts, actor: 'client:cl_1', user: 'u1', project: 'acme', verb: 'lifecycle', target: 'start', outcome: 'ok', durationMs: 5, ...overrides }
}

describe('monthFile and filesToPrune', () => {
    it('names files by UTC month', () => {
        assert.equal(monthFile(new Date('2026-09-30T23:59:59Z')), '2026-09.jsonl')
        assert.equal(monthFile(new Date('2026-01-01T00:00:00Z')), '2026-01.jsonl')
    })

    it('keeps the current month and the eleven before it, and ignores other files', () => {
        const names = ['2025-09.jsonl', '2025-10.jsonl', '2026-09.jsonl', 'notes.txt', '2024-01.jsonl']
        assert.deepEqual(filesToPrune(names, new Date('2026-09-20T00:00:00Z')), ['2025-09.jsonl', '2024-01.jsonl'])
    })
})

describe('AuditLog', () => {
    let dir = ''
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hostd-audit-')) })
    afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

    it('appends to the month file of the event and reads newest first', async () => {
        const log = new AuditLog(join(dir, 'audit'))
        await log.append(event('2026-08-31T10:00:00Z', { target: 'stop' }))
        await log.append(event('2026-09-01T10:00:00Z', { target: 'start' }))
        await log.append(event('2026-09-02T10:00:00Z', { target: 'restart' }))
        assert.deepEqual((await readdir(join(dir, 'audit'))).sort(), ['2026-08.jsonl', '2026-09.jsonl'])
        assert.deepEqual((await log.read({ limit: 10 })).map(e => e.target), ['restart', 'start', 'stop'])
    })

    it('filters by project and stops at the limit', async () => {
        const log = new AuditLog(dir)
        await log.append(event('2026-09-01T00:00:00Z', { project: 'acme', target: 'a1' }))
        await log.append(event('2026-09-02T00:00:00Z', { project: 'other', target: 'o1' }))
        await log.append(event('2026-09-03T00:00:00Z', { project: 'acme', target: 'a2' }))
        assert.deepEqual((await log.read({ project: 'acme', limit: 10 })).map(e => e.target), ['a2', 'a1'])
        assert.deepEqual((await log.read({ limit: 1 })).map(e => e.target), ['a2'])
    })

    it('skips a corrupted line rather than failing the read', async () => {
        const log = new AuditLog(dir)
        await log.append(event('2026-09-01T00:00:00Z', { target: 'good' }))
        await appendFile(join(dir, '2026-09.jsonl'), '{"truncated\n')
        assert.deepEqual((await log.read({ limit: 10 })).map(e => e.target), ['good'])
    })

    it('reads nothing from a directory that does not exist yet', async () => {
        assert.deepEqual(await new AuditLog(join(dir, 'missing')).read({ limit: 10 }), [])
    })

    it('prunes months past retention', async () => {
        const log = new AuditLog(dir, () => new Date('2026-09-20T00:00:00Z'))
        await log.append(event('2025-09-15T00:00:00Z'))
        await log.append(event('2026-09-15T00:00:00Z'))
        assert.deepEqual(await log.prune(), ['2025-09.jsonl'])
        assert.deepEqual(await readdir(dir), ['2026-09.jsonl'])
    })

    // The action already happened; refusing to answer would not undo it. The gap is reported instead.
    it('turns a failed write into a warning instead of an error, and clears it after a good write', async () => {
        const blocker = join(dir, 'not-a-directory')
        await writeFile(blocker, 'x')
        const log = new AuditLog(join(blocker, 'audit'))
        await log.append(event('2026-09-01T00:00:00Z'))
        assert.match(log.warnings()[0] ?? '', /^the audit log could not be written: /)

        const healthy = new AuditLog(dir)
        await healthy.append(event('2026-09-01T00:00:00Z'))
        assert.deepEqual(healthy.warnings(), [])
    })
})
