import type { JobDoc } from "./db";

// Zadania w tle (E06). Każde ma stałe, przewidywalne `_id`, więc wstawienie go dwa razy
// jest niemożliwe (duplikat klucza), a kolejka może dostarczać "co najmniej raz".
// Zadania wstawiamy w tej samej transakcji co zmianę danych (transactional outbox).

const job = (id: string, topic: JobDoc["topic"], payload: JobDoc["payload"], now: Date): JobDoc => ({
  _id: id,
  topic,
  payload,
  status: "pending",
  deliveryCount: 0,
  visibleAt: now,
  createdAt: now,
  updatedAt: now,
});

/** Wysyłka biletu i podsumowania zakupu (karta C). */
export const ticketEmailJob = (reservationId: string, now: Date): JobDoc =>
  job(`ticket-email:${reservationId}`, "ticket-email", { reservationId }, now);

/** Naliczenie punktów za zakup na karcie klienta w Voucherify (karta A). */
export const loyaltyEarnJob = (reservationId: string, email: string, points: number, now: Date): JobDoc =>
  job(`loyalty-earn:${reservationId}`, "loyalty-earn", { reservationId, email, points }, now);

/**
 * Zwrot punktów zdjętych na próbę płatności, która nie skończyła się zapłatą (kompensacja).
 * Jedno zadanie na próbę: `attempt` jest częścią klucza.
 */
export const loyaltyReleaseJob = (
  reservationId: string,
  attempt: number,
  email: string,
  points: number,
  now: Date,
): JobDoc =>
  job(`loyalty-release:${reservationId}:${attempt}`, "loyalty-release", { reservationId, email, points, attempt }, now);
