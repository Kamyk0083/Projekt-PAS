import Image from "next/image";
import { posterUrl } from "@/lib/format";
import styles from "./Poster.module.css";

type Props = { seed: string; alt: string; sizes: string; priority?: boolean; className?: string };

// Kadr z filmu w jednolitym, przygaszonym opracowaniu. Gdy obraz się nie wczyta,
// zostaje tło w kolorze powierzchni (rezerwujemy proporcje 3:4, brak skoków układu).
export function Poster({ seed, alt, sizes, priority, className }: Props) {
  return (
    <div className={`${styles.poster} ${className ?? ""}`}>
      <Image src={posterUrl(seed)} alt={alt} fill sizes={sizes} priority={priority} className={styles.img} />
    </div>
  );
}
