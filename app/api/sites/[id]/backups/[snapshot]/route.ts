import { openBackupDownload } from '@/server/hostd/backups'
import { readHostd } from '@/server/hostd/config'
import { hasAccess } from '@/server/hostd/projects'
import { relayBackupDownload } from '@/server/hostd/relay'
import { callerFromSession } from '@/server/hostd/session'
import { accessOf } from '@/server/sites/access'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string, snapshot: string }> }) {
    const { id, snapshot } = await params

    // Work out who is asking from the session alone. Nothing in the request may influence this.
    const who = await callerFromSession()
    if (!who) return Response.json({ code: 'forbidden', message: 'Sign in first.' }, { status: 403 })

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        console.error('hostd is not configured:', problems.join('; '))
        return Response.json({ code: 'unavailable', message: 'This is temporarily unavailable.' }, { status: 503 })
    }

    return relayBackupDownload(
        {
            config,
            caller: who.caller,
            clientId: who.clientId,
            mayWatch: (clientId, projectId) => hasAccess(clientId, projectId, accessOf, 'BACKUPS'),
            openBackupDownload,
        },
        id,
        snapshot,
    )
}
