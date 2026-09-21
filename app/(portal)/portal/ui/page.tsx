import type { Metadata } from 'next'
import { Container } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import AdminHeader from '../adminHeader'
import Emails from './emails'
import Gallery from './gallery'

export const metadata: Metadata = { title: 'UI', robots: { index: false, follow: false } }

export default async function UiGallery() {
    await requireAdmin()
    return (
        <Container maxWidth="lg" sx={{ pb: 6 }}>
            <AdminHeader />
            <Gallery />
            <Emails />
        </Container>
    )
}
