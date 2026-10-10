'use server'

// Everything the site page changes. Each action works out who is asking from the session alone and checks
// a client's access itself before hostd is asked, exactly as the log relay does. Nothing the browser
// sent may influence either: it names a project and an action, and that is all it is trusted with.

import { revalidatePath } from 'next/cache'

import { callerActor, record, type AuditEntry } from '@/server/audit/record'
import { getDb } from '@/server/db'
import {
    deleteBackup, listRestores, restoreBackup, SCHEDULE_MODES, setSchedule, SNAPSHOT_ID, startBackup, type RestoreRecord, type Schedule,
} from '@/server/hostd/backups'
import { readHostd, type HostdConfig } from '@/server/hostd/config'
import { rollback, setBranch, startDeploy } from '@/server/hostd/deploys'
import {
    addDomain, adoptSite, previewAdopt, removeDomain, verifyDomain, type AdoptPreview,
} from '@/server/hostd/domains'
import { isEnvironmentName, LIVE, newEnvironmentProblem, writeEnvFile, type EnvironmentName } from '@/server/hostd/env'
import { addressProblem, NEEDS_ADDRESS } from '@/server/hostd/environmentAddress'
import {
    addEnvironment, copyFromLive, copyRuns, deleteEnvironment, restoreEnvironment, type CopyRecord,
} from '@/server/hostd/environments'
import type { Caller } from '@/server/hostd/actor'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { setPort } from '@/server/hostd/ports'
import { hasAccess, lifecycle, listEnvironments, readRootDomain } from '@/server/hostd/projects'
import { removeProject } from '@/server/hostd/remove'
import { callerFromSession } from '@/server/hostd/session'
import { writeSettings, type SiteSettings } from '@/server/hostd/settings'
import { accessOf } from '@/server/sites/access'
import type { Permission } from '@/server/sites/permissions'
import { stateWord } from './domains'

export type SiteActionResult = { ok: true, message: string } | { ok: false, error: string }

// The one read among these. It answers a value rather than a sentence, because the dialog it feeds shows
// the file being replaced beside the one that would replace it, and neither is a message.
export type AdoptPreviewResult = { ok: true, preview: AdoptPreview } | { ok: false, error: string }

// A copy answers the run it started beside the sentence, so the page can watch that run
export type CopyStartResult = { ok: true, message: string, run: string } | { ok: false, error: string }

// What the Settings tab polls while a copy runs
export type CopyRunsResult = { ok: true, runs: CopyRecord[], running: boolean } | { ok: false, error: string }

// A restore answers the run it started, like a copy, and the Backups tab polls the restores while one runs
export type RestoreStartResult = { ok: true, message: string, run: string } | { ok: false, error: string }
export type RestoresResult = { ok: true, restores: RestoreRecord[], running: boolean } | { ok: false, error: string }

const LIFECYCLE = ['start', 'stop', 'restart'] as const
type LifecycleAction = typeof LIFECYCLE[number]

// What each one is actually doing, in the present tense, because the containers are still coming up when
// this sentence appears.
const SAID: Record<LifecycleAction, string> = {
    start: 'Starting. It takes a few seconds for the containers to come up.',
    stop: 'Stopping. The site will show its holding page until it is started again.',
    restart: 'Restarting. The site is unavailable for a few seconds.',
}

// The same, about an environment other than live, which is not "the site" to whoever is reading
const SAID_ENVIRONMENT: Record<LifecycleAction, (name: string) => string> = {
    start: () => 'Starting. It takes a few seconds for the containers to come up.',
    stop: name => `Stopping. ${name} will show its holding page until it is started again.`,
    restart: name => `Restarting. ${name} is unavailable for a few seconds.`,
}

// The activity log's sentence for each, in the past tense, because the log is read after the fact. live's
// reads as it always has; any other environment is named, since it is the site's and not the site.
const DID: Record<LifecycleAction, (id: string, environment: EnvironmentName) => string> = {
    start: (id, environment) => environment === LIVE ? `Started ${id}` : `Started ${environment} of ${id}`,
    stop: (id, environment) => environment === LIVE ? `Stopped ${id}` : `Stopped ${environment} of ${id}`,
    restart: (id, environment) => environment === LIVE ? `Restarted ${id}` : `Restarted ${environment} of ${id}`,
}

const SIGN_IN_AGAIN = 'Your session has expired. Sign in again.'
const NOT_YOURS = 'This is not set up yet.'

