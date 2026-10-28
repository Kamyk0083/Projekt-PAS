import Link from "next/link";
import styles from "./status.module.css";

export default function NotFound() {
  return (
    <div className={`page ${styles.center}`}>
      <h1>Nie ma takiej strony</h1>
      <p>Ten seans lub ta rezerwacja nie istnieje. Może link jest niepełny?</p>
      <Link href="/" className="btn btn-primary">
        Zobacz repertuar
      </Link>
    </div>
  );
}
