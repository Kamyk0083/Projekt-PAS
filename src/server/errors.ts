import { MongoNetworkError, MongoServerError, MongoServerSelectionError } from "mongodb";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly opts: { retryable?: boolean; retryAfterSec?: number } = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `Nie znaleziono: ${what}.`);
export const badRequest = (message: string) => new AppError(400, "VALIDATION", message);

// Błędy zależności (baza) zamieniamy na szybkie 503 z Retry-After, zamiast wiszącego żądania.
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    err instanceof MongoServerSelectionError ||
    err instanceof MongoNetworkError ||
    (err instanceof MongoServerError && err.code === 50) // MaxTimeMSExpired
  ) {
    return new AppError(503, "DEPENDENCY_UNAVAILABLE", "Baza danych chwilowo nie odpowiada. Spróbuj za chwilę.", {
      retryable: true,
      retryAfterSec: 3,
    });
  }
  console.error("[api] nieobsłużony błąd", err);
  return new AppError(500, "INTERNAL", "Coś poszło nie tak po naszej stronie.", { retryable: true });
}
