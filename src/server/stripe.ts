import Stripe from "stripe";
import { config } from "./config";
import { AppError } from "./errors";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker";

// Stripe to zależność zewnętrzna (E04): każde wywołanie ma timeout, SDK ponawia błędy sieci
// z kluczem idempotencji, a seria awarii otwiera bezpiecznik i dalej od razu odpowiadamy 503.
// Używamy wyłącznie kluczy testowych: klucz "live" wyłącza płatności zamiast pobrać prawdziwe pieniądze.

const g = globalThis as typeof globalThis & { __kinoStripe?: { key: string; client: Stripe }; __kinoStripeBreaker?: CircuitBreaker };

export const stripeBreaker =
  g.__kinoStripeBreaker ??
  (g.__kinoStripeBreaker = new CircuitBreaker("stripe", {
    windowSize: 10,
    minimumRequests: 4,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30_000,
  }));

function paymentsOff(reason: string) {
  console.error(`[stripe] płatności wyłączone: ${reason}`);
  return new AppError(503, "PAYMENTS_UNAVAILABLE", "Płatności są chwilowo niedostępne. Spróbuj za chwilę.", {
    retryable: true,
    retryAfterSec: 30,
  });
}

function client(): Stripe {
  const key = config.stripe.secretKey;
  if (!key) throw paymentsOff("Brak STRIPE_SECRET_KEY");
  if (!/^(sk|rk)_test_/.test(key)) throw paymentsOff("STRIPE_SECRET_KEY nie jest kluczem testowym");
  if (g.__kinoStripe?.key !== key) {
    g.__kinoStripe = {
      key,
      client: new Stripe(key, {
        timeout: config.stripe.timeoutMs,
        maxNetworkRetries: 2,
        appInfo: { name: "kino-pasaz" },
      }),
    };
  }
  return g.__kinoStripe.client;
}

// Błędy chwilowe Stripe'a (sieć, 5xx, 429) liczą się do bezpiecznika i dają 503.
// Błąd naszego żądania (4xx od Stripe'a) to błąd programu: 500 z logiem, bez otwierania bezpiecznika.
function isTransient(err: unknown) {
  return (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError
  );
}

export async function callStripe<T>(what: string, fn: (stripe: Stripe) => Promise<T>): Promise<T> {
  const stripe = client();
  let outcome: { ok: true; value: T } | { ok: false; err: unknown };
  try {
    outcome = await stripeBreaker.fire(async () => {
      try {
        return { ok: true as const, value: await fn(stripe) };
      } catch (err) {
        if (isTransient(err)) throw err; // tylko awarie zależności liczą się do bezpiecznika
        return { ok: false as const, err };
      }
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Płatności są chwilowo niedostępne. Spróbuj za chwilę.", {
        retryable: true,
        retryAfterSec: Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000)),
      });
    }
    console.error(`[stripe] ${what}: błąd zależności`, err instanceof Error ? err.message : err);
    throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Operator płatności nie odpowiada. Spróbuj za chwilę.", {
      retryable: true,
      retryAfterSec: 5,
    });
  }
  if (!outcome.ok) {
    console.error(`[stripe] ${what}: odrzucone żądanie`, outcome.err instanceof Error ? outcome.err.message : outcome.err);
    throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "Operator płatności odrzucił żądanie. Spróbuj ponownie później.");
  }
  return outcome.value;
}

// Do strony /status: czy płatności są skonfigurowane (bez ujawniania kluczy).
export function paymentsConfigured(): boolean {
  return /^(sk|rk)_test_/.test(config.stripe.secretKey) && config.stripe.webhookSecret.startsWith("whsec_");
}

// Weryfikacja podpisu webhooka: surowe ciało + nagłówek Stripe-Signature + sekret endpointu.
// Domyślna tolerancja 300 s chroni przed powtórzeniem starego, przechwyconego żądania.
export function verifyWebhook(rawBody: string, signature: string | null): Stripe.Event {
  const secret = config.stripe.webhookSecret;
  if (!secret) throw paymentsOff("Brak STRIPE_WEBHOOK_SECRET");
  if (!signature) throw new AppError(400, "INVALID_SIGNATURE", "Brak podpisu Stripe-Signature.");
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new AppError(400, "INVALID_SIGNATURE", "Niepoprawny podpis webhooka.");
  }
}
