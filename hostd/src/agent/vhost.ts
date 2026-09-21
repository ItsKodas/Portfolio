// One environment's Apache vhost, rendered from a fixed template. The only values that reach the output
// are ones the caller has already validated: hostnames through normaliseHostname, the port and the id
// from the registry entry, the token from api, and the certificate paths from the agent's own
// configuration. Nothing here escapes anything, because nothing here is allowed to receive a value that
// would need escaping.

import { posix } from 'node:path'
import type { EnvironmentName } from '../shared/registry.ts'

export type VhostInput = {
    id: string
    environment: EnvironmentName
    primary: string
    aliases: string[]
    port: number
    token: string
    certificate: { chain: string, key: string }
    maintenanceDir: string
    maintenanceFlag: string
    acmeWebroot: string
}

export function vhostPath(dir: string, id: string, environment: EnvironmentName): string {
    return posix.join(dir, `${id}-${environment}.conf`)
}

// Every name a block answers for, in the one shape Apache actually reads: the first as ServerName and
// the rest as ServerAlias. ServerName is single-valued, so a second occurrence in the same container
// silently replaces the first and every name but the last matches no vhost at all, falling through to
// whichever *:443 block Apache loaded first, which on this machine is another client's site.
// apache2ctl configtest has nothing to say about it, so the only guard is rendering it correctly here.
const serverNames = (names: string[]): string =>
    names.map((name, index) => `    Server${index === 0 ? 'Name' : 'Alias'} ${name}`).join('\n')

// The holding page's own URL path, rather than /index.html. ErrorDocument with a local path is an
// internal redirect, so the request runs through translate_name a second time, where both the
// maintenance RewriteRule and the general ProxyPass below would claim it: the page that covers for a
// dead upstream would be fetched from that same dead upstream. So it gets a path nothing else serves,
// excluded from both. /index.html could not be excluded that way, because a real site may serve one and
// excluding it would answer that URL from the maintenance directory while the site is perfectly well.
const HOLDING_PAGE = '/.hostd-maintenance'
// The same path as a RewriteCond pattern, where the dot is a regular expression metacharacter.
const HOLDING_PAGE_PATTERN = HOLDING_PAGE.split('.').join('\\.')

// Port 80 exists to do three things and nothing else: answer the ACME challenge (which 4b needs and which
// costs nothing to serve now), answer the verification token, and send everything else to https. The
// challenge and the token are matched before the rewrite, because a 301 would take a challenge with it.
function port80(input: VhostInput): string {
    return `<VirtualHost *:80>
${serverNames([input.primary, ...input.aliases])}

    Alias "/.well-known/acme-challenge" "${input.acmeWebroot}/.well-known/acme-challenge"
    <Directory "${input.acmeWebroot}/.well-known/acme-challenge">
        Require all granted
    </Directory>

    <Location "/.well-known/hostd/${input.token}">
        Header always set X-Hostd-Token "${input.token}"
        Redirect 204
    </Location>

    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\\.well-known/
    RewriteRule ^/?(.*)$ https://${input.primary}/$1 [R=301,L]
</VirtualHost>`
}

// The maintenance rules come before the proxy so that a deploy in progress, or an upstream that is not
// answering, both meet the holding page rather than a proxy error. ErrorDocument 503 is what turns a
// failed proxy into the same page, which is the half of this that covers an unplanned outage.
//
// This block declares only the primary, never the aliases: an alias declared here as well as on its own
// block below would be matched here first (Apache resolves a name-based vhost by the first block whose
// ServerName or ServerAlias matches), leaving the alias's redirect block unreachable and the site
// answering at two URLs.
//
// The maintenance rewrite excludes /.well-known/ for the same reason the :80 block does, and it is not
// cosmetic here: mod_rewrite's per-server rules run at translate_name, while the <Location> token block
// above runs at fixups, so without the exclusion the token probe 503s for as long as a deploy holds the
// flag. Verification would then fail on every hostname of the environment at once, turning each active
// domain broken and putting "Your website address stopped answering" on the client's screen for a
// routine deploy.
//
// The maintenance-flag RewriteCond's quoting is two layers deep and easy to get backwards: the outer
// double quotes group -f and the path into the one CondPattern argument RewriteCond expects (they are
// separated by a space, and a bare third token would be read as an invalid flags list); the inner single
// quotes are ap_expr's own string-literal syntax, not the config tokenizer's.
function port443(input: VhostInput): string {
    return `<VirtualHost *:443>
    ServerName ${input.primary}

    SSLEngine on
    SSLCertificateFile ${input.certificate.chain}
    SSLCertificateKeyFile ${input.certificate.key}

    <Location "/.well-known/hostd/${input.token}">
        Header always set X-Hostd-Token "${input.token}"
        Redirect 204
    </Location>

    DocumentRoot "${input.maintenanceDir}"
    Alias "${HOLDING_PAGE}" "${input.maintenanceDir}/index.html"
    ErrorDocument 503 ${HOLDING_PAGE}
    Header always set Retry-After "120" "expr=%{REQUEST_STATUS} == 503"

    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\\.well-known/
    RewriteCond %{REQUEST_URI} !^${HOLDING_PAGE_PATTERN}
    RewriteCond expr "-f '${input.maintenanceFlag}'"
    RewriteRule ^ - [R=503,L]

    ProxyPreserveHost On
    ProxyPass ${HOLDING_PAGE} !
    ProxyPass /.well-known/hostd/${input.token} !
    ProxyPass / http://127.0.0.1:${input.port}/
    ProxyPassReverse / http://127.0.0.1:${input.port}/
</VirtualHost>`
}

// An alias never serves the site. It exists to send a visitor to the one canonical address, so that a
// site is not reachable at two URLs with two sets of cookies and two entries in a search index.
//
// The token Location comes before the redirect, same as on the other two blocks and for the same reason:
// verify.ts probes https://<alias>/.well-known/hostd/<token> and treats anything but a 2xx as a failure.
// Without this, the redirect would 301 that probe and every alias would sit pending and then fail, which
// reads as a DNS problem rather than as the ordering bug it would actually be.
function aliasRedirect(input: VhostInput): string {
    if (input.aliases.length === 0) return ''
    return `
<VirtualHost *:443>
${serverNames(input.aliases)}

    SSLEngine on
    SSLCertificateFile ${input.certificate.chain}
    SSLCertificateKeyFile ${input.certificate.key}

    <Location "/.well-known/hostd/${input.token}">
        Header always set X-Hostd-Token "${input.token}"
        Redirect 204
    </Location>

    Redirect permanent / https://${input.primary}/
</VirtualHost>`
}

export function renderVhost(input: VhostInput): string {
    return `# Generated by hostd for ${input.id} (${input.environment}). Do not edit: every change hostd makes
# rewrites this file in full. To take a site back by hand, move this file out of the include directory.

${port80(input)}

${port443(input)}${aliasRedirect(input)}
`
}
