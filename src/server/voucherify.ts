import { createHash } from "node:crypto";
import { collections } from "./db";
import { config } from "./config";
import { AppError } from "./errors";
import { CircuitBreaker, CircuitOpenError } from "./circuitBreaker";
import { refundToBucket, takeFromBucket } from "./rateLimit";

// Voucherify to zależność zewnętrzna dokładnie jak Stripe (E04/E05), tylko mniej wybaczająca:
// Sandbox przyjmuje 100 wywołań na godzinę. Dlatego każde wywołanie przechodzi przez
// - globalny budżet (token bucket w bazie, wspólny dla wszystkich instancji serwera),
// - bezpiecznik: po serii awarii od razu 503, bez dobijania się do usługi,
// - timeout: lepiej szybka odmowa niż wiszące żądanie.
// Klucze wyłącznie w env serwera; ten plik nigdy nie trafia do przeglądarki.
// Bez kluczy działa dostawca symulowany (kolekcja `loyaltySim`), żeby aplikacja
// i testy dawały się uruchomić bez konta.

const BUDGET_BUCKET = "voucherify:budget";

const g = globalThis as typeof globalThis & { __kinoLoyaltyBreaker?: CircuitBreaker };

export const loyaltyBreaker =
  g.__kinoLoyaltyBreaker ??
  (g.__kinoLoyaltyBreaker = new CircuitBreaker("loyalty", {
    windowSize: 10,
    minimumRequests: 4,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30_000,
  }));

export const loyaltyConfigured = () => config.loyalty.provider === "voucherify";

export class InsufficientPointsError extends Error {}

function unavailable(retryAfterSec: number, why: string) {
  return new AppError(503, "LOYALTY_UNAVAILABLE", `Program lojalnościowy jest chwilowo niedostępny (${why}).`, {
    retryable: true,
    retryAfterSec,
  });
}

// ---- Budżet wywołań ---------------------------------------------------------

function budgetOptions() {
  const perHour = Math.max(1, config.loyalty.budgetPerHour);
  return { capacity: perHour, refillPerSec: perHour / 3600 };
}

async function takeBudget(): Promise<() => Promise<void>> {
  const opts = budgetOptions();
  const result = await takeFromBucket(BUDGET_BUCKET, opts);
  if (!result.allowed) {
    // Limit Sandboxa wyczerpany: nie wysyłamy żądania, które i tak dostałoby 429.
    throw unavailable(Math.min(result.retryAfterSec, 3600), "wyczerpany limit wywołań");
  }
  return () => refundToBucket(BUDGET_BUCKET, opts.capacity);
}

export async function budgetSnapshot() {
  const { rateBuckets } = await collections();
  const doc = await rateBuckets.findOne({ _id: BUDGET_BUCKET });
  const { capacity } = budgetOptions();
  return { capacity, remaining: Math.floor(doc?.tokens ?? capacity) };
}

// ---- HTTP -------------------------------------------------------------------

type Json = Record<string, unknown>;

class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly body: Json | null,
    message: string,
  ) {
    super(message);
  }
}

const isTransientStatus = (status: number) => status === 429 || status >= 500;

async function request<T>(what: string, method: "GET" | "POST", path: string, body?: Json): Promise<T> {
  const { apiUrl, appId, secretKey, timeoutMs } = config.loyalty;
  const refund = await takeBudget();

  let outcome: { ok: true; value: T } | { ok: false; err: ProviderError };
  try {
    outcome = await loyaltyBreaker.fire(async () => {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}${path}`, {
          method,
          headers: {
            "X-App-Id": appId,
            "X-App-Token": secretKey,
            "Content-Type": "application/json",
            accept: "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch (err) {
        // Nie doszło do usługi: oddajemy żeton, żeby awaria sieci nie zjadała limitu.
        await refund().catch(() => undefined);
        throw err;
      }
      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as Json) : null;
      if (res.ok) return { ok: true as const, value: parsed as T };
      const message = String(parsed?.message ?? parsed?.key ?? res.statusText);
      const error = new ProviderError(res.status, parsed, message);
      // Tylko awarie zależności liczą się do bezpiecznika; nasz błędny request to nasz problem.
      if (isTransientStatus(res.status)) throw error;
      return { ok: false as const, err: error };
    });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw unavailable(Math.max(1, Math.ceil((err.retryAt - Date.now()) / 1000)), "przerwa po serii błędów");
    }
    console.error(`[voucherify] ${what}: błąd zależności`, err instanceof Error ? err.message : err);
    throw unavailable(5, "usługa nie odpowiada");
  }
  if (!outcome.ok) throw outcome.err;
  return outcome.value;
}

// Voucherify nie pozwala zejść poniżej zera: rozpoznajemy to i tłumaczymy na odmowę,
// a nie na błąd serwera. Komunikat bywa różny, więc patrzymy na kilka sygnałów.
function isInsufficientFunds(err: ProviderError): boolean {
  const key = String(err.body?.key ?? "");
  const text = `${key} ${err.message}`.toLowerCase();
  return /insufficient|not_enough|exceed|balance/.test(text);
}

function providerFailed(what: string, err: unknown): never {
  if (err instanceof ProviderError) {
    console.error(`[voucherify] ${what}: ${err.status} ${err.message}`);
    throw new AppError(502, "LOYALTY_PROVIDER_ERROR", "Program lojalnościowy odrzucił żądanie.");
  }
  throw err;
}

// ---- Operacje (te funkcje podmieniają testy) --------------------------------

type VoucherResponse = {
  code?: string;
  loyalty_card?: { points?: number; balance?: number };
};

/** Karta lojalnościowa klienta (identyfikator to e-mail) albo null, gdy jeszcze jej nie ma. */
export async function findMemberId(email: string): Promise<string | null> {
  if (!loyaltyConfigured()) return simulated.findMemberId(email);
  const campaign = encodeURIComponent(config.loyalty.campaignId);
  const customer = encodeURIComponent(email);
  try {
    const res = await request<{ vouchers?: VoucherResponse[] }>(
      "list vouchers",
      "GET",
      `/v1/vouchers?customer=${customer}&campaign=${campaign}&limit=1`,
    );
    return res.vouchers?.[0]?.code ?? null;
  } catch (err) {
    if (err instanceof ProviderError && err.status === 404) return null;
    return providerFailed("list vouchers", err);
  }
}

/** Zapisanie klienta do kampanii lojalnościowej; zwraca ID karty (member ID). */
export async function createMember(email: string): Promise<string> {
  if (!loyaltyConfigured()) return simulated.createMember(email);
  const campaign = encodeURIComponent(config.loyalty.campaignId);
  try {
    const res = await request<VoucherResponse>("add member", "POST", `/v1/loyalties/${campaign}/members`, {
      customer: { source_id: email, email },
    });
    if (!res.code) throw new ProviderError(502, null, "Odpowiedź bez kodu karty lojalnościowej.");
    return res.code;
  } catch (err) {
    return providerFailed("add member", err);
  }
}

/** Saldo karty. Źródłem prawdy jest Voucherify, nie nasza baza. */
export async function readBalance(memberId: string): Promise<number> {
  if (!loyaltyConfigured()) return simulated.readBalance(memberId);
  try {
    const res = await request<VoucherResponse>(
      "get member",
      "GET",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}`,
    );
    const card = res.loyalty_card ?? {};
    return Math.max(0, Math.floor(card.balance ?? card.points ?? 0));
  } catch (err) {
    return providerFailed("get member", err);
  }
}

