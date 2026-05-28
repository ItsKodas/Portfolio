'use client'

import React from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { GitHub, LinkedIn, YouTube, Instagram, OpenInNew, Circle } from '@mui/icons-material'

import PMPC_Group from '../../public/images/clients/pmpc.svg'
import SpotOnDrones from '../../public/images/clients/spotondrones.png'
import Arbys from '../../public/images/clients/arbys.png'
import ASOT from '../../public/images/clients/asot.svg'

const clients = [
    { src: PMPC_Group, name: 'PMPC Group' },
    { src: SpotOnDrones, name: 'Spot On Drones' },
    { src: Arbys, name: "Arby's" },
    { src: ASOT, name: 'ASOT' },
]

const socials = [
    { label: 'GitHub',    href: 'https://github.com/ItsKodas',                              icon: <GitHub sx={{ fontSize: 18 }} /> },
    { label: 'LinkedIn',  href: 'https://www.linkedin.com/in/dakoda-lancelot',              icon: <LinkedIn sx={{ fontSize: 18 }} /> },
    { label: 'YouTube',   href: 'https://www.youtube.com/channel/UC_3OvoziBu-ztAK9PlAz9Mw', icon: <YouTube sx={{ fontSize: 18 }} /> },
    { label: 'Instagram', href: 'https://www.instagram.com/itskodas',                       icon: <Instagram sx={{ fontSize: 18 }} /> },
]

const skills = [
    'Next.js', 'React', 'TypeScript', 'Node.js',
    'Tailwind CSS', 'PostgreSQL', 'Docker', 'Prisma',
    'MUI', 'Git',
]

const workExperience = [
    {
        company: 'Horizons',
        role: 'Fullstack Developer',
        period: '2019 — Present',
        description: 'Building modern web applications and digital experiences for clients across multiple industries. Full ownership of architecture, design, and delivery.',
        current: true,
    },
    {
        company: 'Spot On Drones',
        role: 'Fullstack Developer',
        period: '2024',
        description: 'Full-stack website and admin dashboard for an agricultural drone services company. Features a YouTube livestream integration with password-protected client access, image gallery management, CASA document handling, and live operational statistics.',
        current: false,
    },
    {
        company: 'PMPC Group',
        role: 'Fullstack Developer',
        period: '2024',
        description: 'Marketing website for a project management and controls consulting firm. Built with Next.js 15 and Framer Motion, featuring scroll-triggered animations, a 17-service showcase, and responsive desktop and mobile layouts.',
        current: false,
    },
    {
        company: "Arby's Auto Glass",
        role: 'Fullstack Developer',
        period: '2025',
        description: 'Service website for a Western Australian auto glass repair business. Includes a dynamic pricing table, quote request form with full validation, auto-rotating image carousel, and an embedded Google Maps service area covering a 40km radius.',
        current: false,
    },
]

const projects = [
    {
        name: 'ASOT Milsim',
        description: 'Community management platform for a military simulation unit. Features real-time collaborative operation briefings (Hocuspocus + Yjs CRDT), automated MILPAC generation with rank and uniform rendering, a 40+ key Discord role-based permission system, 3D terrain visualisation via Babylon.js, and TeamSpeak integration — backed by 27+ MongoDB collections.',
        tech: ['Next.js 15', 'TypeScript', 'MongoDB', 'Hocuspocus', 'Discord OAuth2', 'Babylon.js', 'MUI'],
        link: null,
        featured: true,
    },
    {
        name: 'Horizons Portfolio',
        description: 'Personal portfolio with a layered parallax hero, animated space canvas background, and a glassmorphism bento grid.',
        tech: ['Next.js', 'React Spring', 'Tailwind CSS', 'MUI'],
        link: 'https://github.com/ItsKodas',
        featured: false,
    },
]

// ─── Card shell ────────────────────────────────────────────────────────────────

