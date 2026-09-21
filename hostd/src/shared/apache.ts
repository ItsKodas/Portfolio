// The only language the host rail speaks. The agent writes a request, a systemd unit on the host acts on
// it and writes a result. Both files live in a bind-mounted directory that holds nothing else.
//
// Parsing is strict in the same spirit as the agent protocol: a result that is not exactly right is no
// result at all, because the alternative is treating a half-written file as an answer. The request is
// not parsed here at all, because nothing in this codebase reads one: the host script does, in shell.

export const APACHE_ACTIONS = ['reload', 'adopt'] as const
export type ApacheAction = typeof APACHE_ACTIONS[number]

export const REQUEST_FILE = 'request.json'
export const RESULT_FILE = 'result.json'

export type ApacheWrite = { path: string, text: string }

// One request does at most one write, any number of removals, and, for an adopt, moves named files out of
// sites-enabled. All three happen before the single configtest, which is what makes an adoption one
// reload rather than two.
export type ApacheRequest = {
    seq: number
    action: ApacheAction
    write: ApacheWrite | null
    remove: string[]
    disable: string[]
}

export type ApacheResult = { seq: number, ok: boolean, output: string }

export function parseApacheResult(text: string): ApacheResult | null {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        // A partially written file parses as nothing, which is the same answer as a file that is not
        // there yet: keep waiting. The sequence number is what eventually ends the wait.
        return null
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const { seq, ok, output } = value as Record<string, unknown>
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
    if (typeof ok !== 'boolean' || typeof output !== 'string') return null
    return { seq, ok, output }
}
