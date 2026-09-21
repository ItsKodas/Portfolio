import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { RegistryWriter, applyChange, type Change, type RegistryWriteFs } from './registry-write.ts'

const BASE = `reserved: [horizons.gg]
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    environments:
      live:
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        certificate: letsencrypt
`

// The real entries on the dedi look like this: a note above a key and another trailing one on the same
// line as the value, a compose list written on one line, and an upstream that is not the loopback address.
// All three are things a write can silently destroy, so the fixture carries all three.
const LIVE_ONLY = `reserved: [horizons.gg]
projects:
  arbysauto:
    client: cl_1
    name: Arbys Auto Glass
    # the operator's own note, which must survive a write
    dir: /var/www/arbysauto # port bumped 2025-03, do not reuse 5010
    compose: [docker-compose.yml, docker-compose.override.yml]
    upstream: 10.0.0.5:5011
    services:
      web: { role: site }
    capabilities: [lifecycle, logs]
`

const addProject: Change = {
    kind: 'add-project',
    id: 'bakery',
    project: {
        client: 'cl_2', name: 'Bakery', repo: 'git@github.com:ItsKodas/bakery.git',
        services: { web: { role: 'site' } },
        environment: { name: 'live', dir: '/var/www/bakery', branch: 'main', domain: 'bakery.com', port: 5011, certificate: 'letsencrypt' },
    },
}

describe('applyChange', () => {
    it('adds a project that parses back with the fields it was given', () => {
        const result = applyChange(BASE, addProject)
        assert.ok(result.ok)
        const registry = parseRegistry(result.text)
        const bakery = registry.projects.get('bakery')!
        assert.equal(bakery.name, 'Bakery')
        assert.equal(bakery.environments.get('live')!.port, 5011)
        // and the project that was already there is untouched
        assert.equal(registry.projects.get('acme')!.environments.get('live')!.domain, 'acme.com')
    })

    it('keeps comments and unrelated formatting in the file', () => {
        const withComment = `# hand written note\n${BASE}`
        const result = applyChange(withComment, addProject)
        assert.ok(result.ok)
        assert.match(result.text, /# hand written note/)
    })

    it('adds an environment to an existing project', () => {
        const result = applyChange(BASE, {
            kind: 'add-environment', id: 'acme',
            environment: { name: 'test', dir: '/var/www/acme-test', branch: 'develop', domain: 'test.acme.com', port: 5110, certificate: 'letsencrypt' },
        })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('test')!.branch, 'develop')
    })

    it('records a deployed commit', () => {
        const result = applyChange(BASE, { kind: 'set-deployed', id: 'acme', environment: 'live', commit: '9a1b2c3' })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('live')!.deployed, '9a1b2c3')
    })

    it('sets a branch', () => {
        const result = applyChange(BASE, { kind: 'set-branch', id: 'acme', environment: 'live', branch: 'develop' })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('live')!.branch, 'develop')
    })

    it('refuses a branch on an environment that does not exist', () => {
        assert.equal(applyChange(BASE, { kind: 'set-branch', id: 'acme', environment: 'test', branch: 'develop' }).ok, false)
    })

    it('refuses a branch the registry itself would not load', () => {
        assert.equal(applyChange(BASE, { kind: 'set-branch', id: 'acme', environment: 'live', branch: '--upload-pack' }).ok, false)
    })

    it('removes a project and an environment', () => {
        const gone = applyChange(BASE, { kind: 'remove-project', id: 'acme' })
        assert.ok(gone.ok)
        assert.equal(parseRegistry(gone.text).projects.size, 0)
    })

    it('refuses a change that would produce a registry hostd would reject', () => {
        const clash = applyChange(BASE, { ...addProject, project: { ...addProject.project, environment: { ...addProject.project.environment, dir: '/var/www/acme' } } })
        assert.equal(clash.ok, false)
        assert.match(clash.ok === false ? clash.problem : '', /dir/)
    })

    it('refuses an id that already exists, and one that is reserved', () => {
        assert.equal(applyChange(BASE, { ...addProject, id: 'acme' }).ok, false)
        assert.equal(applyChange(BASE, { ...addProject, id: 'mail' }).ok, false)
    })

    // conflict: true is what a caller (provision.ts) reads to decide whether a folder it made before the
    // write is safe to remove: only "the id, or the environment, was already there" means it is not.
    // A reserved id is not that: nothing else claims it, so it carries no conflict flag.
    it('marks an id or environment that already exists as a conflict, and a reserved id as an ordinary refusal', () => {
        const idTaken = applyChange(BASE, { ...addProject, id: 'acme' })
        assert.deepEqual(idTaken, { ok: false, problem: 'acme already exists', conflict: true })

        const environmentTaken = applyChange(BASE, {
            kind: 'add-environment', id: 'acme',
            environment: { name: 'live', dir: '/var/www/acme-2', branch: 'main', domain: null, port: 5099, certificate: null },
        })
        assert.deepEqual(environmentTaken, { ok: false, problem: 'acme already has a live environment', conflict: true })

        const reserved = applyChange(BASE, { ...addProject, id: 'mail' })
        assert.deepEqual(reserved, { ok: false, problem: 'mail is reserved' })
    })

    it('refuses a change to a project that is not there', () => {
        assert.equal(applyChange(BASE, { kind: 'set-deployed', id: 'ghost', environment: 'live', commit: '9a1b2c3' }).ok, false)
    })
})

