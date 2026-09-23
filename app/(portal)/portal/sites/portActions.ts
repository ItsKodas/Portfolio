'use server'

// The live port check behind the New site form and the Settings tab. The operator's alone, as both forms
// are; hostd refuses anyone else too (hostd/src/api/routes.ts).

import { readHostd } from '@/server/hostd/config'
import { forAdmin } from '@/server/hostd/errors'
import { checkPort } from '@/server/hostd/ports'
import { callerFromSession } from '@/server/hostd/session'

export type PortCheckResult = { ok: true, suggested: number, problem: string | null } | { ok: false, error: string }

const ENVIRONMENTS = ['live', 'test'] as const

export async function checkPortAction(
    port: number | null,
    own: { project: string, environment: string } | null,
): Promise<PortCheckResult> {
    if (port !== null && !Number.isInteger(port)) return { ok: false, error: 'That is not a port.' }
    const environment = own ? ENVIRONMENTS.find(name => name === own.environment) : undefined
    if (own && (!environment || typeof own.project !== 'string')) return { ok: false, error: 'That is not something this form can do.' }

    const who = await callerFromSession()
    if (!who) return { ok: false, error: 'Your session has expired. Sign in again.' }
    if (who.clientId !== null) return { ok: false, error: 'This is not set up yet.' }

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) return { ok: false, error: problems.join('; ') }

    const result = await checkPort(config, who.caller, {
        ...(port !== null ? { port } : {}),
        ...(own && environment ? { own: { project: own.project, environment } } : {}),
    })
    if (!result.ok) return { ok: false, error: forAdmin(result.code, result.message) }
    return { ok: true, suggested: result.value.suggested, problem: result.value.problem }
}
