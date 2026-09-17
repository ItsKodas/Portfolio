import { ArtCanvas, Piece, PieceSvg, type Box } from '../parallax/art'
import styles from './watchtower.module.css'

// Fire lookout tower rising out of the treeline on the valley's right hill: its legs are hidden in the trees, with
// a cab on top, a warm lamp glowing in the cab window and a tiny lookout
// leaning on the balcony rail.
// Drawn in the same 3840x4320 canvas as the parallax art and scaled like object-cover, so it sits on the ridge.

const BASE = { x: 3000, y: 1552 } // where the legs meet the ground, down among the trees on the right hill
const SCALE = 0.8                // keeps it in scale with the trees and ridges around it
const INK = '#152553'             // a shade darker than the ridge, so it reads as a silhouette

// The top edge of the right hill's treeline around the tower (traced from the rendered valley): the tower is only drawn
// above it, so it looks like it stands in the trees
const TREELINE = 'M2820 0 L2820 1686 L2823 1695 L2826 1690 L2829 1695 L2832 1697 L2835 1692 L2838 1684 L2841 1678 L2844 1678 L2847 1672 L2850 1667 L2853 1667 L2856 1659 L2859 1664 L2862 1674 L2865 1665 L2868 1655 L2871 1648 L2874 1652 L2877 1650 L2880 1644 L2883 1644 L2886 1643 L2889 1635 L2892 1638 L2895 1641 L2898 1634 L2901 1631 L2904 1619 L2907 1618 L2910 1623 L2913 1615 L2916 1614 L2919 1607 L2922 1611 L2925 1605 L2928 1610 L2931 1601 L2934 1598 L2937 1589 L2940 1590 L2943 1579 L2946 1579 L2949 1572 L2952 1573 L2955 1573 L2958 1573 L2961 1565 L2964 1567 L2967 1558 L2970 1557 L2973 1557 L2976 1556 L2979 1563 L2982 1549 L2985 1548 L2988 1541 L2991 1536 L2994 1531 L2997 1533 L3000 1526 L3003 1531 L3006 1530 L3009 1526 L3012 1518 L3015 1511 L3018 1504 L3021 1512 L3024 1510 L3027 1499 L3030 1499 L3033 1504 L3036 1502 L3039 1493 L3039 0Z'

// The flickering parts (the lamp's glow and the lit window) are their own small layers, faded with opacity only, so
// the graphics card animates them without repainting the valley around them
const GLOW = { x: BASE.x, y: BASE.y - 95 * SCALE, r: 60 * SCALE }
const GLOW_BOX: Box = { x: GLOW.x - GLOW.r, y: GLOW.y - GLOW.r, w: GLOW.r * 2, h: GLOW.r * 2 }
const WINDOW_BOX: Box = { x: BASE.x - 15, y: BASE.y - 107 * SCALE, w: 30, h: 16 }
const inTower = (children: React.ReactNode) => <g transform={`translate(${BASE.x} ${BASE.y}) scale(${SCALE})`}>{children}</g>

export default function Watchtower() {
    return (
        <ArtCanvas>
            {/* Lamp glow spilling out around the cab (not kept above the trees, so it also lights the ridge a little) */}
            <Piece box={GLOW_BOX} className={styles.glow}>
                <PieceSvg box={GLOW_BOX}>
                    <defs>
                        <radialGradient id="towerLamp">
                            <stop offset="0" stopColor="#ffd98f" stopOpacity="0.85" />
                            <stop offset="0.3" stopColor="#ffab55" stopOpacity="0.35" />
                            <stop offset="1" stopColor="#ff9440" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <circle cx={GLOW.x} cy={GLOW.y} r={GLOW.r} fill="url(#towerLamp)" />
                </PieceSvg>
            </Piece>

            <svg className={styles.tower} viewBox="0 0 3840 4320" preserveAspectRatio="xMidYMid slice">
                <defs>
                    <clipPath id="aboveTrees"><path d={TREELINE} /></clipPath>
                </defs>
                <g clipPath="url(#aboveTrees)">
                    {inTower(
                        <g fill={INK} stroke={INK} strokeLinecap="square">
                            {/* Legs, splayed out towards the ground (running on down into the trees, so no foot ever shows in a dip in the treeline) */}
                            <path d="M-33.3 30 L-12 -83 M33.3 30 L12 -83" strokeWidth="3.5" fill="none" />
                            <path d="M-9.3 30 L-4 -83 M9.3 30 L4 -83" strokeWidth="2" fill="none" />
                            {/* Cross bracing, four levels */}
                            <path d="M-25.7 -10 L21.2 -34 M25.7 -10 L-21.2 -34 M-21.2 -34 L16.7 -58 M21.2 -34 L-16.7 -58 M-16.7 -58 L12.6 -80 M16.7 -58 L-12.6 -80 M-25.7 -10 L25.7 -10 M-21.2 -34 L21.2 -34 M-16.7 -58 L16.7 -58" strokeWidth="1.4" fill="none" />
                            {/* Stairs zig-zagging up one side */}
                            <path d="M-44 30 L-34 2 L-23 -14 L-30 -26 L-20 -42 L-26 -54 L-17 -68 L-22 -76" strokeWidth="1.2" fill="none" />
                            {/* Everything from the deck up, raised on the taller legs */}
                            <g transform="translate(0 -25)">
                                {/* Deck with railing */}
                                <rect x="-27" y="-61" width="54" height="3.5" stroke="none" />
                                <path d="M-27 -61 L-27 -68 M27 -61 L27 -68 M-27 -67 L27 -67" strokeWidth="1.2" fill="none" />
                                {/* Cab, with the lit window cut out of it below */}
                                <path d="M-16 -60 L-16 -82 L16 -82 L16 -60Z M-12 -78 L12 -78 L12 -69 L-12 -69Z" fillRule="evenodd" stroke="none" />
                                {/* Pyramid roof */}
                                <path d="M-21 -81 L0 -95 L21 -81Z" stroke="none" />
                                {/* Tiny lookout on the left of the balcony, leaning forward with forearms on the rail */}
                                <path d="M-20 -61 L-21 -66 M-22.5 -61 L-22.5 -66" strokeWidth="1.3" fill="none" />
                                <path d="M-20.5 -66 L-25 -72" strokeWidth="2.6" fill="none" />
                                <circle cx="-26.4" cy="-74.6" r="1.9" stroke="none" />
                                <path d="M-24.5 -71 L-26.5 -67.5 L-28.5 -67.5" strokeWidth="1" fill="none" />
                            </g>
                        </g>
                    )}
                </g>
            </svg>

            {/* Lit window, with a window frame across it */}
            <Piece box={WINDOW_BOX} className={styles.window}>
                <PieceSvg box={WINDOW_BOX}>
                    {inTower(<>
                        <rect x="-12" y="-103" width="24" height="9" fill="#ffcf7a" />
                        <path d="M0 -103 L0 -94" stroke={INK} strokeWidth="1.4" />
                    </>)}
                </PieceSvg>
            </Piece>
        </ArtCanvas>
    )
}
