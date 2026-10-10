// Page views and visitors for one environment, counted from the access log Apache writes for it. No
// script goes into a client's site and nothing about a visitor leaves the dedi: the log is already there,
// and all this keeps of it is counts.
//
// Every vhost hostd writes logs its serving blocks to accessLogPath() in ACCESS_LOG_FORMAT (see vhost.ts).
// logrotate rotates that file with the rest of /var/log/apache2 (daily, fourteen kept, the older ones
// gzipped), so the logs only reach back a fortnight. Each finished day is therefore also written to a
// small record of its own, and a window longer than the logs comes out of that.
//
// What counts as a page view is deliberately narrow. A browser loading a page asks for text/html (or, for
// a Next.js site moving between pages without a reload, sends RSC: 1); scripts, images, fonts, API calls
// and prefetches do not, and neither do most of the crawlers and uptime checkers that make up much of any
// site's traffic. What is left is filtered by user agent for the bots that do ask for HTML.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { TOP_ROWS, type AnalyticsCount, type AnalyticsDay, type AnalyticsReply } from '../shared/analytics.ts'
import type { EnvironmentName } from '../shared/registry.ts'

// Tab separated, because Apache escapes every control character in a logged value (a tab arrives as \t),
// so a tab can only ever be a separator. The order is the field order parseLine reads. %{sec}t is the
// request's time in seconds since the epoch, which needs no date parsing and has no time zone. %U is the
// path without the query string, which is both what a page is and the part least likely to carry
// anything personal. A header that was not sent is logged as "-".
//
// The client's address three ways, because which one is true depends on what is in front of the site:
// CF-Connecting-IP behind Cloudflare, the first X-Forwarded-For hop behind another proxy, and the peer
// address otherwise. None of them is written anywhere by this module; a visitor is a hash of the address
// and the user agent, held in memory while one day is counted.
const FIELDS = [
    '%{sec}t', '%a', '%{CF-Connecting-IP}i', '%{X-Forwarded-For}i', '%m', '%U', '%>s', '%{Referer}i', '%{User-Agent}i',
    '%{Accept}i', '%{RSC}i', '%{Next-Router-Prefetch}i', '%{Sec-Purpose}i', '%{Purpose}i', '%{CF-IPCountry}i',
] as const
// Written into the vhost as it stands here: a backslash and a t, which mod_log_config reads as a tab.
export const ACCESS_LOG_FORMAT = FIELDS.join('\\t')

export function accessLogName(id: string, environment: EnvironmentName): string {
    // .log last, so Debian's logrotate rule for /var/log/apache2/*.log rotates it with Apache's own.
    // Environment names have no hyphen, so the last hyphen always splits the two, as in vhostPath.
    return `hostd-${id}-${environment}.access.log`
}

export function accessLogPath(dir: string, id: string, environment: EnvironmentName): string {
    return posix.join(dir, accessLogName(id, environment))
}

export type Hit = {
    time: number
    visitor: string
    path: string
    referrer: string | null
    country: string | null
}

const absent = (value: string | undefined): string | null => (value === undefined || value === '' || value === '-' ? null : value)

// Apache's own escaping of a logged value, undone: \" and \\, and \xhh for anything unprintable.
function unescape(value: string): string {
    if (!value.includes('\\')) return value
    return value.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, code: string) => {
        if (code.length === 3) return String.fromCharCode(parseInt(code.slice(1), 16))
        return ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[code] ?? code
    })
}

// Crawlers, link unfurlers, monitors and command line clients. Not exhaustive and not meant to be: the
// page-view rule above already drops anything that does not ask for HTML, and this catches the ones that
// do and say who they are. A bot that pretends to be a browser is counted, as it would be anywhere.
const BOT = new RegExp([
    'bot\\b', 'bot/', 'crawl', 'spider', 'slurp', 'scrap', 'fetch', 'preview', 'monitor', 'uptime', 'pingdom', 'check',
    'headless', 'lighthouse', 'pagespeed', 'phantom', 'selenium', 'puppeteer', 'playwright',
    'curl', 'wget', 'httpie', 'python', 'go-http', 'java/', 'okhttp', 'axios', 'node', 'undici', 'libwww', 'perl', 'ruby', 'php',
    'facebookexternalhit', 'meta-external', 'embedly', 'whatsapp', 'telegram', 'discord', 'slack', 'skype', 'vkshare',
    'ahrefs', 'semrush', 'mj12', 'dotbot', 'petal', 'yandex', 'baidu', 'bytespider', 'sogou', 'applebot', 'duckduck',
    'gptbot', 'chatgpt', 'claude', 'anthropic', 'perplexity', 'ccbot', 'amazonbot', 'google-inspectiontool', 'googleother',
    'censys', 'zgrab', 'masscan', 'nmap', 'nuclei', 'expanse', 'palo alto', 'qualys', 'nessus',
].join('|'), 'i')

