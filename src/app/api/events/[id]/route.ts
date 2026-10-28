import { route, json } from "@/server/http";
import { eventDetails } from "@/server/events";

type Ctx = { params: Promise<{ id: string }> };

// A. GET /api/events/:id -> { event, takenSeats } (kupione + z ważną rezerwacją)
export const GET = route<Ctx>({ pool: "read" }, async (_req, { params }) => {
  const { id } = await params;
  return json(await eventDetails(decodeURIComponent(id)));
});
