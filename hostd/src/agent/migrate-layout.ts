// Moving one environment from the flat layout (/var/www/<site> beside .git, .prev, .next) into the
// nested one (/var/www/<site>/{git, live, test, prev/<env>, next/<env>}). The planning is pure, a list
// of steps worked out from the two sets of trees; the executor is the only part that touches disk, and
// only through DeployFs. runDeploy calls it inside the maintenance window, between the down and the up,
// because Docker records a container's bind-mount paths when it creates it: renaming folders under a
// running container would leave it pointing at paths that no longer exist the next time the host
// restarted it.

import { posix } from 'node:path'

import type { EnvironmentEntry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import { migratingOf, repositoryIn, type DeployTrees } from './deploy-compose.ts'
import type { DeployFs } from './deploy.ts'

export type Step =
    | { kind: 'move', from: string, to: string }
    // Made only if missing, then given the ownership and mode `like` has, read at the time.
    | { kind: 'mkdir', dir: string, like: string }

export type LayoutState = 'flat' | 'interrupted' | 'moved' | 'unknown'

// What is on disk for an environment the registry still records as flat. `to` must be a nested set of
// trees (to.site is not null).
export async function inspectLayout(
    environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees, exists: (path: string) => Promise<boolean>,
): Promise<LayoutState> {
    const site = to.site!
    if (environment.name === 'live') {
        if (await exists(migratingOf(site))) return 'interrupted'
        if (await exists(to.dir) && await exists(repositoryIn(to))) return 'moved'
        // A flat tree is one compose can run: its first registered compose file is at its root.
        const compose = environment.composePaths[0]
        if (compose && await exists(compose)) return 'flat'
        return 'unknown'
    }
    const flat = await exists(from.dir)
    const nested = await exists(to.dir)
    if (flat && !nested) return 'flat'
    if (nested && !flat) return 'moved'
    return 'unknown'
}

// The renames inside the window. For live, the build is still in the flat <site>.next, because the
// site's own folder name is only free once live's tree has left it. For any other environment, live
// is already nested, so the build is in <site>/next/<env>, checked out from the shared repository.
export function windowSteps(environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees): Step[] {
    const site = to.site!
    const prevParent = posix.dirname(to.prev)
    if (environment.name === 'live') {
        const migrating = migratingOf(site)
        return [
            { kind: 'move', from: from.dir, to: migrating },
            { kind: 'mkdir', dir: site, like: migrating },
            { kind: 'mkdir', dir: prevParent, like: migrating },
            { kind: 'move', from: migrating, to: to.prev },
            { kind: 'move', from: from.next, to: to.dir },
            { kind: 'move', from: from.repo, to: to.repo },
        ]
    }
    return [
        { kind: 'mkdir', dir: prevParent, like: site },
        { kind: 'move', from: from.dir, to: to.prev },
        { kind: 'move', from: to.next, to: to.dir },
    ]
}

// Live only: the window's steps after the first, for an agent that died between them. Run in 'resume'
// mode, which skips a move whose source is already gone.
export function resumeSteps(from: DeployTrees, to: DeployTrees): Step[] {
    const migrating = migratingOf(to.site!)
    return [
        { kind: 'mkdir', dir: to.site!, like: migrating },
        { kind: 'mkdir', dir: posix.dirname(to.prev), like: migrating },
        { kind: 'move', from: migrating, to: to.prev },
        { kind: 'move', from: from.next, to: to.dir },
        { kind: 'move', from: from.repo, to: to.repo },
    ]
}

const describeStep = (step: Step): string => step.kind === 'move' ? `move ${step.from} to ${step.to}` : `make ${step.dir}`

// In 'window' mode a failure undoes every completed step in reverse and says whether that worked; the
// caller then starts the flat tree again. In 'resume' mode there is nothing to undo to: the flat layout
// is already gone, so a failure is only reported, and the next deploy tries again.
export async function executeSteps(
    steps: Step[], fs: DeployFs, mode: 'window' | 'resume',
): Promise<{ ok: true } | { ok: false, step: string, problem: string, undone: boolean }> {
    const done: Step[] = []
    for (const step of steps) {
        try {
            if (step.kind === 'mkdir') {
                if (await fs.exists(step.dir)) continue
                const like = await fs.owner(step.like)
                await fs.mkdir(step.dir)
                done.push(step)
                await fs.own(step.dir, like)
            } else {
                if (mode === 'resume' && !(await fs.exists(step.from))) continue
                await fs.move(step.from, step.to)
                done.push(step)
            }
        } catch (error) {
            const problem = describeError(error)
            if (mode === 'resume') return { ok: false, step: describeStep(step), problem, undone: false }
            let undone = true
            for (const back of done.reverse()) {
                try {
                    if (back.kind === 'move') await fs.move(back.to, back.from)
                    else await fs.rmdir(back.dir)
                } catch {
                    undone = false
                }
            }
            return { ok: false, step: describeStep(step), problem, undone }
        }
    }
    return { ok: true }
}
