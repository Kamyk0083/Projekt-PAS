import { route, json } from "@/server/http";
import { listEvents } from "@/server/events";

// A. GET /api/events -> lista wydarzeń (seansów)
export const GET = route({ pool: "read" }, async () => json(await listEvents()));
