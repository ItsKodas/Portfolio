// What a site may be set up to do, shared by the Settings tab and the New site form so the two can never
// offer different lists or describe the same switch two ways.

// hostd/src/shared/registry.ts's CAPABILITIES, in its order. built: false is the three the registry
// accepts but hostd cannot act on yet: ticking one only records that the project has it, the same as
// today's registry entries already do by hand.
export const CAPABILITIES: ReadonlyArray<{ key: string, built: boolean }> = [
    { key: 'lifecycle', built: true },
    { key: 'logs', built: true },
    { key: 'files', built: false },
    { key: 'backups', built: false },
    { key: 'domains', built: true },
    { key: 'provision', built: false },
    { key: 'env', built: true },
    { key: 'deploy', built: true },
]

// Said once, beside the list, rather than on each of the three it is about: repeating it eight times would
// bury the one thing it needs to say under seven copies of the same sentence.
export const NOT_BUILT = 'files, backups and provision are designed but not built yet. hostd cannot act on '
    + 'them, so ticking one here does not switch anything on. Provision, once it is built, will let this '
    + 'project be re-provisioned through the API. Deleting the site needs none of these.'

// Each environment's render-only switches, in hostd's ENVIRONMENT_FLAGS order. The note is said under
// each checkbox: what it does to a site hostd already serves, and what it does to one still on a
// hand-written file, because those are different and the operator may have either.
export type SwitchKey = 'websockets' | 'flexibleSsl'
export const SWITCHES: ReadonlyArray<{ key: SwitchKey, label: string, note: string }> = [
    {
        key: 'websockets',
        label: 'WebSockets',
        note: 'Passes WebSocket connections (socket.io and the like) through to the site. On a site hostd '
            + 'already serves, saving rewrites its Apache configuration straight away. On a site still served by its own '
            + 'hand-written file, this is what lets adoption carry that file\'s WebSocket rules.',
    },
    {
        key: 'flexibleSsl',
        label: 'Cloudflare Flexible SSL',
        note: 'Serves the site on port 80 as well as 443, for a CDN that reaches this server over plain HTTP '
            + '(Cloudflare on Flexible). Without it, port 80 redirects to https and that CDN loops forever. Adoption '
            + 'switches this on by itself when the file it replaces had no port 443 block. Untick it once the CDN '
            + 'reaches port 443 (Cloudflare: Full).',
    },
]
