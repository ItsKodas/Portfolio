// A project list that came back with nothing to say about the containers, filled in one project at a time.
//
// hostd answers /projects?status=1 with a status per project, and when it does this never runs. It does
// not always. A hostd older than that flag ignores the parameter and answers the cheap listing, which
// carries no status field at all; a batch status read that failed puts a refusal into every entry instead.
// Either way the portal is left holding a list of sites it can say nothing about, which is what a nav of
// grey dots all reading "unknown" was.
//
// Asking per project is a different question rather than the same one repeated: hostd's status verb reads
// one project's containers from Docker, and its statuses verb lists every container on the machine and
// groups them (hostd/src/agent/agent.ts, listProjectContainers against listAllContainers). So this can be
// answered where the batch was not, and it is the same call the site page already makes for the one
// project it is about.
//
// It costs one request per project, so it is capped and it never runs for a project hostd has already
// answered for. A current hostd answers for all of them and this makes no requests at all.

import type { Project, ProjectStatus, ServiceStatus } from './projects'

export const FALLBACK_CAP = 24

type Read = (id: string) => Promise<{ ok: true, value: ServiceStatus[] } | { ok: false, code?: string, message?: string }>

// A project hostd has already answered for is left alone. So is one hostd itself could not parse: it has
// no containers to ask about, and the read would only come back with the refusal the entry already
// carries.
function unanswered(project: Project): boolean {
    if (!project.valid) return false
    if (project.services) return false
    return !project.status || !project.status.ok
}

export async function fillStatuses(projects: Project[], read: Read): Promise<Project[]> {
    const asking = projects.filter(unanswered).slice(0, FALLBACK_CAP)
    if (!asking.length) return projects

    const answers = new Map<string, ProjectStatus>()
    await Promise.all(asking.map(async project => {
        const result = await read(project.id)
        answers.set(project.id, result.ok
            ? { ok: true, services: result.value }
            // Kept rather than dropped. The dashboard puts this beside the row, and a reason is the one
            // thing a listing that says nothing about a project never gave us.
            : { ok: false, code: result.code ?? 'failed', message: result.message ?? 'hostd did not answer' })
    }))

    return projects.map(project => {
        const answer = answers.get(project.id)
        return answer ? { ...project, status: answer } : project
    })
}
