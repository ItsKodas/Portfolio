// The same list as ui/tokens.css, for the few places a value is needed in script rather than in a
// stylesheet, such as a meter's fill. ui/tokens.test.ts fails if the two drift apart.

export const TOKENS: Record<string, string> = {
    'night': '#0c0d10',
    'deep': '#101216',
    'panel': '#101216',
    'panel-hi': '#181a20',
    'rule': '#1d1f25',
    'rule-hi': '#282b33',

    'scene-bg': '#101727',
    'scene-paper': '#0b0d1c',

    'ink': '#e8eaee',
    'ink-2': '#9ba1ad',
    'ink-3': '#6b717d',

    'lake': '#8fd4f5',
    'lake-hi': '#a8ddf7',
    'blush': '#f19bb3',

    'good': '#5fc98d',
    'warn': '#e0a84e',
    'crit': '#e4574c',
    'soft-red': '#ffb3ad',

    'radius-chip': '4px',
    'radius-control': '7px',
    'radius-panel': '9px',
    'radius-card': '11px',
}

// Two densities, one visual language: the operator's screens are dense, the client's are roomy.
// Applied with data-density on the area's layout element.
export const DENSITY = ['operator', 'client'] as const
export type Density = typeof DENSITY[number]
