'use client'

// The two places this page prints what the site is, rather than what is being done to it. Both are a
// reading taken by the server component, and both were reporting the middle of an operation as though it
// were the news: a restart is a few seconds of "down" in the strip and a red dot in the sidebar, three
// seconds after the operator pressed Restart and was told the site would be unavailable for a few seconds.
//
// So while ./settling says something is happening, they say that instead. Neither invents a state: what
// they print is the word for the operation, which is the one thing about the site that is certain.

import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import type { SiteState } from '../../siteState'
import { DOING, useSettling } from './settling'

// services and restarts are counted by the page, which knows what a reading it could not take means.
// They are passed through untouched: an operation changes what the site is, not what was counted.
type Stats = { state: SiteState, services: string, restarts: string }

export function SiteStats({ state, services, restarts }: Stats) {
    const { settling } = useSettling()
    return (
        <StatStrip stats={[
            {
                key: 'state',
                value: settling ? DOING[settling.action] : state,
                // Red is for a site that is down when nobody asked it to be. Mid-restart it is down
                // because of the button that was just pressed, which is not a fault to colour.
                tone: !settling && state === 'down' ? 'crit' : undefined,
            },
            { key: 'services', value: services },
            { key: 'restarts', value: restarts },
        ]} />
    )
}

// The site's own entry in the sidebar, which is the only one of them this page can speak for. The rest
// are read from the listing and are none of this operation's business.
export function SiteDot({ state }: { state: SiteState }) {
    const { settling } = useSettling()
    // deploying is the dot that pulses, and is already what this page draws for work in progress. bare
    // because this dot lives in the sidebar, where no dot is labelled any more; the word still reaches a
    // pointer through the dot's title, and mid-operation that word is "restarting" rather than a state.
    if (settling) return <StatusDot state="deploying" label={DOING[settling.action]} bare />
    return <StatusDot state={state} bare />
}
