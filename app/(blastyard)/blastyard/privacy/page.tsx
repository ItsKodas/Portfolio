import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowBack } from '@/ui/icons'

// Blastyard's privacy policy, linked from the Epic Developer Portal (Epic Account Services) and later Steam.
// Keep it matched to what the game really does: the anti-cheat and login code is in
// ItsKodas/blastyard, unreal/Source/Blastyard/Net/BlastyardAntiCheat.cpp.
export const metadata: Metadata = {
    title: 'Blastyard privacy policy',
    description: 'What information Blastyard uses, why, and who it is shared with.',
    alternates: { canonical: '/blastyard/privacy' },
}

const UPDATED = '25 September 2026'
const ISSUES = 'https://github.com/ItsKodas/blastyard/issues'

function Section({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <section className="mb-10">
            <h2 className="mb-3 text-xl font-semibold text-white">{title}</h2>
            <div className="space-y-3 text-base leading-relaxed text-[#b4c3dc]/90">{children}</div>
        </section>
    )
}

function External({ href, children }: { href: string, children: React.ReactNode }) {
    return <a className="text-[#8fd4f5] underline underline-offset-2 hover:text-white" href={href}>{children}</a>
}

export default function BlastyardPrivacyPage() {
    return (
        <main className="min-h-full bg-[#0b101f] px-5 py-16 text-[#dbe6f7] sm:py-24">
            <article className="mx-auto max-w-2xl">
                <Link href="/blastyard" className="mb-10 inline-flex items-center gap-2 text-sm font-medium text-[#8fd4f5]/80 transition-colors hover:text-white">
                    <ArrowBack size={16} /> Blastyard
                </Link>
                <h1 className="mb-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">Privacy policy</h1>
                <p className="mb-12 text-sm text-[#b4c3dc]/70">Last updated {UPDATED}</p>

                <Section title="Who we are">
                    <p>
                        Blastyard is a game made by Horizons (Dakoda Lancelot). This policy explains what information the
                        game uses when you play, why, and who it is shared with. We don&apos;t show ads, sell information or
                        run analytics.
                    </p>
                </Section>

                <Section title="What the game uses">
                    <p><strong className="text-white">Your player name.</strong> The name you pick is shown to the other players in your lobbies. It is saved on your PC.</p>
                    <p>
                        <strong className="text-white">Your IP address.</strong> Online play connects players directly, so the
                        lobby&apos;s host can see the IP addresses of the players who join. When you host a lobby, its address
                        and name are sent to the Blastyard server list at horizons.gg so others can join it by code. The list
                        forgets a lobby when it closes.
                    </p>
                    <p>
                        <strong className="text-white">Your account id.</strong> For online play the game signs you in to Epic
                        Online Services with your Steam account or your Epic account. This gives you an Epic Online Services
                        user id, which is shared with the players in your lobby so Easy Anti-Cheat can check each of you. We
                        don&apos;t get your password or any account details beyond these ids and, for Epic accounts, your display
                        name.
                    </p>
                    <p>
                        <strong className="text-white">Anti-cheat data.</strong> Easy Anti-Cheat, run by Epic Games, checks the
                        game and your PC for cheats while you play online. It collects information about your device, the
                        game&apos;s files and the programs running alongside it. Epic handles this under its own privacy policy.
                    </p>
                    <p>
                        <strong className="text-white">Update checks.</strong> The game asks GitHub for new releases, which
                        tells GitHub your IP address.
                    </p>
                    <p>Practice mode works offline and sends none of this.</p>
                </Section>

                <Section title="Who it is shared with">
                    <p>
                        The other players in your lobbies, and the services the game relies on, each under their own policy:
                        {' '}<External href="https://www.epicgames.com/site/privacypolicy">Epic Games</External> (Epic Online
                        Services and Easy Anti-Cheat),
                        {' '}<External href="https://store.steampowered.com/privacy_agreement/">Valve</External> (Steam) and
                        {' '}<External href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">GitHub</External> (updates).
                    </p>
                </Section>

                <Section title="How long it is kept">
                    <p>
                        We don&apos;t keep a database of players. Server list entries last only while a lobby is open, and your
                        settings and name stay on your PC until you delete them. Epic keeps anti-cheat and account records for
                        as long as its privacy policy says.
                    </p>
                </Section>

                <Section title="Children">
                    <p>Blastyard isn&apos;t aimed at children under 13, and we don&apos;t knowingly collect information from them.</p>
                </Section>

                <Section title="Your choices and contact">
                    <p>
                        You can play Practice offline, and you can unlink Blastyard from your Epic account in your Epic
                        account settings. For questions or requests about your information, open an issue on
                        {' '}<External href={ISSUES}>Blastyard&apos;s GitHub</External>. If this policy changes, the date at the
                        top will change with it.
                    </p>
                </Section>
            </article>
        </main>
    )
}
