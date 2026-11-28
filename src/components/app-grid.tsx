import Link from "next/link";
import { IllustratedIcon } from "@/components/illustrated-icon";
import type { MenuGroup } from "@/components/navigation";
import { iconForDestination } from "@/components/navigation-art";
import styles from "./app-grid.module.css";

/**
 * A menu's pages as a grid of pictures with their names underneath, the way a
 * phone shows its apps: the Farm app's More page and its More menu on a phone.
 * The groups keep their headings, so a page is still found by what it's about.
 */
export function AppGrid({ groups, current, onOpen }: { groups: MenuGroup[]; current?: (href: string) => boolean; onOpen?: () => void }) {
  return (
    <div className={styles.groups}>
      {groups.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h2 className={styles.heading}>{group.heading}</h2>
          <ul className={styles.grid}>
            {group.links.map((link) => {
              const icon = iconForDestination(link.href);
              const here = current?.(link.href) ?? false;
              return (
                <li key={`${link.href}|${link.label}`}>
                  <Link
                    href={link.href}
                    className={`${styles.app} ${here ? styles.appCurrent : ""}`}
                    aria-label={link.tile ? link.label : undefined}
                    aria-current={here ? "page" : undefined}
                    onClick={onOpen}
                  >
                    <span className={styles.picture}>{icon ? <IllustratedIcon name={icon} size={56} /> : null}</span>
                    <span className={styles.name}>{link.tile ?? link.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
