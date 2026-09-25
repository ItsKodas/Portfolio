import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowBack } from '@/ui/icons'

// Blastyard's page: the game's website for its store listings and the Epic Developer Portal, which asks for
// an application website and a privacy policy on a verified domain (the policy is ./privacy)
export const metadata: Metadata = {
    title: 'Blastyard',
    description: 'Blastyard is a third-person team arena shooter with jetpacks, wall runs and toy robots, made by Horizons.',
    alternates: { canonical: '/blastyard' },
}

const RELEASES = 'https://github.com/ItsKodas/blastyard/releases'

export default function BlastyardPage() {
    return (
        <main className="min-h-full bg-[#0b101f] px-5 py-16 text-[#dbe6f7] sm:py-24">
            <div className="mx-auto max-w-2xl">
                <Link href="/" className="mb-10 inline-flex items-center gap-2 text-sm font-medium text-[#8fd4f5]/80 transition-colors hover:text-white">
                    <ArrowBack size={16} /> Horizons
                </Link>
                <h1 className="sr-only">Blastyard</h1>
                <Image src="/blastyard/logo.png" alt="Blastyard" width={2400} height={960} priority className="mb-10 h-auto w-full max-w-lg" />
                <p className="mb-6 max-w-xl text-lg leading-relaxed text-[#dbe6f7]">
                    A third-person team arena shooter. Sprint, slide, wall run and jetpack around the arena as a toy robot,
                    and play team deathmatch with friends in lobbies anyone can host.
                </p>
                <p className="mb-10 max-w-xl text-base leading-relaxed text-[#b4c3dc]/80">
                    Blastyard is in early development for Windows, with a Steam release planned. Online play is protected
                    by Easy Anti-Cheat.
                </p>
                <div className="flex flex-wrap gap-3">
                    <a href={RELEASES} className="rounded-md bg-[#8fd4f5] px-4 py-2 text-sm font-semibold text-[#0b101f] transition-colors hover:bg-white">
                        Download the latest build
                    </a>
                    <Link href="/blastyard/privacy" className="rounded-md border border-[#8fd4f5]/40 px-4 py-2 text-sm font-semibold text-[#8fd4f5] transition-colors hover:border-white hover:text-white">
                        Privacy policy
                    </Link>
                </div>
            </div>
        </main>
    )
}
