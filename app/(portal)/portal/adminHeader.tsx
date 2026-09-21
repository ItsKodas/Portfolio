import Link from 'next/link'
import { Box, Button, Stack, Typography } from '@mui/material'

import { signOut } from '@/server/auth'

export default function AdminHeader() {
    async function signOutAction() {
        'use server'
        await signOut({ redirectTo: '/admin/sign-in' })
    }

    return (
        <Box component="header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 2, mb: 3, borderBottom: 1, borderColor: 'divider' }}>
            <Link href="/admin" style={{ color: 'inherit', textDecoration: 'none' }}>
                <Typography variant="h6" component="p" sx={{ fontWeight: 700 }}>Horizons admin</Typography>
            </Link>
            <Stack direction="row" spacing={2} sx={{ ml: 'auto', mr: 2 }}>
                <Link href="/admin" style={{ color: 'inherit' }}>Quotes</Link>
                <Link href="/admin/clients" style={{ color: 'inherit' }}>Clients</Link>
            </Stack>
            <form action={signOutAction}>
                <Button type="submit" size="small" color="inherit">Sign out</Button>
            </form>
        </Box>
    )
}
