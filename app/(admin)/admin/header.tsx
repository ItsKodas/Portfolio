import Link from 'next/link'
import { Box, Button, Typography } from '@mui/material'

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
            <form action={signOutAction}>
                <Button type="submit" size="small" color="inherit">Sign out</Button>
            </form>
        </Box>
    )
}
