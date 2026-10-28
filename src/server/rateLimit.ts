import { collections, isDuplicateKey } from "./db";
import { config } from "./config";
import { AppError } from "./errors";

// Token bucket (E05) trzymany w bazie, więc wspólny dla wszystkich instancji serwera.
// Doliczenie żetonów i pobranie jednego to jedna atomowa operacja (pipeline update),
// bez wyścigu "przeczytaj, policz, zapisz".
export async function takeToken(clientKey: string, scope: string): Promise<void> {
  const { enabled, capacity, refillPerSec } = config.rateLimit;
  if (!enabled || capacity <= 0) return;

  const { rateBuckets } = await collections();
  const now = new Date();
  const idleTtlMs = Math.ceil((capacity / Math.max(refillPerSec, 0.001)) * 1000) + 60_000;
  const refill = {
    $min: [
      capacity,
      {
        $add: [
          { $ifNull: ["$tokens", capacity] },
          {
            $multiply: [
              { $divide: [{ $subtract: [now, { $ifNull: ["$updatedAt", now] }] }, 1000] },
              refillPerSec,
            ],
          },
        ],
      },
    ],
  };

  const run = () =>
    rateBuckets.findOneAndUpdate(
      { _id: `${scope}:${clientKey}` },
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
  if (state && state.allowed === false) {
    const retryAfterSec = Math.max(1, Math.ceil((1 - state.tokens) / Math.max(refillPerSec, 0.001)));
    throw new AppError(429, "RATE_LIMITED", "Za dużo prób w krótkim czasie. Odczekaj chwilę.", {
      retryable: true,
      retryAfterSec,
    });
  }
}

export function clientKeyFrom(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
