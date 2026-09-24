'use server'

// Everything the site page changes. Each action works out who is asking from the session alone and checks
// a client's ownership itself before hostd is asked, exactly as the log relay does. Nothing the browser
// sent may influence either: it names a project and an action, and that is all it is trusted with.

import { revalidatePath } from 'next/cache'

import { getDb } from '@/server/db'
import { readHostd, type HostdConfig } from '@/server/hostd/config'
import { rollback, setBranch, startDeploy } from '@/server/hostd/deploys'
import {
    addDomain, adoptSite, previewAdopt, removeDomain, verifyDomain, type AdoptPreview,
} from '@/server/hostd/domains'
import { isEnvironmentName, LIVE, newEnvironmentProblem, writeEnvFile, type EnvironmentName } from '@/server/hostd/env'
import { addEnvironment, deleteEnvironment, restoreEnvironment } from '@/server/hostd/environments'
import type { Caller } from '@/server/hostd/actor'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { setPort } from '@/server/hostd/ports'
import { assertOwned, lifecycle, listEnvironments } from '@/server/hostd/projects'
import { removeProject } from '@/server/hostd/remove'
import { callerFromSession } from '@/server/hostd/session'
import { writeSettings, type SiteSettings } from '@/server/hostd/settings'
import { stateWord } from './domains'

export type SiteActionResult = { ok: true, message: string } | { ok: false, error: string }

// The one read among these. It answers a value rather than a sentence, because the dialog it feeds shows
// the file being replaced beside the one that would replace it, and neither is a message.
export type AdoptPreviewResult = { ok: true, preview: AdoptPreview } | { ok: false, error: string }

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