describe('configure', () => {
    // The body the portal's form actually sends. It sends every field on every save, one branches entry
    // per environment, and a blank branch field becomes null: a live-only entry has a synthesised live
    // environment in the listing, so branches: { live: null } rides along with every save of one. Ticking
    // a capability must not reshape the entry, which is a conversion that loses upstream's host, and must
    // not touch anything else in the file either.
    it('changes nothing but the capabilities when the save only ticked one', () => {
        const result = applyChange(LIVE_ONLY, {
            kind: 'configure',
            id: 'arbysauto',
            capabilities: ['lifecycle', 'logs', 'env'],
            repo: null,
            branches: { live: null },
        })
        assert.ok(result.ok)
        assert.deepEqual([...parseRegistry(result.text).projects.get('arbysauto')!.capabilities], ['lifecycle', 'logs', 'env'])

        // Every other line of the file, line for line: the entry keeps its shape, its trailing note, its
        // one-line compose list and its own upstream host. Blind to one thing only, the space yaml's
        // stringify puts inside every flow collection in the document on every write, which the writer
        // takes on purpose rather than reformat the whole file to avoid (see the note by doc.toString).
        const without = (text: string) => text.split('\n')
            .filter(line => !line.includes('capabilities:'))
            .map(line => line.replace(/\[ /g, '[').replace(/ \]/g, ']'))
        assert.deepEqual(without(result.text), without(LIVE_ONLY))
        assert.equal(parseRegistry(result.text).projects.get('arbysauto')!.upstream.host, '10.0.0.5')
    })

    it('replaces the capability list wholesale', () => {
        const result = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: ['lifecycle', 'logs', 'env', 'deploy'] })
        assert.ok(result.ok)
        const registry = parseRegistry(result.text)
        assert.deepEqual([...registry.projects.get('arbysauto')!.capabilities], ['lifecycle', 'logs', 'env', 'deploy'])
    })

    it('can take every capability away', () => {
        const result = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: [] })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('arbysauto')!.capabilities.size, 0)
    })

    it('writes the capability list in flow style, the way the file already writes it', () => {
        // A block sequence would validate and would reformat a file a person maintains by hand: that is
        // the structural difference this test actually cares about. Whether the library pads the inside
        // of the brackets with a space is its own stringify default, applied to the whole document, not
        // a choice this writer makes for this one list, so the match tolerates either spacing.
        const result = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: ['lifecycle', 'env'] })
        assert.ok(result.ok)
        assert.match(result.text, /capabilities: \[ ?lifecycle, env ?\]/)
        assert.doesNotMatch(result.text, /\n\s+- lifecycle/)
    })

    it('leaves an untouched flow mapping padded exactly as the operator wrote it, across more than one write', () => {
        // flowCollectionPadding is a whole-document stringify option, not a per-node one: turning it off
        // to keep a freshly flow-styled list unpadded would also strip the padding from every other flow
        // collection already in the file, on every write from here on, including ones that never touch
        // this project at all. So the writer leaves the library's default padding alone, and this is the
        // proof: services: { role: site } is never touched by either of these changes, and survives both.
        const first = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: ['lifecycle', 'env'] })
        assert.ok(first.ok)
        assert.match(first.text, /services:\n\s+web: \{ role: site \}/)

        const second = applyChange(first.text, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/arbysauto.git' })
        assert.ok(second.ok)
        assert.match(second.text, /services:\n\s+web: \{ role: site \}/)
    })

    it('sets a repo, and clears one', () => {
        const set = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/arbysauto.git' })
        assert.ok(set.ok)
        assert.equal(parseRegistry(set.text).projects.get('arbysauto')!.repo, 'git@github.com:ItsKodas/arbysauto.git')

        const cleared = applyChange(set.text, { kind: 'configure', id: 'arbysauto', repo: null })
        assert.ok(cleared.ok)
        assert.equal(parseRegistry(cleared.text).projects.get('arbysauto')!.repo, null)
    })

    it('converts a live-only entry when a branch is set on it', () => {
        const result = applyChange(LIVE_ONLY, {
            kind: 'configure',
            id: 'arbysauto',
            repo: 'git@github.com:ItsKodas/arbysauto.git',
            branches: { live: 'main' },
        })
        assert.ok(result.ok)

        const live = parseRegistry(result.text).projects.get('arbysauto')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/arbysauto')
        assert.equal(live.branch, 'main')
        assert.equal(live.port, 5011)
        // Every compose file, in the order it was written: an unnamed override is an override hostd
        // cannot see, and the order is the order compose merges them
        assert.deepEqual(live.composePaths, ['/var/www/arbysauto/docker-compose.yml', '/var/www/arbysauto/docker-compose.override.yml'])

        // The three keys the registry refuses to hold beside environments are gone. dir is checked at the
        // project's own indent (4 spaces): environments.live.dir legitimately exists a few lines above, at
        // 8 spaces, so a plain /\s+dir:/ would also match that and could never pass.
        assert.doesNotMatch(result.text, /^ {4}dir:/m)
        assert.doesNotMatch(result.text, /upstream:/)
        // and the operator's note is still there
        assert.match(result.text, /the operator's own note/)
    })

    it('carries every note the operator wrote on the three keys it deletes, trailing ones included', () => {
        const result = applyChange(LIVE_ONLY, {
            kind: 'configure',
            id: 'arbysauto',
            repo: 'git@github.com:ItsKodas/arbysauto.git',
            branches: { live: 'main' },
        })
        assert.ok(result.ok)
        // The note above dir and the one trailing its value: the pair carrying either is deleted by the
        // conversion, so a note left on it is gone for good (the registry is gitignored and not backed up).
        assert.match(result.text, /the operator's own note/)
        assert.match(result.text, /port bumped 2025-03, do not reuse 5010/)
    })

    it('keeps a one-line compose list on one line when it converts', () => {
        const result = applyChange(LIVE_ONLY, {
            kind: 'configure',
            id: 'arbysauto',
            repo: 'git@github.com:ItsKodas/arbysauto.git',
            branches: { live: 'main' },
        })
        assert.ok(result.ok)
        assert.match(result.text, /compose: \[ ?docker-compose\.yml, docker-compose\.override\.yml ?\]/)
        assert.doesNotMatch(result.text, /\n\s+- docker-compose\.yml/)
    })

    it('carries the default compose across when the entry named none', () => {
        const bare = LIVE_ONLY.replace('    compose: [docker-compose.yml, docker-compose.override.yml]\n', '')
        const result = applyChange(bare, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/a.git', branches: { live: 'main' } })
        assert.ok(result.ok)
        const live = parseRegistry(result.text).projects.get('arbysauto')!.environments.get('live')!
        assert.deepEqual(live.composePaths, ['/var/www/arbysauto/docker-compose.yml'])
    })

    it('refuses to convert an entry with no upstream to take a port from', () => {
        const bare = LIVE_ONLY.replace('    upstream: 10.0.0.5:5011\n', '')
        const result = applyChange(bare, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/a.git', branches: { live: 'main' } })
        assert.equal(result.ok, false)
        assert.match(result.problem, /upstream/)
    })

    it('leaves an entry that already has environments alone', () => {
        // BASE is the environments-shaped fixture; no conversion, just the branch
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { live: 'develop' } })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('live')!.branch, 'develop')
    })

    it('refuses a branch for an environment the entry does not have', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { test: 'develop' } })
        assert.equal(result.ok, false)
        assert.match(result.problem, /no test environment/)
    })

    it('clears a branch, which is how an environment stops deploying', () => {
        const set = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { live: 'main' } })
        assert.ok(set.ok)
        const cleared = applyChange(set.text, { kind: 'configure', id: 'acme', branches: { live: null } })
        assert.ok(cleared.ok)
        assert.equal(parseRegistry(cleared.text).projects.get('acme')!.environments.get('live')!.branch, null)
    })

    it('refuses a project that is not registered', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'nothing', capabilities: [] })
        assert.equal(result.ok, false)
    })

    // The validator is the one rule about what a field may be. These prove the write never lands.
    it('refuses an unknown capability', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', capabilities: ['lifecycle', 'teleport'] as never })
        assert.equal(result.ok, false)
    })

    it('refuses a repo that is not a git URL', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', repo: 'not a url' })
        assert.equal(result.ok, false)
    })

    it('refuses a branch name that is not a plain one', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { live: '--upload-pack=evil' } })
        assert.equal(result.ok, false)
    })

    it('refuses a branch on a project with no repo to fetch it from', () => {
        // parseRegistry's own rule: `branch needs repo`
        const noRepo = LIVE_ONLY
        const result = applyChange(noRepo, { kind: 'configure', id: 'arbysauto', branches: { live: 'main' } })
        assert.equal(result.ok, false)
        assert.match(result.problem, /repo/)
    })
})

