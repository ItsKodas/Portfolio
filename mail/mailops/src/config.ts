// Turns the environment into a validated, fully derived config. Every other module takes Config and never
// reads process.env itself, so there is exactly one place where a missing variable can be discovered.

export type RelayConfig = {
    host: string
    port: number
    user: string
    password: string
    spfInclude: string
}

export type Config = {
    mailDomain: string
    mailHostname: string
    forwardTo: string
    cfApiToken: string
    cfZoneId: string
    dmarcRua: string
    deliveryTargets: string[]
    dkimSelector: string
    acceptCatchall: boolean
    relay: RelayConfig | null
}

export class ConfigError extends Error {
    constructor(readonly failures: string[]) {
        super(`Invalid configuration:\n  ${failures.join('\n  ')}`)
        this.name = 'ConfigError'
    }
}

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

type Env = Record<string, string | undefined>

// Anything not explicitly affirmative is off. A catch-all is a decision with real consequences, so a
// typo in the value must resolve to the safe answer rather than to the dangerous one.
function boolean(raw: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase())
}

function required(env: Env, key: string, failures: string[]): string {
    const value = env[key]?.trim()
    if (!value) {
        failures.push(`${key} is required`)
        return ''
    }
    return value
}

export function loadConfig(env: Env): Config {
    const failures: string[] = []

    const mailDomain = required(env, 'MAIL_DOMAIN', failures)
    if (mailDomain && !DOMAIN.test(mailDomain)) failures.push('MAIL_DOMAIN is not a valid domain name')

    const forwardTo = required(env, 'FORWARD_TO', failures)
    const cfApiToken = required(env, 'CF_API_TOKEN', failures)
    const cfZoneId = required(env, 'CF_ZONE_ID', failures)
    const dmarcRua = required(env, 'DMARC_RUA', failures)

    const relayHost = env.RELAY_HOST?.trim() ?? ''
    let relay: RelayConfig | null = null
    if (relayHost) {
        const spfInclude = env.RELAY_SPF_INCLUDE?.trim() ?? ''
        // Without this, flipping the relay on would leave SPF authorising only our own address, and every
        // relayed message would soft-fail. Refuse to start rather than half-configure it.
        if (!spfInclude) failures.push('RELAY_SPF_INCLUDE is required when RELAY_HOST is set')

        // Validate port: use default 587 if unset/empty, otherwise must be a valid number in range 1-65535
        let port = 587
        const portStr = env.RELAY_PORT?.trim()
        if (portStr) {
            const parsed = Number(portStr)
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
                failures.push('RELAY_PORT must be a number between 1 and 65535')
            } else {
                port = parsed
            }
        }

        relay = {
            host: relayHost,
            port,
            user: env.RELAY_USER?.trim() ?? '',
            password: env.RELAY_PASSWORD?.trim() ?? '',
            spfInclude,
        }
    }

    if (failures.length > 0) throw new ConfigError(failures)

    return {
        mailDomain,
        mailHostname: `mail.${mailDomain}`,
        forwardTo,
        cfApiToken,
        cfZoneId,
        dmarcRua,
        deliveryTargets: (env.DELIVERY_TARGETS?.trim() || 'forward').split(',').map(t => t.trim()),
        dkimSelector: env.DKIM_SELECTOR?.trim() || 'mail',
        acceptCatchall: boolean(env.ACCEPT_CATCHALL),
        relay,
    }
}
