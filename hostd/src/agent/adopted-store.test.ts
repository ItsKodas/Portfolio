import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adoptedStore } from './adopted-store.ts'
import type { Owner, PreviousHosts } from '../shared/edge-protocol.ts'

const OWNER: Owner = { project: 'acme', environment: 'live' }
const PREVIOUS: PreviousHosts = {
    proxy: {
        domain_names: ['acme.com', 'www.acme.com'], forward_host: '192.168.0.8', forward_port: 5010, certificate_id: 16,
        ssl_forced: true, http2_support: true, advanced_config: '',
    },
    redirection: null,
    // The hand-made host had Block Exploits off, which the adoption undo must put back
    proxyFixed: { forward_scheme: 'http', block_exploits: false, allow_websocket_upgrade: true, hsts_enabled: false, hsts_subdomains: false, caching_enabled: false },
}

async function scratch() {
    const dir = await mkdtemp(join(tmpdir(), 'hostd-adopted-'))
    return { dir, store: adoptedStore(join(dir, 'adopted')) }
}

describe('adoptedStore', () => {
    it('reads back what it saved, then nothing once cleared', async () => {
        const { store } = await scratch()
        const record = { ids: { proxyHost: 12, redirectionHost: 104 }, previous: PREVIOUS }
        await store.save(OWNER, record)
        assert.deepEqual(await store.read(OWNER), record)
        assert.equal(await store.read({ project: 'acme', environment: 'uat1' }), null)
        await store.clear(OWNER)
        assert.equal(await store.read(OWNER), null)
    })

    it('names the file after the project and environment', async () => {
        const { dir, store } = await scratch()
        await store.save(OWNER, { ids: { proxyHost: 12, redirectionHost: null }, previous: PREVIOUS })
        assert.deepEqual(await readdir(join(dir, 'adopted')), ['acme-live.json'])
    })

    it('reads a corrupt file as nothing saved', async () => {
        const { dir, store } = await scratch()
        await store.save(OWNER, { ids: { proxyHost: 12, redirectionHost: null }, previous: PREVIOUS })
        await writeFile(join(dir, 'adopted', 'acme-live.json'), '{"ids": {"proxyHost": "twelve"}')
        assert.equal(await store.read(OWNER), null)
        await writeFile(join(dir, 'adopted', 'acme-live.json'), JSON.stringify({ ids: { proxyHost: 12, redirectionHost: null }, previous: { proxy: {} } }))
        assert.equal(await store.read(OWNER), null)
    })

    it('clears a record that was never saved without complaint', async () => {
        const { store } = await scratch()
        await store.clear(OWNER)
        assert.equal(await store.read(OWNER), null)
    })
})
