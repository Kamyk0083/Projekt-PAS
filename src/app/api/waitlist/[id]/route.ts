import { route, json } from "@/server/http";
import { leaveWaitlist, waitlistView } from "@/server/waitlist";
import { kickWorker } from "@/server/worker";

type Ctx = { params: Promise<{ id: string }> };

// A/B. GET /api/waitlist/:id -> { status, position, reservationId?, offerExpiresAt? }
// status: waiting | offered | done | missed | left. position liczy się od 1 dla czekających,
// 0 gdy osoba już nie czeka. Odpytuje go strona osoby z listy, więc przy okazji przesuwa kolejkę.
export const GET = route<Ctx>({ pool: "read" }, async (_req, { params }) => {
  const view = await waitlistView((await params).id);
  // Na serverless to odpytywanie napędza też kolejkę zadań (mail z ofertą, ponowienia),
  // najwyżej raz na kilka sekund w danej instancji.
  kickWorker(5_000);
  return json(view);
});

// A. DELETE /api/waitlist/:id: wypisanie z listy (także z oferty: fotel od razu idzie dalej).
// 200 { waitlistId, status }, ponowienie zwraca to samo. 404 nie ma wpisu, 409 bilet już kupiony.
export const DELETE = route<Ctx>({ pool: "write", rateLimitScope: "waitlist" }, async (_req, { params }) => {
  const result = await leaveWaitlist((await params).id);
  kickWorker();
  return json(result);
});
