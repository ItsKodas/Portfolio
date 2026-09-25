'use client'

// The dropdown that says which environment the Deploys tab is about. The Environments tab chooses with its
// own list instead, since it is the list of environments.
//
// A select that navigates rather than client state, for the reason the env file list is links: which
// environment is open is part of the URL, so it reloads, it is shareable, and the panels drawing it stay
// server components. A dropdown rather than a row of links, because a site can have any number of them.

import { useRouter } from 'next/navigation'

import type { EnvironmentName } from '@/server/hostd/environmentName'
import { Field } from '@/ui/Field/Field'
import styles from './site.module.css'

type Props = {
    id: string
    // Which tab it stays on. The dropdown is the same on every tab; where it sends you is not.
    tab: string
    // Only the name is read, so a caller with the registry's full Environment records can hand them
    // straight over and a test can hand over the one field this looks at.
    environments: { name: EnvironmentName }[]
    chosen: string
}

export function EnvSwitcher({ id, tab, environments, chosen }: Props) {
    const router = useRouter()

    // One environment is the ordinary case and a dropdown over a list of one is furniture
    if (environments.length < 2) return null

    return (
        <div className={styles.envSwitcher}>
            <Field
                as="select"
                label="Environment"
                value={chosen}
                onChange={event => router.push(
                    `/portal/sites/${id}?tab=${tab}&env=${encodeURIComponent(event.target.value)}`,
                    // The page stays where it is: the reader is looking at the panel under the dropdown
                    { scroll: false },
                )}
            >
                {environments.map(environment => (
                    <option key={environment.name} value={environment.name}>{environment.name}</option>
                ))}
            </Field>
        </div>
    )
}