type Allowed = { ok: true, caller: Caller, config: HostdConfig, isAdmin: boolean }

// The gate every action goes through. It answers a caller who may not do this exactly as it answers one
// asking about a project that does not exist, so neither can be used to probe for the other. A client needs
// access to the site and, when one is named, the permission the action belongs to.
async function allow(id: string, adminOnly: boolean, permission?: Permission): Promise<Allowed | { ok: false, error: string }> {
    const who = await callerFromSession()
    if (!who) return { ok: false, error: SIGN_IN_AGAIN }

    const isAdmin = who.clientId === null
    if (adminOnly && !isAdmin) return { ok: false, error: NOT_YOURS }

    if (who.clientId && !(await hasAccess(who.clientId, id, accessOf, permission))) return { ok: false, error: NOT_YOURS }

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
async function allowOn(
    id: string, environment: EnvironmentName, adminOnly: boolean, permission?: Permission,
): Promise<Allowed | { ok: false, error: string }> {
    const allowed = await allow(id, adminOnly, permission)
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

// What the activity log is told once hostd has done something. Only after: a refusal changed nothing, and its
// reason is in the console beside everything else hostd said no to.
function done(allowed: Allowed, site: string, entry: Omit<AuditEntry, 'actor' | 'site'>): Promise<void> {
    return record({ ...entry, actor: callerActor(allowed.caller), site })
}

// hostd's message names paths, services and project ids, which is right for the operator and wrong for a
// client. The original is logged either way, so a client's refusal is still diagnosable from this side.
function refused(where: string, isAdmin: boolean, result: { code: string, message: string }): { ok: false, error: string } {
    console.error(`[portal] ${where} failed: ${forAdmin(result.code, result.message)}`)
    return { ok: false, error: isAdmin ? forAdmin(result.code, result.message) : forClient(result.code) }
}

// Any environment, with the same permission: LIFECYCLE is start, stop and restart on the site, and every
// environment is part of the site. live needs no list read, since every site has it; any other name is
// checked against the site's own list first, like every other action about one environment.
export async function lifecycleAction(id: string, action: string, environment: string = LIVE): Promise<SiteActionResult> {
    // Checked against the list rather than cast to it: this string arrived from a browser.
    if (!(LIFECYCLE as readonly string[]).includes(action)) return { ok: false, error: 'That is not something this page can do.' }
    const asked = action as LifecycleAction
    const name = environmentOf(environment)
    if (!name) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = name === LIVE ? await allow(id, false, 'LIFECYCLE') : await allowOn(id, name, false, 'LIFECYCLE')
    if (!allowed.ok) return allowed

    const result = await lifecycle(allowed.config, allowed.caller, id, asked, name)
    if (!result.ok) return refused(`lifecycle ${asked} on ${id}${name === LIVE ? '' : ` ${name}`}`, allowed.isAdmin, result)
    await done(allowed, id, {
        kind: `site.${asked}`,
        summary: DID[asked](id, name),
        ...(name === LIVE ? {} : { target: { type: 'environment', id: name } }),
    })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: name === LIVE ? SAID[asked] : SAID_ENVIRONMENT[asked](name) }
}

// The names an env file sets, for the activity log. A line is NAME=value, optionally behind export; comments
// and blank lines set nothing.
function variableNames(text: string): string[] {
    const names = text.split(/\r?\n/)
        .map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1])
        .filter((name): name is string => !!name)
    return [...new Set(names)]
}

export async function saveEnvAction(id: string, environment: string, path: string, text: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof path !== 'string' || typeof text !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    // The operator, or a client given ENV_FILES on this site. hostd holds the same line: it refuses env to
    // every client except on the sites the portal names in X-Hostd-Env-Sites (hostd/src/api/policy.ts),
    // which are read from the same grants this checks.
    const allowed = await allowOn(id, name, false, 'ENV_FILES')
    if (!allowed.ok) return allowed

    const result = await writeEnvFile(allowed.config, allowed.caller, id, name, path, text)
    if (!result.ok) return refused(`env write ${path} on ${id}`, allowed.isAdmin, result)
    // The variable names and never their values, which are the secrets this file exists to hold
    await done(allowed, id, {
        kind: 'env.file',
        summary: `Saved ${path} on ${name}`,
        target: { type: 'environment', id: name },
        detail: { path, variables: variableNames(text) },
    })

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
    await done(allowed, id, { kind: 'deploy.start', summary: `Deployed ${name}`, target: { type: 'environment', id: name } })

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
    await done(allowed, id, { kind: 'deploy.rollback', summary: `Rolled ${name} back`, target: { type: 'environment', id: name } })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Rolling back. The last version that worked is going up, which takes a minute or two.' }
}

