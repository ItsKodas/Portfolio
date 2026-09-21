// The env files, for the operator only. A server component: hostd is asked here, the caller is worked out
// from the session here, and which file is open is part of the URL rather than client state, so the panel
// reloads and can be linked to.
//
// It re-derives the caller and re-checks the operator rather than trusting the page that rendered it.
// hostd puts the same check ahead of ownership (hostd/src/api/policy.ts), and a check that exists in one
// place only is a check one refactor away from not existing.

import { readHostd } from '@/server/hostd/config'
import { listEnvFiles, readEnvFile, type EnvFile } from '@/server/hostd/env'
import { forAdmin } from '@/server/hostd/errors'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { EnvForm } from './envForm'
import styles from './site.module.css'

// hostd exposes no list of a project's environments, so there is exactly one a page can name today. See
// the note on the same constant in page.tsx.
const LIVE = 'live'

function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    return `${(bytes / 1024).toFixed(1)} kB`
}

function Files({ id, files, chosen }: { id: string, files: EnvFile[], chosen: string | null }) {
    if (!files.length) return <p className={styles.empty}>This environment has no env files.</p>
    return (
        <div className={styles.files}>
            {files.map(file => (
                <a
                    className={styles.file}
                    key={file.path}
                    href={`/portal/sites/${id}?tab=env&file=${encodeURIComponent(file.path)}`}
                    aria-current={file.path === chosen ? 'page' : undefined}
                >
                    {file.path}
                    <span className={styles.fileSize}>{size(file.bytes)}</span>
                </a>
            ))}
        </div>
    )
}

export async function EnvPanel({ id, file }: { id: string, file: string | null }) {
    const who = await callerFromSession()
    if (!who || who.clientId !== null) return null

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        return <Callout tone="warn" title="hostd is not configured">{problems.join('; ')}</Callout>
    }

    const files = await listEnvFiles(config, who.caller, id, LIVE)
    if (!files.ok) {
        return <Callout tone="warn" title="The env files could not be listed">{forAdmin(files.code, files.message)}</Callout>
    }

    // Only a path hostd itself just listed. A path from the address bar never reaches a request, which is
    // the first of the three checks on it: server/hostd/env.ts refuses a climbing path, and hostd resolves
    // the real path one component at a time and refuses a symlink at any position.
    const chosen = file && files.value.some(entry => entry.path === file) ? file : null
    const text = chosen ? await readEnvFile(config, who.caller, id, LIVE, chosen) : null
    const example = chosen ? files.value.find(entry => entry.path === chosen)?.example ?? null : null

    return (
        <>
            {/* No tone, so it is not announced as a problem: it is how the thing works, not something
                that went wrong. */}
            <Callout title="Where this file lives">
                An env file is kept out of every backup, it is not among the files a client can download,
                and it never leaves the dedi. Nothing here is written down anywhere else.
            </Callout>

            <section className={styles.block}>
                <h2>{LIVE}</h2>
                <Files id={id} files={files.value} chosen={chosen} />

                {!chosen && <p className={styles.empty}>Choose a file to read or edit it.</p>}

                {chosen && text && !text.ok && (
                    <Callout tone="warn" title="That file could not be read">{forAdmin(text.code, text.message)}</Callout>
                )}

                {chosen && text && text.ok && (
                    <EnvForm id={id} path={chosen} text={text.value} example={example} />
                )}
            </section>
        </>
    )
}