export function isBot(userAgent: string | null): boolean {
    // A browser always sends one; a request without is a script
    return userAgent === null || BOT.test(userAgent)
}

// Files a page asks for rather than pages, by extension, for the few clients that send text/html in
// Accept for everything.
const ASSET = /\.(?:js|mjs|css|map|json|xml|txt|ico|png|jpe?g|gif|webp|avif|svg|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|webmanifest|php|env|ini|bak|sql|ya?ml|cgi|asp|aspx|jsp)$/i

// The page as the panel lists it: no trailing slash but the root's, and short enough to sit in a row.
function pageOf(path: string): string {
    const trimmed = path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') || '/' : path
    return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed
}

// Only another site's address counts as a referrer. The site's own hostnames are every link a visitor
// clicked inside it, which is a page view already.
function referrerOf(referer: string | null, own: ReadonlySet<string>): string | null {
    if (referer === null) return null
    let host: string
    try {
        host = new URL(referer).hostname.toLowerCase()
    } catch {
        return null
    }
    if (host === '' || own.has(host)) return null
    return host.startsWith('www.') ? host.slice(4) : host
}

// One line of the log, as a page view, or null when it is not one. own is the environment's hostnames.
export function parseLine(line: string, own: ReadonlySet<string>): Hit | null {
    const fields = line.split('\t')
    if (fields.length !== FIELDS.length) return null
    const at = (index: number): string | null => absent(fields[index])
    const sec = at(0), peer = at(1), cfIp = at(2), forwarded = at(3), method = at(4), rawPath = at(5), status = at(6)
    const referer = at(7), userAgent = at(8), accept = at(9), rsc = at(10), routerPrefetch = at(11), secPurpose = at(12)
    const purpose = at(13), country = at(14)

    const time = Number(sec)
    if (!Number.isFinite(time) || time <= 0) return null
    if (method !== 'GET') return null
    const code = Number(status)
    if (!((code >= 200 && code < 300) || code === 304)) return null
    if (rawPath === null) return null
    const path = unescape(rawPath)
    if (!path.startsWith('/') || path.startsWith('/.well-known/') || path.startsWith('/.hostd-maintenance') || ASSET.test(path)) return null

    // A prefetch is the browser guessing, not somebody reading
    if (routerPrefetch !== null) return null
    if (/prefetch|prerender/i.test(`${secPurpose ?? ''} ${purpose ?? ''}`)) return null
    const document = (accept !== null && /text\/html/i.test(accept)) || rsc === '1'
    if (!document) return null

    const agent = userAgent === null ? null : unescape(userAgent)
    if (isBot(agent)) return null

    const address = cfIp ?? forwarded?.split(',')[0]?.trim() ?? peer ?? ''
    const visitor = createHash('sha256').update(`${address}\n${agent}`).digest('base64').slice(0, 16)
    return {
        time: time * 1000,
        visitor,
        path: pageOf(path),
        referrer: referrerOf(referer === null ? null : unescape(referer), own),
        country: country !== null && /^[A-Z]{2}$/.test(country) && country !== 'XX' ? country : null,
    }
}

// The calendar day an instant falls on, YYYY-MM-DD, in the time zone the panel counts days in. Memoised
// by quarter hour, because every log line asks and Intl is slow by comparison: no zone's offset changes
// at a finer step than that.
export function dayCounter(timeZone: string): (ms: number) => string {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    const memo = new Map<number, string>()
    return ms => {
        const slot = Math.floor(ms / 900_000)
        let day = memo.get(slot)
        if (day === undefined) {
            day = format.format(slot * 900_000)
            if (memo.size > 10_000) memo.clear()
            memo.set(slot, day)
        }
        return day
    }
}

