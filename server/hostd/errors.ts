// hostd's messages name paths, project ids and services, which is right for the operator and wrong for a
// client. A client gets a fixed sentence chosen by code; the original is logged by the caller.

import 'server-only'

const CLIENT_MESSAGES: Record<string, string> = {
    unavailable: 'This is temporarily unavailable. Nothing has changed, and it is being looked at.',
    forbidden: 'You do not have access to this.',
    busy: 'Something else is already running on your site. Try again in a moment.',
    'not-found': 'This is not set up yet.',
}

export function forClient(code: string): string {
    return CLIENT_MESSAGES[code] ?? 'Something went wrong. Koda has been told.'
}

export function forAdmin(code: string, message: string): string {
    return `${code}: ${message}`
}