function BentoCard({
    children,
    className = '',
    label,
    accent = 'cyan',
}: {
    children: React.ReactNode
    className?: string
    label?: string
    accent?: 'cyan' | 'purple' | 'amber'
}) {
    const accentColor = {
        cyan:   'rgba(48,194,255,',
        purple: 'rgba(124,58,237,',
        amber:  'rgba(245,158,11,',
    }[accent]

    return (
        <div
            className={`relative rounded-2xl p-5 transition-all duration-300 group ${className}`}
            style={{
                background: 'rgba(11,16,31,0.72)',
                backdropFilter: 'blur(18px)',
                border: `1px solid ${accentColor}0.13)`,
                boxShadow: `0 0 0 0 ${accentColor}0), inset 0 1px 0 rgba(255,255,255,0.04)`,
            }}
        >
            {/* HUD corner brackets */}
            <span className="absolute top-0 left-0 w-3.5 h-3.5 border-t border-l rounded-tl-2xl pointer-events-none" style={{ borderColor: `${accentColor}0.5)` }} />
            <span className="absolute top-0 right-0 w-3.5 h-3.5 border-t border-r rounded-tr-2xl pointer-events-none" style={{ borderColor: `${accentColor}0.5)` }} />
            <span className="absolute bottom-0 left-0 w-3.5 h-3.5 border-b border-l rounded-bl-2xl pointer-events-none" style={{ borderColor: `${accentColor}0.5)` }} />
            <span className="absolute bottom-0 right-0 w-3.5 h-3.5 border-b border-r rounded-br-2xl pointer-events-none" style={{ borderColor: `${accentColor}0.5)` }} />

            {label && (
                <p
                    className="text-[10px] mb-4 tracking-[0.2em] uppercase font-mono"
                    style={{ color: `${accentColor}0.55)` }}
                >
                    {label}
                </p>
            )}

            {children}
        </div>
    )
}

// ─── Divider line ───────────────────────────────────────────────────────────────

