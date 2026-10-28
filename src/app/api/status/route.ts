import { route, json, inFlightCount } from "@/server/http";
import { pools } from "@/server/bulkhead";
import { mailBreaker } from "@/server/mailer";
import { queueStats } from "@/server/worker";
import { config } from "@/server/config";

// Podgląd stanu mechanizmów odporności (bezpiecznik, kolejka, DLQ, pule).
export const GET = route({ pool: "read" }, async () =>
  json({
    serverTime: new Date().toISOString(),
    reservationTtlSeconds: config.reservationTtlMs / 1000,
    inFlight: inFlightCount(),
    pools: [pools.read.stats(), pools.write.stats()],
    mailer: mailBreaker.snapshot(),
    queue: await queueStats(),
    rateLimit: config.rateLimit,
  }),
);