describe('RegistryWriter', () => {
    function fakeFs(initial: string) {
        const files = new Map<string, string>([['/etc/hostd/projects.yaml', initial]])
        const calls: string[] = []
        const writeCalls: { path: string, flag?: string }[] = []
        const fs: RegistryWriteFs = {
            readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
            writeFile: async (path, text, options) => { calls.push(`write ${path}`); writeCalls.push({ path, flag: options?.flag }); files.set(path, text) },
            rename: async (from, to) => { calls.push(`rename ${from} -> ${to}`); files.set(to, files.get(from)!); files.delete(from) },
            unlink: async path => { calls.push(`unlink ${path}`); files.delete(path) },
        }
        return { fs, files, calls, writeCalls }
    }

    it('writes a temporary file beside the registry and renames it over the original', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        assert.deepEqual(await writer.write(addProject), { ok: true })
        assert.equal(calls.length, 2)
        // A random suffix, not a fixed name: two writes must never be able to collide on the same
        // temporary path (see the concurrent-writes test below), and a fixed name could be pre-planted.
        assert.match(calls[0]!, /^write \/etc\/hostd\/\.projects\.yaml\.[0-9a-f]+\.tmp$/)
        assert.match(calls[1]!, /^rename \/etc\/hostd\/\.projects\.yaml\.[0-9a-f]+\.tmp -> \/etc\/hostd\/projects\.yaml$/)
        assert.match(files.get('/etc/hostd/projects.yaml')!, /bakery/)
    })

    // 'wx' is O_CREAT | O_EXCL, matching env-files.ts's own temp file: it fails on anything already at
    // that path, symlink or not, rather than opening through it, so a pre-planted symlink at a guessed
    // temp name cannot capture the write.
    it('opens the temporary file exclusively, the same defense env-files.ts uses for its own temp file', async () => {
        const { fs, writeCalls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        await writer.write(addProject)
        assert.equal(writeCalls.length, 1)
        assert.equal(writeCalls[0]!.flag, 'wx')
    })

    it('leaves the file untouched when the change is refused', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const result = await writer.write({ ...addProject, id: 'acme' })
        assert.equal(result.ok, false)
        assert.equal(files.get('/etc/hostd/projects.yaml'), BASE)
        assert.deepEqual(calls, [])
    })

    it('removes the temporary file when the rename fails, and reports the problem', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        fs.rename = async () => { throw new Error('read-only file system') }
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const result = await writer.write(addProject)
        assert.equal(result.ok, false)
        assert.equal(files.get('/etc/hostd/projects.yaml'), BASE)
        assert.ok(calls.some(call => /^unlink \/etc\/hostd\/\.projects\.yaml\.[0-9a-f]+\.tmp$/.test(call)))
    })

    it('serialises concurrent writes, so two additions both survive', async () => {
        const { fs, files } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const second: Change = {
            ...addProject, id: 'cafe',
            project: { ...addProject.project, name: 'Cafe', environment: { ...addProject.project.environment, dir: '/var/www/cafe', domain: 'cafe.com', port: 5012 } },
        }
        const [a, b] = await Promise.all([writer.write(addProject), writer.write(second)])
        assert.deepEqual([a, b], [{ ok: true }, { ok: true }])
        const registry = parseRegistry(files.get('/etc/hostd/projects.yaml')!)
        assert.deepEqual([...registry.projects.keys()].sort(), ['acme', 'bakery', 'cafe'])
    })
})
