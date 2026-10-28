import { rowsOf, totalSeats, type HallLayout } from "@/lib/hall";
import styles from "./SeatDensity.module.css";

// Miniatura sali: każdy kwadracik to fotel. Pokazuje, gdzie jeszcze jest luźno.
export function SeatDensity({ layout, taken }: { layout: HallLayout; taken: string[] }) {
  const takenSet = new Set(taken);
  const free = totalSeats(layout) - takenSet.size;
  return (
    <div
      className={styles.grid}
      style={{ gridTemplateColumns: `repeat(${layout.seatsPerRow}, var(--cell))` }}
      role="img"
      aria-label={`${free} z ${totalSeats(layout)} foteli wolnych`}
    >
      {rowsOf(layout).flatMap((row) =>
        Array.from({ length: layout.seatsPerRow }, (_, i) => {
          const id = `${row}${i + 1}`;
          return <span key={id} className={takenSet.has(id) ? styles.taken : styles.free} />;
        }),
      )}
    </div>
  );
}
