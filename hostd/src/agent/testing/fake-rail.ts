// A host unit that runs in a test. It implements the same handshake as hostd/host/hostd-apache.sh:
// watch for request.json, perform the writes, run a configtest (which here is whatever the caller says
// it is), reload nothing, write result.json, delete request.json.
//
// This exists so the agent's half of the protocol is exercised end to end against a real filesystem,
// without Apache or systemd. The real unit is checked by hand once, per the runbook.
//
// It follows the script's failure path as well as its happy one, and that is the point of it. The script
// moves disabled files back when the configtest fails, and deliberately leaves the file it wrote on disk
// for the agent's own revert() to undo, because the agent is what knows what was there before. A double
// that quietly applied everything and never put anything back would let an integration test pass while
// the rollback protecting five live client sites was broken.
//
// A `.ts` file, not `.mjs`, specifically so a `.ts` test can import it directly: the suite glob is
// `src/**/*.test.ts`, and a test importing an untyped `.mjs` fails typecheck, which is what let this go
// unexercised by anything automated for a while.

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'

export type FakeRailRequest = {
    seq: number
    action: string
    write: { path: string, text: string } | null
    remove?: string[]
    disable?: string[]
}

export type FakeRailResult = { ok: boolean, output: string }

export type FakeRailOptions = {
    configtest?: (request: FakeRailRequest) => FakeRailResult
    // Where a disabled file is moved to. Defaults to the script's own default, relative to the file being
    // disabled, but a test over a throwaway directory names one explicitly rather than relying on that
    // file living inside a real sites-enabled/../ layout.
    adoptedDir?: string | null
}

export function startFakeRail(dir: string, options: FakeRailOptions = {}) {
    const configtest = options.configtest ?? (() => ({ ok: true, output: 'Syntax OK' }))
    const adoptedDir = options.adoptedDir ?? null
    let stopped = false
    const loop = (async () => {
        while (!stopped) {
            let request: FakeRailRequest
            try {
                request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as FakeRailRequest
            } catch {
                await new Promise(resolve => setTimeout(resolve, 5))
                continue
            }

            // Everything moved aside in this run, so a failed configtest can be undone completely. A
            // disabled file is moved, never deleted: undoing an adoption has to be possible by hand,
            // months later.
            const moved: { from: string, to: string }[] = []
            for (const path of request.remove ?? []) await unlink(path).catch(() => undefined)
            // Only an adopt disables anything, exactly as the script gates it: a reload request carrying
            // a disable list would otherwise move files aside on a path that never runs a restore.
            if (request.action === 'adopt') {
                for (const path of request.disable ?? []) {
                    const adopted = adoptedDir ?? join(dirname(path), '..', 'hostd-adopted')
                    await mkdir(adopted, { recursive: true })
                    // basename, as the script uses, rather than splitting on '/': the suite runs on
                    // Windows too, where a test's own temp paths are not posix ones.
                    const target = join(adopted, `${basename(path)}.bak`)
                    await rename(path, target)
                    moved.push({ from: path, to: target })
                }
            }
            if (request.write) {
                await mkdir(dirname(request.write.path), { recursive: true })
                await writeFile(request.write.path, request.write.text)
            }

            const test = configtest(request)
            // The configtest failed, so nothing has reloaded. The disabled files go back immediately: a
            // site with no vhost at all is the one outcome worse than the one this was trying to
            // replace. What was written is left where it is, for the agent to revert.
            if (!test.ok) {
                for (const { from, to } of moved) await rename(to, from).catch(() => undefined)
            }

            // Written whole and renamed into place, as the script does: the agent is watching this path,
            // and a half-written file would be read as a result that will not parse.
            const result = join(dir, 'result.json')
            await writeFile(`${result}.tmp`, JSON.stringify({ seq: request.seq, ok: test.ok, output: test.output }))
            await rename(`${result}.tmp`, result)
            await unlink(join(dir, 'request.json')).catch(() => undefined)
        }
    })()
    return { stop: async () => { stopped = true; await loop } }
}
