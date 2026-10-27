// Serves holding pages to NPM's error_page: when a site's upstream is down or in maintenance, NPM asks
// for /holding/<id>-<environment> and relays the answer to the visitor. Only the agent's own files are
// ever read, and only after the name has been checked against the same rules the registry applies.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { holdingPagePath } from '../shared/holding.ts'
import { PROJECT_ID, isEnvironmentName } from '../shared/formats.ts'

const FALLBACK = '<!doctype html><meta charset="utf-8"><title>Be right back</title><h1>Be right back</h1><p>This site is briefly unavailable. Please try again in a few minutes.</p>\n'

export function holdingHandler(root: string, readFile: (path: string) => Promise<string | null>): (req: IncomingMessage, res: ServerResponse) => void {
    const notFound = (res: ServerResponse) => {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('not found\n')
    }
    return (req, res) => {
        void (async () => {
            // The query string is not part of the name. Anything with a further slash, dot segment or
            // escape fails the name rules below, so no path is ever built from it.
            // Any method: nginx's error_page to a named location keeps the visitor's own, so a form posted to
            // a site that is down arrives as a POST and must get the page, not a 404.
            const match = /^\/holding\/([^/?#]+)(?:\?.*)?$/.exec(req.url ?? '')
            if (!match) return notFound(res)
            // Split on the LAST hyphen: project ids may contain hyphens, environment names never do.
            const name = match[1] as string
            const cut = name.lastIndexOf('-')
            const id = name.slice(0, cut)
            const environment = name.slice(cut + 1)
            if (cut < 0 || !PROJECT_ID.test(id) || !isEnvironmentName(environment)) return notFound(res)

            let body: string | null = null
            try {
                body = await readFile(holdingPagePath(root, id, environment))
            } catch {
                body = null
            }
            // 503 either way: the visitor is being told the site is temporarily away, and Retry-After
            // lets well behaved crawlers come back rather than drop the page.
            res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '120' })
            res.end(req.method === 'HEAD' ? undefined : body ?? FALLBACK)
        })().catch(() => {
            if (!res.headersSent) res.writeHead(500)
            res.end()
        })
    }
}
