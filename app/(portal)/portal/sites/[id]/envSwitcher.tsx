// The strip that says which environment a tab is about. It began inside deployPanel.tsx, and the Domains
// tab needs the same one: a domain belongs to an environment, so that tab keeps the selector rather than
// dropping it. Lifted here rather than copied, because two strips that are meant to look and behave
// identically drift the moment one of them is edited on its own.
//
// Links rather than buttons, for the reason the env file list is links: which environment is open is part
// of the URL, so it reloads, it is shareable, and the panel drawing it stays a server component.

import type { EnvironmentName } from '@/server/hostd/env'
import styles from './site.module.css'

type Props = {
    id: string
    // Which tab the links stay on. The strip is the same on both; where it sends you is not.
    tab: string
    // Only the name is read, so a caller with the registry's full Environment records can hand them
    // straight over and a test can hand over the one field this looks at.
    environments: { name: EnvironmentName }[]
    chosen: string
}

export function EnvSwitcher({ id, tab, environments, chosen }: Props) {
    // One environment is the ordinary case and a switcher over a list of one is furniture
    if (environments.length < 2) return null
    return (
        <div className={styles.files}>
            {environments.map(environment => (
                <a
                    className={styles.file}
                    key={environment.name}
                    href={`/portal/sites/${id}?tab=${tab}&env=${environment.name}`}
                    aria-current={environment.name === chosen ? 'page' : undefined}
                >
                    {environment.name}
                </a>
            ))}
        </div>
    )
}
