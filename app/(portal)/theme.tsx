'use client'

// A plain dark MUI theme in the site's navy, for the client portal only. Copied from app/(admin)/admin/theme.tsx
// rather than shared: the admin area and the portal will diverge, and a shared theme would silently make every
// future admin tweak a client-facing change too.

import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'

const theme = createTheme({
    palette: {
        mode: 'dark',
        background: { default: '#0b101f', paper: '#111a38' },
        primary: { main: '#8fd4f5' },
        secondary: { main: '#f19bb3' },
    },
    typography: { fontFamily: 'inherit' },
    shape: { borderRadius: 12 },
})

export default function PortalTheme({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {children}
        </ThemeProvider>
    )
}
