import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { credentialArgs, credentialLine, readCredentials } from './credentials.ts'

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
