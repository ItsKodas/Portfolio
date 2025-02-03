import type { Metadata, Viewport } from "next"
import { Montserrat } from "next/font/google"
import "./globals.css"



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
		<html lang="en" className="h-full">
			<head>
				<link rel="apple-touch-icon" href="/banner.jpg" />
			</head>

			<body className={`${montserrat.className} antialiased h-full`}>
				{children}
			</body>
		</html>
	)
}
