import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { ACCESS_LOG_FORMAT, Analytics, accessLogName, isBot, parseLine } from './analytics.ts'

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const OWN = new Set(['acme.com', 'www.acme.com'])

type Line = {
    time?: string
    peer?: string
    cfIp?: string
    forwarded?: string
    method?: string
    path?: string
    status?: string
    referer?: string
    agent?: string
    accept?: string
    rsc?: string
    routerPrefetch?: string
    secPurpose?: string
    purpose?: string
    country?: string
}

// One line as Apache would write it in ACCESS_LOG_FORMAT, "-" for anything not sent
function line(over: Line = {}): string {
    const value = { time: '1760097600', peer: '203.0.113.9', method: 'GET', path: '/', status: '200', agent: CHROME, accept: HTML, ...over }
    return [
        value.time, value.peer, value.cfIp, value.forwarded, value.method, value.path, value.status, value.referer, value.agent,
        value.accept, value.rsc, value.routerPrefetch, value.secPurpose, value.purpose, value.country,
    ].map(field => field ?? '-').join('\t')
}

describe('ACCESS_LOG_FORMAT', () => {
    it('has a field for every column parseLine reads', () => {
        assert.equal(ACCESS_LOG_FORMAT.split('\\t').length, line().split('\t').length)
    })
})

describe('parseLine', () => {
    it('counts a browser loading a page', () => {
        const hit = parseLine(line({ path: '/about/', referer: 'https://www.google.com/', country: 'AU' }), OWN)
        assert.equal(hit?.path, '/about')
        assert.equal(hit?.referrer, 'google.com')
        assert.equal(hit?.country, 'AU')
        assert.equal(hit?.time, 1760097600_000)
    })

    it('counts a Next.js page change, which fetches RSC rather than HTML', () => {
        assert.notEqual(parseLine(line({ accept: '*/*', rsc: '1' }), OWN), null)
    })

    it('ignores assets, API calls, prefetches, failures, HEAD and hostd\'s own paths', () => {
        assert.equal(parseLine(line({ path: '/_next/static/chunk.js' }), OWN), null)
        assert.equal(parseLine(line({ accept: 'application/json' }), OWN), null)
        assert.equal(parseLine(line({ rsc: '1', accept: '*/*', routerPrefetch: '1' }), OWN), null)
        assert.equal(parseLine(line({ secPurpose: 'prefetch;prerender' }), OWN), null)
        assert.equal(parseLine(line({ status: '404' }), OWN), null)
        assert.equal(parseLine(line({ status: '503' }), OWN), null)
        assert.equal(parseLine(line({ method: 'HEAD' }), OWN), null)
        assert.equal(parseLine(line({ path: '/.well-known/hostd/abc123' }), OWN), null)
        assert.equal(parseLine(line({ path: '/.hostd-maintenance' }), OWN), null)
        assert.equal(parseLine(line({ path: '/wp-login.php' }), OWN), null)
    })

    it('ignores bots, and a request with no user agent at all', () => {
        assert.equal(parseLine(line({ agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), OWN), null)
        assert.equal(parseLine(line({ agent: 'curl/8.5.0' }), OWN), null)
        assert.equal(parseLine(line({ agent: '-' }), OWN), null)
    })

    it('counts the site\'s own pages linking to each other as views, not as referrers', () => {
        assert.equal(parseLine(line({ referer: 'https://www.acme.com/contact' }), OWN)?.referrer, null)
    })

    it('reads the visitor from Cloudflare\'s header first, so every visitor is not Cloudflare', () => {
        const one = parseLine(line({ peer: '172.68.0.1', cfIp: '198.51.100.1' }), OWN)
        const two = parseLine(line({ peer: '172.68.0.1', cfIp: '198.51.100.2' }), OWN)
        const again = parseLine(line({ peer: '172.68.0.2', cfIp: '198.51.100.1' }), OWN)
        assert.notEqual(one?.visitor, two?.visitor)
        assert.equal(one?.visitor, again?.visitor)
    })

    it('never keeps the address itself', () => {
        assert.doesNotMatch(JSON.stringify(parseLine(line({ cfIp: '198.51.100.1' }), OWN)), /198\.51/)
    })

    it('refuses a line from another format rather than misreading it', () => {
        assert.equal(parseLine('203.0.113.9 - - [10/Oct/2026:13:00:00 +0000] "GET / HTTP/1.1" 200 512', OWN), null)
    })
})

describe('Analytics time zone', () => {
    it('counts a visit on the day it was where the panel is read', async () => {
        const { logDir, stateDir, name } = await fixture()
        // 20:00 UTC on the 9th is 06:00 on the 10th in Brisbane
        await writeFile(join(logDir, name), line({ time: at(Date.parse('2026-10-09T20:00:00Z')) }) + '\n')
        const report = await new Analytics({ logDir, stateDir, timeZone: 'Australia/Brisbane', now: () => NOON }).report('acme', 'live', [], 2)
        assert.deepEqual(report.days, [{ date: '2026-10-09', views: 0, visitors: 0 }, { date: '2026-10-10', views: 1, visitors: 1 }])
    })
})

describe('isBot', () => {
    it('lets ordinary browsers through', () => {
        assert.equal(isBot(CHROME), false)
        assert.equal(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), false)
    })
})

const DAY = 86_400_000
const NOON = Date.parse('2026-10-10T12:00:00Z')
const at = (ms: number) => String(Math.floor(ms / 1000))

