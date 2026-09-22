// Pure boot-time checks that index.ts's failures list calls into, split out so they can be unit tested
// without importing index.ts itself, which runs main() (Docker, the registry, the socket) as a side
// effect of module load.

import { posix } from 'node:path'

// hostd-apache.sh disables a hand-written site by moving its sites-enabled entry into the adopted-backup
// directory with a plain `mv`. On Debian that entry is a relative symlink a2ensite wrote, of the form
// `../sites-available/<name>.conf`, and a relative symlink only keeps resolving from wherever it lands.
// `../sites-available` reaches the right place from the adopted-backup directory today purely because
// both HOSTD_APACHE_SITES_ENABLED and HOSTD_APACHE_ADOPTED_DIR default directly under /etc/apache2, so
// `../` from either means the same thing. That is a coincidence of the defaults, not something either
// path is declared to guarantee, and both are independently overridable.
//
// Comparing the parent directory of each is exactly the condition the relative symlink depends on: it
// resolves after the move if and only if the two directories share a parent, i.e. are siblings. This does
// not try to model every depth a `..`-laden symlink could in principle use; a2ensite writes exactly one
// `../`, and the whole point of catching this at boot is to keep the layout simple enough that a single
// `../` always works, rather than to support arbitrarily deep rearrangements later.
export function siblingDirProblem(sitesEnabled: string, adopted: string): string | null {
    const sitesParent = posix.dirname(sitesEnabled)
    const adoptedParent = posix.dirname(adopted)
    if (sitesParent === adoptedParent) return null
    return `HOSTD_APACHE_SITES_ENABLED (${sitesEnabled}) and HOSTD_APACHE_ADOPTED_DIR (${adopted}) must be sibling directories, so a relative symlink hostd-apache.sh moves from one to the other keeps resolving; today their parents are ${sitesParent} and ${adoptedParent}`
}
