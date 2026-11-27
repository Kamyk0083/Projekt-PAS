import { route, json } from "@/server/http";
import { AppError } from "@/server/errors";
import { handleResendEvent, verifyResendWebhook } from "@/server/resendWebhook";
import { kickWorker } from "@/server/worker";

// Zdarzenia Resenda są małe; większe ciało to nie Resend, tylko próba zapchania serwera.
const MAX_BODY_BYTES = 256 * 1024;

// C. POST /api/webhooks/resend: los wysłanego maila (email.delivered, email.bounced, ...).
// Podpis Svix jak przy Stripe: bez poprawnego podpisu 400 i żadnej zmiany. 5xx oznacza dla
// Resenda "ponów później". Bez limitu żądań na IP (Svix wysyła z kilku adresów).
export const POST = route({ pool: "write" }, async (req) => {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Za duże żądanie.");
  // Podpis liczy się z surowego ciała, więc nie wolno go parsować przed weryfikacją.
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Za duże żądanie.");
  const verified = verifyResendWebhook(raw, req.headers);
  const outcome = await handleResendEvent(verified);
  // Mail z ofertą się odbił: następna osoba właśnie dostała miejsce, mail do niej wysyłamy od razu.
  if (outcome === "offer-missed") kickWorker();
  return json({ received: true, outcome });
});