// A server action's arguments arrive off the wire like any other request body, so the SiteSettings type on
// the one below is a claim the compiler checks and nothing else checks. This is the shape check every
// other action here makes of its own arguments, mirroring hostd's parseConfigureArgs (which checks it
// again, and has the last word on what a capability, a repo and a branch may actually be).
// domains is deliberately not among the keys accepted here: the Settings form never sends one, and the
// only thing allowed to set an address is makePrimaryDomainAction below, which builds its own object.
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
    await done(allowed, id, { kind: 'site.settings', summary: `Saved the settings of ${id}`, detail: { settings } })

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
    await done(allowed, id, {
        kind: 'deploy.branch', summary: `${name} now follows ${branch}`, target: { type: 'environment', id: name }, detail: { branch },
    })

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
    await done(allowed, id, {
        kind: 'env.port', summary: `Moved ${name} to port ${port}`, target: { type: 'environment', id: name }, detail: { port },
    })

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
    await done(allowed, id, { kind: 'domain.add', summary: `Added ${wanted} to ${name}`, target: { type: 'domain', id: wanted } })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: `${wanted} is added. hostd checks its DNS before it starts serving it.` }
}

// Promoting one of the environment's aliases to be its main address. The same configure request again,
// and hostd treats an alias given as the new domain as a swap: the old main address becomes an alias, so
// both names keep being served and only the redirect between them turns round. Nothing stops answering,
// which is why this sits behind a plain confirmation rather than the typed one above.
export async function makePrimaryDomainAction(id: string, environment: string, hostname: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof hostname !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const wanted = hostname.trim().toLowerCase()
    const result = await writeSettings(allowed.config, allowed.caller, id, { domains: { [name]: wanted } })
    if (!result.ok) return refused(`make ${wanted} the primary domain on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, {
        kind: 'domain.primary', summary: `Made ${wanted} ${name}'s main address`, target: { type: 'domain', id: wanted },
    })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: `${wanted} is the main address now, and the old one redirects to it.` }
}

