// What one deploy leaves behind, and the rules over a run of them. Pure: the store beside it (in
// agent/deploy-state.ts) is what puts this on disk. Nothing here ever holds an env value or a repo URL,
// because a client is allowed to read this history for their own site.

import type { EnvironmentName } from './registry.ts'

// A repo with a broken build would otherwise rebuild every two minutes for ever. Three is enough to ride
// out a flaky remote and few enough that a genuinely broken branch stops quickly.
export const PAUSE_AFTER_FAILURES = 3
// Enough for the portal to draw a history without this file growing without bound.
export const MAX_DEPLOY_RECORDS = 20

// One line of a deploy as it happens. `step` is the deploy narrating itself (the deps.log calls
// runDeploy already makes), `output` is a line docker compose printed, and `end` is the last event of a
// deploy: its text is the outcome, the reason when there is one, and the duration, so a watcher knows it
// is over and how it went without polling the history.
//
// startedAt identifies the deploy. One stream carries a sequence of deploys, so this is what tells a
// watcher that the lines arriving now belong to a different one from the lines above them.
export type DeployEvent = {
    at: string
    startedAt: string
    kind: 'step' | 'output' | 'end'
    text: string
}

// How much of one deploy is kept for a watcher who has not attached yet. Most deploys are started by the
// poller with nobody watching, so this is what stops a chatty build costing anything unbounded.
export const MAX_WATCH_BYTES = 256 * 1024

export const DEPLOY_TRIGGERS = ['poll', 'manual', 'rollback', 'branch'] as const
export type DeployTrigger = typeof DEPLOY_TRIGGERS[number]
export type DeployOutcome = 'ok' | 'failed' | 'rolled-back'

export type DeployRecord = {
    commit: string
    subject: string | null
    // 'hostd' for a poll, 'admin' for everything a person asked for: the agent never learns which user
    // that was, and the audit log in api is where that is recorded.
    actor: string
    trigger: DeployTrigger
    startedAt: string
    durationMs: number
    outcome: DeployOutcome
    reason: string | null
    // The tail of whatever command failed, so a broken build is diagnosable from the portal. Never an
    // env file's contents: nothing here reads one.
    output: string | null
}

export type EnvironmentDeploys = { deploys: DeployRecord[], consecutiveFailures: number, paused: boolean }

export function emptyDeploys(): EnvironmentDeploys {
    return { deploys: [], consecutiveFailures: 0, paused: false }
}

export function deployKey(id: string, environment: EnvironmentName): string {
    return `${id}:${environment}`
}

// The name of the maintenance flag file, which the design spells <id>-<env>. Deliberately not the deploy
// key above: that one is only ever a map key, while this becomes a filename Apache is configured to look
// for, and a colon in a path is a needless thing to make a vhost template quote.
export function maintenanceKey(id: string, environment: EnvironmentName): string {
    return `${id}-${environment}`
}

// A rolled-back deploy counts as a failure: the site is serving the commit it started on, and a branch
// that keeps doing this must stop being polled just as surely as one that fails to build.
export function recordDeploy(state: EnvironmentDeploys, record: DeployRecord): EnvironmentDeploys {
    const consecutiveFailures = record.outcome === 'ok' ? 0 : state.consecutiveFailures + 1
    return {
        deploys: [record, ...state.deploys].slice(0, MAX_DEPLOY_RECORDS),
        consecutiveFailures,
        paused: consecutiveFailures >= PAUSE_AFTER_FAILURES,
    }
}

// The newest commit this environment is known to have served healthily, which is what a rollback goes
// back to. `exclude` is whatever is deployed now, so rolling back from a healthy deploy goes to the one
// before it rather than to itself.
export function lastHealthyCommit(state: EnvironmentDeploys, exclude: string | null): string | null {
    const found = state.deploys.find(record => record.outcome === 'ok' && record.commit !== exclude)
    return found?.commit ?? null
}
