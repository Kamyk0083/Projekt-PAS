import { route, json, inFlightCount } from "@/server/http";
import { pools } from "@/server/bulkhead";
import { mailBreaker, mailProvider } from "@/server/mailer";
import { budgetSnapshot, loyaltyBreaker, loyaltyConfigured } from "@/server/voucherify";
import { paymentsConfigured, stripeBreaker } from "@/server/stripe";
import { queueStats } from "@/server/worker";
import { config } from "@/server/config";
import { resendWebhookConfigured } from "@/server/resendWebhook";
import { waitlistStats } from "@/server/waitlist";

// Podgląd stanu mechanizmów odporności (bezpiecznik, kolejka, DLQ, pule).
export const GET = route({ pool: "read" }, async () =>
  json({
    serverTime: new Date().toISOString(),
    reservationTtlSeconds: config.reservationTtlMs / 1000,
    inFlight: inFlightCount(),
    pools: [pools.read.stats(), pools.write.stats()],
    mailer: mailBreaker.snapshot(),
    // Etap IV: czy przyjmujemy zdarzenia Resenda (odbite maile) i ile osób czeka na listach.
    mail: { provider: mailProvider(), webhookConfigured: resendWebhookConfigured() },
    waitlist: await waitlistStats(),
    // Voucherify: Sandbox przyjmuje 100 wywołań na godzinę, więc widać zużycie budżetu.
    loyalty: { configured: loyaltyConfigured(), breaker: loyaltyBreaker.snapshot(), budget: await budgetSnapshot() },
    payments: { configured: paymentsConfigured(), breaker: stripeBreaker.snapshot() },
    queue: await queueStats(),
    rateLimit: config.rateLimit,
  }),
);
