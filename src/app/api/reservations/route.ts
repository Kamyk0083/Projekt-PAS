import { route, json, readJson } from "@/server/http";
import { parseIdempotencyKey, parseReservationInput, reserve } from "@/server/reservations";

// B. POST /api/reservations { eventId, seatId, customerName, email } -> { reservationId, expiresAt }
// Opcjonalny nagłówek Idempotency-Key: ponowienie zwraca tę samą rezerwację (200 zamiast 201).
export const POST = route({ pool: "write", rateLimitScope: "reserve" }, async (req) => {
  const input = parseReservationInput(await readJson(req));
  const key = parseIdempotencyKey(req.headers.get("idempotency-key"));
  const { reservationId, expiresAt, replayed } = await reserve(input, key);
  return json(
    { reservationId, expiresAt },
    { status: replayed ? 200 : 201, headers: replayed ? { "Idempotent-Replayed": "true" } : {} },
  );
});
