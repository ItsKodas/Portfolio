// A host unit that runs in a test. It implements the same handshake as hostd/host/hostd-apache.sh:
// watch for request.json, perform the writes, run a configtest (which here is whatever the caller says
// it is), reload nothing, write result.json, delete request.json.
//
// This exists so the agent's half of the protocol is exercised end to end against a real filesystem,
// without Apache or systemd. The real unit is checked by hand once, per the runbook.

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export function startFakeRail(dir, { configtest = () => ({ ok: true, output: 'Syntax OK' }) } = {}) {
    let stopped = false
    const loop = (async () => {
        while (!stopped) {
            let request
            try {
                request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'))
            } catch {
                await new Promise(resolve => setTimeout(resolve, 5))
                continue
            }
            for (const path of request.remove ?? []) await unlink(path).catch(() => undefined)
            for (const path of request.disable ?? []) {
                await mkdir(join(dirname(path), '..', 'hostd-adopted'), { recursive: true })
                await rename(path, join(dirname(path), '..', 'hostd-adopted', `${path.split('/').pop()}.bak`))
            }
            if (request.write) {
                await mkdir(dirname(request.write.path), { recursive: true })
                await writeFile(request.write.path, request.write.text)
            }
            const test = configtest(request)
            await writeFile(join(dir, 'result.json'), JSON.stringify({ seq: request.seq, ok: test.ok, output: test.output }))
            await unlink(join(dir, 'request.json')).catch(() => undefined)
        }
    })()
    return { stop: async () => { stopped = true; await loop } }
}
