import type { Metadata } from 'next'
import { Box, Chip, Container, Divider, Paper, Stack, Typography } from '@mui/material'

import { requireClient } from '@/server/clients/auth'
import { describeDevice } from '@/server/clients/account'
import { RECOVERY_CODE_COUNT } from '@/server/clients/setup'
import { repo } from '@/server/clients/wiring'
import { formatWhen } from '../format'
import PortalHeader from '../header'
import { ChangePasswordForm, RegenerateCodesForm, SignOutElsewhereButton } from '../forms'

export const metadata: Metadata = { title: 'Account' }

export default async function PortalAccountPage() {
    const { client, sessionId } = await requireClient()
    const [sessions, unusedCodes] = await Promise.all([
        repo().listSessions(client.id),
        repo().countUnusedRecoveryCodes(client.id),
    ])

    return (
        <Container maxWidth="md" sx={{ pb: 6 }}>
            <PortalHeader name={client.name} />
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 4 }}>Account</Typography>
            <Stack spacing={3}>
                <Paper sx={{ p: 3 }}>
                    <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Password</Typography>
                    <ChangePasswordForm />
                </Paper>

                <Paper sx={{ p: 3 }}>
                    <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Where you are signed in</Typography>
                    <Stack spacing={2} divider={<Divider />} sx={{ mb: sessions.length > 1 ? 2 : 0 }}>
                        {sessions.map(session => (
                            <Box key={session.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <Box>
                                    <Stack direction="row" spacing={1} alignItems="center">
                                        <Typography variant="body1">{describeDevice(session.userAgent)}</Typography>
                                        {session.id === sessionId && <Chip label="This device" size="small" color="primary" variant="outlined" />}
                                    </Stack>
                                    <Typography variant="body2" color="text.secondary">
                                        Last used {formatWhen(session.lastUsedAt)}
                                    </Typography>
                                </Box>
                            </Box>
                        ))}
                    </Stack>
                    {sessions.length > 1 && <SignOutElsewhereButton />}
                </Paper>

                <Paper sx={{ p: 3 }}>
                    <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Recovery codes</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        {unusedCodes} of {RECOVERY_CODE_COUNT} unused
                    </Typography>
                    <RegenerateCodesForm />
                </Paper>
            </Stack>
        </Container>
    )
}
