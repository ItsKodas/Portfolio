import type { Metadata } from 'next'

import { ForgotForm, Panel } from '../forms'

export const metadata: Metadata = { title: 'Forgotten your password?' }

export default function ForgotPage() {
    return <Panel title="Forgotten your password?"><ForgotForm /></Panel>
}
