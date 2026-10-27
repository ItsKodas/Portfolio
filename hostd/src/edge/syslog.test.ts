import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { routesOf, startSyslog, syslogLine, type Route } from './syslog.ts'
import { parseRegistry } from '../shared/registry.ts'

const route: Route = host => host === 'www.spotondrones.com' ? { id: 'spotondrones', environment: 'live' } : null
const datagram = '<190>Oct 27 16:01:51 hostd: www.spotondrones.com\t1730000000.123\t10.0.0.1\tGET'

test('a datagram from NPM is filed under its environment without the host field', () => {
    assert.deepEqual(syslogLine(datagram, '192.168.0.5', '192.168.0.5', route), {
        path: '/var/log/hostd/hostd-spotondrones-live.access.log',
        line: '1730000000.123\t10.0.0.1\tGET',
    })
})

test('host matching ignores case', () => {
    const upper = datagram.replace('www.spotondrones.com', 'WWW.SpotOnDrones.com')
    assert.ok(syslogLine(upper, '192.168.0.5', '192.168.0.5', routesOf(registry())))
})

test('a datagram from anywhere else is dropped', () => {
    assert.equal(syslogLine(datagram, '192.168.0.9', '192.168.0.5', route), null)
})

test('an unknown host, a missing tag and a missing host field are dropped', () => {
    assert.equal(syslogLine(datagram.replace('www.spotondrones.com', 'evil.example'), '192.168.0.5', '192.168.0.5', route), null)
    assert.equal(syslogLine(datagram.replace('hostd:', 'other:'), '192.168.0.5', '192.168.0.5', route), null)
    assert.equal(syslogLine('<190>Oct 27 16:01:51 hostd: nohostfield', '192.168.0.5', '192.168.0.5', route), null)
    assert.equal(syslogLine('garbage', '192.168.0.5', '192.168.0.5', route), null)
})

test('a log line cannot smuggle a second line into the file', () => {
    assert.equal(syslogLine(`${datagram}\nfake`, '192.168.0.5', '192.168.0.5', route), null)
})

function registry() {
    return parseRegistry(`
projects:
  spotondrones:
    client: cl_1
    name: Spot On Drones
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/spotondrones, port: 5011, domain: www.spotondrones.com, aliases: [spotondrones.com] }
`)
}

test('routesOf maps every hostname of every environment, lowercased', () => {
    const lookup = routesOf(registry())
    assert.deepEqual(lookup('SpotOnDrones.com'), { id: 'spotondrones', environment: 'live' })
    assert.equal(lookup('other.example'), null)
})

test('the receiver appends over UDP, survives a failed append, and ignores strangers', async () => {
    const appended: Array<[string, string]> = []
    let failures = 0
    let failNext = true
    const socket = startSyslog({
        host: '127.0.0.1', port: 0, allowed: '127.0.0.1', logDir: '/logs', route: () => route,
        append: async (path, line) => {
            if (failNext) { failNext = false; throw new Error('disk full') }
            appended.push([path, line])
        },
        onError: () => { failures++ },
    })
    await new Promise<void>(resolve => socket.once('listening', resolve))
    const { port } = socket.address()
    const client = createSocket('udp4')
    const send = (text: string) => new Promise<void>(resolve => client.send(text, port, '127.0.0.1', () => resolve()))
    await send(datagram)
    await send('junk')
    await send(datagram)
    for (let i = 0; i < 50 && appended.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 20))
    client.close()
    socket.close()
    assert.equal(failures, 1)
    assert.deepEqual(appended, [['/logs/hostd-spotondrones-live.access.log', '1730000000.123\t10.0.0.1\tGET\n']])
})
