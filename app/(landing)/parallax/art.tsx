import styles from './art.module.css'

// Building blocks for moving parts of the hero art that stay cheap to animate. Rather than animating shapes inside one
// big svg (which makes the browser repaint the whole screen-sized layer every frame), each moving part is its own
// small element, placed in the art's 3840x4320 canvas and moved with CSS transforms and opacity only, which the
// graphics card can do without repainting.

export const CANVAS = { width: 3840, height: 4320 }

export interface Box { x: number, y: number, w: number, h: number }

const pct = (v: number, of: number) => `${(v / of * 100).toFixed(4)}%`

// The art canvas: covers the two-screen-tall layer and is centred, like object-cover on the other layers
export function ArtCanvas({ children, className = '' }: { children: React.ReactNode, className?: string }) {
    return <div className={`${styles.canvas} ${className}`} aria-hidden="true">{children}</div>
}

// A box in canvas units, as an absolutely positioned element within the canvas (the hero art's, unless another is given)
export function Piece({ box, canvas = CANVAS, className = '', style, children }: { box: Box, canvas?: { width: number, height: number }, className?: string, style?: React.CSSProperties, children?: React.ReactNode }) {
    return (
        <div className={`${styles.piece} ${className}`}
            style={{ left: pct(box.x, canvas.width), top: pct(box.y, canvas.height), width: pct(box.w, canvas.width), height: pct(box.h, canvas.height), ...style }}>
            {children}
        </div>
    )
}

// An svg filling its piece, drawn in canvas coordinates (its view box is the piece's box)
export function PieceSvg({ box, children }: { box: Box, children: React.ReactNode }) {
    return (
        <svg className={styles.fill} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} preserveAspectRatio="none">
            {children}
        </svg>
    )
}

// A point in canvas units, as a transform origin within a piece
export const originIn = (box: Box, x: number, y: number) => `${pct(x - box.x, box.w)} ${pct(y - box.y, box.h)}`

// A distance in canvas units, as a percentage of a piece's width or height (for translating a piece by canvas units)
export const acrossX = (box: Box, d: number) => pct(d, box.w)
export const acrossY = (box: Box, d: number) => pct(d, box.h)
