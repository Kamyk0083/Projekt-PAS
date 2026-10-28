"use client";

import type { ApiErrorBody } from "@/lib/types";

// Klient API odporny na awarie częściowe:
// - timeout (E02/E04): fetch nie ma domyślnego limitu czasu, więc ustawiamy własny,
// - retry z wykładniczym backoffem i jitterem tylko dla błędów chwilowych (sieć, 429, 5xx),
//   z poszanowaniem Retry-After (E05),
// - POST ponawiamy wyłącznie, gdy operacja jest idempotentna (Idempotency-Key albo zakup).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type Options = {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
  idempotent?: boolean; // czy wolno bezpiecznie ponowić
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function delayFor(attempt: number, retryAfter: string | null): number {
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(fromHeader)) return Math.min(fromHeader, 6000);
  const cap = 400 * 2 ** attempt;
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const canRetry = method === "GET" || opts.idempotent || Boolean(opts.idempotencyKey);
  const retries = canRetry ? (opts.retries ?? 3) : 0;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let lastError: ApiError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 8000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
        cache: "no-store",
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const timedOut = timeout.aborted;
      lastError = new ApiError(
        0,
        timedOut ? "TIMEOUT" : "NETWORK",
        timedOut ? "Serwer długo nie odpowiada." : "Brak połączenia z serwerem.",
        true,
      );
      if (attempt < retries) {
        await wait(delayFor(attempt, null), opts.signal);
        continue;
      }
      throw lastError;
    }

    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    lastError = new ApiError(
      res.status,
      body?.code ?? "HTTP_" + res.status,
      body?.error ?? "Nie udało się wykonać operacji.",
      RETRYABLE_STATUS.has(res.status),
    );
    if (lastError.retryable && attempt < retries) {
      await wait(delayFor(attempt, res.headers.get("retry-after")), opts.signal);
      continue;
    }
    throw lastError;
  }
  throw lastError ?? new ApiError(0, "UNKNOWN", "Nieznany błąd.", true);
}

export function newIdempotencyKey(): string {
  return `rsv-${crypto.randomUUID()}`;
}
