import { route, json } from "@/server/http";
import { purchase } from "@/server/reservations";

type Ctx = { params: Promise<{ id: string }> };

// C. POST /api/reservations/:id/purchase -> { code } albo 410, gdy rezerwacja wygasła.
// Idempotentne: ponowny zakup tej samej rezerwacji zwraca ten sam kod.
export const POST = route<Ctx>({ pool: "write", rateLimitScope: "purchase" }, async (_req, { params }) => {
  const { id } = await params;
  const { code, replayed } = await purchase(id);
  return json({ code }, { headers: replayed ? { "Idempotent-Replayed": "true" } : {} });
});
