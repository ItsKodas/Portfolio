import { useSyncExternalStore } from 'react'

import { TIERS } from './tiers'

// How much of the hero scene is showing, as the cumulative tokens the head script put on the root (see script.ts),
// for components to follow. The server always renders the still scene, and the browser climbs from there once it
// knows what it can hold (see climb.ts).

const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

const tokens = () => (document.documentElement.getAttribute('data-scene') || '').split(/\s+/).filter(Boolean)

// Whether a part of the scene is in yet, for example useScene('depth')
export function useScene(token: string) {
    return useSyncExternalStore(subscribe, () => tokens().indexOf(token) !== -1, () => false)
}

// How many tiers are in, and the most this browser was judged able to hold
export const currentTier = () => tokens().length
export const sceneMax = () => Number(document.documentElement.getAttribute('data-scene-max') || 0)

// Puts the first n tiers in, in TIERS order
export function setTier(n: number) {
    const root = document.documentElement
    const next = TIERS.slice(0, n).map(t => t.token).join(' ')
    if (root.getAttribute('data-scene') === next) return
    root.setAttribute('data-scene', next)
    listeners.forEach(l => l())
}

// Sets the scene outright, as the desktop wallpaper's settings do (and marks it forced, so the climb and the frame
// watch leave it alone)
export function setPerf(mode: 'full' | 'lite') {
    document.documentElement.setAttribute('data-perf-forced', '')
    setTier(mode === 'full' ? TIERS.length : 0)
}
