// Konfiguracja z zmiennych środowiskowych, czytana leniwie (testy mogą ją nadpisać).

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export const config = {
  get mongoUri() {
    return process.env.MONGODB_URI || "";
  },
  get mongoDb() {
    return process.env.MONGODB_DB || "kino";
  },
  // 15 minut na produkcji, 2 minuty w testach (RESERVATION_TTL_SECONDS=120).
  get reservationTtlMs() {
    const minutes = process.env.RESERVATION_TTL_MINUTES;
    if (minutes) return num("RESERVATION_TTL_MINUTES", 15) * 60_000;
    return num("RESERVATION_TTL_SECONDS", 900) * 1000;
  },
  get rateLimit() {
    return {
      enabled: bool("RATE_LIMIT_ENABLED", true),
      capacity: num("RATE_LIMIT_CAPACITY", 40),
      refillPerSec: num("RATE_LIMIT_REFILL_PER_SEC", 2),
    };
  },
  get mailer() {
    return {
      failureRate: num("MAILER_FAILURE_RATE", 0.15),
      latencyMs: num("MAILER_LATENCY_MS", 400),
      timeoutMs: num("MAILER_TIMEOUT_MS", 2000),
    };
  },
  get workerEnabled() {
    return bool("WORKER_ENABLED", true);
  },
  get cronSecret() {
    return process.env.CRON_SECRET || "";
  },
  // Stripe (etap II). Klucze tylko z env serwera, nigdy w repo ani w przeglądarce.
  get stripe() {
    return {
      secretKey: process.env.STRIPE_SECRET_KEY || "",
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
      timeoutMs: num("STRIPE_TIMEOUT_MS", 8000),
    };
  },
  // Adres sklepu do stron powrotu ze Stripe'a. Nie bierzemy go z nagłówka Host,
  // bo ten kontroluje klient (open redirect po płatności).
  get appUrl() {
    const explicit = process.env.APP_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    const vercelHost =
      process.env.VERCEL_ENV === "production" ? process.env.VERCEL_PROJECT_PRODUCTION_URL : process.env.VERCEL_URL;
    if (vercelHost) return `https://${vercelHost}`;
    return `http://localhost:${process.env.PORT || 3000}`;
  },
  // Etap I: zakup bez płatności (POST /purchase). Domyślnie wyłączony, bo od etapu II
  // bilet wydajemy dopiero po opłaceniu. Włącza się tylko do testów kryteriów etapu I.
  get legacyPurchase() {
    return bool("LEGACY_PURCHASE_WITHOUT_PAYMENT", false);
  },
  // Timeout operacji na bazie: lepiej szybka porażka niż wiszący request (E04).
  dbOpTimeoutMs: 3000,
};