async function fixture() {
    const logDir = await mkdtemp(join(tmpdir(), 'hostd-logs-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'hostd-analytics-'))
    const name = accessLogName('acme', 'live')
    return { logDir, stateDir, name }
}

describe('Analytics', () => {
    it('counts views and distinct visitors per day, across the live log and the rotated ones', async () => {
        const { logDir, stateDir, name } = await fixture()
        await writeFile(join(logDir, name), [
            line({ time: at(NOON), path: '/' }),
            line({ time: at(NOON + 1000), path: '/about', peer: '203.0.113.10' }),
            line({ time: at(NOON + 2000), path: '/about' }),
            line({ time: at(NOON), path: '/main.css' }),
        ].join('\n') + '\n')
        await writeFile(join(logDir, `${name}.1`), line({ time: at(NOON - DAY), referer: 'https://news.ycombinator.com/' }) + '\n')
        await writeFile(join(logDir, `${name}.2.gz`), gzipSync(line({ time: at(NOON - 2 * DAY), country: 'NZ' }) + '\n'))
        // Another environment's log in the same directory is none of this one's business
        await writeFile(join(logDir, accessLogName('acme', 'test')), line({ time: at(NOON) }) + '\n')

        const analytics = new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON + 3000 })
        const report = await analytics.report('acme', 'live', ['acme.com'], 3)

        assert.deepEqual(report.days, [
            { date: '2026-10-08', views: 1, visitors: 1 },
            { date: '2026-10-09', views: 1, visitors: 1 },
            { date: '2026-10-10', views: 3, visitors: 2 },
        ])
        assert.deepEqual(report.pages, [{ key: '/', count: 3 }, { key: '/about', count: 2 }])
        assert.deepEqual(report.referrers, [{ key: 'news.ycombinator.com', count: 1 }])
        assert.deepEqual(report.countries, [{ key: 'NZ', count: 1 }])
        assert.equal(report.since, '2026-10-08')
        assert.equal(report.logging, true)
    })

    it('keeps finished days after logrotate has dropped them, and never writes today', async () => {
        const { logDir, stateDir, name } = await fixture()
        await writeFile(join(logDir, name), line({ time: at(NOON) }) + '\n')
        await writeFile(join(logDir, `${name}.1`), line({ time: at(NOON - DAY) }) + '\n')
        await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON }).report('acme', 'live', [], 7)

        const saved = JSON.parse(await readFile(join(stateDir, 'acme-live.json'), 'utf8'))
        assert.deepEqual(Object.keys(saved.days), ['2026-10-09'])

        // A week later the rotated file is long gone, and the day is still there
        await writeFile(join(logDir, `${name}.1`), '')
        await writeFile(join(logDir, name), '')
        const later = await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON + 7 * DAY }).report('acme', 'live', [], 10)
        assert.equal(later.days.find(day => day.date === '2026-10-09')?.views, 1)
        assert.equal(later.since, '2026-10-09')
    })

    it('keeps the fuller count of a day the logs now only partly reach', async () => {
        const { logDir, stateDir, name } = await fixture()
        await writeFile(join(logDir, name), '')
        await writeFile(join(logDir, `${name}.1`), [line({ time: at(NOON - DAY) }), line({ time: at(NOON - DAY + 1) })].join('\n') + '\n')
        await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON }).report('acme', 'live', [], 7)

        await writeFile(join(logDir, `${name}.1`), line({ time: at(NOON - DAY) }) + '\n')
        const report = await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON }).report('acme', 'live', [], 7)
        assert.equal(report.days.find(day => day.date === '2026-10-09')?.views, 2)
    })

    it('does not read a rotated file again once every day in it is on record', async () => {
        const { logDir, stateDir, name } = await fixture()
        await writeFile(join(logDir, name), '')
        const old = join(logDir, `${name}.3.gz`)
        await writeFile(old, gzipSync(line({ time: at(NOON - 3 * DAY) }) + '\n'))
        await writeFile(join(logDir, `${name}.1`), line({ time: at(NOON - DAY) }) + '\n')
        await utimes(old, (NOON - 3 * DAY) / 1000, (NOON - 3 * DAY) / 1000)
        await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON }).report('acme', 'live', [], 7)

        // Garbage in the old file now would show if it were read: it is not
        await writeFile(old, gzipSync([1, 2, 3].map(() => line({ time: at(NOON - 3 * DAY) })).join('\n') + '\n'))
        await utimes(old, (NOON - 3 * DAY) / 1000, (NOON - 3 * DAY) / 1000)
        const report = await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON }).report('acme', 'live', [], 7)
        assert.equal(report.days.find(day => day.date === '2026-10-07')?.views, 1)
    })

    it('says when the environment is not being logged at all', async () => {
        const { logDir, stateDir } = await fixture()
        const report = await new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => NOON }).report('acme', 'live', [], 30)
        assert.equal(report.logging, false)
        assert.equal(report.since, null)
        assert.equal(report.days.length, 30)
        assert.ok(report.days.every(day => day.views === 0))
    })

    it('reuses a recent answer rather than reading the logs again', async () => {
        const { logDir, stateDir, name } = await fixture()
        await writeFile(join(logDir, name), line({ time: at(NOON) }) + '\n')
        let now = NOON
        const analytics = new Analytics({ logDir, stateDir, timeZone: 'UTC', now: () => now })
        assert.equal((await analytics.report('acme', 'live', [], 1)).days[0]?.views, 1)

        await writeFile(join(logDir, name), [line({ time: at(NOON) }), line({ time: at(NOON + 1) })].join('\n') + '\n')
        now = NOON + 30_000
        assert.equal((await analytics.report('acme', 'live', [], 1)).days[0]?.views, 1)
        now = NOON + 90_000
        assert.equal((await analytics.report('acme', 'live', [], 1)).days[0]?.views, 2)
    })
})
