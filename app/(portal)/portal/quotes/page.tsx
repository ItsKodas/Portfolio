import type { Metadata } from 'next'
import Link from 'next/link'
import { Box, Chip, Container, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material'
import { WarningAmber } from '@mui/icons-material'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { emailsMissing } from '@/server/quotes/emails'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, STATUSES, STATUS_LABELS, type Status } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { STATUS_COLOURS, formatWhen } from '../format'
import AdminHeader from '../adminHeader'

export const metadata: Metadata = { title: 'Quotes' }

const isStatus = (value: string | undefined): value is Status => (STATUSES as readonly string[]).includes(value ?? '')

export default async function Inbox({ searchParams }: { searchParams: Promise<{ status?: string, archived?: string }> }) {
    await requireAdmin()
    const params = await searchParams
    const status = isStatus(params.status) ? params.status : undefined
    const archived = params.archived === '1'

    const repo = quoteRepo(getDb())
    const [quotes, newCount] = await Promise.all([repo.list({ status, archived }), repo.countNew()])
    const now = new Date()

    const filters: { label: string, href: string, active: boolean }[] = [
        { label: 'All', href: '/admin', active: !status && !archived },
        ...STATUSES.map(value => ({ label: STATUS_LABELS[value], href: `/admin?status=${value}`, active: status === value && !archived })),
        { label: 'Archived', href: '/admin?archived=1', active: archived },
    ]

    return (
        <Container maxWidth="lg" sx={{ pb: 6 }}>
            <AdminHeader />
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 2 }}>
                <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>Quotes</Typography>
                <Typography color="text.secondary">{newCount} new</Typography>
            </Box>

            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1, mb: 3 }}>
                {filters.map(filter => (
                    <Link key={filter.label} href={filter.href}>
                        <Chip label={filter.label} clickable color={filter.active ? 'primary' : 'default'} variant={filter.active ? 'filled' : 'outlined'} />
                    </Link>
                ))}
            </Stack>

            {quotes.length === 0 ? (
                <Typography color="text.secondary">Nothing here.</Typography>
            ) : (
                <Paper>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Received</TableCell>
                                    <TableCell>Name</TableCell>
                                    <TableCell>Company</TableCell>
                                    <TableCell>Project</TableCell>
                                    <TableCell>Budget</TableCell>
                                    <TableCell>Status</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {quotes.map(quote => (
                                    <TableRow key={quote.id} hover>
                                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatWhen(quote.createdAt)}</TableCell>
                                        <TableCell>
                                            <Link href={`/admin/quotes/${quote.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{quote.name}</Link>
                                            {emailsMissing(quote, now) && (
                                                <Tooltip title="An email for this quote was not sent">
                                                    <WarningAmber color="warning" sx={{ fontSize: 18, ml: 1, verticalAlign: 'middle' }} />
                                                </Tooltip>
                                            )}
                                        </TableCell>
                                        <TableCell>{quote.company}</TableCell>
                                        <TableCell>{quote.projectType && PROJECT_TYPE_LABELS[quote.projectType]}</TableCell>
                                        <TableCell>{quote.budget && BUDGET_LABELS[quote.budget]}</TableCell>
                                        <TableCell><Chip size="small" label={STATUS_LABELS[quote.status]} color={STATUS_COLOURS[quote.status]} /></TableCell>
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
