import { randomUUID } from "node:crypto";
import { collections, getDb, isDuplicateKey, type EventDoc, type ReservationDoc, type WaitlistDoc } from "./db";
import { config } from "./config";
import { AppError, badRequest, notFound } from "./errors";
import { freeSeats, getEventDoc, takenSeats } from "./events";
import { waitlistOfferJob } from "./jobs";
import { isPaid, maskEmail, reservationInput, seatKey } from "./reservations";
import { totalSeats } from "@/lib/hall";
import type { WaitlistJoin, WaitlistView } from "@/lib/types";

// Lista oczekujących (etap IV).
//
// Karta A: zapis na wyprzedany seans, miejsce w kolejce, wypisanie.
// Karta B: zwolniony fotel zamienia się w zwykłą rezerwację z etapu I dla pierwszej osoby z kolejki.
// Karta C (src/server/waitlistMail.ts, src/server/resendWebhook.ts): mail z linkiem do zapłaty
// i informacja z webhooka Resenda, że mail nie doszedł.
//
// Fotel zwalnia się po cichu: rezerwacja po prostu mija (expiresAt), nikt nie wysyła zdarzenia.
// Vercel Cron na darmowym planie budzi nas najwyżej raz dziennie, więc kolejka nie może na nim
// polegać. Zamiast tego "dogania" stan przy każdym żądaniu, które dotyczy seansu (mapa sali,
// rezerwacja, zapis, stan wpisu na liście, webhook Resenda) oraz w workerze. Każdy przebieg jest
// idempotentny, a o tym, kto dostaje fotel, rozstrzyga transakcja w bazie, więc wiele instancji
// naraz nie rozda jednego miejsca dwa razy.

const WAITLIST_ID = /^[0-9a-f-]{36}$/i;

const waitlistInput = reservationInput.pick({ customerName: true, email: true });

export function parseWaitlistId(id: string): string {
  if (!WAITLIST_ID.test(id)) throw notFound("wpis na liście oczekujących");
  return id;
}

function parseJoin(body: unknown) {
  const result = waitlistInput.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join(".");
    throw badRequest(first ? (field ? `${field}: ${first.message}` : first.message) : "Niepoprawne dane.");
  }
  return result.data;
}

/** Miejsce w kolejce liczone od 1. Kto już nie czeka (oferta, bilet, wypisanie), ma 0. */
export async function positionOf(entry: WaitlistDoc): Promise<number> {
  if (entry.status !== "waiting") return 0;
  const { waitlist } = await collections();
  const ahead = await waitlist.countDocuments(
    { eventId: entry.eventId, status: "waiting", seq: { $lt: entry.seq } },
    { maxTimeMS: config.dbOpTimeoutMs },
  );
  return ahead + 1;
}

// ---- Karta A: zapis --------------------------------------------------------------------

/**
 * POST /api/events/:id/waitlist { email, customerName } -> { waitlistId, position }.
 * - Odmowa 4xx, gdy seans nie jest wyprzedany: wolny fotel rezerwuje się normalnie.
 * - Ta sama osoba drugi raz (podwójny klik, ponowienie): ten sam wpis i aktualne miejsce,
 *   bo e-mail jest unikalny wśród aktywnych wpisów seansu (unikalny indeks, nie sprawdzenie w kodzie).
 * - Kolejność nadaje licznik w tej samej transakcji co zapis, więc dwa równoległe zapisy
 *   dostają różne, kolejne numery, a zwrócone `position` jest dokładne.
 */
