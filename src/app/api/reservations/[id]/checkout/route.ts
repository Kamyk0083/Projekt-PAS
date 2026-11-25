import { route, json } from "@/server/http";
import { AppError, badRequest } from "@/server/errors";
import { startCheckout } from "@/server/payments";

type Ctx = { params: Promise<{ id: string }> };

// B. POST /api/reservations/:id/checkout { points? } -> { url } strony płatności Stripe'a
// albo odmowa 4xx: 404 brak rezerwacji, 409 już opłacona / za mało punktów, 410 wygasła,
// 400 gdy punkty przekraczają połowę ceny. Bez `points` działa jak w etapie II.
// Idempotentne: podwójny klik i ponowienie zwracają tę samą sesję płatności.
export const POST = route<Ctx>({ pool: "write", rateLimitScope: "checkout" }, async (req, { params }) => {
  const { id } = await params;
  return json(await startCheckout(id, await readPoints(req)));
});

// Ciało jest opcjonalne (etap II wysyła POST bez ciała), ale jeśli jest, musi być poprawne.
async function readPoints(req: Request): Promise<number> {
  const raw = await req.text().catch(() => "");
  if (!raw.trim()) return 0;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, "VALIDATION", "Treść żądania musi być poprawnym JSON-em.");
  }
  if (typeof body !== "object" || body === null) throw badRequest("Treść żądania musi być obiektem JSON.");
  const points = (body as { points?: unknown }).points;
  if (points === undefined || points === null) return 0;
  if (typeof points !== "number" || !Number.isFinite(points)) throw badRequest("Pole points musi być liczbą.");
  return points;
}
