import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markerFor } from '../shared/edge-protocol.ts'
import { certificateFor, describeHosts, renderHosts, tokenFromHosts, type HostsInput } from './npm-render.ts'

const BROTLI = `if ($http_content_encoding ~* "(^|,)\s*br\s*(,|$)") {
    return 415;
}`

function input(over: Partial<HostsInput> = {}): HostsInput {
    return {
        id: 'spotondrones', environment: 'live', primary: '1stcanzukbrigade.com', aliases: [], port: 3000,
        flexibleSsl: false, token: 'abc123def456', certificateId: 16,
        upstreamHost: '192.168.0.8', edgeHost: '192.168.0.8', edgeHttpPort: 8790, ...over,
    }
}

test('renders a Full SSL site', () => {
    const { proxy } = renderHosts(input())
    assert.equal(proxy.certificate_id, 16)
    assert.equal(proxy.ssl_forced, true)
    assert.equal(proxy.http2_support, true)
    assert.equal(proxy.forward_host, '192.168.0.8')
    assert.equal(proxy.forward_port, 3000)
    assert.deepEqual(proxy.domain_names, ['1stcanzukbrigade.com'])
})

test('renders a Flexible site', () => {
    const { proxy } = renderHosts(input({ flexibleSsl: true, certificateId: null }))
    assert.equal(proxy.certificate_id, 0)
    assert.equal(proxy.ssl_forced, false)
    assert.equal(proxy.http2_support, false)
})

test('advanced_config starts with the marker and carries the brotli snippet, the token location, the holding page and the syslog log', () => {
    const { proxy } = renderHosts(input())
    const config = proxy.advanced_config
    assert.equal(config.split('\n')[0], markerFor({ project: 'spotondrones', environment: 'live' }))
    for (const wanted of [
        'location = /.well-known/hostd/abc123def456 {',
        'add_header X-Hostd-Token "abc123def456" always;',
        'return 204;',
        'error_page 502 504 = @hostd_holding;',
        'rewrite ^ /holding/spotondrones-live break;',
        'proxy_pass http://192.168.0.8:8790;',
        'access_log syslog:server=192.168.0.8:5514,tag=hostd,nohostname hostd;',
        BROTLI,
    ]) assert.ok(config.includes(wanted), wanted)
    assert.ok(!config.includes('proxy_pass http://192.168.0.8:8790/'))
})

test('aliases go to a redirection host', () => {
    const spec = renderHosts(input({ primary: 'www.spotondrones.com', aliases: ['spotondrones.com'] }))
    const redirect = spec.redirection
    assert.ok(redirect)
    assert.deepEqual(redirect.domain_names, ['spotondrones.com'])
    assert.equal(redirect.forward_domain_name, 'www.spotondrones.com')
    assert.equal(redirect.certificate_id, spec.proxy.certificate_id)
    assert.equal(redirect.ssl_forced, spec.proxy.ssl_forced)
    assert.equal(redirect.http2_support, spec.proxy.http2_support)
    assert.equal(redirect.advanced_config.split('\n')[0], markerFor({ project: 'spotondrones', environment: 'live' }))
    assert.ok(redirect.advanced_config.includes('location = /.well-known/hostd/abc123def456 {'))
    assert.ok(!redirect.advanced_config.includes('error_page'))
    assert.ok(!redirect.advanced_config.includes('access_log'))
    assert.equal(renderHosts(input()).redirection, null)
})

test('certificateFor matches on a label boundary', () => {
    const certs = new Map([['spotondrones.com', 18], ['horizons.gg', 3]])
    assert.deepEqual(certificateFor(certs, ['redesign.spotondrones.com']), { ok: true, id: 18 })
    assert.deepEqual(certificateFor(certs, ['spotondrones.com', 'www.spotondrones.com']), { ok: true, id: 18 })
    const au = certificateFor(certs, ['spotondrones.com.au'])
    assert.ok(!au.ok && au.problem.includes('spotondrones.com.au'))
    assert.deepEqual(certificateFor(certs, ['mappies.horizons.gg']), { ok: true, id: 3 })
    const deep = certificateFor(certs, ['uat1.mappies.horizons.gg'])
    assert.ok(!deep.ok && deep.problem.includes('two labels below horizons.gg'))
    assert.equal(certificateFor(certs, ['a.horizons.gg', 'spotondrones.com']).ok, false)
    const nested = new Map([['horizons.gg', 3], ['mappies.horizons.gg', 9]])
    assert.deepEqual(certificateFor(nested, ['uat.mappies.horizons.gg']), { ok: true, id: 9 })
})

test('tokenFromHosts reads the token back', () => {
    const spec = renderHosts(input())
    assert.equal(tokenFromHosts(spec), 'abc123def456')
    assert.equal(tokenFromHosts({ proxy: { ...spec.proxy, advanced_config: 'nothing here' }, redirection: null }), null)
})

test('describeHosts lists domains, upstream, certificate, flags, redirect target and config', () => {
    const spec = renderHosts(input({ primary: 'www.spotondrones.com', aliases: ['spotondrones.com'] }))
    const text = describeHosts(spec)
    for (const wanted of ['Proxy host', 'www.spotondrones.com', '192.168.0.8:3000', 'Certificate: 16', 'SSL forced: yes', 'HTTP/2: yes', 'Redirection host', 'spotondrones.com', 'Redirects to: www.spotondrones.com', '    ' + markerFor({ project: 'spotondrones', environment: 'live' }), '    error_page 502 504 = @hostd_holding;']) {
        assert.ok(text.includes(wanted), wanted)
    }
    assert.ok(!describeHosts(renderHosts(input({ flexibleSsl: true, certificateId: null }))).includes('Redirection host'))
    assert.ok(describeHosts(renderHosts(input({ flexibleSsl: true, certificateId: null }))).includes('Certificate: none'))
})
