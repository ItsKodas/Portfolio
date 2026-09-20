// The only place an actor header is produced. hostd trusts whatever the portal claims about who is asking,
// so nothing that arrived from a browser may reach these values: a caller is built from a session, or not
// at all. Both builders throw rather than returning a bad header, because a wrong actor is a client acting
// as another client.

import 'server-only'

import { CLIENT_ID_PATTERN } from '../clients/ids'

// What hostd accepts in X-Hostd-User, kept in step with hostd/src/shared/formats.ts
const USER_ID = /^[A-Za-z0-9_@.:+-]{1,128}$/

export type Caller = {
    actor: string
    user: string
}

export function callerForAdmin(email: string): Caller {
    if (!USER_ID.test(email)) throw new Error('hostd: the admin email is not a usable user id')
    return { actor: 'admin', user: email }
}

export function callerForClient(clientId: string): Caller {
    if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('hostd: not one of our client ids')
    return { actor: `client:${clientId}`, user: clientId }
}
