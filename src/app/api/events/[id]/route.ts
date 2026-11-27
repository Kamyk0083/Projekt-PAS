import { route, json } from "@/server/http";
import { eventDetails } from "@/server/events";
import { advanceWaitlist, logAdvanceError } from "@/server/waitlist";
import { kickWorker } from "@/server/worker";

type Ctx = { params: Promise<{ id: string }> };

// A. GET /api/events/:id -> { event, takenSeats, soldOut } (kupione + z ważną rezerwacją).
// Etap IV: zanim policzymy zajęte fotele, kolejka seansu dogania stan: fotel, który właśnie
// się zwolnił, trafia do pierwszej osoby z listy oczekujących, a nie wraca na mapę jako wolny.
// Mapę odpytuje każdy, kto ją ogląda, więc to jeden ze "zegarów" kolejki zamiast crona.
export const GET = route<Ctx>({ pool: "read" }, async (_req, { params }) => {
  const id = decodeURIComponent((await params).id);
  const advanced = await advanceWaitlist(id).catch((err) => (logAdvanceError(err), null));
  kickWorker(advanced?.offered ? 0 : 15_000);
  return json(await eventDetails(id));
});
