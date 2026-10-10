// What is kept of an email once it has gone. Everything, except the token in an invite or reset link: that
// token is a password in all but name, and the tables that hold it store only its hash for that reason. A
// copy here in the clear would undo that, so the link is kept with the token taken out.

const TOKEN_LINK = /(\/portal\/(?:invite|reset)\/)[A-Za-z0-9_~.%-]+/g

export const TOKEN_REMOVED = '[token removed]'

export function withoutTokens(text: string): string {
    return text.replace(TOKEN_LINK, `$1${TOKEN_REMOVED}`)
}
