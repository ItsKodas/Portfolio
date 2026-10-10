import { callerActor, record } from '@/server/audit/record'
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

    const response = await relayBackupDownload(
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
    // Recorded once hostd has agreed to hand it over, which is as close to "downloaded" as this side can see
    if (response.ok) {
        await record({
            kind: 'backup.download', actor: callerActor(who.caller), site: id,
            summary: `Downloaded backup ${snapshot}`, target: { type: 'backup', id: snapshot },
        })
    }
    return response
}