// A calendar date moved by whole days, which is arithmetic on the date alone and has no time zone
export function shiftDay(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

// One day's counts as they are kept: the top of each list, not all of it, so a day with ten thousand
// distinct paths (a scanner trying every one) still costs a few kilobytes.
export type DayRecord = {
    views: number
    visitors: number
    pages: Record<string, number>
    referrers: Record<string, number>
    countries: Record<string, number>
}
const KEPT_PER_DAY = 50

type Bucket = {
    views: number
    visitors: Set<string>
    pages: Map<string, number>
    referrers: Map<string, number>
    countries: Map<string, number>
}

const bump = (map: Map<string, number>, key: string | null) => {
    if (key !== null) map.set(key, (map.get(key) ?? 0) + 1)
}

function topOf(map: Map<string, number> | Record<string, number>, limit: number): Array<[string, number]> {
    const entries = map instanceof Map ? [...map] : Object.entries(map)
    return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)
}

function recordOf(bucket: Bucket): DayRecord {
    return {
        views: bucket.views,
        visitors: bucket.visitors.size,
        pages: Object.fromEntries(topOf(bucket.pages, KEPT_PER_DAY)),
        referrers: Object.fromEntries(topOf(bucket.referrers, KEPT_PER_DAY)),
        countries: Object.fromEntries(topOf(bucket.countries, KEPT_PER_DAY)),
    }
}

export type AnalyticsFs = {
    readdir(dir: string): Promise<string[]>
    // Last modification, in milliseconds; null when the file is not there
    mtime(path: string): Promise<number | null>
    // The file's lines, gunzipped when the name ends .gz
    lines(path: string): AsyncIterable<string>
    readFile(path: string): Promise<string | null>
    // Atomically, by rename, so a crash mid-write leaves the previous record rather than half of one
    writeFile(path: string, text: string): Promise<void>
}

