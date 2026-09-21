import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { credentialLine } from './credentials.ts'

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
