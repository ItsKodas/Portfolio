// The one line the fetcher's Git credential file holds. Split out of index.ts, which runs the whole
// fetcher the moment it is imported and so can never be read by a test, because the exact shape of this
// line is the difference between every private repo being readable and none of them being.

// git-credential-store reads each line of its file as a URL and keeps it only when that URL carries BOTH
// a username and a password. A line whose userinfo is the token on its own parses as a username with no
// password, is dropped without a word (no warning, no non-zero exit), and leaves Git asking the terminal
// for a username it was never going to be given. x-access-token is GitHub's own username for "the
// password is a token", and is accepted for a PAT, a fine-grained PAT and an app installation token
// alike, so one form covers every token this fetcher can be handed.
export function credentialLine(token: string): string {
    return `https://x-access-token:${token}@github.com\n`
}

import { CREDENTIAL_NAME } from '../shared/registry.ts'

// Where git's "store" helper reads the default token from, and where each named one goes beside it. Named
// explicitly with --file everywhere rather than relied on via $HOME, so the location never depends on how
// the container sets that variable.
export const DEFAULT_CREDENTIAL_FILE = '/root/.git-credentials'
export const credentialFile = (name: string) => `${DEFAULT_CREDENTIAL_FILE}.${name}`

const PREFIX = 'GITHUB_TOKEN_'

// Every GITHUB_TOKEN_<NAME> in the environment, as name to token. A malformed suffix or an empty value
// is a problem rather than a skip: the fetcher refuses to boot on one, the same way it already refuses
// to boot without GITHUB_TOKEN at all.
export function readCredentials(env: Record<string, string | undefined>): { tokens: Map<string, string>, problems: string[] } {
    const tokens = new Map<string, string>()
    const problems: string[] = []
    for (const key of Object.keys(env).sort()) {
        if (!key.startsWith(PREFIX) || key === 'GITHUB_TOKEN') continue
        const suffix = key.slice(PREFIX.length)
        const name = suffix.toLowerCase()
        if (suffix !== suffix.toUpperCase() || !CREDENTIAL_NAME.test(name)) {
            problems.push(`${key} is not a credential name: use capitals, digits and underscores`)
            continue
        }
        const token = env[key]
        if (!token) {
            problems.push(`${key} is empty`)
            continue
        }
        tokens.set(name, token)
    }
    return { tokens, problems }
}

// git treats credential.helper as a list and tries its entries in config order, with command-line -c
// entries last. The empty value first is what CLEARS that list, so the global helper set at boot (the
// default token) cannot answer ahead of the one named here. Without it a project on a second account
// would be fetched with the wrong token and told nothing about it.
export function credentialArgs(name: string | null): string[] {
    return name === null ? [] : ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${credentialFile(name)}`]
}
