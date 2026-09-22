import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { credentialArgs, credentialLine, readCredentials, writeCredentials } from './credentials.ts'
import type { Runner } from '../agent/compose.ts'

// Checked against the real helper rather than reasoned about, because the failure mode is silent:
//   printf 'protocol=https\nhost=github.com\n\n' | git credential-store --file=<file> get
// answers nothing at all for `https://<token>@github.com` (username, no password: the line is dropped)
// and answers username=x-access-token, password=<token> for the form below. The dropped line is what
// left every private repo's branch list reading "could not read Username for 'https://github.com':
// terminal prompts disabled", GIT_TERMINAL_PROMPT=0 (set in git.ts) turning a prompt into that error.
// Only the one public repo among the sites kept working, because ls-remote never asked it for anything.
//
// The suite cannot shell out to git to prove this: the Dockerfile runs npm test in the `base` stage, and
// git is installed one stage later, in `fetcher`. So the shape is pinned here instead.
describe('credentialLine', () => {
    it('gives the token as the password under a username, which is the only form the store helper keeps', () => {
        assert.equal(credentialLine('ghp_example'), 'https://x-access-token:ghp_example@github.com\n')
    })

    it('carries both halves the helper requires, rather than a username on its own', () => {
        const url = new URL(credentialLine('ghp_example').trim())
        assert.equal(url.username, 'x-access-token')
        assert.equal(url.password, 'ghp_example')
        assert.equal(url.host, 'github.com')
    })
})

describe('readCredentials', () => {
    it('reads every GITHUB_TOKEN_<NAME> as a named token, lowercasing the name', () => {
        const { tokens, problems } = readCredentials({ GITHUB_TOKEN: 'default', GITHUB_TOKEN_ACME: 'a', GITHUB_TOKEN_NORTHWIND: 'n' })
        assert.deepEqual(problems, [])
        assert.deepEqual([...tokens], [['acme', 'a'], ['northwind', 'n']])
    })

    // The default token is not a named one: it has no suffix, and every project without a credential
    // key already reaches it through the global helper.
    it('leaves GITHUB_TOKEN itself out of the named list', () => {
        const { tokens } = readCredentials({ GITHUB_TOKEN: 'default' })
        assert.equal(tokens.size, 0)
    })

    // Loud, not skipped: a name that is silently ignored surfaces days later as a deploy that cannot
    // read a repository, with nothing anywhere saying why.
    it('reports a suffix that is not a name this registry could ever hold', () => {
        const { problems } = readCredentials({ GITHUB_TOKEN_Acme: 'a' })
        assert.deepEqual(problems, ['GITHUB_TOKEN_Acme is not a credential name: use capitals, digits and underscores'])
    })

    it('reports an empty value rather than writing a credential file with no token in it', () => {
        const { problems } = readCredentials({ GITHUB_TOKEN_ACME: '' })
        assert.deepEqual(problems, ['GITHUB_TOKEN_ACME is empty'])
    })
})

describe('credentialArgs', () => {
    // The empty first value is the whole point. git reads credential.helper as a LIST and tries the
    // entries in config order, with command-line -c entries last, so without the reset the global
    // helper written at boot answers first and the DEFAULT token is used against the other account:
    // silently succeeding on a public repo, silently failing on a private one, with no wrong-token
    // error anywhere to read. Nothing else in this change can regress this quietly.
    it('resets the helper list before naming its own, so the global default cannot answer first', () => {
        assert.deepEqual(credentialArgs('acme'), [
            '-c', 'credential.helper=',
            '-c', 'credential.helper=store --file=/root/.git-credentials.acme',
        ])
    })

    it('adds nothing at all for the default credential, leaving the global helper in charge', () => {
        assert.deepEqual(credentialArgs(null), [])
    })
})

function fakeFs() {
    const written: Array<{ path: string, text: string, mode: number }> = []
    const chmodded: Array<{ path: string, mode: number }> = []
    const fs = {
        writeFile: async (path: string, text: string, mode: number) => { written.push({ path, text, mode }) },
        chmod: async (path: string, mode: number) => { chmodded.push({ path, mode }) },
    }
    return { fs, written, chmodded }
}

function fakeRunner() {
    const runs: string[][] = []
    const run: Runner = async (command, args) => {
        runs.push([command, ...args])
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    return { run, runs }
}

describe('writeCredentials', () => {
    it('writes the default token where the global helper reads it, as it always has', async () => {
        const { fs, written, chmodded } = fakeFs()
        const { run, runs } = fakeRunner()
        await writeCredentials('default', new Map(), run, fs)

        assert.deepEqual(written, [{ path: '/root/.git-credentials', text: credentialLine('default'), mode: 0o600 }])
        assert.deepEqual(runs[0], ['git', 'config', '--global', 'credential.helper', 'store --file=/root/.git-credentials'])
        assert.deepEqual(runs[1], ['git', 'config', '--global', 'url.https://github.com/.insteadOf', 'git@github.com:'])
        // writeFile's mode is only honoured when it is the call that creates the file, so the chmod
        // re-application is what actually keeps the credential file private on every boot, not just the first.
        assert.deepEqual(chmodded, [{ path: '/root/.git-credentials', mode: 0o600 }])
    })

    it('writes one file per named token, beside the default and just as private', async () => {
        const { fs, written, chmodded } = fakeFs()
        const { run } = fakeRunner()
        await writeCredentials('default', new Map([['acme', 'a']]), run, fs)

        assert.deepEqual(written[1], { path: '/root/.git-credentials.acme', text: credentialLine('a'), mode: 0o600 })
        assert.deepEqual(chmodded[1], { path: '/root/.git-credentials.acme', mode: 0o600 })
    })

    // Only the default is ever made global. A named file is reached by the -c pair credentialArgs
    // builds, per invocation, which is what keeps one git run from reaching another account's token.
    it('makes no global config for a named token', async () => {
        const { fs } = fakeFs()
        const { run, runs } = fakeRunner()
        await writeCredentials('default', new Map([['acme', 'a']]), run, fs)

        assert.ok(!runs.some(argv => argv.join(' ').includes('.git-credentials.acme')))
    })

    it('throws when git config fails, so boot stops rather than running without a helper', async () => {
        const { fs } = fakeFs()
        const run: Runner = async () => ({ exitCode: 1, stdout: '', stderr: 'nope', timedOut: false })
        await assert.rejects(() => writeCredentials('default', new Map(), run, fs), /credential.helper failed/)
    })
})
