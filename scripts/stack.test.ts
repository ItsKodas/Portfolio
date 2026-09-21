// scripts/stack.sh, exercised through its own --dry-run. The substance of that script is the order it
// runs the three stacks in and the flags it refuses, both of which --dry-run makes into plain text, so
// none of this needs a Docker daemon or a dedi.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Named absolutely, and with the separators sh understands on either platform, so cwd below decides only
// where the caller is standing and never whether the script can be found at all.
const SCRIPT = `${ROOT}scripts/stack.sh`.replace(/\\/g, '/')

// sh rather than bash: the script is POSIX, and this is what the dedi runs it with.
function run(args: string[], cwd = ROOT) {
    const result = spawnSync('sh', [SCRIPT, ...args], { cwd, encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// The command lines only, so a test asserting on order is not also asserting on any banner or blank line
// the script prints around them.
function commands(stdout: string): string[] {
    return stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('['))
}

describe('up', () => {
    test('brings the stacks up in hostd, mail, site order', () => {
        const result = run(['--dry-run', 'up'])

        expect(result.status).toBe(0)
        expect(commands(result.stdout)).toEqual([
            '[hostd] docker compose up -d',
            '[mail] docker compose up -d',
            '[site] docker compose up -d',
        ])
    })

    test('forwards an allowed flag to every stack', () => {
        const result = run(['--dry-run', 'up', '--build'])

        expect(result.status).toBe(0)
        expect(commands(result.stdout)).toEqual([
            '[hostd] docker compose up -d --build',
            '[mail] docker compose up -d --build',
            '[site] docker compose up -d --build',
        ])
    })

    test('forwards several allowed flags in the order they were given', () => {
        const result = run(['--dry-run', 'up', '--build', '--force-recreate'])

        expect(commands(result.stdout)[0]).toBe('[hostd] docker compose up -d --build --force-recreate')
    })

    test('does not build unless asked', () => {
        // Bare up still builds an image that is missing, which is compose's own behaviour; what must not
        // appear is the flag that rebuilds one already there.
        expect(run(['--dry-run', 'up']).stdout).not.toContain('--build')
    })
})

describe('down', () => {
    test('takes the stacks down in the reverse order', () => {
        const result = run(['--dry-run', 'down'])

        expect(result.status).toBe(0)
        expect(commands(result.stdout)).toEqual([
            '[site] docker compose down',
            '[mail] docker compose down',
            '[hostd] docker compose down',
        ])
    })

    test('never removes volumes', () => {
        // The rail that matters most: mail-data, db-data and hostd-state are named volumes, and no route
        // through this script may reach them.
        const result = run(['--dry-run', 'down', '--remove-orphans'])

        expect(result.stdout).not.toContain('-v')
        expect(result.stdout).not.toContain('--volumes')
    })

    test('refuses to run unconfirmed when nothing can answer the prompt', () => {
        // stdin here is a pipe, not a terminal, which is also how it would arrive from cron or a CI run.
        const result = run(['down'])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('-y')
    })

    test('does not prompt for a dry run, which changes nothing', () => {
        expect(run(['--dry-run', 'down']).status).toBe(0)
    })
})

describe('choosing one stack', () => {
    test('acts on only the named stack', () => {
        expect(commands(run(['--dry-run', 'up', 'hostd']).stdout)).toEqual(['[hostd] docker compose up -d'])
    })

    test('keeps the flags when a stack is named', () => {
        expect(commands(run(['--dry-run', 'up', '--build', 'mail']).stdout)).toEqual(['[mail] docker compose up -d --build'])
    })

    test('guards the hostd network when the site goes up without hostd', () => {
        // The site joins hostd's network as external, so compose fails on a missing network with a
        // message that does not say which of the two stacks is at fault.
        const result = run(['--dry-run', 'up', 'site'])

        expect(commands(result.stdout)).toEqual([
            '[site] guard: docker network inspect hostd',
            '[site] docker compose up -d',
        ])
    })

    test('does not guard when hostd is coming up in the same run', () => {
        expect(run(['--dry-run', 'up']).stdout).not.toContain('guard')
    })

    test('does not guard on the way down', () => {
        expect(run(['--dry-run', 'down', 'site']).stdout).not.toContain('guard')
    })

    test('refuses a stack it does not know', () => {
        const result = run(['--dry-run', 'up', 'horizons'])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('horizons')
    })
})

describe('refusing what it was not given', () => {
    test('refuses a flag that is not on the allowlist', () => {
        const result = run(['--dry-run', 'down', '-v'])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('-v')
    })

    test('refuses an up flag asked for on the way down', () => {
        // --build means nothing to down, and silently dropping it would hide the mistake.
        const result = run(['--dry-run', 'down', '--build'])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('--build')
    })

    test('refuses a verb it does not know', () => {
        const result = run(['--dry-run', 'restart'])

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('restart')
    })

    test('refuses to run with no verb at all', () => {
        expect(run([]).status).not.toBe(0)
    })
})

describe('where it is run from', () => {
    test('finds the stacks when run from a subdirectory', () => {
        // The dedi runs it from the repo root, but resolving the three directories from the script's own
        // location rather than the caller's means neither the root nor anywhere else is a special case.
        const fromRoot = commands(run(['--dry-run', 'up']).stdout)
        const fromSubdirectory = commands(run(['--dry-run', 'up'], `${ROOT}hostd`).stdout)

        expect(fromSubdirectory).toEqual(fromRoot)
    })
})
