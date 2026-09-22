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

import type { Runner } from '../agent/compose.ts'

const GIT_CONFIG_TIMEOUT_MS = 10_000

// Only the parts of node:fs/promises this needs, so a test can watch what was written without touching
// a disk. The mode is passed to writeFile AND re-applied with chmod, because writeFile's mode is only
// honoured when it is the call that creates the file.
export type CredentialFs = {
    writeFile(path: string, text: string, mode: number): Promise<void>
    chmod(path: string, mode: number): Promise<void>
}

// Puts each token where git itself will find it and never anywhere else: not a command-line argument (so
// it cannot appear in `ps`), not a log line, not the status file. The default token gets the global
// helper, exactly as before. A named token gets a file and nothing else: credentialArgs names it per
// invocation, which is what keeps one git run from reaching another account's token.
//
// url.insteadOf is global and account-independent: it is what lets a registry entry go on giving its
// repo as an ssh-style URL and still be fetched over HTTPS, so no SSH key needs to exist here either.
export async function writeCredentials(
    default_: string, tokens: Map<string, string>, run: Runner, fs: CredentialFs,
): Promise<void> {
    await fs.writeFile(DEFAULT_CREDENTIAL_FILE, credentialLine(default_), 0o600)
    await fs.chmod(DEFAULT_CREDENTIAL_FILE, 0o600)
    for (const [name, token] of tokens) {
        await fs.writeFile(credentialFile(name), credentialLine(token), 0o600)
        await fs.chmod(credentialFile(name), 0o600)
    }

    const helper = await run('git', ['config', '--global', 'credential.helper', `store --file=${DEFAULT_CREDENTIAL_FILE}`], GIT_CONFIG_TIMEOUT_MS)
    if (helper.exitCode !== 0) throw new Error(`git config credential.helper failed: ${helper.stderr || helper.stdout}`)

    const insteadOf = await run('git', ['config', '--global', 'url.https://github.com/.insteadOf', 'git@github.com:'], GIT_CONFIG_TIMEOUT_MS)
    if (insteadOf.exitCode !== 0) throw new Error(`git config url.insteadOf failed: ${insteadOf.stderr || insteadOf.stdout}`)
}
