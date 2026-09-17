import type { Metadata, Viewport } from "next"
import { Montserrat } from "next/font/google"
import "./globals.css"
import { PERF_SCRIPT } from "./perf/script"



const montserrat = Montserrat({ subsets: ["latin"] })


export const viewport: Viewport = {
	themeColor: "#4eccfa"
}

export const metadata: Metadata = {
	title: "Horizons",
	description: "Description...",
	keywords: ["web development"],
	twitter: {
		// images: `${process.env.NEXT_PUBLIC_BASEURL}/meta_banner.png`
	},
	openGraph: {
		// images: `${process.env.NEXT_PUBLIC_BASEURL}/meta_banner.png`
	}
}



export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		// The head script marks the root with the performance mode before hydrating, which React would otherwise flag
		<html lang="en" className="h-full" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: PERF_SCRIPT }} />
				<link rel="apple-touch-icon" href="/banner.jpg" />
			</head>

			<body className={`${montserrat.className} antialiased h-full`}>
				{children}
			</body>
		</html>
	)
}
