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
