'use client'

// A plain dark MUI theme in the site's navy, for the admin area only

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

export default function AdminTheme({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {children}
        </ThemeProvider>
    )
}
