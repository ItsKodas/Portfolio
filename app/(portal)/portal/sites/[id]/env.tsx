// The env files, the Environments tab's Env files section, for the operator and for a client given ENV_FILES
// on this site. A server component: hostd is asked here, the caller is worked out from the session here, and
// which file is open is part of the URL rather than client state, so the panel reloads and can be linked to.
//
// It re-derives the caller and re-checks the grant rather than trusting the page that rendered it. hostd
// holds the same line (hostd/src/api/policy.ts), and a check that exists in one place only is a check one
// refactor away from not existing.

import { readHostd } from '@/server/hostd/config'
import { listEnvFiles, readEnvFile, type EnvFile, type EnvironmentName } from '@/server/hostd/env'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { hasAccess } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { accessOf } from '@/server/sites/access'
import { Callout } from '@/ui/Callout/Callout'
import { EnvForm } from './envForm'
import styles from './site.module.css'

function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    return `${(bytes / 1024).toFixed(1)} kB`
}

function Files({ id, environment, files, chosen }: { id: string, environment: string, files: EnvFile[], chosen: string | null }) {
    if (!files.length) return <p className={styles.empty}>This environment has no env files.</p>
    return (
        <div className={styles.files}>
            {files.map(file => (
                <a
                    className={styles.file}
                    key={file.path}
                    href={`/portal/sites/${id}?tab=environments&env=${encodeURIComponent(environment)}&file=${encodeURIComponent(file.path)}`}
                    aria-current={file.path === chosen ? 'page' : undefined}
                >
                    {file.path}
                    <span className={styles.fileSize}>{size(file.bytes)}</span>
                </a>
            ))}
        </div>
    )
}

type Props = {
    id: string
    file: string | null
    // The environment chosen in the Environments tab's list. The page has already checked it is one this
    // site has.
    environment: EnvironmentName
}

export async function EnvPanel({ id, file, environment }: Props) {
    const who = await callerFromSession()
    if (!who) return null
    const isAdmin = who.clientId === null
    if (who.clientId !== null && !(await hasAccess(who.clientId, id, accessOf, 'ENV_FILES'))) return null
    // hostd's own words are the operator's; a client is told what it means for them
    const said = (result: { code: string, message: string }) => (isAdmin ? forAdmin(result.code, result.message) : forClient(result.code))

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        return isAdmin
            ? <Callout tone="warn" title="hostd is not configured">{problems.join('; ')}</Callout>
            : <Callout tone="warn" title="The env files could not be listed">{forClient('unavailable')}</Callout>
    }

    const files = await listEnvFiles(config, who.caller, id, environment)
    if (!files.ok) {
        return <Callout tone="warn" title="The env files could not be listed">{said(files)}</Callout>
    }

    // Only a path hostd itself just listed. A path from the address bar never reaches a request, which is
    // the first of the three checks on it: server/hostd/env.ts refuses a climbing path, and hostd resolves
    // the real path one component at a time and refuses a symlink at any position.
    const chosen = file && files.value.some(entry => entry.path === file) ? file : null
    const text = chosen ? await readEnvFile(config, who.caller, id, environment, chosen) : null
    const example = chosen ? files.value.find(entry => entry.path === chosen)?.example ?? null : null

    return (
        <>
            {/* No tone, so it is not announced as a problem: it is how the thing works, not something
                that went wrong. */}
            <Callout title="Where this file lives">
                {isAdmin
                    ? 'An env file is kept out of every backup, it is not among the files a client can download, '
                        + 'and it never leaves the dedi. Nothing here is written down anywhere else.'
                    : 'An env file is kept out of every backup and never leaves the server. Nothing here is '
                        + 'written down anywhere else.'}
            </Callout>

            {/* No heading of its own: the Environments tab names the environment over all its sections */}
            <section className={styles.block}>
                <Files id={id} environment={environment} files={files.value} chosen={chosen} />

                {!chosen && <p className={styles.empty}>Choose a file to read or edit it.</p>}

                {chosen && text && !text.ok && (
                    <Callout tone="warn" title="That file could not be read">{said(text)}</Callout>
                )}

                {chosen && text && text.ok && (
                    <EnvForm id={id} environment={environment} path={chosen} text={text.value} example={example} />
                )}
            </section>
        </>
    )
}