// The site's root domain, set from Settings: the base new environments' addresses sit under, and one of
// live's own addresses (hostd refuses any other), so as an alias it redirects to live's main address. A
// name live does not answer to yet is added to live first, through the same request the Domains section's
// add uses: as an alias, or as live's main address if it has none. null takes the root away, which puts
// the base back to live's main address without a leading www.
export async function setRootDomainAction(id: string, hostname: string | null): Promise<SiteActionResult> {
    if (hostname !== null && typeof hostname !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, LIVE, true)
    if (!allowed.ok) return allowed

    const wanted = hostname === null || hostname.trim() === '' ? null : hostname.trim().toLowerCase()
    let added = false
    if (wanted !== null) {
        const listed = await listEnvironments(allowed.config, allowed.caller, id)
        if (!listed.ok) return refused(`environments of ${id} for a root domain`, allowed.isAdmin, listed)
        const live = listed.value.find(one => one.name === LIVE)
        const has = live !== undefined && (live.domain === wanted || (live.aliases ?? []).includes(wanted))
        if (!has) {
            const result = await addDomain(allowed.config, allowed.caller, id, LIVE, wanted)
            if (!result.ok) return refused(`add domain ${wanted} on ${id} for its root domain`, allowed.isAdmin, result)
            await done(allowed, id, { kind: 'domain.add', summary: `Added ${wanted} to ${LIVE}`, target: { type: 'domain', id: wanted } })
            added = true
        }
    }

    const result = await writeSettings(allowed.config, allowed.caller, id, { rootDomain: wanted })
    if (!result.ok) return refused(`root domain ${wanted ?? 'cleared'} on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, {
        kind: 'site.settings',
        summary: wanted === null ? `Cleared the root domain of ${id}` : `Set the root domain of ${id} to ${wanted}`,
        detail: { rootDomain: wanted },
    })

    revalidatePath(`/portal/sites/${id}`)
    if (wanted === null) return { ok: true, message: "Cleared. New environments go under live's main address again." }
    return {
        ok: true,
        message: `New environments now go under ${wanted}.`
            + (added ? ` It was added to live as well, and hostd checks its DNS before it starts serving it.` : ''),
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
    await done(allowed, id, { kind: 'domain.remove', summary: `Removed ${wanted} from ${name}`, target: { type: 'domain', id: wanted } })

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
    await done(allowed, id, {
        kind: 'domain.verify', summary: `Checked ${wanted}: ${stateWord(result.value.state)}`, target: { type: 'domain', id: wanted },
    })

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
    await done(allowed, id, { kind: 'site.adopt', summary: `Adopted ${name}'s configuration`, target: { type: 'environment', id: name } })

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
    await done(allowed, id, { kind: 'site.delete', summary: `Deleted ${id}` })

    // Only once hostd has let it go, so a refusal never takes anyone's access away from a site that is still
    // there. Deleting the row takes every client's access with it. A failure here leaves access to a site
    // hostd no longer knows, which shows as unavailable and can be removed from each client's page.
    try {
        await getDb().site.deleteMany({ where: { projectId: id } })
    } catch (error) {
        console.error(`[portal] unlinking ${id} after deleting it failed: ${String(error)}`)
        return { ok: true, message: "Deleted, but clients still have access to it. Remove it from each client's page." }
    }

    revalidatePath('/portal', 'layout')
    return { ok: true, message: 'Deleted.' }
}

// Environments beside live. All three are the operator's alone: hostd puts them under its provision
// policy verb, ahead of ownership, and this is the same rule applied a step earlier. live is never
// added, deleted or restored, and is refused here before the session is read.

// The address is required, and is exactly one label below horizons.gg or below live's primary domain.
// The form only offers those two bases, but a request is a request: the base is checked here against live's
// domain as hostd has it now, read again, never against one the browser says it saw.
export async function addEnvironmentAction(
    id: string, name: string, branch: string, domain: string, copyLive: boolean = false,
): Promise<SiteActionResult> {
    if (typeof name !== 'string') return { ok: false, error: 'That is not something this page can do.' }
    // The form checks the same rule before it sends, so this sentence is only ever seen by a request the
    // form did not make. hostd has the final word either way: only it knows the names already taken.
    const problem = newEnvironmentProblem(name)
    if (problem) return { ok: false, error: problem }
    if (typeof branch !== 'string' || branch.trim() === '') {
        return { ok: false, error: 'That is not something this page can do.' }
    }
    if (domain === null || domain === undefined || (typeof domain === 'string' && domain.trim() === '')) {
        return { ok: false, error: NEEDS_ADDRESS }
    }
    if (typeof domain !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    // Lowercased for the reason the domain actions do it: a pasted hostname often has capitals in it
    const hostname = domain.trim().toLowerCase()
    // Read for every address, even one ending in horizons.gg: live's own domain can sit under it too
    const listed = await listEnvironments(allowed.config, allowed.caller, id)
    if (!listed.ok) return refused(`environments of ${id} for a new address`, allowed.isAdmin, listed)
    const liveDomain = listed.value.find(one => one.name === LIVE)?.domain ?? null
    const root = await readRootDomain(allowed.config, allowed.caller, id)
    if (!root.ok) return refused(`root domain of ${id} for a new address`, allowed.isAdmin, root)
    const wrong = addressProblem(hostname, liveDomain, root.value)
    if (wrong) return { ok: false, error: wrong }

    // Only a real true asks for a copy: this arrived from a browser like everything else here
    const result = await addEnvironment(allowed.config, allowed.caller, id, {
        name, branch: branch.trim(), domain: hostname, copyFromLive: copyLive === true,
    })
    if (!result.ok) return refused(`add environment ${name} on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, {
        kind: 'env.add',
        summary: `Added ${name}, following ${branch.trim()} at ${hostname}`,
        target: { type: 'environment', id: name },
        detail: { branch: branch.trim(), domain: hostname, copyFromLive: copyLive === true },
    })

    revalidatePath(`/portal/sites/${id}`)
    // The environment exists either way; only its vhost is missing, and its Domains section can add it
    const vhost = result.value.vhost
    const said = vhost && !vhost.ok
        ? `${name} is added, but its address was not set up: ${vhost.message}. Add it again from its Domains section on the Environments tab.`
        : null
    // The copy is beside the add too: a refused one leaves the environment there, and it can be copied into
    // from its Summary once whatever hostd named is sorted.
    const copy = result.value.copy
    if (copy && 'run' in copy) {
        return { ok: true, message: `${said ?? `${name} is added.`} A copy of live's data into it has started.` }
    }
    if (copy && 'refused' in copy) {
        const why = `the copy of live's data did not start: ${copy.refused.replace(/\.+$/, '')}.`
        return { ok: true, message: said ? `${said} Also, ${why}` : `${name} is added, but ${why}` }
    }
    return { ok: true, message: said ?? `${name} is added. Its first deploy starts it.` }
}

export async function deleteEnvironmentAction(id: string, environment: string, confirm: string): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || name === LIVE || typeof confirm !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    // Sent as typed, for the reason deleteSiteAction sends it as typed: hostd's comparison is the confirmation
    const result = await deleteEnvironment(allowed.config, allowed.caller, id, name, confirm)
    if (!result.ok) return refused(`delete environment ${name} on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, { kind: 'env.delete', summary: `Deleted ${name}`, target: { type: 'environment', id: name } })

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
    await done(allowed, id, {
        kind: 'env.restore', summary: `Restored ${name}`, target: { type: 'environment', id: name }, detail: { ...result.value },
    })

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

// Copying live's databases and storage into another environment. The operator's alone: hostd puts it under
// its provision verb, and this is the same rule applied a step earlier. It is real client data going
// somewhere less guarded than live, so live is refused here before the session is read, and the
// environment's name has to be typed back, checked here and not only in the dialog.
export async function copyFromLiveAction(id: string, environment: string, confirm: string): Promise<CopyStartResult> {
    const name = environmentOf(environment)
    if (!name || name === LIVE || typeof confirm !== 'string') return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    if (confirm.trim() !== name) return { ok: false, error: `Type ${name} back exactly to confirm the copy.` }

    const result = await copyFromLive(allowed.config, allowed.caller, id, name)
    if (!result.ok) return refused(`copy from live into ${name} on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, { kind: 'env.copy', summary: `Copied live's data into ${name}`, target: { type: 'environment', id: name } })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, run: result.value.run, message: `Copying live's data into ${name}. It can take a few minutes.` }
}

