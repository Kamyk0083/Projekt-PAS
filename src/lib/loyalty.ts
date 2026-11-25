// Program lojalnościowy (etap III): kurs i reguły liczenia punktów.
// Jedno miejsce dla serwera i dla przeglądarki, żeby przycisk "Zapłać 22 zł"
// i kwota sesji Stripe'a nigdy nie mogły się rozjechać.

// 1 punkt = 1 grosz, czyli 100 punktów = 1 zł.
export const GROSZE_PER_POINT = 1;
// Za każdy pełny złoty zapłacony kartą: 10 punktów.
export const POINTS_PER_PLN = 10;
// Nowy klient dostaje na start 1000 punktów (10 zł).
export const WELCOME_POINTS = 1000;
// Punktami da się zapłacić najwyżej połowę ceny biletu.
export const MAX_POINTS_SHARE = 0.5;

/** Wartość punktów w groszach. */
export const pointsToGrosze = (points: number) => points * GROSZE_PER_POINT;

/** Najwięcej punktów, jakie wolno wydać na bilet za `amount` groszy (połowa ceny, w dół). */
export const maxPointsFor = (amount: number) => Math.floor((amount * MAX_POINTS_SHARE) / GROSZE_PER_POINT);

/** Ile klient realnie może wydać: mniejsze z limitu biletu i jego salda. */
export const spendablePoints = (amount: number, balance: number) =>
  Math.max(0, Math.min(maxPointsFor(amount), Math.floor(balance)));

/** Do dopłaty kartą po odjęciu punktów. */
export const cardAmountFor = (amount: number, points: number) => amount - pointsToGrosze(points);

/** Punkty za zakup: tylko od części zapłaconej kartą i tylko od pełnych złotych. */
export const pointsEarnedFor = (cardAmount: number) => Math.floor(Math.max(0, cardAmount) / 100) * POINTS_PER_PLN;

export type PointsSplit = { amount: number; pointsUsed: number; pointsValue: number; cardAmount: number; pointsEarned: number };

/** Całe rozliczenie jednego biletu. Nie waliduje: do tego jest `validatePoints`. */
export function splitPayment(amount: number, pointsUsed: number): PointsSplit {
  const cardAmount = cardAmountFor(amount, pointsUsed);
  return { amount, pointsUsed, pointsValue: pointsToGrosze(pointsUsed), cardAmount, pointsEarned: pointsEarnedFor(cardAmount) };
}

export type PointsRejection = "NOT_INTEGER" | "NEGATIVE" | "OVER_HALF";

/** Reguły wspólne dla klienta i serwera. Serwer dodatkowo sprawdza saldo w Voucherify. */
export function validatePoints(amount: number, points: number): PointsRejection | null {
  if (!Number.isInteger(points)) return "NOT_INTEGER";
  if (points < 0) return "NEGATIVE";
  if (points > maxPointsFor(amount)) return "OVER_HALF";
  return null;
}

/** "1 punkt", "2 punkty", "5 punktów" */
export function pluralPoints(n: number): string {
  const abs = Math.abs(n);
  if (abs === 1) return "punkt";
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return "punkty";
  return "punktów";
}

const pointsFmt = new Intl.NumberFormat("pl-PL");
export const formatPoints = (n: number) => `${pointsFmt.format(n)} ${pluralPoints(n)}`;
