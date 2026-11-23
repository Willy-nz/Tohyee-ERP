import styles from "./crm-period-bars.module.css";

/**
 * A bar for each period, tallest for the biggest value, with the figure
 * written above it: a count or a percentage over time at a glance. The table
 * under it still has every figure.
 */
export function PeriodBars({ label, bars, max }: { label: string; bars: Array<{ period: string; value: number | null; text: string }>; max?: number }) {
  const top = Math.max(1, max ?? 0, ...bars.map((bar) => bar.value ?? 0));
  return (
    <ol className={styles.bars} aria-label={label}>
      {bars.map((bar) => (
        <li key={bar.period} className={styles.column}>
          <span className={styles.value}>{bar.text}</span>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.bar} style={{ height: `${Math.round(((bar.value ?? 0) / top) * 100)}%` }} />
          </span>
          <span className={styles.period}>{bar.period}</span>
        </li>
      ))}
    </ol>
  );
}
