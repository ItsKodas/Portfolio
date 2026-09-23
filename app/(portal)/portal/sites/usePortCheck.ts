'use client'

// Asks hostd about the port in a field as the operator types, a moment after they stop. Only a whole
// number from 5000 up is asked about: anything else is the form's own validation to say, without a round
// trip. The suggestion comes back with every answer, including the first one for an empty field of a new
// site. A field for an environment that already has a port never asks for a suggestion at all.

import { useEffect, useRef, useState } from 'react'

import { checkPortAction } from './portActions'

type Own = { project: string, environment: string } | null
export type PortCheckState = { suggested: number | null, problem: string | null, error: string | null, checking: boolean }

export function usePortCheck(value: string, own: Own, options: { skip?: boolean, delayMs?: number } = {}): PortCheckState {
    const { skip = false, delayMs = 400 } = options
    const [state, setState] = useState<PortCheckState>({ suggested: null, problem: null, error: null, checking: false })
    const project = own?.project ?? null
    const environment = own?.environment ?? null
    // The last suggestion hostd gave, kept outside state so reading it never itself re-triggers the effect
    // below (only `value` and the rest of its own deps do).
    const suggestedRef = useRef<number | null>(null)

    useEffect(() => {
        if (skip) {
            setState(prev => ({ ...prev, problem: null, error: null, checking: false }))
            return
        }
        const trimmed = value.trim()
        const port = /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 5000 && Number(trimmed) <= 65535 ? Number(trimmed) : null
        // A value that is there but not a port in range: no question to ask about it, only the suggestion
        if (trimmed !== '' && port === null) setState(prev => ({ ...prev, problem: null }))
        // And for an environment that already has a port, not even that: a suggestion is only for a new
        // site's empty field, so there is nothing to ask hostd at all
        if (project !== null && environment !== null && port === null) {
            setState(prev => ({ ...prev, problem: null, checking: false }))
            return
        }

        // The field just filled with hostd's own suggestion (an unowned field only, since a project's
        // environment could have moved on since that answer): nothing has changed since hostd said so, so
        // there is nothing to ask again.
        if (project === null && environment === null && port !== null && port === suggestedRef.current) {
            setState(prev => ({ ...prev, problem: null, checking: false }))
            return
        }

        let live = true
        setState(prev => ({ ...prev, checking: true }))
        const timer = setTimeout(() => {
            checkPortAction(port, project && environment ? { project, environment } : null)
                .then(result => {
                    if (!live) return
                    if (result.ok) {
                        suggestedRef.current = result.suggested
                        setState({ suggested: result.suggested, problem: result.problem, error: null, checking: false })
                    } else {
                        setState(prev => ({ ...prev, error: result.error, checking: false }))
                    }
                })
                .catch(() => { if (live) setState(prev => ({ ...prev, error: 'The port could not be checked.', checking: false })) })
        }, trimmed === '' ? 0 : delayMs)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [value, project, environment, skip, delayMs])

    return state
}
