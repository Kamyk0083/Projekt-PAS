import { collections, isDuplicateKey, type JobDoc } from "./db";
import { CircuitOpenError } from "./circuitBreaker";
import { mailBreaker, sendMail } from "./mailer";
import { sweepExpired } from "./reservations";
import { seatLabel } from "@/lib/hall";

// Praca w tle (E06). Kolejka to kolekcja `jobs` (zasilana przez transactional outbox przy zakupie).
// - receive: atomowe przejęcie zadania z "visibility timeout" (zadanie ukryte, nie usunięte),
// - ack PO pracy: worker padnie w połowie -> zadanie wróci (at-least-once),
// - duplikaty: dostawca maili deduplikuje po kluczu idempotencji = ID zadania,
// - retry z wykładniczym backoffem, limit prób, dead letter queue na zatrute wiadomości.

const VISIBILITY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const BATCH = 8;

class PermanentJobError extends Error {}

function backoffMs(deliveryCount: number) {
  const base = Math.min(300, 2 ** deliveryCount * 5) * 1000;
  return Math.round(base * (0.5 + Math.random() * 0.5)); // jitter, żeby ponowienia się nie zbiegały
}

async function claimJob(): Promise<JobDoc | null> {
  const { jobs } = await collections();
  const now = new Date();
  return jobs.findOneAndUpdate(
    { status: { $in: ["pending", "processing"] }, visibleAt: { $lte: now } },
    {
      $set: { status: "processing", visibleAt: new Date(now.getTime() + VISIBILITY_TIMEOUT_MS), updatedAt: now },
      $inc: { deliveryCount: 1 },
    },
    { sort: { visibleAt: 1 }, returnDocument: "after" },
  );
}

async function deadLetter(job: JobDoc, reason: string) {
  const { jobs, deadLetters } = await collections();
  try {
    await deadLetters.insertOne({
      _id: job._id,
      topic: job.topic,
      payload: job.payload,
      deliveryCount: job.deliveryCount,
      lastError: reason,
      failedAt: new Date(),
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  await jobs.updateOne(
    { _id: job._id, status: "processing" },
    { $set: { status: "dead", lastError: reason, updatedAt: new Date() } },
  );
}

async function handleTicketEmail(job: JobDoc) {
  const { reservations, events } = await collections();
  const reservation = await reservations.findOne({ _id: job.payload.reservationId });
  if (!reservation || reservation.status !== "purchased" || !reservation.code) {
    throw new PermanentJobError(`Brak opłaconej rezerwacji ${job.payload.reservationId}`);
  }
  const event = await events.findOne({ _id: reservation.eventId });
  const when = event
    ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(
        event.startsAt,
      )
    : "";
  await sendMail({
    idempotencyKey: job._id,
    to: reservation.email,
    subject: `Twój bilet: ${event?.film ?? "seans"} (${reservation.code})`,
    body: [
      `Cześć ${reservation.customerName},`,
      `${event?.film ?? ""}, ${when}, ${event?.hall ?? ""}.`,
      `${seatLabel(reservation.seatId)}. Kod biletu: ${reservation.code}.`,
    ].join("\n"),
  });
}

async function processJob(job: JobDoc): Promise<"done" | "retry" | "dead"> {
  const { jobs } = await collections();
  if (job.deliveryCount > MAX_ATTEMPTS) {
    await deadLetter(job, job.lastError ?? "Przekroczono limit prób");
    return "dead";
  }
  try {
    await handleTicketEmail(job);
    // ack dopiero po wykonanej pracy
    await jobs.updateOne(
      { _id: job._id, status: "processing" },
      { $set: { status: "done", updatedAt: new Date() }, $unset: { lastError: "" } },
    );
    return "done";
  } catch (err) {
    if (err instanceof PermanentJobError) {
      await deadLetter(job, err.message);
      return "dead";
    }
    const now = Date.now();
    if (err instanceof CircuitOpenError) {
      // Zależność leży: nie palimy prób, wracamy, gdy bezpiecznik przepuści próbę.
      await jobs.updateOne(
        { _id: job._id, status: "processing" },
        {
          $set: { status: "pending", visibleAt: new Date(Math.max(err.retryAt, now + 1000)), updatedAt: new Date() },
          $inc: { deliveryCount: -1 },
        },
      );
      return "retry";
    }
    const message = err instanceof Error ? err.message : String(err);
    await jobs.updateOne(
      { _id: job._id, status: "processing" },
      {
        $set: {
          status: "pending",
          visibleAt: new Date(now + backoffMs(job.deliveryCount)),
          lastError: message,
          updatedAt: new Date(),
        },
      },
    );
    return "retry";
  }
}

export async function runWorkerTick() {
  const swept = await sweepExpired();
  const outcome = { done: 0, retry: 0, dead: 0 };
  // Gdy bezpiecznik jest otwarty, nie pobieramy zadań mailowych wcale.
  if (mailBreaker.canRequest()) {
    const claimed: JobDoc[] = [];
    for (let i = 0; i < BATCH; i++) {
      const job = await claimJob();
      if (!job) break;
      claimed.push(job);
      if (!mailBreaker.canRequest()) break;
    }
    const results = await Promise.all(claimed.map(processJob));
    for (const r of results) outcome[r]++;
  }
  return { swept, ...outcome };
}

const g = globalThis as typeof globalThis & { __kinoWorker?: { timer: ReturnType<typeof setInterval> } };

export function startWorker(intervalMs = 3000) {
  if (g.__kinoWorker) return;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // jeden tick naraz
    running = true;
    try {
      await runWorkerTick();
    } catch (err) {
      console.error("[worker] tick nieudany", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  g.__kinoWorker = { timer };
  console.log("[worker] uruchomiony w procesie serwera");
}

export function stopWorker() {
  if (g.__kinoWorker) clearInterval(g.__kinoWorker.timer);
  g.__kinoWorker = undefined;
}

export async function queueStats() {
  const { jobs, deadLetters, mails } = await collections();
  const byStatus = await jobs.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray();
  const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  const [dead, sent, recentDead] = await Promise.all([
    deadLetters.countDocuments(),
    mails.countDocuments(),
    deadLetters.find({}, { sort: { failedAt: -1 }, limit: 5 }).toArray(),
  ]);
  return {
    pending: counts.pending ?? 0,
    processing: counts.processing ?? 0,
    done: counts.done ?? 0,
    deadLetters: dead,
    mailsSent: sent,
    // /status jest publiczny: ID zadania zawiera ID rezerwacji, a ono działa jak link do biletu.
    // Pokazujemy tylko typ zadania i błąd z wyciętymi identyfikatorami.
    recentDeadLetters: recentDead.map((d) => ({
      topic: d.topic,
      lastError: d.lastError.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "…"),
      failedAt: d.failedAt.toISOString(),
    })),
  };
}
