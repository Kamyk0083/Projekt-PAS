import { route, json, readJson } from "@/server/http";
import { joinWaitlist } from "@/server/waitlist";
import { kickWorker } from "@/server/worker";

type Ctx = { params: Promise<{ id: string }> };

// A. POST /api/events/:id/waitlist { email, customerName } -> { waitlistId, position }
// 201 nowy wpis, 200 ta sama osoba drugi raz (nagłówek Idempotent-Replayed).
// Odmowy: 400 złe dane, 404 nie ma seansu, 409 NOT_SOLD_OUT (są wolne miejsca),
// 409 EVENT_STARTED, 409 WAITLIST_FULL, 429 za dużo zapisów z jednego adresu IP.
export const POST = route<Ctx>({ pool: "write", rateLimitScope: "waitlist" }, async (req, { params }) => {
  const id = decodeURIComponent((await params).id);
  const { waitlistId, position, replayed } = await joinWaitlist(id, await readJson(req));
  kickWorker(15_000);
  return json(
    { waitlistId, position },
    { status: replayed ? 200 : 201, headers: replayed ? { "Idempotent-Replayed": "true" } : {} },
  );
});
