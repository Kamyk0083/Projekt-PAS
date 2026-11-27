import { createHmac, timingSafeEqual } from "node:crypto";
import { collections, isDuplicateKey } from "./db";
import { config } from "./config";
import { AppError } from "./errors";
import { offerUndelivered } from "./waitlist";

// Karta C (etap IV): webhook Resenda. Resend mówi nim, co się stało z wysłanym mailem
// (m.in. email.delivered, email.bounced). Webhook podpisuje Svix, tak jak Stripe swój:
//   podpis = base64(HMAC-SHA256(klucz, "<svix-id>.<svix-timestamp>.<surowe ciało>")),
//   klucz = base64-dekodowana część sekretu po "whsec_", nagłówek: "v1,<podpis> v1,<podpis2>".
// Bez poprawnego podpisu nic nie zmieniamy (400). Znacznik czasu starszy niż 5 minut to
// powtórzenie przechwyconego żądania: też 400.

const TOLERANCE_SEC = 5 * 60;
const RESERVATION_ID = /^[0-9a-f-]{36}$/i;

// Zdarzenia oznaczające "mail nie doszedł". Odbicie (bounce) jest głównym przypadkiem z zadania.
const UNDELIVERED = new Set(["email.bounced", "email.failed", "email.suppressed"]);

export type ResendWebhookEvent = {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    // Resend oddaje tagi jako obiekt { nazwa: wartość }; na wszelki wypadek przyjmujemy też listę.
    tags?: Record<string, string> | { name: string; value: string }[];
    bounce?: { type?: string; subType?: string; message?: string };
  };
};

export type VerifiedResendEvent = { svixId: string; event: ResendWebhookEvent };

export function resendWebhookConfigured(): boolean {
  return config.resendWebhookSecret.startsWith("whsec_");
}

function invalid(message: string) {
  return new AppError(400, "INVALID_SIGNATURE", message);
}

/** Weryfikacja podpisu na surowym ciele, zanim cokolwiek sparsujemy. */
export function verifyResendWebhook(rawBody: string, headers: Headers, nowMs = Date.now()): VerifiedResendEvent {
  const secret = config.resendWebhookSecret;
  if (!secret) {
    console.error("[resend] webhook wyłączony: brak RESEND_WEBHOOK_SECRET");
    throw new AppError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook poczty nie jest skonfigurowany.", {
      retryable: true,
      retryAfterSec: 60,
    });
  }
  const svixId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!svixId || !timestamp || !signatures) throw invalid("Brak podpisu webhooka (nagłówki svix-*).");

  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(nowMs / 1000 - sentAt) > TOLERANCE_SEC) {
    throw invalid("Znacznik czasu webhooka jest spoza tolerancji 5 minut.");
  }

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${svixId}.${timestamp}.${rawBody}`).digest();
  const valid = signatures.split(" ").some((part) => {
    const [version, signature] = part.split(",");
    if (version !== "v1" || !signature) return false;
    const given = Buffer.from(signature, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw invalid("Niepoprawny podpis webhooka.");

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(rawBody) as ResendWebhookEvent;
  } catch {
    throw new AppError(400, "VALIDATION", "Treść webhooka nie jest poprawnym JSON-em.");
  }
  if (!event || typeof event.type !== "string") throw new AppError(400, "VALIDATION", "Webhook bez pola type.");
  return { svixId, event };
}

function tagsOf(event: ResendWebhookEvent): Record<string, string> {
  const tags = event.data?.tags;
  if (!tags) return {};
  if (Array.isArray(tags)) return Object.fromEntries(tags.map((t) => [t.name, t.value]));
  return tags;
}

export type ResendOutcome = "offer-missed" | "bounced" | "delivered" | "ignored";

/**
 * Obsługa zdarzenia. Svix dostarcza "co najmniej raz" i bez gwarancji kolejności, więc:
 * - powtórka (ten sam svix-id) zwraca zapamiętany wynik i nic nie zmienia,
 * - odbicie maila z ofertą zamyka tylko bieżącą, nieopłaconą ofertę tej rezerwacji,
 * - zdarzenie o mailu, którego nie znamy (inny projekt na tym samym koncie), ignorujemy.
 */
export async function handleResendEvent({ svixId, event }: VerifiedResendEvent): Promise<ResendOutcome> {
  const { resendEvents, mails, waitlist } = await collections();
  const seen = await resendEvents.findOne({ _id: svixId }, { maxTimeMS: config.dbOpTimeoutMs });
  if (seen) return seen.outcome as ResendOutcome;

  const emailId = event.data?.email_id ?? null;
  const tags = tagsOf(event);
  const mail = emailId ? await mails.findOne({ providerId: emailId }) : null;
  // Mail z ofertą rozpoznajemy po tagach, a gdy ich brak, po kluczu idempotencji w naszym outboksie.
  const fromOutbox = mail?._id.startsWith("waitlist-offer:") ? mail._id.slice("waitlist-offer:".length) : undefined;
  const offerReservation = tags.kind === "waitlist_offer" ? tags.reservation : fromOutbox;
  const reservationId = offerReservation && RESERVATION_ID.test(offerReservation) ? offerReservation : undefined;
  const now = new Date();

  let outcome: ResendOutcome = "ignored";
  if (UNDELIVERED.has(event.type)) {
    if (emailId) await mails.updateOne({ providerId: emailId }, { $set: { bouncedAt: now } });
    if (reservationId) {
      outcome = (await offerUndelivered(reservationId)) === "missed" ? "offer-missed" : "bounced";
    } else if (mail) {
      outcome = "bounced";
    }
    if (outcome !== "ignored") {
      console.warn(`[resend] ${event.type}: ${event.data?.bounce?.type ?? ""} ${event.data?.bounce?.subType ?? ""}`.trim());
    }
  } else if (event.type === "email.delivered") {
    if (emailId) await mails.updateOne({ providerId: emailId }, { $set: { deliveredAt: now } });
    if (reservationId) {
      await waitlist.updateOne({ reservationId, status: "offered" }, { $set: { deliveredAt: now, updatedAt: now } });
    }
    if (mail || reservationId) outcome = "delivered";
  }

  // Zapis po obsłudze: gdy obsługa padnie, Svix ponowi zdarzenie i spróbujemy jeszcze raz.
  try {
    await resendEvents.insertOne({ _id: svixId, type: event.type, emailId, outcome, receivedAt: now });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  return outcome;
}
