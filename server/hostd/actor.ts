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
    // A client's sites, from the portal's database, sent as X-Hostd-Sites so hostd checks access against
    // the same list the portal does. Absent for the operator, who reaches every site.
    sites?: string[]
}

export function callerForAdmin(email: string): Caller {
    if (!USER_ID.test(email)) throw new Error('hostd: the admin email is not a usable user id')
    return { actor: 'admin', user: email }
}

// The portal acting on its own account rather than for whoever is signed in: sending a site's holding page
// contact after a client edited theirs, which hostd only takes from an admin. hostd's audit log names the
// user as portal, so it is never mistaken for the operator having done it.
export function callerForPortal(): Caller {
    return { actor: 'admin', user: 'portal' }
}

// hostd's project id grammar (hostd/src/shared/formats.ts), which X-Hostd-Sites is refused whole without
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// user is who hostd's audit line names. It is the client themselves, except when the operator is viewing as
// them: then hostd holds the client's line on access and still records the operator as the one asking.
export function callerForClient(clientId: string, sites: string[], user: string = clientId): Caller {
    if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('hostd: not one of our client ids')
    if (!USER_ID.test(user)) throw new Error('hostd: not a usable user id')
    // A site the portal holds under an id hostd would never accept cannot be one hostd serves, so it is left
    // out rather than allowed to make hostd refuse every request this client makes.
    return { actor: `client:${clientId}`, user, sites: sites.filter(site => PROJECT_ID.test(site)) }
}
