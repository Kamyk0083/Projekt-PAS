import { after } from "next/server";
import { collections, isDuplicateKey, type JobDoc } from "./db";
import { CircuitOpenError } from "./circuitBreaker";
import { mailBreaker, MailRejectedError, sendMail } from "./mailer";
import { earnMarker, grantPoints, markerApplied, releaseMarker, spendMarker, spendPoints } from "./loyalty";
import { releaseAbandonedPoints, setAttemptPointsState } from "./payments";
import { isPaid, sweepExpired } from "./reservations";
import { buildTicketMail } from "./ticketMail";
import { loyaltyBreaker } from "./voucherify";
import { advanceAllWaitlists } from "./waitlist";
import { deliverOfferMail } from "./waitlistMail";

// Praca w tle (E06). Kolejka to kolekcja `jobs` (zasilana przez transactional outbox przy zakupie).
// - receive: atomowe przejęcie zadania z "visibility timeout" (zadanie ukryte, nie usunięte),
// - ack PO pracy: worker padnie w połowie -> zadanie wróci (at-least-once),
// - duplikaty: dostawca maili deduplikuje po kluczu idempotencji = ID zadania, a operacje
//   na punktach rozpoznajemy po markerze w historii karty w Voucherify,
// - retry z wykładniczym backoffem, limit prób, dead letter queue na zatrute wiadomości.

const VISIBILITY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const BATCH = 8;

/** Zadania, których nie ma sensu ponawiać: idą od razu do DLQ. */
class PermanentJobError extends Error {}
/**
 * Nie wiemy, czy operacja na zewnętrznej usłudze przeszła. Zgadywanie oznaczałoby podwójne
 * naliczenie punktów albo ich utratę, więc zadanie idzie do DLQ do decyzji człowieka.
 */
class AmbiguousStateError extends Error {}

function backoffMs(deliveryCount: number) {
  const base = Math.min(300, 2 ** deliveryCount * 5) * 1000;
  return Math.round(base * (0.5 + Math.random() * 0.5)); // jitter, żeby ponowienia się nie zbiegały
}

// Zadania mailowe i punktowe mają osobne bezpieczniki: awaria Voucherify nie wstrzymuje maili.
const breakerFor = (topic: JobDoc["topic"]) =>
  topic === "ticket-email" || topic === "waitlist-offer" ? mailBreaker : loyaltyBreaker;