// Reading only, which the Settings tab polls while a copy runs, so it does not revalidate. Admin only all
// the same: the records name services and folders, and hostd refuses a client them too.
export async function copyRunsAction(id: string, environment: string): Promise<CopyRunsResult> {
    const name = environmentOf(environment)
    if (!name || name === LIVE) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allowOn(id, name, true)
    if (!allowed.ok) return allowed

    const result = await copyRuns(allowed.config, allowed.caller, id, name)
    if (!result.ok) return refused(`copy runs of ${name} on ${id}`, allowed.isAdmin, result)

    return { ok: true, runs: result.value.runs, running: result.value.running }
}

// Backups. Unlike deploys, these are a client's as well as the operator's: hostd's backup and backup-read
// policy verbs let a client with access run, delete, download and schedule backups of the site, so every one
// of these goes through allow(id, false, 'BACKUPS'). The portal asks for its own permission because a copy
// is the site's whole database. hostd still needs the project's backups capability and refuses without it.

// What a client is told when hostd refuses a run as a bad request. The only bad requests a run can be are
// the manual cap and the cooldown, and the page already says which before the button is pressed; this is
// for the race where another tab got there first.
const BACKUP_REFUSED = 'There are already five copies, or one was taken in the last ten minutes. Delete one, or wait, and try again.'

export async function backupNowAction(id: string): Promise<SiteActionResult> {
    const allowed = await allow(id, false, 'BACKUPS')
    if (!allowed.ok) return allowed

    const result = await startBackup(allowed.config, allowed.caller, id)
    if (!result.ok) {
        if (!allowed.isAdmin && result.code === 'bad-request') {
            console.error(`[portal] backup of ${id} failed: ${forAdmin(result.code, result.message)}`)
            return { ok: false, error: BACKUP_REFUSED }
        }
        return refused(`backup of ${id}`, allowed.isAdmin, result)
    }
    await done(allowed, id, { kind: 'backup.start', summary: `Started a backup of ${id}` })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Started. A copy takes a few minutes, and it appears in the list when it is done.' }
}

