import type { Metadata } from 'next'

import { requireAdmin } from '@/server/auth'
import AdminHeader from '../adminHeader'
import frame from '../frame.module.css'
import Emails from './emails'
import Gallery from './gallery'

export const metadata: Metadata = { title: 'UI', robots: { index: false, follow: false } }

export default async function UiGallery() {
    await requireAdmin()
    return (
        <div className={frame.page}>
            <AdminHeader />
            <Gallery />
            <Emails />
        </div>
    )
}
