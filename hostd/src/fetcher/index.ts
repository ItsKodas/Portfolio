// The fetcher: boot gate, then a Unix socket server that runs Git on the agent's behalf. It holds the
// GitHub token and reaches GitHub, but has no Docker socket, so nothing it does can touch a container.

import { createServer } from 'node:net'
import { chmod, chown, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSpawnRunner, type Runner } from '../agent/compose.ts'
import { runGit } from './git.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { handleFetchConnection } from './server.ts'

const SOCKET_PATH = process.env.HOSTD_FETCH_SOCKET ?? '/run/hostd-fetch/fetch.sock'
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const WWW = '/var/www'
const POLL_MS = 10_000
const GIT_CONFIG_TIMEOUT_MS = 10_000
// Where the "store" credential helper reads the token from. Named explicitly with --file rather than
// relied on via $HOME, so the location never depends on how the container sets that variable.
const CREDENTIAL_FILE = '/root/.git-credentials'

const log = (message: string) => console.log(`[fetcher] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fail(failures: string[]): never {
    for (const failure of failures) log(`FATAL ${failure}`)
    process.exit(1)
}

// Puts the token where Git itself will find it and never anywhere else: not a command-line argument (so
// it cannot appear in `ps`), not a log line, not the status file. url.insteadOf then means a registry
// entry can go on giving its repo as an ssh-style URL and still be fetched over HTTPS with this token,
// so no SSH key needs to exist in this container either.
async function writeCredentials(token: string, run: Runner): Promise<void> {
    await writeFile(CREDENTIAL_FILE, `https://${token}@github.com\n`, { mode: 0o600 })
    await chmod(CREDENTIAL_FILE, 0o600)

    const helper = await run('git', ['config', '--global', 'credential.helper', `store --file=${CREDENTIAL_FILE}`], GIT_CONFIG_TIMEOUT_MS)
    if (helper.exitCode !== 0) throw new Error(`git config credential.helper failed: ${helper.stderr || helper.stdout}`)

    const insteadOf = await run('git', ['config', '--global', 'url.https://github.com/.insteadOf', 'git@github.com:'], GIT_CONFIG_TIMEOUT_MS)
    if (insteadOf.exitCode !== 0) throw new Error(`git config url.insteadOf failed: ${insteadOf.stderr || insteadOf.stdout}`)
}

// stat() alone only shows the mount exists; a read-only bind mount still stats as a directory, so a
// probe write is the only way to know the fetcher can actually clone into it.
async function checkWritable(dir: string): Promise<boolean> {
    try {
        const info = await stat(dir)
        if (!info.isDirectory()) return false
        const probe = join(dir, `.hostd-write-check-${process.pid}`)
        await writeFile(probe, '')
        try {
            await rm(probe, { force: true })
        } catch {
            // The write above already proved the mount is writable; failing to clean up the probe file is
            // a stray file left behind, not evidence the mount cannot be written to. Reporting FATAL over
            // it would refuse to boot a fetcher whose mount is perfectly fine.
        }
        return true
    } catch {
        return false
    }
}

async function main(): Promise<void> {
    const token = process.env.GITHUB_TOKEN ?? null
    const runner = createSpawnRunner()

    const failures: string[] = []
    if (!token) failures.push('GITHUB_TOKEN is not set')
    if (!(await checkWritable(WWW))) failures.push(`${WWW} is not a writable mounted directory`)
    const version = await runner('git', ['--version'], GIT_CONFIG_TIMEOUT_MS)
    if (version.timedOut || version.exitCode !== 0) failures.push('git --version did not run')
    if (failures.length > 0) fail(failures)

    await writeCredentials(token as string, runner)

    await rm(SOCKET_PATH, { force: true })
    // Restrictive for exactly as long as it takes to create and chmod the socket, and no longer. bind()
    // honours the process umask, so a normal one here would leave a moment where the socket exists wider
    // than the chmod below narrows it to; this is what closes that window, not what protects the
    // credential file above (that one is written with an explicit mode and chmod'd again right after, so
    // whatever umask was in effect when it happened was never load-bearing either way). Owned by root,
    // group root: this socket now lives in a volume shared only with the agent (never with api), so
    // there is no group to widen it for the way agent.sock widens for api's gid.
    process.umask(0o177)
    const server = createServer(socket => {
        handleFetchConnection(socket, request => runGit(request, runner), log)
            .catch(error => log(`connection failed: ${describeError(error)}`))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(SOCKET_PATH, resolve)
    })
    await chown(SOCKET_PATH, 0, 0)
    await chmod(SOCKET_PATH, 0o600)
    // A normal umask for the rest of this process's life, because everything from here on is git,
    // checking a commit out into a tree under /var/www. A restrictive umask left in place would silently
    // strip the executable bit git itself is trying to set on the checkout: tested against the live
    // machine, the same commit's same file, recorded 100755 in the repository's own index, came out
    // -rw------- under 0177 and -rwxr-xr-x under 0022. deploy.ts still normalises ownership and the rest
    // of the mode once a checkout is done (see own/ownTree in agent/own-tree.ts), but it can only carry
    // forward whatever bit git was actually allowed to set here; it has no way to recover one this umask
    // already erased before deploy.ts ever saw the file.
    process.umask(0o022)
    log(`listening on ${SOCKET_PATH}`)

    for (;;) {
        await writeStatus(STATUS_FILE, buildStatus([], new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)
    }
}

main().catch(error => fail([describeError(error)]))
