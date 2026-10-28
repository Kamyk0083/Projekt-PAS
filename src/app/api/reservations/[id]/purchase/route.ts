import { after } from "next/server";
import { route, json } from "@/server/http";
import { purchase } from "@/server/reservations";
import { runWorkerTick } from "@/server/worker";

type Ctx = { params: Promise<{ id: string }> };

// C. POST /api/reservations/:id/purchase -> { code } albo 410, gdy rezerwacja wygasła.
// Idempotentne: ponowny zakup tej samej rezerwacji zwraca ten sam kod.
export const POST = route<Ctx>({ pool: "write", rateLimitScope: "purchase" }, async (_req, { params }) => {
  const { id } = await params;
  const { code, replayed } = await purchase(id);
  // Mail z biletem: po wysłaniu odpowiedzi szturchamy workera (działa też na serverless,
  // gdzie nie ma długo żyjącego procesu). Zadanie i tak czeka w kolejce, więc błąd tu nic nie psuje.
  if (!replayed) {
    try {
      after(() => runWorkerTick().catch(() => undefined));
    } catch {
      /* poza kontekstem żądania (np. testy): zadanie obsłuży zwykły worker */
    }
  }
  return json({ code }, { headers: replayed ? { "Idempotent-Replayed": "true" } : {} });
});
