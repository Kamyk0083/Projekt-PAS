import { route, json } from "@/server/http";
import { runWorkerTick } from "@/server/worker";
import { config } from "@/server/config";

// Jeden przebieg workera na żądanie (np. Vercel Cron albo środowisko bez długo żyjącego procesu).
export const GET = route({ pool: "write" }, async (req) => {
  if (config.cronSecret && req.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return json({ error: "Brak uprawnień.", code: "UNAUTHORIZED" }, { status: 401 });
  }
  return json(await runWorkerTick());
});
