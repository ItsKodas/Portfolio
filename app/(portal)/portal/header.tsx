import Link from 'next/link'
import { Box, Button, Typography } from '@mui/material'

import { signOutAction } from './actions'

// Same shape as app/(admin)/admin/header.tsx: a wordmark, an identity, and a way out.
export default function PortalHeader({ name }: { name: string }) {
    return (
        <Box component="header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 2, mb: 3, borderBottom: 1, borderColor: 'divider' }}>
            <Link href="/portal" style={{ color: 'inherit', textDecoration: 'none' }}>
                <Typography variant="h6" component="p" sx={{ fontWeight: 700 }}>Horizons</Typography>
            </Link>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Typography variant="body2" color="text.secondary">{name}</Typography>
                <Link href="/portal/account" style={{ color: 'inherit', fontSize: '0.875rem' }}>Account</Link>
                <form action={signOutAction}>
                    <Button type="submit" size="small" color="inherit">Sign out</Button>
                </form>
            </Box>
        </Box>
    )
}