function GlowDivider() {
    return (
        <div className="w-full h-px my-10" style={{
            background: 'linear-gradient(90deg, transparent, rgba(48,194,255,0.25) 40%, rgba(124,58,237,0.2) 60%, transparent)'
        }} />
    )
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function Landing() {
    return (
        <div className="px-5 pb-20 pt-20 max-w-5xl mx-auto">

            {/* ── Client strip ──────────────────────────────────────── */}
            <div className="mb-12">
                <p className="text-center text-[10px] tracking-[0.3em] uppercase font-mono mb-6" style={{ color: 'rgba(48,194,255,0.4)' }}>
                    trusted by
                </p>
                <div className="flex items-center justify-center gap-10 flex-wrap">
                    {clients.map((c) => (
                        <div key={c.name} className="relative h-10 w-32 opacity-40 hover:opacity-70 transition-opacity duration-300" title={c.name}>
                            <Image src={c.src} alt={c.name} fill className="object-contain" style={{ filter: 'brightness(0) invert(1)' }} />
                        </div>
                    ))}
                </div>
            </div>

            <GlowDivider />

            {/* ── Bento grid ────────────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

                {/* About ── col-span-2 */}
                <BentoCard className="lg:col-span-2" label="// 01 — about">
                    <div className="flex items-start gap-2 mb-3">
                        <h2 className="text-2xl font-bold text-white leading-tight">Dakoda Lancelot</h2>
                        <span
                            className="mt-1.5 flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-mono shrink-0"
                            style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', color: 'rgba(52,211,153,0.9)' }}
                        >
                            <Circle sx={{ fontSize: 6 }} /> Available
                        </span>
                    </div>
                    <p className="text-sm mb-4 font-medium" style={{ color: 'rgba(48,194,255,0.8)' }}>
                        Fullstack Developer · Founder @ Horizons
                    </p>
                    <p className="text-sm leading-relaxed" style={{ color: 'rgba(180,200,230,0.65)' }}>
                        Building modern digital experiences with clean code and thoughtful design.
                        Specialising in fullstack web development — from scalable backends to
                        polished, performant frontends.
                    </p>
                </BentoCard>

                {/* Social ── col-span-1 */}
                <BentoCard label="// 02 — connect" accent="purple">
                    <div className="flex flex-col gap-1.5">
                        {socials.map((s) => (
                            <Link
                                key={s.label}
                                href={s.href}
                                target="_blank"
                                className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group/link"
                                style={{ color: 'rgba(180,200,230,0.6)' }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(124,58,237,0.08)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                                <span className="transition-colors duration-200 group-hover/link:text-[#c084fc]">{s.icon}</span>
                                <span className="text-sm font-medium transition-colors duration-200 group-hover/link:text-[#c084fc]">{s.label}</span>
                                <OpenInNew sx={{ fontSize: 11, marginLeft: 'auto', opacity: 0.3 }} className="group-hover/link:opacity-70 transition-opacity duration-200" />
                            </Link>
                        ))}
                    </div>
                </BentoCard>

                {/* Skills ── col-span-1 */}
                <BentoCard label="// 03 — stack" accent="amber">
                    <div className="flex flex-wrap gap-2">
                        {skills.map((skill) => (
                            <span
                                key={skill}
                                className="text-xs px-2.5 py-1 rounded-lg font-mono"
                                style={{
                                    background: 'rgba(245,158,11,0.07)',
                                    border: '1px solid rgba(245,158,11,0.18)',
                                    color: 'rgba(251,191,36,0.8)'
                                }}
                            >
                                {skill}
                            </span>
                        ))}
                    </div>
                </BentoCard>

                {/* Work Experience ── col-span-2 */}
                <BentoCard className="lg:col-span-2" label="// 04 — work experience">
                    <div className="flex flex-col gap-4">
                        {workExperience.map((entry, i) => (
                            <div key={i} className="flex gap-4">
                                <div className="flex flex-col items-center pt-1.5">
                                    <div
                                        className="w-2 h-2 rounded-full shrink-0"
                                        style={{ background: entry.current ? '#30c2ff' : 'rgba(100,120,150,0.5)', boxShadow: entry.current ? '0 0 8px rgba(48,194,255,0.6)' : 'none' }}
                                    />
                                    {i < workExperience.length - 1 && (
                                        <div className="w-px flex-1 mt-2" style={{ background: 'rgba(48,194,255,0.1)' }} />
                                    )}
                                </div>
                                <div className="flex-1 pb-2">
                                    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                                        <h3 className="text-white font-semibold">{entry.company}</h3>
                                        <span className="text-xs font-mono" style={{ color: 'rgba(120,140,170,0.7)' }}>{entry.period}</span>
                                    </div>
                                    <p className="text-sm mb-2" style={{ color: 'rgba(48,194,255,0.75)' }}>{entry.role}</p>
                                    <p className="text-sm leading-relaxed" style={{ color: 'rgba(180,200,230,0.55)' }}>{entry.description}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </BentoCard>

                {/* Featured Project ── col-span-2 */}
                {projects.filter(p => p.featured).map((project) => (
                    <BentoCard key={project.name} className="lg:col-span-2" label="// 05 — featured project">
                        <div className="flex items-start justify-between gap-3 mb-3">
                            <h3 className="text-white font-bold text-lg">{project.name}</h3>
                            <span
                                className="text-[10px] px-2 py-0.5 rounded-full font-mono shrink-0 mt-1"
                                style={{ background: 'rgba(48,194,255,0.1)', border: '1px solid rgba(48,194,255,0.2)', color: 'rgba(48,194,255,0.8)' }}
                            >
                                private
                            </span>
                        </div>
                        <p className="text-sm leading-relaxed mb-5" style={{ color: 'rgba(180,200,230,0.6)' }}>
                            {project.description}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {project.tech.map(t => (
                                <span
                                    key={t}
                                    className="text-xs px-2.5 py-1 rounded-lg font-mono"
                                    style={{ background: 'rgba(48,194,255,0.06)', border: '1px solid rgba(48,194,255,0.15)', color: 'rgba(48,194,255,0.75)' }}
                                >
                                    {t}
                                </span>
                            ))}
                        </div>
                    </BentoCard>
                ))}

                {/* Side Project ── col-span-1 */}
                {projects.filter(p => !p.featured).map((project) => (
                    <BentoCard key={project.name} label="// 06 — project" accent="purple">
                        <h3 className="text-white font-bold mb-2">{project.name}</h3>
                        <p className="text-sm leading-relaxed mb-4" style={{ color: 'rgba(180,200,230,0.6)' }}>
                            {project.description}
                        </p>
                        <div className="flex flex-wrap gap-2 mb-4">
                            {project.tech.map(t => (
                                <span
                                    key={t}
                                    className="text-xs px-2 py-0.5 rounded-lg font-mono"
                                    style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)', color: 'rgba(167,139,250,0.8)' }}
                                >
                                    {t}
                                </span>
                            ))}
                        </div>
                        {project.link && (
                            <Link
                                href={project.link}
                                target="_blank"
                                className="inline-flex items-center gap-1.5 text-xs font-mono transition-opacity duration-200 hover:opacity-80"
                                style={{ color: 'rgba(167,139,250,0.8)' }}
                            >
                                <GitHub sx={{ fontSize: 14 }} /> View on GitHub
                            </Link>
                        )}
                    </BentoCard>
                ))}

            </div>

            {/* ── Footer ────────────────────────────────────────────── */}
            <GlowDivider />
            <p className="text-center text-[10px] tracking-[0.2em] uppercase font-mono" style={{ color: 'rgba(48,194,255,0.2)' }}>
                © {new Date().getFullYear()} Horizons · Dakoda Lancelot
            </p>

        </div>
    )
}