// The gate for an action about one environment: allow() first, then the site's own list of environments,
// read from hostd. A site can have any number of them, so a well formed name is not enough; one this site
// does not have is refused here rather than sent on for hostd to refuse.
async function allowOn(id: string, environment: EnvironmentName, adminOnly: boolean): Promise<Allowed | { ok: false, error: string }> {
    const allowed = await allow(id, adminOnly)
    if (!allowed.ok) return allowed

    const listed = await listEnvironments(allowed.config, allowed.caller, id)
    if (!listed.ok) {
        console.error(`[portal] environments of ${id} could not be read: ${forAdmin(listed.code, listed.message)}`)
        return { ok: false, error: allowed.isAdmin ? forAdmin(listed.code, listed.message) : forClient(listed.code) }
    }
    if (!listed.value.some(one => one.name === environment)) {
        return { ok: false, error: `This site has no ${environment} environment.` }
    }

    return allowed
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

export async function saveEnvAction(id: string, environment: string, path: string, text: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof path !== 'string' || typeof text !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    // Editing env files is the operator's alone. hostd refuses a client outright (hostd/src/api/policy.ts
    // puts that check ahead of ownership), and this is the same rule applied a step earlier.
    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const result = await writeEnvFile(allowed.config, allowed.caller, id, name, path, text)
    if (!result.ok) return refused(`env write ${path} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Saved. The containers are restarting, which takes about twenty seconds.' }
}

// Deploying, rolling back and switching branch are the operator's alone: hostd puts 'deploy' among its
// admin-only policy verbs (hostd/src/api/policy.ts) ahead of ownership, and this is the same rule applied
// a step earlier. Reading the history is not admin-only, and has no action here: the panel reads it while
// it renders.
//
// All three answer as soon as the work has started, because a deploy is minutes of building and hostd's
// own call timeout is 150 seconds. Nothing here waits for an outcome, and the message says so.
// Only the shape, checked before the session is read. Whether this site has it is allowOn's question.
function environmentOf(environment: unknown): EnvironmentName | null {
    return isEnvironmentName(environment) ? environment : null
}

export async function deployAction(id: string, environment: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const result = await startDeploy(allowed.config, allowed.caller, id, name)
    if (!result.ok) return refused(`deploy ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Deploying. It builds first and swaps over after, which usually takes a minute or two.' }
}

export async function rollbackAction(id: string, environment: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    // Which commit it goes back to is hostd's to decide, and the route takes none: the page names it
    // beforehand from the same rule, but it is never sent.
    const result = await rollback(allowed.config, allowed.caller, id, name)
    if (!result.ok) return refused(`rollback ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Rolling back. The last version that worked is going up, which takes a minute or two.' }
}

// A server action's arguments arrive off the wire like any other request body, so the SiteSettings type on
// the one below is a claim the compiler checks and nothing else checks. This is the shape check every
// other action here makes of its own arguments, mirroring hostd's parseConfigureArgs (which checks it
// again, and has the last word on what a capability, a repo and a branch may actually be).
// domains is deliberately not among the keys accepted here: the Settings form never sends one, and the
// only thing allowed to set an address is setPrimaryDomainAction below, which builds its own object.
function isSettings(value: unknown): value is SiteSettings {
    if (typeof value !== 'object' || value === null) return false
    const { capabilities, repo, credential, branches, websockets, flexibleSsl, ...rest } = value as Record<string, unknown>
    if (Object.keys(rest).length > 0) return false
    if (capabilities !== undefined && !(Array.isArray(capabilities) && capabilities.every(one => typeof one === 'string'))) return false
    if (repo !== undefined && repo !== null && typeof repo !== 'string') return false
    if (credential !== undefined && credential !== null && typeof credential !== 'string') return false
    for (const flags of [websockets, flexibleSsl]) {
        if (flags === undefined) continue
        if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return false
        if (!Object.values(flags).every(enabled => typeof enabled === 'boolean')) return false
    }
    if (branches === undefined) return true
    if (typeof branches !== 'object' || branches === null || Array.isArray(branches)) return false
    return Object.values(branches).every(branch => branch === null || typeof branch === 'string')
}

// Editing the registry entry is the operator's alone. hostd refuses a client outright (configure is in
// its ADMIN_ONLY list, ahead of ownership), and this is the same rule applied a step earlier.
export async function saveSettingsAction(id: string, settings: SiteSettings): Promise<SiteActionResult> {
    if (!isSettings(settings)) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    const result = await writeSettings(allowed.config, allowed.caller, id, settings)
    if (!result.ok) return refused(`settings on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return {
        ok: true,
        message: 'Saved. Nothing was started or stopped: this only changes what the site is allowed to do.',
    }
}

export async function setBranchAction(id: string, environment: string, branch: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof branch !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const result = await setBranch(allowed.config, allowed.caller, id, name, branch)
    if (!result.ok) return refused(`branch ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    // Switching branch deploys its tip, and it is also what resumes an environment hostd has paused, so
    // both are said here rather than leaving the second one to be discovered.
    return { ok: true, message: `Now following ${branch}. A deploy of it has started.` }
}

// Moving an environment to another port recreates its containers, so it is its own action rather than
// part of the Settings save, which never starts or stops anything. The operator's alone, as every other
// change to the registry entry is.
export async function setPortAction(id: string, environment: string, port: number): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof port !== 'number' || !Number.isInteger(port)) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const result = await setPort(allowed.config, allowed.caller, id, name, port)
    if (!result.ok) return refused(`port ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    // hostd's own output already names the environment and the port, and says whether it restarted
    return { ok: true, message: `${result.value.output}.` }
}

// Domains. Every one of these is the operator's alone: hostd keeps 'domains' among its admin-only policy
// verbs (hostd/src/api/policy.ts) and leaves only 'domains-read' to an owner, so the client-readable half
// of this tab has no action at all and each of these applies that same rule a step earlier. Verifying is
// among them on purpose: re-checking a hostname makes hostd go out and look, and writes down what it
// found, which is not a read whatever it is called.
//
// A hostname arrives from a browser like every other argument here. server/hostd/domains.ts holds the
// copy of hostd's own HOSTNAME grammar and refuses a bad one before the round trip; hostd checks it again.

export async function addDomainAction(id: string, environment: string, hostname: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof hostname !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    // Lowercased here rather than left to hostd, because the grammar it is checked against has no capital
    // letters in it and a pasted hostname often does.
    const wanted = hostname.trim().toLowerCase()
    const result = await addDomain(allowed.config, allowed.caller, id, name, wanted)
    if (!result.ok) return refused(`add domain ${wanted} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: `${wanted} is added. hostd checks its DNS before it starts serving it.` }
}

// The site's own address, which until now could only be given at provision time: every site enrolled by
// hand has none, so this is the first thing the tab needs to be able to do. It goes through configure
// rather than the domains verb, because it edits the registry entry, and hostd is the one that decides
// whether that edit also has to reach Apache.
//
// This one is for an environment with NO address. Moving an existing one is changePrimaryDomainAction
// below, which is the same request behind a confirmation, because the two are nothing like as dangerous
// as each other.
export async function setPrimaryDomainAction(id: string, environment: string, hostname: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof hostname !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    // Lowercased here for the same reason the domain actions below do it: the grammar it is checked
    // against has no capital letters in it and a pasted hostname often does.
    const wanted = hostname.trim().toLowerCase()
    const result = await writeSettings(allowed.config, allowed.caller, id, { domains: { [name]: wanted } })
    if (!result.ok) return refused(`set primary domain ${wanted} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return {
        ok: true,
        message: `${wanted} is this site's address now. Nothing is served from it until this environment is adopted.`,
    }
}

// Moving an address that already exists. The same configure request as above, and deliberately not the
// same action: the old name stops being served, the new one starts from unverified and hostd rewrites
// the Apache configuration behind it, so the operator names the new hostname back before any of it
// happens. That ceremony is the whole reason this is separate.
//
// The confirmation is checked here and not only in the dialog. A server action is a request like any
// other: a disabled button proves nothing about what actually arrived, and this is the one action on
// the tab that takes a live site off its own address.
export async function changePrimaryDomainAction(
    id: string, environment: string, hostname: string, confirm: string,
): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof hostname !== 'string' || typeof confirm !== 'string') {
        return { ok: false, error: 'That is not something this page can do.' }
    }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const wanted = hostname.trim().toLowerCase()
    if (confirm.trim().toLowerCase() !== wanted) {
        return { ok: false, error: 'Type the new address back exactly to confirm the change.' }
    }

    const result = await writeSettings(allowed.config, allowed.caller, id, { domains: { [name]: wanted } })
    if (!result.ok) return refused(`change primary domain to ${wanted} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return {
        ok: true,
        message: `${wanted} is this site's address now. If hostd serves this site, its configuration has been rewritten.`,
    }
}

export async function removeDomainAction(id: string, environment: string, hostname: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof hostname !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const wanted = hostname.trim().toLowerCase()
    const result = await removeDomain(allowed.config, allowed.caller, id, name, wanted)
    if (!result.ok) return refused(`remove domain ${wanted} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: `${wanted} is gone. The configuration reloads in a few seconds.` }
}

export async function verifyDomainAction(id: string, environment: string, hostname: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof hostname !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const wanted = hostname.trim().toLowerCase()
    const result = await verifyDomain(allowed.config, allowed.caller, id, name, wanted)
    if (!result.ok) return refused(`verify domain ${wanted} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    // This one answers the record it just re-checked, so the outcome is said rather than the asking
    return { ok: true, message: `${wanted} is ${stateWord(result.value.state)}.` }
}

// Reading only, and the one thing here that does not revalidate: nothing has changed yet. It is what the
// adopt dialog shows before anything does.
export async function adoptPreviewAction(id: string, environment: string): Promise<AdoptPreviewResult> {
    const name = environmentOf(environment)
    if (!name) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const result = await previewAdopt(allowed.config, allowed.caller, id, name)
    if (!result.ok) {
        console.error(`[portal] adopt preview ${name} on ${id} failed: ${forAdmin(result.code, result.message)}`)
        return { ok: false, error: allowed.isAdmin ? forAdmin(result.code, result.message) : forClient(result.code) }
    }

    return { ok: true, preview: result.value }
}

export async function adoptAction(id: string, environment: string, confirm: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof confirm !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    // Sent as typed. hostd compares it with the project's own name and refuses anything else, and that
    // check is the whole point of it: softening it here would throw away the confirmation.
    const result = await adoptSite(allowed.config, allowed.caller, id, name, confirm)
    if (!result.ok) return refused(`adopt ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return {
        ok: true,
        message: 'Done. hostd owns this site\'s configuration now, and the hand-written one is switched off.',
    }
}

// Deleting the site is the operator's alone: hostd puts removal among its admin-only policy verbs, and this
// is the same rule applied a step earlier. hostd stops the site, unregisters it and takes its vhost off; the
// folder, volumes and databases stay on the server.
export async function deleteSiteAction(id: string, confirm: string): Promise<SiteActionResult> {
    if (typeof confirm !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    // Sent as typed, for the same reason adoptAction sends it as typed: hostd's comparison is the confirmation.
    const result = await removeProject(allowed.config, allowed.caller, id, confirm)
    if (!result.ok) return refused(`delete ${id}`, allowed.isAdmin, result)

    // Only once hostd has let it go, so a refusal never leaves a client's link pointing at nothing. A
    // failure here leaves a link to a site hostd no longer knows, which the client's page shows as unavailable
    // and which can be removed from that page.
    try {
        await getDb().site.deleteMany({ where: { projectId: id } })
    } catch (error) {
        console.error(`[portal] unlinking ${id} after deleting it failed: ${String(error)}`)
        return { ok: true, message: "Deleted, but it is still linked to its client. Remove it from the client's page." }
    }

    revalidatePath('/portal', 'layout')
    return { ok: true, message: 'Deleted.' }
}

// Environments beside live. All three are the operator's alone: hostd puts them under its provision
// policy verb, ahead of ownership, and this is the same rule applied a step earlier. live is never
// added, deleted or restored, and is refused here before the session is read.

export async function addEnvironmentAction(
    id: string, name: string, branch: string, domain: string | null,
): Promise<SiteActionResult> {
    if (typeof name !== 'string') return { ok: false, error: 'That is not something this page can do.' }
    // The form checks the same rule before it sends, so this sentence is only ever seen by a request the
    // form did not make. hostd has the final word either way: only it knows the names already taken.
    const problem = newEnvironmentProblem(name)
    if (problem) return { ok: false, error: problem }
    if (typeof branch !== 'string' || branch.trim() === '' || (domain !== null && typeof domain !== 'string')) {
        return { ok: false, error: 'That is not something this page can do.' }
    }

    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    // Lowercased for the reason the domain actions do it: a pasted hostname often has capitals in it
    const hostname = domain === null || domain.trim() === '' ? null : domain.trim().toLowerCase()
    const result = await addEnvironment(allowed.config, allowed.caller, id, { name, branch: branch.trim(), domain: hostname })
    if (!result.ok) return refused(`add environment ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    // The environment exists either way; only its address is missing, and the Domains tab can add it
    const vhost = result.value.vhost
    if (vhost && !vhost.ok) {
        return {
            ok: true,
            message: `${name} is added, but its address was not set up: ${vhost.message}. Add it again from the Domains tab.`,
        }
    }
    return { ok: true, message: `${name} is added. Its first deploy starts it.` }
}

export async function deleteEnvironmentAction(id: string, environment: string, confirm: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || name === LIVE || typeof confirm !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    // Sent as typed, for the reason deleteSiteAction sends it as typed: hostd's comparison is the confirmation
    const result = await deleteEnvironment(allowed.config, allowed.caller, id, name, confirm)
    if (!result.ok) return refused(`delete environment ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: `${name} is deleted. It is stopped and kept for 30 days, and can be restored from here until then.` }
}

export async function restoreEnvironmentAction(id: string, environment: string, deletedAt: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || name === LIVE || typeof deletedAt !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    // allow rather than allowOn: a deleted environment is exactly one the site no longer has. hostd refuses
    // a restore over a name the site has since been given.
    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    const result = await restoreEnvironment(allowed.config, allowed.caller, id, name, deletedAt)
    if (!result.ok) return refused(`restore environment ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    // What hostd had to change on the way back is said, because each one is something to fix elsewhere:
    // a port another service expects, or a hostname that now points at something else.
    const { port, portChanged, droppedHostnames, warnings } = result.value
    // hostd's two ways of saying it did not start it: the start failed, or the environment could not be
    // read back to start. Either way "starting" would be untrue.
    const notStarted = warnings.some(warning => /\bstarted\b/.test(warning))
    const said = [notStarted ? `${name} is back, but it is not running.` : `${name} is back and starting.`]
    if (portChanged) {
        said.push(port === null
            ? 'Its old port was taken, so it is on another port now.'
            : `Its old port was taken, so it is on port ${port} now.`)
    }
    if (droppedHostnames.length > 0) {
        said.push(`These hostnames were taken while it was deleted, so it came back without them: ${droppedHostnames.join(', ')}.`)
    }
    if (warnings.length > 0) {
        said.push(`hostd reported: ${warnings.map(warning => warning.replace(/\.+$/, '')).join('; ')}.`)
    }
    return { ok: true, message: said.join(' ') }
}
