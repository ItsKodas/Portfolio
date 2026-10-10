'use server'

// The New site form's two calls: what to offer in its selects, and creating the site. Both are the
// operator's alone; hostd refuses provisioning to anyone else too (hostd/src/api/policy.ts), and this is the
// same rule applied a step earlier.

import { revalidatePath } from 'next/cache'

import { repo } from '@/server/clients/wiring'
import { ALL_PERMISSIONS } from '@/server/sites/permissions'
import { readHostd, type HostdConfig } from '@/server/hostd/config'
import type { Caller } from '@/server/hostd/actor'
import { createProject } from '@/server/hostd/create'
import { listCredentials } from '@/server/hostd/credentials'
import { startDeploy } from '@/server/hostd/deploys'
import { forAdmin } from '@/server/hostd/errors'
import { callerFromSession } from '@/server/hostd/session'
import { newSiteSchema } from './schema'

export type NewSiteOptions =
    | { ok: true, clients: Array<{ id: string, name: string }>, credentials: string[] | null, credentialsError: string | null }
    | { ok: false, error: string }

// warnings are what did not happen after hostd created the site: the site exists either way, so these
// are said on its page rather than as a failure to create it.
export type NewSiteResult = { ok: true, id: string, warnings: string[] } | { ok: false, error: string }

const SIGN_IN_AGAIN = 'Your session has expired. Sign in again.'
const NOT_YOURS = 'This is not set up yet.'

async function allowAdmin(): Promise<{ ok: true, caller: Caller, config: HostdConfig } | { ok: false, error: string }> {
    const who = await callerFromSession()
    if (!who) return { ok: false, error: SIGN_IN_AGAIN }
    if (who.clientId !== null) return { ok: false, error: NOT_YOURS }

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) return { ok: false, error: problems.join('; ') }
    return { ok: true, caller: who.caller, config }
}

export async function newSiteOptionsAction(): Promise<NewSiteOptions> {
    const allowed = await allowAdmin()
    if (!allowed.ok) return allowed

    const clients = (await repo().list())
        .map(client => ({ id: client.id, name: client.company ? `${client.name} (${client.company})` : client.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    // A list that did not load leaves the Account field as plain text, as the Settings tab does
    const held = await listCredentials(allowed.config, allowed.caller)
    return {
        ok: true,
        clients,
        credentials: held.ok ? held.value : null,
        credentialsError: held.ok ? null : held.message,
    }
}

export async function createSiteAction(input: unknown): Promise<NewSiteResult> {
    const parsed = newSiteSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'That is not something this form can do.' }
    const site = parsed.data

    const allowed = await allowAdmin()
    if (!allowed.ok) return allowed

    // Before hostd is asked, so a client deleted since the form opened does not leave a site created with
    // nobody to give it to.
    if (site.client !== '' && !(await repo().byId(site.client))) {
        return { ok: false, error: 'That client no longer exists. Reopen the form and pick again.' }
    }

    const result = await createProject(allowed.config, allowed.caller, {
        id: site.id,
        name: site.name,
        repo: site.repo,
        ...(site.credential !== '' ? { credential: site.credential } : {}),
        branch: site.branch,
        domain: site.domain === '' ? null : site.domain,
        certificate: site.domain === '' ? null : site.certificate,
        dir: site.dir,
        compose: site.compose,
        capabilities: site.capabilities,
        websockets: site.websockets,
        flexibleSsl: site.flexibleSsl,
        port: site.port,
    })
    if (!result.ok) {
        console.error(`[portal] creating ${site.id} failed: ${forAdmin(result.code, result.message)}`)
        return { ok: false, error: forAdmin(result.code, result.message) }
    }

    const warnings: string[] = []
    if (result.value.vhost && !result.value.vhost.ok) warnings.push(`The vhost was not written: ${result.value.vhost.message}`)

    // The client picked in the form is given the site the way the Access tab gives it, with everything a
    // client can be given. hostd is not told: access is the portal's record, sent with each request.
    if (site.client !== '') {
        try {
            await repo().grantAccess(site.client, { projectId: site.id, name: site.name }, ALL_PERMISSIONS)
        } catch (error) {
            console.error(`[portal] giving ${site.client} access to ${site.id} failed: ${String(error)}`)
            warnings.push('The site was created but the client was not given access. Give it from the site\'s Access tab.')
        }
    }

    if (site.deploy) {
        if (!site.capabilities.includes('deploy')) {
            warnings.push('Not deployed: the deploy feature is off for this site.')
        } else {
            const deployed = await startDeploy(allowed.config, allowed.caller, site.id, 'live')
            if (!deployed.ok) warnings.push(`Not deployed: ${forAdmin(deployed.code, deployed.message)}`)
        }
    }

    revalidatePath('/portal', 'layout')
    return { ok: true, id: site.id, warnings }
}
