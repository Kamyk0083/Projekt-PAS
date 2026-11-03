import { route, json } from "@/server/http";
import { startCheckout } from "@/server/payments";

type Ctx = { params: Promise<{ id: string }> };

// A. POST /api/reservations/:id/checkout -> { url } strony płatności Stripe'a
// albo odmowa 4xx: 404 brak rezerwacji, 409 już opłacona, 410 wygasła.
// Idempotentne: podwójny klik i ponowienie zwracają tę samą sesję płatności.
export const POST = route<Ctx>({ pool: "write", rateLimitScope: "checkout" }, async (_req, { params }) => {
  const { id } = await params;
  return json(await startCheckout(id));
});
