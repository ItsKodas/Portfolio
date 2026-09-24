import { getDb } from '@/server/db'
import { readHostd } from '@/server/hostd/config'
import { openDeployStream } from '@/server/hostd/deployWatch'
import { assertOwned } from '@/server/hostd/projects'
import { relayDeployWatch } from '@/server/hostd/relay'
import { callerFromSession } from '@/server/hostd/session'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params

    // Work out who is asking from the session alone. Nothing in the request may influence this.
    const who = await callerFromSession()
    if (!who) return Response.json({ code: 'forbidden', message: 'Sign in first.' }, { status: 403 })

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        console.error('hostd is not configured:', problems.join('; '))
        return Response.json({ code: 'unavailable', message: 'This is temporarily unavailable.' }, { status: 503 })
    }

    const db = getDb()
    return relayDeployWatch(
        {
            config,
            caller: who.caller,
            clientId: who.clientId,
            assertOwned: (clientId, projectId) => assertOwned(clientId, projectId, async pid => {
                const site = await db.site.findUnique({ where: { projectId: pid }, select: { projectId: true, clientId: true } })
                return site
            }),
            openDeployStream,
        },
        id,
        new URL(request.url).searchParams,
    )
}
