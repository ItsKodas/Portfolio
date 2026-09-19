// The Docker healthcheck for both containers: exit 0 when the status file is ok and fresh.

import { readFileSync } from 'node:fs'
import { isHealthy } from './status.ts'

const path = process.argv[2] ?? '/tmp/hostd-status.json'
let text = ''
try {
    text = readFileSync(path, 'utf8')
} catch {
    process.exit(1)
}
process.exit(isHealthy(text, Date.now()) ? 0 : 1)
