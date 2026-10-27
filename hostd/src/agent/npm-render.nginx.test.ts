// Runs the rendered advanced_config through the real nginx's syntax check, which no unit test can stand
// in for. Skipped unless HOSTD_NGINX_CHECK=1, because it needs docker and pulls an image.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NGINX_LOG_FORMAT } from './analytics.ts'
import { renderHosts } from './npm-render.ts'

describe('rendered hosts under nginx -t', { skip: process.env.HOSTD_NGINX_CHECK !== '1' }, () => {
    it('are accepted by nginx', async () => {
        const spec = renderHosts({
            id: 'acme', environment: 'production', primary: 'acme.com', aliases: ['www.acme.com'], port: 3000,
            flexibleSsl: true, token: 'a'.repeat(32), certificateId: null,
            upstreamHost: '192.168.0.8', edgeHost: '192.168.0.8', edgeHttpPort: 8790,
        })
        assert.ok(spec.redirection)
        const dir = await mkdtemp(join(tmpdir(), 'hostd-nginx-'))
        try {
            const conf = `events {}
http {
    ${NGINX_LOG_FORMAT}
    server {
        listen 80;
        server_name acme.com;
${spec.proxy.advanced_config}
        location / { proxy_pass http://127.0.0.1:1; }
    }
    server {
        listen 80;
        server_name www.acme.com;
${spec.redirection.advanced_config}
        location / { return 301 https://x$request_uri; }
    }
}
`
            await writeFile(join(dir, 'nginx.conf'), conf)
            // The default mime.types is not needed: nothing in the config includes it
            execFileSync('docker', ['run', '--rm', '-v', `${dir}:/etc/nginx:ro`, 'nginx:1.27-alpine', 'nginx', '-t'], { stdio: 'pipe' })
        } catch (error) {
            const failed = error as { stderr?: Buffer }
            assert.fail(`nginx -t failed: ${failed.stderr?.toString() ?? String(error)}`)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
