import styles from './scroll.module.css'

const ScrollIcon = () => {
    return (
        <div>
            <svg className={styles.arrows}>
                <path className={styles.a1} d="M0 0 L30 32 L60 0"></path>
                <path className={styles.a2} d="M0 20 L30 52 L60 20"></path>
                <path className={styles.a3} d="M0 40 L30 72 L60 40"></path>
            </svg>
        </div>
    )
}

export default ScrollIcon