async function claimJob(topics: JobDoc["topic"][]): Promise<JobDoc | null> {
  const { jobs } = await collections();
  const now = new Date();
  return jobs.findOneAndUpdate(
    { topic: { $in: topics }, status: { $in: ["pending", "processing"] }, visibleAt: { $lte: now } },
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

// ---- Wysyłka biletu (karta C) ------------------------------------------------

async function handleTicketEmail(job: JobDoc) {
  const { reservations, events } = await collections();
  const reservation = await reservations.findOne({ _id: job.payload.reservationId });
  if (!reservation || !isPaid(reservation) || !reservation.code) {
    throw new PermanentJobError(`Brak opłaconej rezerwacji ${job.payload.reservationId}`);
  }
  const event = await events.findOne({ _id: reservation.eventId });
  const mail = buildTicketMail(reservation, event);
  await sendMail({ idempotencyKey: job._id, to: reservation.email, ...mail });
}

// ---- Punkty (karta A) --------------------------------------------------------

/**
 * Zanim powtórzymy operację na punktach, sprawdzamy w Voucherify, czy nasz zapis już tam jest.
 * Pytamy tylko przy ponowieniu i tylko gdy żądanie mogło wyjść, żeby nie marnować limitu.
 */
async function alreadyApplied(job: JobDoc, email: string, marker: string): Promise<boolean> {
  if (job.deliveryCount <= 1 && !job.issuedAt) return false;
  const applied = await markerApplied(email, marker);
  if (applied === null) {
    throw new AmbiguousStateError(`Nie wiadomo, czy operacja ${marker} przeszła: sprawdź kartę w Voucherify`);
  }
  return applied;
}

/** Znacznik „żądanie wychodzi”: po restarcie w połowie wiemy, że trzeba sprawdzić historię. */
async function markIssued(job: JobDoc) {
  const { jobs } = await collections();
  await jobs.updateOne({ _id: job._id }, { $set: { issuedAt: new Date() } });
}

async function handleLoyaltyEarn(job: JobDoc) {
  const { reservationId, email, points } = job.payload;
  if (!email || !points) throw new PermanentJobError("Zadanie bez adresu albo liczby punktów");
  const marker = earnMarker(reservationId);
  if (await alreadyApplied(job, email, marker)) return;
  await markIssued(job);
  // Punkty ujemne to korekta: opłacona sesja, za którą punkty zdążyły już wrócić na kartę.
  if (points > 0) await grantPoints(email, points, marker);
  else await spendPoints(email, -points, marker);
}

/**
 * Kompensacja: punkty zdjęte na próbę płatności, która nie skończyła się zapłatą, wracają
 * na kartę klienta. Stan próby w bazie mówi, czy jest co zwracać.
 */
async function handleLoyaltyRelease(job: JobDoc) {
  const { reservationId, email, points, attempt: n } = job.payload;
  if (!email || !points || !n) throw new PermanentJobError("Zadanie bez danych próby płatności");
  const { reservations } = await collections();
  const doc = await reservations.findOne({ _id: reservationId });
  const attempt = doc?.checkouts?.find((a) => a.n === n);
  if (!doc || !attempt) throw new PermanentJobError(`Brak próby ${n} rezerwacji ${reservationId}`);
  // Bilet opłacony tą próbą albo punkty już wróciły: nie ma nic do roboty.
  if (attempt.pointsState === "consumed" || attempt.pointsState === "released") return;

  if (attempt.pointsState === "pending") {
    // Nie wiemy, czy punkty w ogóle zeszły (timeout przy zdejmowaniu): sprawdzamy w Voucherify.
    const spent = await markerApplied(email, spendMarker(reservationId, n));
    if (spent === null) {
      throw new AmbiguousStateError(`Nie wiadomo, czy punkty zeszły z karty (${reservationId}, próba ${n})`);
    }
    if (!spent) {
      await setAttemptPointsState(reservationId, n, "failed");
      return;
    }
  }

  const marker = releaseMarker(reservationId, n);
  if (!(await alreadyApplied(job, email, marker))) {
    await markIssued(job);
    await grantPoints(email, points, marker);
  }
  await setAttemptPointsState(reservationId, n, "released");
}

// ---- Lista oczekujących (etap IV, karta C) -------------------------------------

async function handleWaitlistOffer(job: JobDoc) {
  // "stale": oferta już nieaktualna (kupione, wypisany, czas minął). To nie błąd: ack bez maila.
  await deliverOfferMail(job.payload.reservationId, job._id);
}

const handlers: Record<JobDoc["topic"], (job: JobDoc) => Promise<void>> = {
  "ticket-email": handleTicketEmail,
  "loyalty-earn": handleLoyaltyEarn,
  "loyalty-release": handleLoyaltyRelease,
  "waitlist-offer": handleWaitlistOffer,
};

async function processJob(job: JobDoc): Promise<"done" | "retry" | "dead"> {
  const { jobs } = await collections();
  if (job.deliveryCount > MAX_ATTEMPTS) {
    await deadLetter(job, job.lastError ?? "Przekroczono limit prób");
    return "dead";
  }
  try {
    await handlers[job.topic](job);
    // ack dopiero po wykonanej pracy
    await jobs.updateOne(
      { _id: job._id, status: "processing" },
      { $set: { status: "done", updatedAt: new Date() }, $unset: { lastError: "" } },
    );
    return "done";
  } catch (err) {
    if (err instanceof PermanentJobError || err instanceof MailRejectedError || err instanceof AmbiguousStateError) {
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
  // Punkty zdjęte na płatność, która nigdy nie doszła, muszą wrócić na kartę klienta.
  const released = await releaseAbandonedPoints().catch((err) => {
    console.error("[worker] nie udało się zlecić zwrotu punktów", err instanceof Error ? err.message : err);
    return 0;
  });

  // Lista oczekujących: zwolnione fotele dla kolejnych osób i zamknięcie skończonych ofert.
  // Zwykle robią to żądania dotyczące seansu; tu jest siatka bezpieczeństwa (worker, cron).
  const offered = await advanceAllWaitlists().catch((err) => {
    console.error("[worker] nie udało się przesunąć list oczekujących", err instanceof Error ? err.message : err);
    return 0;
  });

  // Bierzemy tylko zadania dla zależności, które odpowiadają: zalana usługa nie blokuje drugiej.
  const topics = (Object.keys(handlers) as JobDoc["topic"][]).filter((t) => breakerFor(t).canRequest());
  const outcome = { done: 0, retry: 0, dead: 0 };
  const claimed: JobDoc[] = [];
  for (let i = 0; i < BATCH && topics.length; i++) {
    const open = topics.filter((t) => breakerFor(t).canRequest());
    if (!open.length) break;
    const job = await claimJob(open);
    if (!job) break;
    claimed.push(job);
  }
  const results = await Promise.all(claimed.map(processJob));
  for (const r of results) outcome[r]++;
  return { swept, releasedPoints: released, waitlistOffers: offered, ...outcome };
}

// Na serverless nie ma stale działającego workera, a Vercel Cron na darmowym planie budzi nas
// raz dziennie. Dlatego żądania, które coś zmieniły (nowa oferta z listy, odbity mail) albo są
// regularnie odpytywane, zlecają przebieg workera po wysłaniu odpowiedzi (`after`).
// Odpytywanie zleca go najwyżej raz na `throttleMs` w danej instancji.
const kicks = (globalThis as typeof globalThis & { __kinoKick?: { at: number } }).__kinoKick ?? { at: 0 };
(globalThis as typeof globalThis & { __kinoKick?: { at: number } }).__kinoKick = kicks;

export function kickWorker(throttleMs = 0) {
  const now = Date.now();
  if (throttleMs > 0 && now - kicks.at < throttleMs) return;
  kicks.at = now;
  try {
    after(() => runWorkerTick().catch(() => undefined));
  } catch {
    /* poza kontekstem żądania (np. testy): zadanie obsłuży zwykły worker */
  }
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
