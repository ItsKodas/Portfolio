// Frosted panel in the night's navy, catching a little of the lake's light along its edge
export function Panel({ children, className = '' }: { children: React.ReactNode, className?: string }) {
    return (
        <div className={`rounded-3xl border border-[#8fd4f5]/10 bg-[#111a38]/55 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_60px_-30px_rgba(0,0,0,0.6)] ${className}`}>
            {children}
        </div>
    )
}
