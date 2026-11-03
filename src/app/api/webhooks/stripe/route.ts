import { after } from "next/server";
import { route, json } from "@/server/http";
import { AppError } from "@/server/errors";
import { handleStripeEvent } from "@/server/payments";
import { verifyWebhook } from "@/server/stripe";
import { runWorkerTick } from "@/server/worker";

// Zdarzenia Stripe'a są małe; większe ciało to nie Stripe, tylko próba zapchania serwera.
const MAX_BODY_BYTES = 256 * 1024;

// B. POST /api/webhooks/stripe: zdarzenia od Stripe'a, w tym checkout.session.completed.
// Bez limitu żądań na IP (Stripe wysyła z kilku adresów), ale z podpisem: bez poprawnego
// Stripe-Signature nic nie zmieniamy (400). 5xx oznacza dla Stripe'a "ponów później".
export const POST = route({ pool: "write" }, async (req) => {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Za duże żądanie.");
  // Podpis liczy się z surowego ciała, więc nie wolno go parsować przed weryfikacją.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Za duże żądanie.");
  const event = verifyWebhook(raw, req.headers.get("stripe-signature"));
  const outcome = await handleStripeEvent(event);
  if (outcome === "paid") {
    try {
      after(() => runWorkerTick().catch(() => undefined));
    } catch {
      /* poza kontekstem żądania (np. testy): zadanie obsłuży zwykły worker */
    }
  }
  return json({ received: true });
});