export async function joinWaitlist(
  rawEventId: string,
  body: unknown,
): Promise<WaitlistJoin & { replayed: boolean }> {
  const input = parseJoin(body);
  const event = await getEventDoc(rawEventId);
  const eventId = event._id;
  if (event.startsAt.getTime() <= Date.now()) {
    throw new AppError(409, "EVENT_STARTED", "Ten seans już się rozpoczął.");
  }

  // Zwolnione fotele najpierw trafiają do osób, które już czekają. Jeśli fotel jest wolny,
  // a nikt nie czeka, seans nie jest wyprzedany i zapis na listę nie ma sensu.
  await advanceWaitlist(eventId).catch(logAdvanceError);

  const { waitlist } = await collections();
  const existing = await waitlist.findOne({ eventId, email: input.email, active: true });
  if (existing) return { waitlistId: existing._id, position: await positionOf(existing), replayed: true };

  const taken = await takenSeats(eventId);
  if (taken.length < totalSeats(event.layout)) {
    throw new AppError(
      409,
      "NOT_SOLD_OUT",
      "Na ten seans są jeszcze wolne miejsca. Zarezerwuj fotel zamiast zapisywać się na listę.",
    );
  }
  const active = await waitlist.countDocuments({ eventId, active: true }, { maxTimeMS: config.dbOpTimeoutMs });
  if (active >= config.waitlist.maxPerEvent) {
    throw new AppError(409, "WAITLIST_FULL", "Lista oczekujących na ten seans jest pełna.");
  }

  const { client } = await getDb();
  const { counters } = await collections();
  const now = new Date();
  const doc: WaitlistDoc = {
    _id: randomUUID(),
    eventId,
    email: input.email,
    customerName: input.customerName,
    seq: 0,
    status: "waiting",
    active: true,
    createdAt: now,
    updatedAt: now,
    offers: 0,
  };

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const counter = await counters.findOneAndUpdate(
        { _id: `waitlist:${eventId}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after", session },
      );
      doc.seq = counter!.seq;
      await waitlist.insertOne(doc, { session });
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Równoległy zapis tej samej osoby wygrał wyścig: oddajemy jego wpis.
    const winner = await waitlist.findOne({ eventId, email: input.email, active: true });
    if (!winner) throw err;
    return { waitlistId: winner._id, position: await positionOf(winner), replayed: true };
  } finally {
    await session.endSession();
  }

  return { waitlistId: doc._id, position: await positionOf(doc), replayed: false };
}

// ---- Karta A: stan wpisu i wypisanie ---------------------------------------------------

/** GET /api/waitlist/:id -> { status, position, reservationId?, offerExpiresAt? }. */
export async function waitlistView(rawId: string): Promise<WaitlistView> {
  const id = parseWaitlistId(rawId);
  const { waitlist, reservations } = await collections();
  let entry = await waitlist.findOne({ _id: id }, { maxTimeMS: config.dbOpTimeoutMs });
  if (!entry) throw notFound("wpis na liście oczekujących");

  // Ten endpoint odpytuje strona osoby z listy, więc to on najczęściej "budzi" kolejkę.
  if (entry.active) {
    await advanceWaitlist(entry.eventId).catch(logAdvanceError);
    entry = (await waitlist.findOne({ _id: id })) ?? entry;
  }

  const view: WaitlistView = {
    waitlistId: entry._id,
    eventId: entry.eventId,
    status: entry.status,
    position: await positionOf(entry),
    emailMasked: maskEmail(entry.email),
    serverTime: new Date().toISOString(),
  };
  if (entry.status !== "waiting" && entry.status !== "left" && entry.reservationId) {
    view.reservationId = entry.reservationId;
    if (entry.seatId) view.seatId = entry.seatId;
  }
  if (entry.status === "offered" && entry.reservationId) {
    const reservation = await reservations.findOne({ _id: entry.reservationId }, { projection: { expiresAt: 1 } });
    if (reservation) view.offerExpiresAt = reservation.expiresAt.toISOString();
  }
  if (entry.status === "missed" && entry.missedReason) view.missedReason = entry.missedReason;
  return view;
}

/**
 * DELETE /api/waitlist/:id. W każdej chwili: z kolejki albo z oferty. Wypisanie z oferty
 * od razu oddaje fotel następnej osobie (nie czekamy, aż minie 15 minut).
 * Ponowienie jest bezpieczne: drugi DELETE zwraca ten sam wynik.
 */
export async function leaveWaitlist(rawId: string): Promise<{ waitlistId: string; status: WaitlistDoc["status"] }> {
  const id = parseWaitlistId(rawId);
  const { waitlist } = await collections();

  // Kilka prób, bo stan może się zmienić między odczytem a zapisem (np. właśnie dostał ofertę).
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await waitlist.findOne({ _id: id }, { maxTimeMS: config.dbOpTimeoutMs });
    if (!entry) throw notFound("wpis na liście oczekujących");
    if (entry.status === "done") {
      throw new AppError(409, "ALREADY_PURCHASED", "Bilet z listy oczekujących jest już kupiony, więc nie ma z czego się wypisać.");
    }
    if (entry.status === "left" || entry.status === "missed") return { waitlistId: id, status: entry.status };

    const now = new Date();
    if (entry.status === "waiting") {
      const left = await waitlist.updateOne(
        { _id: id, status: "waiting" },
        { $set: { status: "left", active: false, finishedAt: now, updatedAt: now } },
      );
      if (left.modifiedCount === 1) return { waitlistId: id, status: "left" };
      continue;
    }

    const outcome = await closeOffer(entry, "left", now);
    if (outcome === "done") {
      throw new AppError(409, "ALREADY_PURCHASED", "Bilet z listy oczekujących jest już kupiony, więc nie ma z czego się wypisać.");
    }
    if (outcome === "closed") {
      // Fotel wrócił: od razu proponujemy go następnej osobie.
      await advanceWaitlist(entry.eventId).catch(logAdvanceError);
      return { waitlistId: id, status: "left" };
    }
  }
  throw new AppError(409, "CONFLICT", "Stan wpisu właśnie się zmienia. Spróbuj ponownie.", { retryable: true });
}

// ---- Karta B: zwolniony fotel dla pierwszej osoby z kolejki ----------------------------

export type AdvanceResult = { offered: number; closed: number };

// Jeden przebieg na seans naraz w obrębie instancji: odpytywanie mapy sali przez wielu
// klientów nie mnoży pracy. Między instancjami poprawność zapewniają transakcje.
type Slot = { running: Promise<AdvanceResult>; queued?: Promise<AdvanceResult> };
const g = globalThis as typeof globalThis & { __kinoWaitlistRuns?: Map<string, Slot> };
const runs = g.__kinoWaitlistRuns ?? (g.__kinoWaitlistRuns = new Map());

export function logAdvanceError(err: unknown) {
  console.error("[waitlist] nie udało się przesunąć kolejki", err instanceof Error ? err.message : err);
}

/**
 * Doprowadza kolejkę seansu do aktualnego stanu:
 * 1. zamyka oferty, które się skończyły (kupione -> done, minął czas -> missed),
 * 2. wolne fotele oddaje kolejnym osobom z kolejki jako zwykłe rezerwacje.
 * Idempotentne: można wołać przy każdym żądaniu i z wielu instancji naraz.
 */
export function advanceWaitlist(eventId: string): Promise<AdvanceResult> {
  const slot = runs.get(eventId);
  if (!slot) return startRun(eventId);
  // Trwający przebieg mógł zacząć się przed zmianą, o której wie wołający (np. właśnie zwolnił
  // fotel). Dlatego wszyscy, którzy przyszli w trakcie, dostają jeden wspólny przebieg zaraz po nim.
  slot.queued ??= slot.running.catch(() => undefined).then(() => advanceWaitlist(eventId));
  return slot.queued;
}

function startRun(eventId: string): Promise<AdvanceResult> {
  const slot = {} as Slot;
  slot.running = advance(eventId).finally(() => {
    if (runs.get(eventId) === slot) runs.delete(eventId);
  });
  runs.set(eventId, slot);
  return slot.running;
}

/** Przebieg bez współdzielenia: tak wyglądają dwie instancje serwera naraz (testy wyścigów). */
export const advanceWaitlistUnshared = (eventId: string) => advance(eventId);

async function advance(eventId: string): Promise<AdvanceResult> {
  const { waitlist } = await collections();
  // Szybka ścieżka: seans bez nikogo na liście kosztuje jedno zapytanie po indeksie.
  const anyone = await waitlist.findOne(
    { eventId, status: { $in: ["waiting", "offered"] } },
    { projection: { _id: 1 }, maxTimeMS: config.dbOpTimeoutMs },
  );
  if (!anyone) return { offered: 0, closed: 0 };
  const closed = await closeFinishedOffers(eventId);
  const offered = await fillFreeSeats(eventId);
  return { offered, closed };
}

/** Wszystkie seanse z aktywną listą: siatka bezpieczeństwa w workerze i w cronie. */
export async function advanceAllWaitlists(limit = 50): Promise<number> {
  const { waitlist } = await collections();
  const eventIds = (await waitlist.distinct("eventId", { status: { $in: ["waiting", "offered"] } })).slice(0, limit);
  let offered = 0;
  for (const eventId of eventIds) {
    offered += (await advanceWaitlist(eventId).catch((err) => (logAdvanceError(err), { offered: 0 }))).offered;
  }
  return offered;
}

async function closeFinishedOffers(eventId: string): Promise<number> {
  const { waitlist, reservations } = await collections();
  const offers = await waitlist.find({ eventId, status: "offered" }, { maxTimeMS: config.dbOpTimeoutMs }).toArray();
  let closed = 0;
  for (const entry of offers) {
    const reservation = entry.reservationId ? await reservations.findOne({ _id: entry.reservationId }) : null;
    const now = new Date();
    if (reservation && !isPaid(reservation) && reservation.status === "held" && reservation.expiresAt > now) continue;
    const outcome = await closeOffer(entry, reservation && isPaid(reservation) ? "done" : "expired", now);
    if (outcome !== "unchanged") closed++;
  }
  return closed;
}

type CloseReason = "done" | "expired" | "undelivered" | "left";
type CloseOutcome = "closed" | "requeued" | "done" | "unchanged";

/**
 * Koniec oferty. W jednej transakcji: stan wpisu, rezerwacja (held -> expired) i fotel
 * (wraca do puli od razu, a nie dopiero po expiresAt). Warunek na `reservationId` sprawia,
 * że spóźnione zdarzenie dotyczące starej oferty nie zamknie nowej.
 *
 * Wyjątek: mail z ofertą nie wyszedł z naszej winy (Resend leżał), a czas minął. Wtedy osoba
 * nie traci miejsca w kolejce: wraca na swoje miejsce i dostanie ofertę jeszcze raz. Inaczej
 * awaria dostawcy poczty "spaliłaby" po kolei całą kolejkę.
 */
async function closeOffer(entry: WaitlistDoc, reason: CloseReason, now: Date): Promise<CloseOutcome> {
  const { client } = await getDb();
  const { waitlist, reservations, seats } = await collections();
  const reservationId = entry.reservationId;
  let outcome = "unchanged" as CloseOutcome;

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      outcome = "unchanged";
      const reservation = reservationId ? await reservations.findOne({ _id: reservationId }, { session }) : null;
      const match = { _id: entry._id, status: "offered" as const, reservationId };

      if (reservation && isPaid(reservation)) {
        // Zapłacił (np. webhook Stripe'a doszedł chwilę temu): to sukces, nie koniec oferty.
        const res = await waitlist.updateOne(
          match,
          { $set: { status: "done", active: false, finishedAt: now, updatedAt: now } },
          { session },
        );
        if (res.modifiedCount === 1 || reason === "left") outcome = "done";
        return;
      }
      if (reason === "done") return; // rezerwacja nie jest opłacona: nic nie zmieniamy

      const notNotified = reason === "expired" && !entry.notifiedAt && !entry.undeliveredAt;
      const update: Partial<WaitlistDoc> = notNotified
        ? { status: "waiting", updatedAt: now }
        : reason === "left"
          ? { status: "left", active: false, finishedAt: now, updatedAt: now }
          : {
              status: "missed",
              active: false,
              finishedAt: now,
              updatedAt: now,
              missedReason: reason === "undelivered" || entry.undeliveredAt ? "undelivered" : "timeout",
              ...(reason === "undelivered" ? { undeliveredAt: now } : {}),
            };
      const res = await waitlist.updateOne(match, { $set: update }, { session });
      if (res.modifiedCount !== 1) return; // ktoś już zamknął tę ofertę

      if (reservation && reservation.status === "held") {
        await reservations.updateOne(
          { _id: reservation._id, status: "held" },
          { $set: { status: "expired", expiresAt: reservation.expiresAt < now ? reservation.expiresAt : now } },
          { session },
        );
        await seats.deleteOne(
          { _id: seatKey(reservation.eventId, reservation.seatId), reservationId: reservation._id, status: "held" },
          { session },
        );
      }
      outcome = notNotified ? "requeued" : "closed";
    });
  } finally {
    await session.endSession();
  }
  if (outcome === "requeued") {
    console.warn(`[waitlist] oferta ${entry._id.slice(0, 8)}… minęła bez wysłanego maila: osoba wraca na swoje miejsce`);
  }
  return outcome;
}

class EntryGone extends Error {}

async function fillFreeSeats(eventId: string): Promise<number> {
  const event = await getEventDoc(eventId);
  if (event.startsAt.getTime() <= Date.now()) return 0; // po rozpoczęciu seansu nie rozdajemy miejsc
  const { waitlist } = await collections();
  const free = freeSeats(event, await takenSeats(eventId));
  const limit = config.waitlist.maxOffersPerRun;
  let offered = 0;

  for (let round = 0; free.length && offered < limit && round < limit * 4; round++) {
    const entry = await waitlist.findOne({ eventId, status: "waiting" }, { sort: { seq: 1 } });
    if (!entry) break;
    const result = await offerSeat(event, entry, free[0]);
    if (result === "offered") {
      free.shift();
      offered++;
    } else if (result === "seat-taken") {
      free.shift(); // fotel zajął w międzyczasie ktoś inny: próbujemy następny
    }
    // "entry-gone": wpis zmienił stan (oferta z innej instancji, wypisanie): bierzemy kolejny
  }
  return offered;
}

/**
 * Oferta = zwykła rezerwacja z etapu I. W jednej transakcji:
 * - wpis waiting -> offered (warunkowo: tylko jeden przebieg zamieni ten sam wpis),
 * - fotel: warunkowy upsert jak przy rezerwacji (wolny albo z wygasłą blokadą),
 * - rekord rezerwacji z danymi osoby z listy,
 * - zadanie wysłania maila (transactional outbox: oferta bez maila nie powstanie).
 */
async function offerSeat(event: EventDoc, entry: WaitlistDoc, seatId: string): Promise<"offered" | "seat-taken" | "entry-gone"> {
  const { client } = await getDb();
  const { waitlist, reservations, seats, jobs } = await collections();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.reservationTtlMs);
  const reservationId = randomUUID();

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const claimed = await waitlist.updateOne(
        { _id: entry._id, status: "waiting" },
        {
          $set: { status: "offered", reservationId, seatId, offeredAt: now, updatedAt: now },
          $inc: { offers: 1 },
          $unset: { mailDeadline: "", notifiedAt: "", mailId: "", deliveredAt: "", undeliveredAt: "" },
        },
        { session },
      );
      if (claimed.modifiedCount !== 1) throw new EntryGone();

      const previous = await seats.findOneAndUpdate(
        { _id: seatKey(event._id, seatId), status: "held", expiresAt: { $lte: now } },
        { $set: { eventId: event._id, seatId, status: "held", reservationId, expiresAt, updatedAt: now } },
        { upsert: true, returnDocument: "before", session },
      );
      if (previous) {
        await reservations.updateOne(
          { _id: previous.reservationId, status: "held" },
          { $set: { status: "expired" } },
          { session },
        );
      }
      const reservation: ReservationDoc = {
        _id: reservationId,
        eventId: event._id,
        seatId,
        customerName: entry.customerName,
        email: entry.email,
        status: "held",
        amount: event.price,
        currency: "pln",
        expiresAt,
        createdAt: now,
        checkouts: [],
        waitlistId: entry._id,
      };
      await reservations.insertOne(reservation, { session });
      await jobs.insertOne(waitlistOfferJob(reservationId, entry._id, now), { session });
    });
    return "offered";
  } catch (err) {
    if (err instanceof EntryGone) return "entry-gone";
    if (isDuplicateKey(err)) return "seat-taken";
    throw err;
  } finally {
    await session.endSession();
  }
}

// ---- Kontrakt wewnętrzny C -> B: mail nie doszedł ----------------------------------------

/**
 * Karta C daje znać karcie B, że mail z ofertą nie doszedł (odbity w webhooku Resenda albo
 * odrzucony na stałe przy wysyłce). Oferta przepada od razu, fotel trafia do następnej osoby.
 * Działa tylko na bieżącą ofertę tej rezerwacji: powtórzony albo spóźniony webhook nic nie psuje,
 * a opłacona rezerwacja zostaje opłacona.
 */
export async function offerUndelivered(reservationId: string): Promise<"missed" | "ignored"> {
  const { waitlist } = await collections();
  const entry = await waitlist.findOne({ reservationId, status: "offered" });
  if (!entry) return "ignored";
  const outcome = await closeOffer(entry, "undelivered", new Date());
  if (outcome !== "closed") return "ignored";
  await advanceWaitlist(entry.eventId).catch(logAdvanceError);
  return "missed";
}

/**
 * Karta C: termin w mailu ustalamy przy pierwszej próbie wysyłki i od tej chwili fotel czeka
 * pełny czas rezerwacji. Gdy poczta się spóźnia (kolejka, awaria Resenda), osoba z listy nie
 * dostaje maila "masz jeszcze 40 sekund". Przedłużamy tylko ważną, nieopłaconą ofertę.
 */
export async function fixMailDeadline(entry: WaitlistDoc, reservation: ReservationDoc): Promise<Date | null> {
  const { client } = await getDb();
  const { waitlist, reservations, seats } = await collections();
  const now = new Date();
  const deadline = new Date(Math.max(reservation.expiresAt.getTime(), now.getTime() + config.reservationTtlMs));
  let result = null as Date | null;

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      result = null;
      const fixed = await waitlist.updateOne(
        { _id: entry._id, status: "offered", reservationId: reservation._id, mailDeadline: { $exists: false } },
        { $set: { mailDeadline: deadline, updatedAt: now } },
        { session },
      );
      if (fixed.modifiedCount !== 1) return;
      const held = await reservations.updateOne(
        { _id: reservation._id, status: "held", expiresAt: { $gt: now } },
        { $set: { expiresAt: deadline } },
        { session },
      );
      const seat = await seats.updateOne(
        { _id: seatKey(reservation.eventId, reservation.seatId), reservationId: reservation._id, status: "held", expiresAt: { $gt: now } },
        { $set: { expiresAt: deadline, updatedAt: now } },
        { session },
      );
      if (held.modifiedCount !== 1 || seat.modifiedCount !== 1) throw new EntryGone();
      result = deadline;
    });
  } catch (err) {
    if (!(err instanceof EntryGone)) throw err;
    return null;
  } finally {
    await session.endSession();
  }
  if (result) return result;
  // Termin ustaliła już wcześniejsza próba tego samego zadania: używamy jej terminu.
  const fresh = await waitlist.findOne({ _id: entry._id, status: "offered", reservationId: reservation._id });
  return fresh?.mailDeadline ?? null;
}

/** Do /status: same liczby, bez adresów i identyfikatorów. */
export async function waitlistStats() {
  const { waitlist } = await collections();
  const rows = await waitlist.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray();
  const counts = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  return {
    waiting: counts.waiting ?? 0,
    offered: counts.offered ?? 0,
    done: counts.done ?? 0,
    missed: counts.missed ?? 0,
    left: counts.left ?? 0,
  };
}
