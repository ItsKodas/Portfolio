// The New site form's rules, shared by the form (to say what is wrong before anything is sent) and the
// server action (which cannot trust the form). Each one is hostd's own, copied from
// hostd/src/shared/formats.ts and registry.ts; hostd checks every one of them again.

import { z } from 'zod'

import { CAPABILITIES } from '../sites/features'

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
const RESERVED_PROJECT_IDS = ['hostd', 'mail', 'horizons']
const DIR_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
const GIT_REPO = /^(git@[A-Za-z0-9.-]+:[A-Za-z0-9._\/-]+\.git|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+(\.git)?)$/
const GIT_REF = /^(?!.*\.\.)(?!.*\.lock$)(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/
const CREDENTIAL_NAME = /^[a-z0-9_]{1,32}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_COMPOSE_FILES = 8

// A compose file's path relative to the site's folder: no absolute path, no way out of the folder, and
// one spelling of each path, the same rule hostd's relativePathProblem applies.
const composeFile = z.string().trim().min(1, 'Name each compose file, or remove the empty one.')
    .refine(path => !path.startsWith('/'), 'Compose files are relative to the site folder.')
    .refine(path => path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
        'A compose file path cannot contain empty, . or .. segments.')

export const newSiteSchema = z.object({
    name: z.string().trim().min(1, 'Enter a name.').max(100, 'Keep the name under 100 characters.'),
    id: z.string().trim()
        .regex(PROJECT_ID, 'The id is 2 to 31 lower case letters, digits and hyphens, starting with a letter or digit.')
        .refine(value => !RESERVED_PROJECT_IDS.includes(value), 'That id is reserved for one of your own stacks.'),
    dir: z.string().trim().regex(DIR_NAME, 'The folder is one name: lower case letters, digits, hyphens and underscores.'),
    // '' is None: a site the operator runs for themselves
    client: z.union([z.literal(''), z.string().regex(CLIENT_ID, 'Pick a client from the list.')]),
    repo: z.string().trim().regex(GIT_REPO, 'Use an ssh (git@github.com:owner/repo.git) or https git URL.'),
    // '' is the default token
    credential: z.union([z.literal(''), z.string().regex(CREDENTIAL_NAME, 'Pick an account from the list.')]),
    branch: z.string().trim().regex(GIT_REF, 'Use a plain branch name, like main.'),
    compose: z.array(composeFile).min(1, 'List at least one compose file.').max(MAX_COMPOSE_FILES, `List at most ${MAX_COMPOSE_FILES} compose files.`)
        .refine(list => new Set(list).size === list.length, 'Each compose file only once.'),
    capabilities: z.array(z.enum(CAPABILITIES.map(cap => cap.key) as [string, ...string[]]))
        .refine(list => new Set(list).size === list.length, 'Each feature only once.'),
    websockets: z.boolean(),
    flexibleSsl: z.boolean(),
    // '' is no domain yet
    domain: z.union([z.literal(''), z.string().trim().toLowerCase().regex(HOSTNAME, 'Use a plain domain name, like example.com.')]),
    certificate: z.enum(['letsencrypt', 'cloudflare-origin']),
    deploy: z.boolean(),
})

export type NewSiteInput = z.input<typeof newSiteSchema>
export type NewSiteValues = z.output<typeof newSiteSchema>

// The id a name suggests, until the operator types their own: lower case, runs of anything else become one
// hyphen, and trimmed to the id's own length limit.
export function slugOf(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31).replace(/-+$/, '')
}
