// The deploy panel's own reasoning, kept out of the component so it can be tested without rendering
// anything, the same way site.ts is. Nothing here asks hostd anything.

import type { DeployHistory, DeployOutcome, DeployRecord } from '@/server/hostd/deploys'

// Which commit a rollback would put back. hostd decides this for itself (lastHealthyCommit, in
// hostd/src/shared/deploys.ts) and the rollback route takes no commit at all, deliberately: there is no
// way to ask for a particular one. The rule is mirrored here only so the button can name the commit
// before it is pressed, because a rollback is done while panicking and has to say what it will do.
export function rollbackTarget(history: DeployHistory): string | null {
    const found = history.deploys.find(record => record.outcome === 'ok' && record.commit !== history.deployed)
    return found?.commit ?? null
}

export function formatDuration(ms: number): string {
    // A deploy that fell over in its first moments reports a duration under a second, and "0s" reads as a
    // figure that was never taken rather than a fast one. Short, because ui/Row's meta column is 58px and
    // this is the one value that has to share it with 1m 14s: "under a second" wrapped onto two lines and
    // took the row's alignment with it, which a browser showed and no test could have.
    if (ms < 1000) return '<1s'
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// 'deployed' rather than 'ok', because the column is read as a sentence about the commit beside it.
// 'rolled back' is amber and not red on purpose: the site never stopped serving, hostd put the previous
// copy back by itself, and the thing to look at is the commit, not the machine.
const WORDS: Record<DeployOutcome, string> = { ok: 'deployed', failed: 'failed', 'rolled-back': 'rolled back' }
const TONES: Record<DeployOutcome, 'good' | 'warn' | 'crit'> = { ok: 'good', failed: 'crit', 'rolled-back': 'warn' }

export function outcomeWord(outcome: DeployOutcome): string {
    return WORDS[outcome]
}

export function outcomeTone(outcome: DeployOutcome): 'good' | 'warn' | 'crit' {
    return TONES[outcome]
}

export function shortCommit(commit: string): string {
    return commit.slice(0, 7)
}

// A client is shown the deploys that reached their site and stayed there, and nothing else. A build that
// failed, and one that landed and was put back before anyone saw it, are not updates: from outside the
// machine neither of them happened, and listing them would be asking the client to worry about our
// problems. The operator's list below has all three.
export function updatesFor(history: DeployHistory): DeployRecord[] {
    return history.deploys.filter(record => record.outcome === 'ok')
}

// What one deploy reads as to someone who wants to know what changed: a headline, the description under
// it, and for a merge, the commits it brought in.
export type UpdateNotes = {
    headline: string | null
    description: string
    changes: Array<{ subject: string, body: string }>
}

// The subject a merge commit is given by the forge rather than by a person. GitHub's says only which
// branch it came from and puts the pull request's title on the next line; GitLab's says the same and
// puts the merge request's title, then its description, under it.
const MERGE_SUBJECT = /^Merge (pull request|branch|remote-tracking branch) /

export function notesFor(record: DeployRecord): UpdateNotes {
    const details = record.details ?? null
    const body = details?.body ?? ''
    if (record.subject && MERGE_SUBJECT.test(record.subject) && body) {
        const [title = '', ...rest] = body.split('\n')
        return { headline: title.trim(), description: rest.join('\n').trim(), changes: details?.changes ?? [] }
    }
    return { headline: record.subject, description: body, changes: details?.changes ?? [] }
}

// Whether a deploy has anything to open: a row that expands into nothing is a promise it cannot keep.
export function hasNotes(notes: UpdateNotes): boolean {
    return notes.description !== '' || notes.changes.length > 0
}
