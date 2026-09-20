import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Box, Chip, Container, Divider, Paper, Stack, Typography } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { getDb } from '@/server/db'
import { quoteRepo } from '@/server/quotes/repo'
import { formatWhen } from '../../format'
import AdminHeader from '../../header'
import {
    AddSiteForm, ClearLockButton, ClientForm, ClientId, DeleteClientButton, RemoveSiteButton,
    ResendInviteButton, ResetTwoFactorButton, SendResetButton, SuspendButton,
} from '../controls'
import { STATE_COLOURS, clientState } from '../state'

export const metadata: Metadata = { title: 'Client' }

function Detail({ label, children }: { label: string, children: React.ReactNode }) {
    return (
        <Box>
            <Typography variant="caption" color="text.secondary" component="p">{label}</Typography>
            <Typography component="div">{children}</Typography>
        </Box>
    )
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const clients = repo()
    const client = await clients.byId(id)
    if (!client) notFound()

    const [sites, sessions, unusedRecoveryCodes, quotes] = await Promise.all([
        clients.listSites(id),
        clients.listSessions(id),
        clients.countUnusedRecoveryCodes(id),
        quoteRepo(getDb()).listForClient(id),
    ])

    const now = new Date()
    const state = clientState(client, now)

    return (
        <Container maxWidth="md" sx={{ pb: 6 }}>
            <AdminHeader />
            <Stack direction="row" sx={{ alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
                <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>{client.name}</Typography>
                <Chip label={state} color={STATE_COLOURS[state]} />
            </Stack>
            <Box sx={{ mb: 3 }}><ClientId id={client.id} /></Box>

            <Paper sx={{ p: 3, mb: 3 }}>
                <ClientForm clientId={client.id} initial={{ name: client.name, company: client.company, email: client.email }} />
            </Paper>

            <Paper sx={{ p: 3, mb: 3 }}>
                <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Account</Typography>
                <Stack sx={{ gap: 2 }}>
                    <Detail label="Last sign-in">{client.lastSignInAt ? formatWhen(client.lastSignInAt) : 'Never'}</Detail>
                    <Detail label="Recovery codes remaining">{unusedRecoveryCodes}</Detail>
                    <Detail label="Sessions">
                        {sessions.length === 0 ? 'None' : (
                            <Stack sx={{ gap: 0.5 }}>
                                {sessions.map(session => (
                                    <Typography key={session.id} variant="body2">
                                        {formatWhen(session.lastUsedAt)}{session.mfaAt ? '' : ' (not yet verified)'}
                                        {session.userAgent && ` (${session.userAgent})`}
                                    </Typography>
                                ))}
                            </Stack>
                        )}
                    </Detail>
                </Stack>
                <Divider sx={{ my: 2 }} />
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {!client.passwordHash && <ResendInviteButton clientId={client.id} />}
                    <SendResetButton clientId={client.id} />
                    <ResetTwoFactorButton clientId={client.id} />
                    <SuspendButton clientId={client.id} suspended={!!client.suspendedAt} />
                    {client.lockedUntil && client.lockedUntil.getTime() > now.getTime() && <ClearLockButton clientId={client.id} />}
                    <DeleteClientButton clientId={client.id} />
                </Stack>
            </Paper>

            <Paper sx={{ p: 3, mb: 3 }}>
                <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Sites</Typography>
                <Stack sx={{ gap: 1, mb: 2 }}>
                    {sites.length === 0 ? <Typography color="text.secondary">No sites linked yet.</Typography> : sites.map(site => (
                        <Stack key={site.id} direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                            <Typography sx={{ flex: 1 }}>{site.name} <Typography component="span" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{site.projectId}</Typography></Typography>
                            <RemoveSiteButton clientId={client.id} siteId={site.id} />
                        </Stack>
                    ))}
                </Stack>
                <AddSiteForm clientId={client.id} />
            </Paper>

            <Paper sx={{ p: 3 }}>
                <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Linked quotes</Typography>
                {quotes.length === 0 ? <Typography color="text.secondary">No quotes linked.</Typography> : (
                    <Stack sx={{ gap: 1 }}>
                        {quotes.map(quote => (
                            <Typography key={quote.id}>
                                <Link href={`/admin/quotes/${quote.id}`} style={{ color: 'inherit' }}>{quote.name}</Link>
                                <Typography component="span" color="text.secondary"> ({formatWhen(quote.createdAt)})</Typography>
                            </Typography>
                        ))}
                    </Stack>
                )}
            </Paper>
        </Container>
    )
}
