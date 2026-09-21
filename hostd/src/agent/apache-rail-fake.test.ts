// ApacheRail and startFakeRail (hostd/src/agent/testing/fake-rail.ts) are the two ends of the same
// handshake, each independently claiming to implement hostd-apache.sh's protocol. Everywhere else in the
// suite, one of them is replaced by an in-memory double; this file is the one place both run for real,
// against a real temporary directory, so a divergence between what the agent expects and what the fake
// (standing in for the real host script) actually does would show up here rather than only on the dedi.
//
// The failure case matters more than the success one: it is what proves the rollback that protects every
// live client site (restoring a disabled vhost when a configtest fails) actually happens, rather than
// only being described in a comment. Before this file existed, nothing imported the fake rail at all.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rename, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApacheRail, type RailFs } from './apache-rail.ts'
import { startFakeRail } from './testing/fake-rail.ts'

const railFs: RailFs = {
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    rename: (from, to) => rename(from, to),
    readFile: path => readFile(path, 'utf8'),
    unlink: path => unlink(path),
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'hostd-apache-rail-'))
    try {
        await run(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

describe('ApacheRail against the fake host rail, over a real filesystem', () => {
    it('round-trips a successful request: the write lands and request.json is gone', async () => {
        await withTempDir(async dir => {
            const fake = startFakeRail(dir)
            try {
                const rail = new ApacheRail(dir, railFs)
                const target = join(dir, 'acme-live.conf')
                const result = await rail.send('reload', { write: { path: target, text: 'ServerName acme.com\n' }, remove: [], disable: [] })

                assert.equal(result.ok, true)
                assert.equal(await readFile(target, 'utf8'), 'ServerName acme.com\n')
                await assert.rejects(readFile(join(dir, 'request.json')), /ENOENT/)
            } finally {
                await fake.stop()
            }
        })
    })

    it('on a failed configtest, restores the disabled file and answers ok:false', async () => {
        await withTempDir(async dir => {
            // A stand-in for /etc/apache2/sites-enabled/acme.conf, hand-written and serving right now.
            const enabled = join(dir, 'sites-enabled')
            const adopted = join(dir, 'hostd-adopted')
            await mkdir(enabled, { recursive: true })
            const oldVhost = join(enabled, 'acme.conf')
            await writeFile(oldVhost, 'ServerName acme.com\n# the site as it already runs\n', 'utf8')

            const fake = startFakeRail(dir, { configtest: () => ({ ok: false, output: 'AH00526: Syntax error on line 4' }), adoptedDir: adopted })
            try {
                const rail = new ApacheRail(dir, railFs)
                const newVhost = join(dir, 'acme-live.conf')
                const result = await rail.send('adopt', {
                    write: { path: newVhost, text: 'this is not valid Apache config' },
                    remove: [],
                    disable: [oldVhost],
                })

                assert.equal(result.ok, false)
                assert.match(result.output, /AH00526/)
                // The whole point: a client's hand-written vhost must not be left moved aside with
                // nothing serving in its place just because the new one hostd tried to write was bad.
                assert.equal(await readFile(oldVhost, 'utf8'), 'ServerName acme.com\n# the site as it already runs\n')
                await assert.rejects(readFile(join(adopted, 'acme.conf.bak')), /ENOENT/)
            } finally {
                await fake.stop()
            }
        })
    })
})
