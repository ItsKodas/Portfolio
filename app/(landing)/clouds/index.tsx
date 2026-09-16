import { BASE_Y, CLOUD_HEIGHT, CLOUD_WIDTH, COOL, WARM, cloudSvg } from './shapes'
import styles from './clouds.module.css'

interface Cloud {
    seed: number
    horizon: number  // where the billows sit, as % down the (two screen tall) layer
    width: number    // vw
    duration: number // seconds to cross the screen
    progress: number // 0-1, how far across it starts so the sky isn't empty on load
    opacity: number
    flip?: boolean   // mirror so the tall end is on the other side
}

// Long cloud banks resting on the horizon, sized like the clouds in the original artwork
const CLOUDS: Cloud[] = [
    { seed: 1,  horizon: 26,   width: 52, duration: 460, progress: 0.1,  opacity: 1 },
    { seed: 5,  horizon: 25,   width: 42, duration: 400, progress: 0.3,  opacity: 1, flip: true },
    { seed: 22, horizon: 25.5, width: 48, duration: 440, progress: 0.52, opacity: 1 },
    { seed: 9,  horizon: 26.5, width: 60, duration: 520, progress: 0.72, opacity: 1, flip: true },
    { seed: 14, horizon: 24.5, width: 34, duration: 360, progress: 0.9,  opacity: 1 },
]

// Built once per module; each cloud has a warm and a cool copy that cross-fade as it drifts
const IMAGES = CLOUDS.map(c => ({ warm: `url("${cloudSvg(c.seed, WARM)}")`, cool: `url("${cloudSvg(c.seed, COOL)}")` }))

export default function CloudStream() {
    return (
        <div className={styles.stream} aria-hidden="true">
            {CLOUDS.map((cloud, i) => {
                const timing = {
                    animationDuration: `${cloud.duration}s`,
                    animationDelay: `${-cloud.progress * cloud.duration}s`,
                }

                return (
                    <div
                        key={cloud.seed}
                        className={styles.cloud}
                        style={{
                            ...timing,
                            // Billows at `horizon`; the body below them fades out into the haze over the mountains
                            bottom: `calc(${100 - cloud.horizon}% - ${((CLOUD_HEIGHT - BASE_Y) / CLOUD_WIDTH * cloud.width).toFixed(2)}vw)`,
                            width: `${cloud.width}vw`,
                            aspectRatio: `${CLOUD_WIDTH} / ${CLOUD_HEIGHT}`,
                            opacity: cloud.opacity,
                        }}
                    >
                        <div className={`${styles.image} ${cloud.flip ? styles.flip : ''}`} style={{ backgroundImage: IMAGES[i].warm }} />
                        <div className={`${styles.image} ${styles.cool} ${cloud.flip ? styles.flip : ''}`} style={{ ...timing, backgroundImage: IMAGES[i].cool }} />
                    </div>
                )
            })}
        </div>
    )
}
