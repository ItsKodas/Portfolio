import type { Metadata } from 'next'
import { Alert, Container, Paper, Stack, Typography } from '@mui/material'

import { requireClient } from '@/server/clients/auth'
import { repo } from '@/server/clients/wiring'
import PortalHeader from './header'

export const metadata: Metadata = { title: 'Portal' }

// Deliberately plain: a separate session is designing the client dashboard, and this page must not prejudge it.
export default async function PortalHome() {
    const { client } = await requireClient()
    const sites = await repo().listSites(client.id)

    return (
        <Container maxWidth="md" sx={{ pb: 6 }}>
            <PortalHeader name={client.name} />
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>
                {client.company ?? client.name}
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 4 }}>
                This is where your sites will appear. Controls are on the way.
            </Typography>
            {sites.length === 0
                ? <Alert severity="info">No sites are linked to your account yet. Koda will add them here.</Alert>
                : (
                    <Stack spacing={2}>
                        {sites.map(site => (
                            <Paper key={site.id} sx={{ p: 3 }}>
                                <Typography variant="h6" component="h2">{site.name}</Typography>
                                <Typography variant="body2" color="text.secondary">Controls are coming soon.</Typography>
                            </Paper>
                        ))}
                    </Stack>
                )}
        </Container>
    )
}