/**
 * Dodanie (points > 0) albo odjęcie (points < 0) punktów. Zwraca saldo po operacji.
 * `marker` wpisujemy w `reason`, żeby po ponowieniu zadania rozpoznać własną operację.
 */
export async function adjustBalance(memberId: string, points: number, marker: string): Promise<number> {
  if (!loyaltyConfigured()) return simulated.adjustBalance(memberId, points, marker);
  try {
    const res = await request<{ balance?: number }>(
      "adjust balance",
      "POST",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}/balance`,
      { points, reason: marker },
    );
    return Math.max(0, Math.floor(res.balance ?? 0));
  } catch (err) {
    if (err instanceof ProviderError && isInsufficientFunds(err)) throw new InsufficientPointsError(err.message);
    return providerFailed("adjust balance", err);
  }
}

/**
 * Czy nasza operacja z tym markerem już przeszła? Pytamy tylko przy ponowieniu zadania,
 * żeby kolejka "co najmniej raz" nie naliczyła punktów dwa razy.
 * `null` = nie dało się ustalić (wtedy wolimy nie zgadywać).
 */
export async function hasTransaction(memberId: string, marker: string): Promise<boolean | null> {
  if (!loyaltyConfigured()) return simulated.hasTransaction(memberId, marker);
  try {
    const res = await request<{ transactions?: unknown[] }>(
      "list transactions",
      "GET",
      `/v1/loyalties/members/${encodeURIComponent(memberId)}/transactions?limit=100`,
    );
    if (!res.transactions) return null;
    return res.transactions.some((t) => JSON.stringify(t).includes(marker));
  } catch (err) {
    if (err instanceof AppError) throw err; // 503: zależność leży, zadanie wróci później
    console.error(
      "[voucherify] list transactions: nie udało się sprawdzić historii",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ---- Dostawca symulowany (bez kluczy) ---------------------------------------
// Ten sam kontrakt, dane w kolekcji `loyaltySim`, żeby demo i testy działały bez konta.

const simulated = {
  async findMemberId(email: string): Promise<string | null> {
    const { loyaltySim } = await collections();
    const doc = await loyaltySim.findOne({ email });
    return doc?._id ?? null;
  },
  async createMember(email: string): Promise<string> {
    const { loyaltySim } = await collections();
    // Skrót, nie obcięty e-mail: dwa adresy o wspólnym początku ("delivered+a@…",
    // "delivered+b@…") nie mogą trafić na tę samą kartę.
    const memberId = `sim-${createHash("sha256").update(email).digest("hex").slice(0, 24)}`;
    await loyaltySim.updateOne(
      { _id: memberId },
      { $setOnInsert: { email, balance: 0, transactions: [] } },
      { upsert: true },
    );
    return memberId;
  },
  async readBalance(memberId: string): Promise<number> {
    const { loyaltySim } = await collections();
    const doc = await loyaltySim.findOne({ _id: memberId });
    return doc?.balance ?? 0;
  },
  async adjustBalance(memberId: string, points: number, marker: string): Promise<number> {
    const { loyaltySim } = await collections();
    const doc = await loyaltySim.findOneAndUpdate(
      // Warunek jak w Voucherify: saldo nie może zejść poniżej zera.
      { _id: memberId, ...(points < 0 ? { balance: { $gte: -points } } : {}) },
      { $inc: { balance: points }, $push: { transactions: { marker, points, at: new Date() } } },
      { returnDocument: "after" },
    );
    if (!doc) throw new InsufficientPointsError("Za mało punktów na karcie.");
    return doc.balance;
  },
  async hasTransaction(memberId: string, marker: string): Promise<boolean | null> {
    const { loyaltySim } = await collections();
    const doc = await loyaltySim.findOne({ _id: memberId });
    return (doc?.transactions ?? []).some((t) => t.marker === marker);
  },
};
