// The one line of a site's .env that hostd owns: <portEnv>=<port>. The site's compose file publishes it
// (ports: ["127.0.0.1:${WEB_PORT}:3000"]), which is how the port chosen in the portal is the port the
// site actually binds. The root .env, because that is the file compose reads for interpolation when it
// runs with --project-directory set to the environment's folder, as every compose call hostd makes does.
// Writes go through env-files.ts, so this stays inside the same boundary every other env write does.

import type { EnvironmentEntry } from '../shared/registry.ts'
import { readEnvFileIfPresent, writeEnvFile, type EnvFs } from './env-files.ts'

export const PORT_ENV_FILE = '.env'

// key is always an ENV_VAR_NAME (capitals, digits, underscores; see registry.ts's parsePortEnv), so it is safe
// to put straight into a pattern. An `export` prefix and spaces around = are the same key to compose, and
// a later copy of it would win over the one written here, so later copies are dropped.
export function withEnvValue(text: string, key: string, value: string): string {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
    let found = false
    const lines: string[] = []
    for (const line of text.split('\n')) {
        if (!pattern.test(line)) {
            lines.push(line)
            continue
        }
        if (!found) lines.push(`${key}=${value}`)
        found = true
    }
    if (found) return lines.join('\n')
    const body = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${body}${key}=${value}\n`
}

export async function writePortEnv(
    environment: EnvironmentEntry, key: string, port: number, fs?: EnvFs,
): Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }> {
    const read = await readEnvFileIfPresent(environment, PORT_ENV_FILE, fs)
    if (!read.ok) return read
    const written = await writeEnvFile(environment, PORT_ENV_FILE, withEnvValue(read.text ?? '', key, String(port)), fs)
    return written.ok ? { ok: true, previous: read.text } : written
}

// EnvFs has no unlink, so a .env this created is emptied rather than removed. An empty .env reads the
// same as a missing one to compose.
export async function restorePortEnv(
    environment: EnvironmentEntry, previous: string | null, fs?: EnvFs,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    return writeEnvFile(environment, PORT_ENV_FILE, previous ?? '', fs)
}
