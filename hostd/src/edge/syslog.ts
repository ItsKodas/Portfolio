// Receives NPM's per-site access log over UDP syslog and files each line where the analytics reader
// expects it. nginx sends `<PRI>Mmm dd hh:mm:ss hostd: <message>` (nohostname), and the message is the
// hostd log format, whose first tab-separated field is $host. That field only says which site the line is
// for; it is dropped, and the rest is what the old Apache format left in the file.

import { createSocket, type Socket } from 'node:dgram'
import { accessLogPath } from '../shared/analytics.ts'
import { hostnamesOf, type EnvironmentName, type Registry } from '../shared/registry.ts'

export type Route = (host: string) => { id: string, environment: EnvironmentName } | null

const DATAGRAM = /^<\d{1,3}>[A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d hostd: ([^\r\n]*)\r?\n?$/

// Every hostname the registry gives an environment, lowercased, mapped to its owner
export function routesOf(registry: Registry): Route {
    const map = new Map<string, { id: string, environment: EnvironmentName }>()
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) {
            for (const host of hostnamesOf(environment)) map.set(host.toLowerCase(), { id: project.id, environment: environment.name })
        }
    }
    return host => map.get(host.toLowerCase()) ?? null
}

export function syslogLine(datagram: string, source: string, allowed: string, route: Route, logDir = '/var/log/hostd'): { path: string, line: string } | null {
    // UDP source addresses can be forged, but the socket is bound to the private upstream network only
    if (source !== allowed) return null
    const match = DATAGRAM.exec(datagram)
    if (!match) return null
    const message = match[1] as string
    const tab = message.indexOf('\t')
    if (tab < 1) return null
    const owner = route(message.slice(0, tab))
    if (!owner) return null
    return { path: accessLogPath(logDir, owner.id, owner.environment), line: message.slice(tab + 1) }
}

export type SyslogOptions = {
    host: string
    port: number
    allowed: string
    logDir: string
    route: () => Route
    append: (path: string, line: string) => Promise<void>
    // Called for a failed append, never for a malformed datagram
    onError?: (error: unknown) => void
}

export function startSyslog(options: SyslogOptions): Socket {
    const socket = createSocket('udp4')
    socket.on('message', (message, remote) => {
        const entry = syslogLine(message.toString('utf8'), remote.address, options.allowed, options.route(), options.logDir)
        if (entry === null) return
        options.append(entry.path, `${entry.line}\n`).catch(error => options.onError?.(error))
    })
    // A socket error (not a bad datagram) is reported rather than left to crash the process
    socket.on('error', error => options.onError?.(error))
    socket.bind(options.port, options.host)
    return socket
}
