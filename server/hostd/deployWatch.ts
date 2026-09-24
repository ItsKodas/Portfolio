// Opens the stream of a running deploy. The same shape as logs.ts and for the same reason: the portal
// proxies hostd's event stream rather than reading it, so the browser never holds a hostd token.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'
import { isEnvironmentName, type EnvironmentName } from './env'
import { fetchHostdStream, type LogStream, PROJECT_ID } from './logs'

export async function openDeployStream(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<LogStream> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    if (!isEnvironmentName(environment)) {
        return { ok: false, code: 'bad-request', message: 'no such environment' }
    }

    return fetchHostdStream(config, caller, `/projects/${id}/${environment}/deploy`, fetchImpl)
}