export const realAnalyticsFs: AnalyticsFs = {
    readdir: async dir => {
        try {
            return await readdir(dir)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw error
        }
    },
    mtime: async path => {
        try {
            return (await stat(path)).mtimeMs
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
    },
    lines: path => {
        const raw = createReadStream(path)
        const input = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
        // A truncated .gz (logrotate mid-compress) ends the file early rather than failing the whole read
        input.on('error', () => input.emit('end'))
        return createInterface({ input, crlfDelay: Infinity })
    },
    readFile: async path => {
        try {
            return await readFile(path, 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
    },
    writeFile: async (path, text) => {
        await mkdir(posix.dirname(path), { recursive: true })
        await writeFile(`${path}.tmp`, text, 'utf8')
        await rename(`${path}.tmp`, path)
    },
}

export type AnalyticsDeps = {
    // Where Apache writes the access logs: the vhosts name files in it, and this reads them back
    logDir: string
    // Where the record of finished days is kept, one file per environment
    stateDir: string
    // The zone days are counted in: where the people reading the panel are, not where the server is
    timeZone: string
    fs?: AnalyticsFs
    now?: () => number
}

// How long one environment's answer is reused. Long enough that reloading the overview does not reread
// a fortnight of logs, short enough that the numbers for today still move while somebody watches.
const CACHE_MS = 60_000
// How long a finished day is kept for, well beyond the longest window anyone can ask for
const KEEP_DAYS = 400

type StateFile = { version: 1, days: Record<string, DayRecord> }

export class Analytics {
    private readonly fs: AnalyticsFs
    private readonly now: () => number
    private readonly dayOf: (ms: number) => string
    private readonly cache = new Map<string, { at: number, days: Map<string, DayRecord>, logging: boolean }>()
    // One read per environment at a time: a second request while the logs are being read waits for that
    // read rather than starting another one beside it.
    private readonly reading = new Map<string, Promise<{ days: Map<string, DayRecord>, logging: boolean }>>()

    constructor(private readonly deps: AnalyticsDeps) {
        this.fs = deps.fs ?? realAnalyticsFs
        this.now = deps.now ?? Date.now
        this.dayOf = dayCounter(deps.timeZone)
    }

    async report(id: string, environment: EnvironmentName, hostnames: string[], windowDays: number): Promise<AnalyticsReply> {
        const { days, logging } = await this.counted(id, environment, hostnames)

        const today = this.dayOf(this.now())
        const window: AnalyticsDay[] = []
        const pages = new Map<string, number>()
        const referrers = new Map<string, number>()
        const countries = new Map<string, number>()
        for (let back = windowDays - 1; back >= 0; back--) {
            const date = shiftDay(today, -back)
            const record = days.get(date)
            window.push({ date, views: record?.views ?? 0, visitors: record?.visitors ?? 0 })
            if (!record) continue
            for (const [key, count] of Object.entries(record.pages)) pages.set(key, (pages.get(key) ?? 0) + count)
            for (const [key, count] of Object.entries(record.referrers)) referrers.set(key, (referrers.get(key) ?? 0) + count)
            for (const [key, count] of Object.entries(record.countries)) countries.set(key, (countries.get(key) ?? 0) + count)
        }

        const rows = (map: Map<string, number>): AnalyticsCount[] => topOf(map, TOP_ROWS).map(([key, count]) => ({ key, count }))
        const dates = [...days.keys()].sort()
        return {
            ok: true,
            environment,
            days: window,
            pages: rows(pages),
            referrers: rows(referrers),
            countries: rows(countries),
            since: dates[0] ?? null,
            logging,
        }
    }

    private async counted(id: string, environment: EnvironmentName, hostnames: string[]): Promise<{ days: Map<string, DayRecord>, logging: boolean }> {
        const key = `${id}:${environment}`
        const cached = this.cache.get(key)
        if (cached && this.now() - cached.at < CACHE_MS) return cached

        const running = this.reading.get(key)
        if (running) return running
        const read = this.read(id, environment, hostnames)
            .then(result => {
                this.cache.set(key, { at: this.now(), ...result })
                return result
            })
            .finally(() => this.reading.delete(key))
        this.reading.set(key, read)
        return read
    }

    private statePath(id: string, environment: EnvironmentName): string {
        return posix.join(this.deps.stateDir, `${id}-${environment}.json`)
    }

    private async loadState(id: string, environment: EnvironmentName): Promise<Map<string, DayRecord>> {
        const text = await this.fs.readFile(this.statePath(id, environment))
        if (text === null) return new Map()
        try {
            const parsed = JSON.parse(text) as StateFile
            if (parsed?.version !== 1 || typeof parsed.days !== 'object' || parsed.days === null) return new Map()
            return new Map(Object.entries(parsed.days))
        } catch {
            // A record that will not parse is started again: it only holds counts the logs held first
            return new Map()
        }
    }

    private async read(id: string, environment: EnvironmentName, hostnames: string[]): Promise<{ days: Map<string, DayRecord>, logging: boolean }> {
        const stored = await this.loadState(id, environment)
        const today = this.dayOf(this.now())
        // The latest day the record already holds. A rotated file last written before that day began can
        // only hold days the record already has, so it is not read again.
        const latestStored = [...stored.keys()].sort().at(-1) ?? null
        // A day earlier than that in UTC terms, which covers the start of the day in any zone
        const skipBefore = latestStored === null ? null : Date.parse(`${shiftDay(latestStored, -1)}T00:00:00Z`)

        const name = accessLogName(id, environment)
        const files = (await this.fs.readdir(this.deps.logDir)).filter(file => file === name || file.startsWith(`${name}.`))
        const logging = files.includes(name)

        const own = new Set(hostnames.map(host => host.toLowerCase()))
        const buckets = new Map<string, Bucket>()
        for (const file of files) {
            const path = posix.join(this.deps.logDir, file)
            if (file !== name && skipBefore !== null) {
                const mtime = await this.fs.mtime(path)
                if (mtime !== null && mtime < skipBefore) continue
            }
            for await (const line of this.fs.lines(path)) {
                const hit = parseLine(line, own)
                if (hit === null) continue
                const date = this.dayOf(hit.time)
                let bucket = buckets.get(date)
                if (!bucket) {
                    bucket = { views: 0, visitors: new Set(), pages: new Map(), referrers: new Map(), countries: new Map() }
                    buckets.set(date, bucket)
                }
                bucket.views++
                bucket.visitors.add(hit.visitor)
                bump(bucket.pages, hit.path)
                bump(bucket.referrers, hit.referrer)
                bump(bucket.countries, hit.country)
            }
        }

        // The record wins for a day it holds more of. The oldest day the logs still reach is only partly
        // in them (rotation cut it in two), and the record saw it whole before that happened.
        const days = new Map(stored)
        for (const [date, bucket] of buckets) {
            const fresh = recordOf(bucket)
            const kept = stored.get(date)
            if (!kept || fresh.views >= kept.views) days.set(date, fresh)
        }

        // Only finished days are written: today's count is still moving, and comes from the log each time.
        const cutoff = shiftDay(today, -KEEP_DAYS)
        const finished = Object.fromEntries([...days].filter(([date]) => date < today && date >= cutoff).sort(([a], [b]) => a.localeCompare(b)))
        const changed = JSON.stringify(finished) !== JSON.stringify(Object.fromEntries([...stored].sort(([a], [b]) => a.localeCompare(b))))
        if (changed) await this.fs.writeFile(this.statePath(id, environment), JSON.stringify({ version: 1, days: finished } satisfies StateFile))

        return { days, logging }
    }
}
