import { collections, isDuplicateKey } from "./db";
import { config } from "./config";
import { AppError } from "./errors";

// Token bucket (E05) trzymany w bazie, więc wspólny dla wszystkich instancji serwera.
// Doliczenie żetonów i pobranie jednego to jedna atomowa operacja (pipeline update),
// bez wyścigu "przeczytaj, policz, zapisz".

export type BucketOptions = { capacity: number; refillPerSec: number };
export type BucketResult = { allowed: boolean; tokens: number; retryAfterSec: number };

// Jedno wiadro: pobiera żeton, jeśli jest. Nie rzuca wyjątkiem, bo tego samego mechanizmu
// używamy i do limitu żądań na IP (429), i do budżetu wywołań Voucherify (503).
export async function takeFromBucket(id: string, { capacity, refillPerSec }: BucketOptions): Promise<BucketResult> {
  const { rateBuckets } = await collections();
  const now = new Date();
  const rate = Math.max(refillPerSec, 0.000001);
  const idleTtlMs = Math.ceil((capacity / rate) * 1000) + 60_000;
  const refill = {
    $min: [
      capacity,
      {
        $add: [
          { $ifNull: ["$tokens", capacity] },
          { $multiply: [{ $divide: [{ $subtract: [now, { $ifNull: ["$updatedAt", now] }] }, 1000] }, rate] },
        ],
      },
    ],
  };

  const run = () =>
    rateBuckets.findOneAndUpdate(
      { _id: id },
      [
        { $set: { tokens: refill, updatedAt: now } },
        {
          $set: {
            allowed: { $gte: ["$tokens", 1] },
            tokens: { $cond: [{ $gte: ["$tokens", 1] }, { $subtract: ["$tokens", 1] }, "$tokens"] },
            expireAt: new Date(now.getTime() + idleTtlMs),
          },
        },
      ],
      { upsert: true, returnDocument: "after", maxTimeMS: config.dbOpTimeoutMs },
    );

  let doc;
  try {
    doc = await run();
  } catch (err) {
    // Dwa pierwsze żądania naraz mogą oba próbować utworzyć wiadro: drugie ponawiamy.
    if (!isDuplicateKey(err)) throw err;
    doc = await run();
  }

  const state = doc as unknown as { allowed?: boolean; tokens: number } | null;
  const tokens = state?.tokens ?? capacity;
  const allowed = state?.allowed !== false;
  return { allowed, tokens, retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / rate)) };
}

// Oddanie żetonu: operacja, która nie doszła do zależności, nie powinna zużywać budżetu.
export async function refundToBucket(id: string, capacity: number): Promise<void> {
  const { rateBuckets } = await collections();
  await rateBuckets.updateOne({ _id: id }, [
    { $set: { tokens: { $min: [capacity, { $add: [{ $ifNull: ["$tokens", 0] }, 1] }] } } },
  ]);
}

// Limit żądań na IP dla operacji zapisu: 429 z Retry-After.
export async function takeToken(clientKey: string, scope: string): Promise<void> {
  const { enabled, capacity, refillPerSec } = config.rateLimit;
  if (!enabled || capacity <= 0) return;
  const result = await takeFromBucket(`${scope}:${clientKey}`, { capacity, refillPerSec });
  if (!result.allowed) {
    throw new AppError(429, "RATE_LIMITED", "Za dużo prób w krótkim czasie. Odczekaj chwilę.", {
      retryable: true,
      retryAfterSec: result.retryAfterSec,
    });
  }
}

export function clientKeyFrom(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
