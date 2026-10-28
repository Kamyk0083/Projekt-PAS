import Link from "next/link";
import { FilmStrip } from "@phosphor-icons/react/dist/ssr";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand} aria-label="Kino Pasaż, repertuar">
          <FilmStrip size={22} weight="fill" className={styles.mark} aria-hidden />
          <span>Kino Pasaż</span>
        </Link>
        <nav aria-label="Główna" className={styles.nav}>
          <Link href="/">Repertuar</Link>
          <Link href="/status">Stan systemu</Link>
        </nav>
      </div>
    </header>
  );
}
