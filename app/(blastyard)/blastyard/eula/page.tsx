import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowBack } from '@/ui/icons'

// Blastyard's end user licence agreement, linked from the Epic Games Store's store settings (Terms of use > EULA link)
// and later Steam. It sits beside ../privacy and should stay in step with it.
export const metadata: Metadata = {
    title: 'Blastyard end user licence agreement',
    description: 'The terms you agree to when you install or play Blastyard.',
    alternates: { canonical: '/blastyard/eula' },
}

const UPDATED = '29 September 2026'

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

const LINK = 'text-[#8fd4f5] underline underline-offset-2 hover:text-white'

export default function BlastyardEulaPage() {
    return (
        <main className="min-h-full bg-[#0b101f] px-5 py-16 text-[#dbe6f7] sm:py-24">
            <article className="mx-auto max-w-2xl">
                <Link href="/blastyard" className="mb-10 inline-flex items-center gap-2 text-sm font-medium text-[#8fd4f5]/80 transition-colors hover:text-white">
                    <ArrowBack size={16} /> Blastyard
                </Link>
                <h1 className="mb-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">End user licence agreement</h1>
                <p className="mb-12 text-sm text-[#b4c3dc]/70">Last updated {UPDATED}</p>

                <Section title="The agreement">
                    <p>
                        This agreement is between you and Horizons (Dakoda Lancelot), who makes Blastyard. By installing or
                        playing Blastyard, including its test and beta builds, you agree to it. If you don&apos;t agree, don&apos;t
                        install or play the game. The store you got Blastyard from (for example the Epic Games Store) has its own
                        terms, which also apply.
                    </p>
                </Section>

                <Section title="Your licence">
                    <p>
                        We give you a personal, non-exclusive, non-transferable licence to install Blastyard and play it for your
                        own non-commercial entertainment, on devices you own or control, for as long as you have it from an
                        authorised store. The game is licensed to you, not sold: Horizons and its licensors keep all rights in it,
                        including its code, art, sounds, names and logos.
                    </p>
                    <p>
                        You may stream and record Blastyard and share videos and screenshots of it, including on monetised
                        channels, as long as you don&apos;t suggest Horizons endorses you.
                    </p>
                </Section>

                <Section title="What you must not do">
                    <p>Unless the law lets you do it anyway, you must not:</p>
                    <ul className="list-disc space-y-2 pl-6">
                        <li>copy, sell, rent, lend or share the game or your access to it, or share beta keys or test builds without our permission;</li>
                        <li>reverse engineer, decompile or modify the game, or get around its copy protection or Easy Anti-Cheat;</li>
                        <li>use cheats, bots, exploits or any unauthorised software that gives you an advantage or changes online play;</li>
                        <li>harass, threaten or abuse other players, or use names or content that are hateful or unlawful;</li>
                        <li>disrupt or overload lobbies, servers or the services the game uses.</li>
                    </ul>
                    <p>
                        We may block or remove players who break these rules from online play, and Easy Anti-Cheat may ban
                        accounts it finds cheating.
                    </p>
                </Section>

                <Section title="Early development and beta builds">
                    <p>
                        Blastyard is in development. Features, maps and weapons may change or be removed, progress and settings
                        may be reset, and builds may have bugs or crash. Beta access is given at our discretion and can end at any
                        time. Please report problems you find so they can be fixed.
                    </p>
                </Section>

                <Section title="Online play and third-party services">
                    <p>
                        Online play needs an internet connection and relies on services run by others, including Epic Online
                        Services and Easy Anti-Cheat by Epic Games, and Steam by Valve. Their terms apply to your use of them. We
                        may change or stop online features, and we can&apos;t promise they will always be available.
                    </p>
                    <p>
                        How the game uses your information is explained in the
                        {' '}<Link className={LINK} href="/blastyard/privacy">privacy policy</Link>.
                    </p>
                </Section>

                <Section title="Updates">
                    <p>
                        The game may update itself through the store you got it from. Updates are covered by this agreement, and
                        some online features may need the latest version.
                    </p>
                </Section>

                <Section title="Ending this licence">
                    <p>
                        You can end this agreement at any time by uninstalling Blastyard. We may end your licence if you seriously
                        or repeatedly break it. When it ends, you must stop playing and delete the game.
                    </p>
                </Section>

                <Section title="Warranties and liability">
                    <p>
                        Nothing in this agreement limits rights you have under consumer law that can&apos;t be excluded, including
                        the consumer guarantees under the Australian Consumer Law. Beyond those rights, the game is provided as is,
                        and to the extent the law allows, Horizons isn&apos;t liable for indirect or consequential loss, or for loss
                        of data, arising from your use of the game. Where our liability can be limited, it is limited to
                        supplying the game again or to the amount you paid for it.
                    </p>
                </Section>

                <Section title="Epic Games">
                    <p>
                        Blastyard uses the Unreal® Engine. Unreal® is a trademark or registered trademark of Epic Games, Inc. in
                        the United States of America and elsewhere. Epic Games is not a party to this agreement and isn&apos;t
                        responsible for the game. See also the
                        {' '}<External href="https://www.epicgames.com/site/en-US/tos">Epic Games terms of service</External>.
                    </p>
                </Section>

                <Section title="Changes and law">
                    <p>
                        We may update this agreement. The date at the top changes when we do, and playing after that means you
                        accept the new version. This agreement is governed by the laws in force in Queensland, Australia, and the
                        courts there have jurisdiction, except where your local consumer law says otherwise.
                    </p>
                </Section>

                <Section title="Contact">
                    <p>
                        For questions about this agreement, use the support links on Blastyard&apos;s store page or on
                        {' '}<Link className={LINK} href="/blastyard">horizons.gg/blastyard</Link>.
                    </p>
                </Section>
            </article>
        </main>
    )
}
