import { pools } from "./bulkhead";
import { AppError, toAppError } from "./errors";
import { clientKeyFrom, takeToken } from "./rateLimit";
import type { ApiErrorBody } from "@/lib/types";

// Load shedding (E05): globalny limit żądań w locie. Powyżej progu od razu 503,
// żeby reszta była obsłużona w normalnym czasie.
const MAX_IN_FLIGHT = 400;
const g = globalThis as typeof globalThis & { __kinoInFlight?: { n: number } };
const inFlight = g.__kinoInFlight ?? (g.__kinoInFlight = { n: 0 });

export function inFlightCount() {
  return inFlight.n;
}

type RouteOptions = { pool: "read" | "write"; rateLimitScope?: string };
type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

export function route<C>(opts: RouteOptions, handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    if (inFlight.n >= MAX_IN_FLIGHT) {
      return errorResponse(
        new AppError(503, "OVERLOADED", "Serwer jest przeciążony. Spróbuj za chwilę.", {
          retryable: true,
          retryAfterSec: 2,
        }),
      );
    }
    inFlight.n++;
    try {
      if (opts.rateLimitScope) await takeToken(clientKeyFrom(req), opts.rateLimitScope);
      return await pools[opts.pool].run(() => handler(req, ctx));
    } catch (err) {
      return errorResponse(toAppError(err));
    } finally {
      inFlight.n--;
    }
  };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function errorResponse(err: AppError): Response {
  const body: ApiErrorBody = { error: err.message, errorCode: err.code, retryable: err.opts.retryable ?? false };
  const headers: Record<string, string> = {};
  if (err.opts.retryAfterSec) headers["Retry-After"] = String(err.opts.retryAfterSec);
  return json(body, { status: err.status, headers });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AppError(400, "VALIDATION", "Treść żądania musi być poprawnym JSON-em.");
  }
}
