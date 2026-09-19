// Server-Sent Events framing. JSON.stringify never emits a raw newline, so one data line per event is
// always enough.

export function sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// A comment line. Keeps an idle follow stream from being timed out by anything in between.
export const SSE_KEEPALIVE = ': keepalive\n\n'
