import type { Metadata } from 'next'
import Link from 'next/link'
import { Box, Button, Chip, Container, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { formatWhen } from '../format'
import AdminHeader from '../header'
import { STATE_COLOURS, clientState } from './state'

export const metadata: Metadata = { title: 'Clients' }

export default async function ClientsPage() {
    await requireAdmin()
    const clients = await repo().list()
    const now = new Date()

    return (
        <Container maxWidth="lg" sx={{ pb: 6 }}>
            <AdminHeader />
            <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mb: 3, flexWrap: 'wrap' }}>
                <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>Clients</Typography>
                <Button variant="contained" component={Link} href="/admin/clients/new">New client</Button>
            </Box>

            {clients.length === 0 ? (
                <Typography color="text.secondary">No clients yet.</Typography>
            ) : (
                <Paper>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Name</TableCell>
                                    <TableCell>Company</TableCell>
                                    <TableCell>Email</TableCell>
                                    <TableCell>Status</TableCell>
                                    <TableCell>Sites</TableCell>
                                    <TableCell>Last sign-in</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {clients.map(client => (
                                    <TableRow key={client.id} hover>
                                        <TableCell>
                                            <Link href={`/admin/clients/${client.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{client.name}</Link>
                                        </TableCell>
                                        <TableCell>{client.company}</TableCell>
                                        <TableCell>{client.email}</TableCell>
                                        <TableCell>
                                            <Chip size="small" label={clientState(client, now)} color={STATE_COLOURS[clientState(client, now)]} />
                                        </TableCell>
                                        <TableCell>{client._count.sites}</TableCell>
                                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{client.lastSignInAt ? formatWhen(client.lastSignInAt) : 'Never'}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            )}
        </Container>
    )
}
