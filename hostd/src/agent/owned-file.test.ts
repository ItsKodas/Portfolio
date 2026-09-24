import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { writeOwnedFile, type OwnedFileFs } from './owned-file.ts'

const DIR = '/var/www/acme'
const TARGET = `${DIR}/hostd.ports.yml`
const TEXT = 'services:\n  web:\n    ports: !override ["127.0.0.1:5010:3000"]\n'

type SetupOptions = {
    // Makes chown throw, for the cleanup path.
    chownFails?: boolean
}

// A recorder fs, the same style deploy.test.ts's own DeployFs fake uses: every call is pushed onto
// one list, in order, so a test can assert on what happened and in what sequence rather than only on
// the outcome.
function setup(options: SetupOptions = {}) {
    const calls: string[] = []
    const owner = { uid: 1000, gid: 1000, mode: 0o775 }
    const fs: OwnedFileFs = {
        stat: async path => {
            calls.push(`stat ${path}`)
            return owner
        },
        writeFile: async (path, text, opts) => {
            calls.push(`write ${path} ${opts.flag} ${opts.mode.toString(8)} ${text}`)
        },
        chown: async (path, uid, gid) => {
            calls.push(`chown ${path} ${uid}:${gid}`)
            if (options.chownFails) throw new Error('operation not permitted')
        },
        rename: async (from, to) => {
            calls.push(`rename ${from} ${to}`)
        },
        unlink: async path => {
            calls.push(`unlink ${path}`)
        },
    }
    return { fs, calls, owner }
}

// A temp name is random, so tests match the fixed part and pull the random suffix back out of the
// call list rather than predicting it.
function temporaryOf(calls: string[]): string {
    const write = calls.find(call => call.startsWith(`write ${DIR}/.hostd.ports.yml.`))
    assert.ok(write, calls.join(', '))
    return write.split(' ')[1]!
}

describe('writeOwnedFile', () => {
    it('writes the text to a random-suffixed temp file beside the target, never opening the target itself', async () => {
        const context = setup()
        await writeOwnedFile(TARGET, TEXT, context.fs)
        const temporary = temporaryOf(context.calls)
        assert.match(temporary, /^\/var\/www\/acme\/\.hostd\.ports\.yml\.[0-9a-f]{12}$/)
        assert.ok(context.calls.some(call => call.startsWith(`write ${temporary} wx 644 `)), context.calls.join(', '))
        assert.equal(context.calls.some(call => call.startsWith(`write ${TARGET} `)), false, context.calls.join(', '))
    })

    it('stats the parent directory, not the target, to find who to chown as', async () => {
        const context = setup()
        await writeOwnedFile(TARGET, TEXT, context.fs)
        assert.ok(context.calls.includes(`stat ${DIR}`), context.calls.join(', '))
        assert.equal(context.calls.some(call => call.startsWith(`stat ${TARGET}`)), false)
    })

    it('chowns the temp file, never the target path itself', async () => {
        const context = setup()
        await writeOwnedFile(TARGET, TEXT, context.fs)
        const temporary = temporaryOf(context.calls)
        assert.ok(context.calls.includes(`chown ${temporary} ${context.owner.uid}:${context.owner.gid}`), context.calls.join(', '))
        assert.equal(context.calls.some(call => call.startsWith(`chown ${TARGET} `)), false)
    })

    it('renames the temp file over the target once it is owned', async () => {
        const context = setup()
        await writeOwnedFile(TARGET, TEXT, context.fs)
        const temporary = temporaryOf(context.calls)
        assert.ok(context.calls.includes(`rename ${temporary} ${TARGET}`), context.calls.join(', '))
        const chownAt = context.calls.indexOf(`chown ${temporary} ${context.owner.uid}:${context.owner.gid}`)
        const renameAt = context.calls.indexOf(`rename ${temporary} ${TARGET}`)
        assert.ok(chownAt !== -1 && renameAt !== -1 && chownAt < renameAt)
    })

    it('removes the temp file and rethrows when the chown fails, and never renames it over the target', async () => {
        const context = setup({ chownFails: true })
        await assert.rejects(writeOwnedFile(TARGET, TEXT, context.fs), /operation not permitted/)
        const temporary = temporaryOf(context.calls)
        assert.ok(context.calls.includes(`unlink ${temporary}`), context.calls.join(', '))
        assert.equal(context.calls.some(call => call.startsWith('rename ')), false, context.calls.join(', '))
    })
})
