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
  // Poczta (etap III). Bez RESEND_API_KEY zostaje dostawca symulowany z etapu I,
  // żeby aplikacja i testy działały bez kluczy. Klucz tylko w env serwera.
  get mail() {
    const apiKey = process.env.RESEND_API_KEY || "";
    const wanted = (process.env.MAIL_PROVIDER || "").toLowerCase();
    const provider: "resend" | "simulated" = wanted === "simulated" ? "simulated" : apiKey ? "resend" : "simulated";
    return {
      provider,
      apiKey,
      // Bez własnej domeny Resend wysyła tylko z onboarding@resend.dev.
      from: process.env.MAIL_FROM || "Kino Pasaż <onboarding@resend.dev>",
      timeoutMs: num("MAIL_TIMEOUT_MS", 8000),
    };
  },
  // Program lojalnościowy w Voucherify (etap III). Saldo prowadzi Voucherify, nie nasza baza.
  get loyalty() {
    const appId = process.env.VOUCHERIFY_APP_ID || "";
    const secretKey = process.env.VOUCHERIFY_SECRET_KEY || "";
    const campaignId = process.env.VOUCHERIFY_CAMPAIGN_ID || "";
    const wanted = (process.env.LOYALTY_PROVIDER || "").toLowerCase();
    const live = Boolean(appId && secretKey && campaignId) && wanted !== "simulated";
    return {
      provider: (live ? "voucherify" : "simulated") as "voucherify" | "simulated",
      appId,
      secretKey,
      campaignId,
      // Klaster konta: api, eu1, as1 (https://docs.voucherify.io/api-reference/authentication).
      apiUrl: (process.env.VOUCHERIFY_API_URL || "https://api.voucherify.io").replace(/\/$/, ""),
      timeoutMs: num("VOUCHERIFY_TIMEOUT_MS", 6000),
      // Sandbox przyjmuje 100 wywołań na godzinę: zostawiamy sobie zapas (E05).
      budgetPerHour: num("VOUCHERIFY_BUDGET_PER_HOUR", 80),
      // Saldo z Voucherify podpowiadamy w UI z cache'a; nasze własne operacje go odświeżają.
      cacheTtlMs: num("LOYALTY_CACHE_TTL_SECONDS", 45) * 1000,
    };
  },
  // Lista oczekujących (etap IV). Miejsce dla osoby z listy to zwykła rezerwacja, więc czeka
  // tyle samo co ona (reservationTtlMs). Tutaj tylko ograniczenia samej kolejki.
  get waitlist() {
    return {
      // Najwięcej aktywnych wpisów na jeden seans: zalew fałszywych adresów nie rozdmucha kolejki.
      maxPerEvent: num("WAITLIST_MAX_PER_EVENT", 300),
      // Ile ofert najwyżej rozdajemy w jednym przebiegu (ogranicza pracę jednego żądania).
      maxOffersPerRun: num("WAITLIST_MAX_OFFERS_PER_RUN", 10),
    };
  },
  // Webhook Resenda (etap IV): zdarzenia o losie wysłanego maila, podpisane przez Svix.
  // Sekret whsec_... z panelu Resend > Webhooks, tylko w env serwera.
  get resendWebhookSecret() {
    return process.env.RESEND_WEBHOOK_SECRET || "";
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
