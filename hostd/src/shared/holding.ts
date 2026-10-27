// Where a holding page lives and what its maintenance flag is called. Split out of agent/holding-pages.ts
// so edge, which must name the same files in an NPM host's config, can share them without importing agent/.

import { posix } from 'node:path'
import { maintenanceKey } from './deploys.ts'
import type { EnvironmentName } from './registry.ts'

export { maintenanceKey }

// Where an environment's own page lives, which the vhost names as its holding page. Under sites/ so the
// shared fallback, index.html, can never be overwritten by a project whose id happens to be "index".
export function holdingPagePath(pageDir: string, id: string, environment: EnvironmentName): string {
    return posix.join(pageDir, 'sites', `${maintenanceKey(id, environment)}.html`)
}
