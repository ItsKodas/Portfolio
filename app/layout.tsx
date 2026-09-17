import type { Metadata, Viewport } from "next"
import { Montserrat } from "next/font/google"
import "./globals.css"
import { PERF_SCRIPT } from "./perf/script"
import { SITE, SKILLS } from "./site"



const montserrat = Montserrat({ subsets: ["latin"] })


export const viewport: Viewport = {
	themeColor: SITE.colour,
	colorScheme: "dark",
}

// The share images come from opengraph-image.tsx and twitter-image.tsx beside this file, and the icons from favicon.ico
// and icon.tsx / apple-icon.tsx
export const metadata: Metadata = {
	metadataBase: new URL(SITE.url),
	title: {
		default: SITE.title,
		template: `%s · ${SITE.name}`,
	},
	description: SITE.description,
	applicationName: SITE.name,
	authors: [{ name: SITE.author, url: SITE.url }],
	creator: SITE.author,
	publisher: SITE.author,
	keywords: [SITE.author, SITE.name, "fullstack developer", "web developer", "web development", "portfolio", "freelance web developer", "website design", ...SKILLS],
	category: "technology",
	alternates: { canonical: "/" },
	robots: {
		index: true,
		follow: true,
		googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
	},
	openGraph: {
		type: "website",
		url: "/",
		siteName: SITE.name,
		title: SITE.title,
		description: SITE.description,
		locale: SITE.locale,
	},
	twitter: {
		card: "summary_large_image",
		title: SITE.title,
		description: SITE.description,
	},
	formatDetection: { telephone: false, email: false, address: false },
}



export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		// The head script marks the root with the performance mode before hydrating, which React would otherwise flag
		<html lang="en-AU" className="h-full" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: PERF_SCRIPT }} />
			</head>

			<body className={`${montserrat.className} antialiased h-full`}>
				{children}
			</body>
		</html>
	)
}
