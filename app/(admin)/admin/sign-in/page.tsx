import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Alert, Box, Button, Paper, Typography } from '@mui/material'

import { auth, signIn } from '@/server/auth'
import { isAdminSession } from '@/server/auth/allow'

export const metadata: Metadata = { title: 'Sign in' }

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
    if (isAdminSession(await auth(), process.env.ADMIN_EMAIL)) redirect('/admin')
    const { error } = await searchParams

    async function signInWithGoogle() {
        'use server'
        await signIn('google', { redirectTo: '/admin' })
    }

    return (
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
            <Paper sx={{ p: 4, width: '100%', maxWidth: 380 }}>
                <Typography variant="h5" component="h1" sx={{ mb: 3, fontWeight: 700 }}>Horizons admin</Typography>
                {error && (
                    <Alert severity="error" sx={{ mb: 3 }}>
                        {error === 'AccessDenied' ? 'That Google account is not authorised.' : 'Sign-in failed. Please try again.'}
                    </Alert>
                )}
                <form action={signInWithGoogle}>
                    <Button type="submit" variant="contained" fullWidth size="large">Sign in with Google</Button>
                </form>
            </Paper>
        </Box>
    )
}
