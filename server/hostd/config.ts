// Where hostd is and how to prove we are the portal. Its own group, so a missing hostd setting stops the
// portal pages that need it and leaves the landing page, the quote form and the inbox working.

import 'server-only'

import { required, type Env } from '../env'

export type HostdConfig = {
    url: string
    token: string
}

export function readHostd(env: Env, problems: string[]): HostdConfig {
    const url = required(env, 'HOSTD_URL', problems)
    if (url && !/^https?:\/\//.test(url)) problems.push('HOSTD_URL must be an http or https URL')

    const token = required(env, 'HOSTD_API_TOKEN', problems)
    // hostd refuses to start under 32 characters, so a shorter one here is a placeholder nobody filled in.
    // The length is reported, never the value.
    if (token && token.length < 32) problems.push('HOSTD_API_TOKEN must be at least 32 characters')

    return { url: url.replace(/\/+$/, ''), token }
}