export async function deleteBackupAction(id: string, snapshot: string): Promise<SiteActionResult> {
    if (typeof snapshot !== 'string' || !SNAPSHOT_ID.test(snapshot)) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allow(id, false, 'BACKUPS')
    if (!allowed.ok) return allowed

    const result = await deleteBackup(allowed.config, allowed.caller, id, snapshot)
    if (!result.ok) return refused(`backup delete ${snapshot} on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, { kind: 'backup.delete', summary: `Deleted backup ${snapshot}`, target: { type: 'backup', id: snapshot } })

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Deleted.' }
}

// Putting a copy back over live. The operator's, and a client's only where they were given RESTORE_BACKUPS on
// this site: Backups alone is not enough, because it replaces everything live has saved since. hostd holds the
// same line, refusing backup-restore to every client except on the sites named in X-Hostd-Restore-Sites. The
// site's name has to be typed back, and is sent to hostd as typed, so hostd's comparison is the
// confirmation, as it is for deleting the site. hostd takes a fresh copy of live before it changes anything.
export async function restoreBackupAction(id: string, snapshot: string, confirm: string): Promise<RestoreStartResult> {
    if (typeof snapshot !== 'string' || !SNAPSHOT_ID.test(snapshot) || typeof confirm !== 'string') {
        return { ok: false, error: 'That is not something this page can do.' }
    }

    const allowed = await allow(id, false, 'RESTORE_BACKUPS')
    if (!allowed.ok) return allowed

    const result = await restoreBackup(allowed.config, allowed.caller, id, snapshot, confirm)
    if (!result.ok) return refused(`restore of backup ${snapshot} on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, {
        kind: 'backup.restore',
        summary: `Started putting backup ${snapshot} back over live`,
        target: { type: 'backup', id: snapshot },
        detail: { run: result.value.run },
    })

    revalidatePath(`/portal/sites/${id}`)
    return {
        ok: true,
        run: result.value.run,
        message: 'Restoring. A fresh copy of the live site is made first, then the site is paused while the copy is put back.',
    }
}

// Reading only, which the Backups tab polls while a restore runs, so it does not revalidate. Held to the same
// grant as starting one. hostd's reason for a failed restore names paths and services on the dedi, so a client
// gets the record without it, the same way a failed backup is told to them.
export async function restoresAction(id: string): Promise<RestoresResult> {
    const allowed = await allow(id, false, 'RESTORE_BACKUPS')
    if (!allowed.ok) return allowed

    const result = await listRestores(allowed.config, allowed.caller, id)
    if (!result.ok) return refused(`restores of ${id}`, allowed.isAdmin, result)

    const restores = allowed.isAdmin ? result.value.restores : result.value.restores.map(one => ({ ...one, reason: null }))
    return { ok: true, restores, running: result.value.running }
}

export type ScheduleSaveResult = { ok: true, message: string, schedule: Schedule } | { ok: false, error: string }

const whole = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

// The same shape hostd's parseSchedule accepts, checked here because this object arrived from a browser.
// hostd checks it again and clamps the keep counts to the operator's ceiling, which only it knows.
function isSchedule(value: unknown): value is Schedule {
    if (!value || typeof value !== 'object') return false
    const { mode, hour, minute, weekday, keep } = value as Record<string, unknown>
    if (typeof mode !== 'string' || !(SCHEDULE_MODES as readonly string[]).includes(mode)) return false
    if (!whole(hour, 0, 23) || !whole(minute, 0, 59) || !whole(weekday, 0, 6)) return false
    if (!keep || typeof keep !== 'object') return false
    const { daily, weekly, monthly } = keep as Record<string, unknown>
    return whole(daily, 0, 3650) && whole(weekly, 0, 520) && whole(monthly, 0, 120)
}

export async function saveScheduleAction(id: string, schedule: unknown): Promise<ScheduleSaveResult> {
    if (!isSchedule(schedule)) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allow(id, false, 'BACKUPS')
    if (!allowed.ok) return allowed

    // Only the fields hostd reads, so nothing else a browser added rides along to it
    const { mode, hour, minute, weekday, keep } = schedule
    const asked: Schedule = { mode, hour, minute, weekday, keep: { daily: keep.daily, weekly: keep.weekly, monthly: keep.monthly } }

    const result = await setSchedule(allowed.config, allowed.caller, id, asked)
    if (!result.ok) return refused(`backup schedule on ${id}`, allowed.isAdmin, result)
    await done(allowed, id, { kind: 'backup.schedule', summary: `Saved the backup schedule (${result.value.mode})`, detail: { schedule: result.value } })

    const saved = result.value
    const clamped = saved.keep.daily !== keep.daily || saved.keep.weekly !== keep.weekly || saved.keep.monthly !== keep.monthly

    revalidatePath(`/portal/sites/${id}`)
    return {
        ok: true,
        schedule: saved,
        message: clamped ? 'Saved, with fewer copies kept than asked for: that is the most this site can keep.' : 'Saved.',
    }
}
