// What the zone should look like, computed from config plus two things that change at runtime: the public
// IP and whether the DKIM key exists yet. Pure, so the interesting logic is testable without a network.

import type { Config } from './config.ts'

export type DesiredRecord = {
    type: 'A' | 'MX' | 'TXT'
    name: string
    content: string
    ttl: number
    proxied?: boolean
    priority?: number
}

// SPF is derived rather than fixed so that flipping the relay switch cannot leave it stale. It ends in a
// soft fail (~all) deliberately: on an unproven IP a visible DMARC report beats a silent hard rejection.
export function spfContent(config: Config): string {
    const parts = ['v=spf1', `a:${config.mailHostname}`]
    if (config.relay) parts.push(`include:${config.relay.spfInclude}`)
    parts.push('~all')
    return parts.join(' ')
}

export function desiredRecords(config: Config, ip: string, dkimPublicKey: string | null): DesiredRecord[] {
    const records: DesiredRecord[] = [
        // proxied: false is mandatory. Cloudflare's proxy is HTTP only and a proxied host breaks SMTP silently.
        { type: 'A', name: config.mailHostname, content: ip, ttl: 60, proxied: false },
        { type: 'MX', name: config.mailDomain, content: config.mailHostname, ttl: 300, priority: 10 },
        { type: 'TXT', name: config.mailDomain, content: spfContent(config), ttl: 300 },
    ]

    if (dkimPublicKey) {
        records.push({
            type: 'TXT',
            name: `${config.dkimSelector}._domainkey.${config.mailDomain}`,
            content: dkimPublicKey,
            ttl: 300,
        })
    }

    records.push({
        type: 'TXT',
        name: `_dmarc.${config.mailDomain}`,
        content: `v=DMARC1; p=none; rua=mailto:${config.dmarcRua}`,
        ttl: 300,
    })

    return records
}
