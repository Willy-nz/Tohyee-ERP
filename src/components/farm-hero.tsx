import type { ReactNode } from "react";
import styles from "./farm-hero.module.css";

/*
 * The dark panel a farm page opens with: what the page is about, the farm,
 * a few figures, and the page's own picture of how things stand. The look
 * began with the medicine cabinet; this is the same frame for the other
 * farm pages, so they read as one family. Purely how it looks: each page
 * still loads and records its own data.
 */

export type HeroStat = { value: ReactNode; label: string; tone?: "attention" | "alert" };

export function FarmHero({
  eyebrow,
  title,
  stats = [],
  action,
  heading,
  hint,
  footer,
  label,
  children,
}: {
  /** Small capitals above the name: "Stock / mobs". */
  eyebrow: string;
  /** Usually the farm's name. */
  title: string;
  stats?: HeroStat[];
  /** The page's main button, beside the figures. */
  action?: ReactNode;
  /** Small capitals over the body: "On the farm now". */
  heading: string;
  /** What tapping does, in small capitals at the right. */
  hint?: string;
  /** Small capitals along the bottom edge. */
  footer: string;
  /** Read out for the whole panel. */
  label: string;
  children?: ReactNode;
}) {
  return (
    <section className={styles.hero} aria-label={label}>
      <header className={styles.top}>
        <div className={styles.identity}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        {stats.length || action ? (
          <div className={styles.stats}>
            {stats.map((stat) => (
              <span key={stat.label} className={stat.tone === "attention" ? styles.attention : stat.tone === "alert" ? styles.alert : undefined}>
                <strong>{stat.value}</strong> {stat.label}
              </span>
            ))}
            {action ? <div className={styles.action}>{action}</div> : null}
          </div>
        ) : null}
      </header>
      <div className={styles.glass}>
        <div className={styles.glassTop} aria-hidden="true">
          <span>{heading}</span>
          {hint ? <span>{hint}</span> : null}
        </div>
        {children}
      </div>
      <div className={styles.footer} aria-hidden="true">
        <span className={styles.light} />
        <span className={styles.footerLabel}>{footer}</span>
        <span className={styles.rule} />
        <span className={styles.footerLabel}>TOHYEE · FARM</span>
      </div>
    </section>
  );
}

/** The line a panel shows when there's nothing in it yet. */
export function HeroEmpty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

/** A grid of things to tap inside a panel: mobs, gauges, jobs. */
export function HeroTiles({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <ul className={`${styles.tiles} ${wide ? styles.tilesWide : ""}`}>{children}</ul>;
}

export function HeroTile({
  title,
  figure,
  unit,
  lines = [],
  mark,
  picture,
  pictureAbove = false,
  tone,
  pressed,
  onOpen,
  label,
}: {
  title: ReactNode;
  /** The one number that matters: head, millimetres, days. */
  figure?: ReactNode;
  unit?: string;
  lines?: string[];
  /** A small swatch before the name. */
  mark?: ReactNode;
  /** The tile's drawn picture (farm-hero-art), at its right-hand side. */
  picture?: ReactNode;
  /** A wide picture goes across the top instead, so it doesn't squeeze the words. */
  pictureAbove?: boolean;
  tone?: "attention" | "alert";
  pressed?: boolean;
  onOpen?: () => void;
  label?: string;
}) {
  const inner = (
    <>
      {picture && pictureAbove ? <span className={styles.pictureAbove}>{picture}</span> : null}
      <span className={styles.words}>
        <span className={styles.tileTitle}>
          {mark ? <span className={styles.mark}>{mark}</span> : null}
          {title}
        </span>
        {figure !== undefined ? (
          <span className={styles.figure}>
            {figure}
            {unit ? <small> {unit}</small> : null}
          </span>
        ) : null}
        {lines.map((line) => (
          <span key={line} className={styles.line}>{line}</span>
        ))}
      </span>
      {picture && !pictureAbove ? <span className={styles.picture}>{picture}</span> : null}
    </>
  );
  const className = `${styles.tile} ${pictureAbove ? styles.tileStacked : ""} ${tone === "attention" ? styles.tileAttention : tone === "alert" ? styles.tileAlert : ""} ${pressed ? styles.tilePressed : ""}`;
  return (
    <li>
      {onOpen ? (
        <button type="button" className={className} onClick={onOpen} aria-pressed={pressed} aria-label={label}>
          {inner}
        </button>
      ) : (
        <div className={className}>{inner}</div>
      )}
    </li>
  );
}
