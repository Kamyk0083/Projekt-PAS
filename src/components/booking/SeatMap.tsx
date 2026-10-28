"use client";

import { useCallback, useRef } from "react";
import { rowsOf, type HallLayout } from "@/lib/hall";
import styles from "./SeatMap.module.css";

type Props = {
  layout: HallLayout;
  taken: Set<string>;
  selected: string | null;
  onSelect: (seatId: string) => void;
  onTakenAttempt: (seatId: string) => void;
};

// Karta A: mapa sali. Ekran na górze, rzędy A-H, numerowane fotele, zajęte wyszarzone.
// Klawiatura: strzałki przesuwają fokus między fotelami (roving tabindex), Enter/Spacja wybiera.
export function SeatMap({ layout, taken, selected, onSelect, onTakenAttempt }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const rows = rowsOf(layout);
  const focusTarget = selected ?? `${rows[Math.floor(rows.length / 2)]}${Math.ceil(layout.seatsPerRow / 2)}`;

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const current = (e.target as HTMLElement).dataset.seat;
      if (!current) return;
      const r = rows.indexOf(current[0]);
      const c = Number(current.slice(1));
      const moves: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      let next: string | undefined;
      if (moves[e.key]) {
        const [dr, dc] = moves[e.key];
        const nr = Math.min(rows.length - 1, Math.max(0, r + dr));
        const nc = Math.min(layout.seatsPerRow, Math.max(1, c + dc));
        next = `${rows[nr]}${nc}`;
      } else if (e.key === "Home") next = `${rows[r]}1`;
      else if (e.key === "End") next = `${rows[r]}${layout.seatsPerRow}`;
      if (!next) return;
      e.preventDefault();
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-seat="${next}"]`)?.focus();
    },
    [rows, layout.seatsPerRow],
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.screen} aria-hidden>
        <div className={styles.screenArc} />
        <div className={styles.beam} />
        <span>Ekran</span>
      </div>

      <div
        ref={gridRef}
        className={styles.grid}
        role="grid"
        aria-label="Plan sali. Strzałki zmieniają fotel, Enter wybiera."
        onKeyDown={onKeyDown}
        style={{ "--cols": layout.seatsPerRow } as React.CSSProperties}
      >
        {rows.map((row) => (
          <div role="row" key={row} className={styles.row}>
            <span className={styles.rowLabel} aria-hidden>
              {row}
            </span>
            {Array.from({ length: layout.seatsPerRow }, (_, i) => {
              const n = i + 1;
              const id = `${row}${n}`;
              const isTaken = taken.has(id);
              const isSelected = selected === id;
              return (
                <span
                  role="gridcell"
                  key={id}
                  className={layout.aisleAfter === n ? styles.aisle : undefined}
                >
                  <button
                    type="button"
                    data-seat={id}
                    className={styles.seat}
                    data-state={isSelected ? "selected" : isTaken ? "taken" : "free"}
                    aria-pressed={isSelected}
                    aria-disabled={isTaken || undefined}
                    aria-label={`Rząd ${row}, miejsce ${n}, ${isTaken ? "zajęty" : isSelected ? "wybrany" : "wolny"}`}
                    tabIndex={id === focusTarget ? 0 : -1}
                    onClick={(e) => {
                      if (!isTaken) return onSelect(id);
                      const el = e.currentTarget;
                      el.dataset.shake = "";
                      setTimeout(() => delete el.dataset.shake, 400);
                      onTakenAttempt(id);
                    }}
                  >
                    {n}
                  </button>
                </span>
              );
            })}
            <span className={styles.rowLabel} aria-hidden>
              {row}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
