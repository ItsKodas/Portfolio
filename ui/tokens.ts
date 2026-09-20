// The same list as ui/tokens.css, for the few places a value is needed in script rather than in a
// stylesheet, such as a meter's fill. ui/tokens.test.ts fails if the two drift apart.

export const TOKENS: Record<string, string> = {
    'night': '#0b101f',
    'deep': '#0d1429',
    'panel': '#111a38',
    'panel-hi': '#16224a',
    'rule': '#1f2b52',
    'rule-hi': '#2c3c6e',

    'scene-bg': '#101727',
    'scene-paper': '#0b0d1c',

    'ink': '#eef2ff',
    'ink-2': '#a9b6dd',
    'ink-3': '#6f7da8',

    'lake': '#8fd4f5',
    'lake-hi': '#a8ddf7',
    'blush': '#f19bb3',

    'good': '#6fd39b',
    'warn': '#f0b45c',
    'crit': '#f4685f',
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
