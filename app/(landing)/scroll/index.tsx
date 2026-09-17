'use client'

import styles from './scroll.module.css'
import { NOTE_LINES } from './note'

// A handwritten note in the hero pointing down to the work below, for anyone after a website. When the page loads each
// letter is traced in turn (its outline drawn with a pen stroke, then filled), then the arrow draws and bobs gently;
// clicking the note scrolls down to the content. The letters are Caveat glyph outlines (see note.ts).

const WRITE_START = 0.6  // seconds after load before the pen starts
const LETTER_GAP = 0.085 // seconds between letters starting
const LINE_PAUSE = 0.2   // the pen lifting between lines

// When each letter starts, and when the writing is done
const timings = (() => {
    let t = WRITE_START
    const lines = NOTE_LINES.map((line, l) => {
        const starts = line.glyphs.map(() => {
            const start = t
            t += LETTER_GAP * (l === 0 ? 1 : 0.8)
            return start
        })
        t += LINE_PAUSE
        return starts
    })
    return { lines, done: t + 0.2 }
})()

const ScrollIcon = () => {
    const scrollDown = () => window.scrollTo({ top: window.innerHeight * 0.55, behavior: 'smooth' })

    return (
        <button type="button" onClick={scrollDown} className={styles.note} aria-label="Need a website? Take a look below">
            {NOTE_LINES.map((line, l) => (
                <svg key={l} className={l === 0 ? styles.line1 : styles.line2} viewBox={line.viewBox} aria-hidden="true">
                    {line.glyphs.map((g, i) => (
                        <path key={i} className={styles.glyph} d={g.d} pathLength={1}
                            style={{ animationDelay: `${timings.lines[l][i].toFixed(3)}s, ${(timings.lines[l][i] + 0.28).toFixed(3)}s` }} />
                    ))}
                </svg>
            ))}
            <svg className={styles.arrow} viewBox="0 0 80 120" aria-hidden="true" style={{ '--arrow-start': `${timings.done.toFixed(2)}s` } as React.CSSProperties}>
                {/* A slightly wobbly stroke curling down, with a hand-drawn head */}
                <path className={styles.shaft} d="M44 4 C30 18 24 34 34 50 C44 66 52 74 44 92 C42 98 40 104 39 112" />
                <path className={styles.head} d="M24 96 C30 102 35 108 39 113 C44 105 50 99 57 93" />
            </svg>
        </button>
    )
}

export default ScrollIcon
