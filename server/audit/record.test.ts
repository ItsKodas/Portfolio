import { afterEach, describe, expect, it, vi } from 'vitest'

const auditCreate = vi.fn()
const emailCreate = vi.fn()
const findClient = vi.fn()

vi.mock('../db', () => ({
    getDb: () => ({
        auditEvent: { create: (...args: unknown[]) => auditCreate(...args) },
        sentEmail: { create: (...args: unknown[]) => emailCreate(...args) },
        client: { findUnique: (...args: unknown[]) => findClient(...args) },
    }),
}))

const { callerActor, record, recordEmail } = await import('./record')

const email = {
    from: 'Horizons <hello@horizons.gg>', to: 'ann@example.com', replyTo: 'koda@horizons.gg', subject: 'Reset',
    text: 'Go to https://horizons.gg/portal/reset/abcDEF_123', html: '<a href="https://horizons.gg/portal/reset/abcDEF_123">Go</a>',
}

afterEach(() => vi.resetAllMocks())

describe('record', () => {
    it('writes who, what and where', async () => {
        await record({ kind: 'deploy.start', actor: { type: 'ADMIN', id: 'koda@horizons.gg' }, site: 'asot', summary: 'Deployed live' })
        expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
            kind: 'deploy.start', actorType: 'ADMIN', actorId: 'koda@horizons.gg', site: 'asot', summary: 'Deployed live',
        }) })
    })

    it('names a client it was only given the id of', async () => {
        findClient.mockResolvedValue({ name: 'Ann', company: 'Acme' })
        await record({ kind: 'site.restart', actor: { type: 'CLIENT', id: 'cl_ABCD1234' }, summary: 'Restarted asot' })
        expect(auditCreate.mock.calls[0][0].data.actorName).toBe('Ann (Acme)')
    })

    it('never throws, so a log line can never stop what it records', async () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
        auditCreate.mockRejectedValue(new Error('database is down'))
        await expect(record({ kind: 'site.stop', actor: { type: 'VISITOR' }, summary: 'x' })).resolves.toBeUndefined()
        expect(quiet).toHaveBeenCalled()
        quiet.mockRestore()
    })
})

describe('recordEmail', () => {
    it('keeps the email without the token in its link', async () => {
        await recordEmail(email, null)
        const data = emailCreate.mock.calls[0][0].data
        expect(data.text).not.toContain('abcDEF_123')
        expect(data.html).not.toContain('abcDEF_123')
        expect(data.error).toBeNull()
        expect(data.to).toBe('ann@example.com')
    })

    it('keeps the relay\'s reason when it refused', async () => {
        await recordEmail(email, new Error('550 mailbox unavailable'))
        expect(emailCreate.mock.calls[0][0].data.error).toBe('550 mailbox unavailable')
    })

    it('never throws', async () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
        emailCreate.mockRejectedValue(new Error('database is down'))
        await expect(recordEmail(email, null)).resolves.toBeUndefined()
        quiet.mockRestore()
    })
})

describe('callerActor', () => {
    it('reads the operator and a client from a hostd caller', () => {
        expect(callerActor({ actor: 'admin', user: 'koda@horizons.gg' })).toEqual({ type: 'ADMIN', id: 'koda@horizons.gg' })
        expect(callerActor({ actor: 'client:cl_1', user: 'cl_1', sites: [] })).toEqual({ type: 'CLIENT', id: 'cl_1' })
    })
})
