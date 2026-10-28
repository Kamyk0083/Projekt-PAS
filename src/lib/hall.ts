// Geometria sali kinowej. Wspólna dla serwera (walidacja seatId) i klienta (mapa sali).

export const ROW_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export type HallLayout = {
  rows: number; // liczba rzędów, licząc od A
  seatsPerRow: number;
  aisleAfter: number | null; // przejście za fotelem o tym numerze (tylko wizualnie)
};

const SEAT_ID = /^([A-Z])(\d{1,2})$/;

export function parseSeatId(seatId: string): { row: string; number: number } | null {
  const match = SEAT_ID.exec(seatId);
  if (!match) return null;
  return { row: match[1], number: Number(match[2]) };
}

export function isSeatInHall(seatId: string, layout: HallLayout): boolean {
  const parsed = parseSeatId(seatId);
  if (!parsed) return false;
  const rowIndex = ROW_LETTERS.indexOf(parsed.row as (typeof ROW_LETTERS)[number]);
  return (
    rowIndex >= 0 &&
    rowIndex < layout.rows &&
    parsed.number >= 1 &&
    parsed.number <= layout.seatsPerRow
  );
}

export function rowsOf(layout: HallLayout): string[] {
  return ROW_LETTERS.slice(0, layout.rows);
}

export function seatLabel(seatId: string): string {
  const parsed = parseSeatId(seatId);
  if (!parsed) return seatId;
  return `Rząd ${parsed.row}, miejsce ${parsed.number}`;
}

export function totalSeats(layout: HallLayout): number {
  return layout.rows * layout.seatsPerRow;
}
