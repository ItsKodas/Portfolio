import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { fileModeFor } from './own-tree.ts'

describe('fileModeFor', () => {
    // The case this exists for: a repository commits a file as 100755 (an entrypoint, a build script, a
    // binary). Once the fetcher stops masking that away at checkout (see fetcher/index.ts), the checkout
    // really does come out executable, 0755 under a normal 0022 umask. Losing that here, by deriving a
    // file's mode purely from the site directory's own mode, would make deploying it pointless: the site
    // directory is 0775, which has no reason to be 0111 on any particular file, and 0775 & 0o666 alone
    // (the previous, wrong expression) throws the executable bit away regardless of what git just set.
    it('keeps a file executable when the checkout already made it so', () => {
        assert.equal(fileModeFor(0o755, 0o775), 0o775)
    })

    it('leaves a plain file without execute bits, even when the site directory has them', () => {
        assert.equal(fileModeFor(0o644, 0o775), 0o664)
    })

    it('takes the site\'s read and write bits over the file\'s own, when they differ', () => {
        // A file checked out more permissively than the site directory (0666, say) still only ends up as
        // permissive as the site itself allows: the site's rw bits win, not the file's.
        assert.equal(fileModeFor(0o666, 0o750), 0o750 & 0o666)
    })
})
