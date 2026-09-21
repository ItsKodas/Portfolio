'use server'

// Everything the site page changes. Each action works out who is asking from the session alone and checks
// a client's ownership itself before hostd is asked, exactly as the log relay does. Nothing the browser
// sent may influence either: it names a project and an action, and that is all it is trusted with.

import { revalidatePath } from 'next/cache'

import { getDb } from '@/server/db'
import { readHostd, type HostdConfig } from '@/server/hostd/config'
import { writeEnvFile } from '@/server/hostd/env'
import type { Caller } from '@/server/hostd/actor'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { assertOwned, lifecycle } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'

export type SiteActionResult = { ok: true, message: string } | { ok: false, error: string }

const LIFECYCLE = ['start', 'stop', 'restart'] as const
type LifecycleAction = typeof LIFECYCLE[number]

// What each one is actually doing, in the present tense, because the containers are still coming up when
// this sentence appears.
const SAID: Record<LifecycleAction, string> = {
    start: 'Starting. It takes a few seconds for the containers to come up.',
    stop: 'Stopping. The site will show its holding page until it is started again.',
    restart: 'Restarting. The site is unavailable for a few seconds.',
}

const SIGN_IN_AGAIN = 'Your session has expired. Sign in again.'
const NOT_YOURS = 'This is not set up yet.'

type Allowed = { ok: true, caller: Caller, config: HostdConfig, isAdmin: boolean }

// The gate every action goes through. It answers a caller who may not do this exactly as it answers one
// asking about a project that does not exist, so neither can be used to probe for the other.
async function allow(id: string, adminOnly: boolean): Promise<Allowed | { ok: false, error: string }> {
    const who = await callerFromSession()
    if (!who) return { ok: false, error: SIGN_IN_AGAIN }

    const isAdmin = who.clientId === null
    if (adminOnly && !isAdmin) return { ok: false, error: NOT_YOURS }

    if (who.clientId) {
        const db = getDb()
        const owned = await assertOwned(who.clientId, id, projectId =>
            db.site.findUnique({ where: { projectId }, select: { projectId: true, clientId: true } }))
        if (!owned) return { ok: false, error: NOT_YOURS }
    }

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        console.error(`[portal] hostd is not configured: ${problems.join('; ')}`)
        // The operator is told which setting; a client is told nothing about our infrastructure, because
        // it is not theirs to debug.
        return { ok: false, error: isAdmin ? problems.join('; ') : forClient('unavailable') }
    }

    return { ok: true, caller: who.caller, config, isAdmin }
}

// hostd's message names paths, services and project ids, which is right for the operator and wrong for a
// client. The original is logged either way, so a client's refusal is still diagnosable from this side.
function refused(where: string, isAdmin: boolean, result: { code: string, message: string }): SiteActionResult {
    console.error(`[portal] ${where} failed: ${forAdmin(result.code, result.message)}`)
    return { ok: false, error: isAdmin ? forAdmin(result.code, result.message) : forClient(result.code) }
}

export async function lifecycleAction(id: string, action: string): Promise<SiteActionResult> {
    // Checked against the list rather than cast to it: this string arrived from a browser.
    if (!(LIFECYCLE as readonly string[]).includes(action)) return { ok: false, error: 'That is not something this page can do.' }
    const asked = action as LifecycleAction

    const allowed = await allow(id, false)
    if (!allowed.ok) return allowed

    const result = await lifecycle(allowed.config, allowed.caller, id, asked)
    if (!result.ok) return refused(`lifecycle ${asked} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: SAID[asked] }
}

export async function saveEnvAction(id: string, path: string, text: string): Promise<SiteActionResult> {
    if (typeof path !== 'string' || typeof text !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    // Editing env files is the operator's alone. hostd refuses a client outright (hostd/src/api/policy.ts
    // puts that check ahead of ownership), and this is the same rule applied a step earlier.
    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    // live, because hostd exposes no list of a project's environments yet: the registry holds them but
    // nothing answers them over the wire, so there is exactly one environment a page can name today.
    const result = await writeEnvFile(allowed.config, allowed.caller, id, 'live', path, text)
    if (!result.ok) return refused(`env write ${path} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Saved. The containers are restarting, which takes about twenty seconds.' }
}
