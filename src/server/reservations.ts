import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { collections, duplicateKeyField, getDb, isDuplicateKey, type ReservationDoc } from "./db";
import { config } from "./config";
import { AppError, badRequest, notFound } from "./errors";
import { getEventDoc, toEvent } from "./events";
import { isSeatInHall } from "@/lib/hall";
import type { EmailStatus, ReservationView } from "@/lib/types";

export const reservationInput = z.object({
  eventId: z.string().trim().min(1).max(100),
  seatId: z.string().trim().toUpperCase().min(2).max(10),
  customerName: z
    .string()
    .trim()
    .min(2, "Podaj imię (co najmniej 2 znaki).")
    .max(80, "Imię może mieć najwyżej 80 znaków."),
  email: z.string().trim().toLowerCase().max(200).pipe(z.email("Podaj poprawny adres e-mail.")),
});

export type ReservationInput = z.infer<typeof reservationInput>;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const RESERVATION_ID = /^[0-9a-f-]{36}$/i;

const seatKey = (eventId: string, seatId: string) => `${eventId}|${seatId}`;

export function parseReservationInput(body: unknown): ReservationInput {
  const result = reservationInput.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join(".");
    throw badRequest(first ? (field ? `${field}: ${first.message}` : first.message) : "Niepoprawne dane.");
  }
  return result.data;
}

export function parseIdempotencyKey(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!IDEMPOTENCY_KEY.test(raw)) throw badRequest("Nagłówek Idempotency-Key ma niepoprawny format.");
  return raw;
}

type ReserveResult = { reservationId: string; expiresAt: string; replayed: boolean };

function replayOf(doc: ReservationDoc, input: ReservationInput): ReserveResult {
  // Ten sam klucz, inna treść: to nie jest ponowienie, tylko błąd klienta.
  if (doc.eventId !== input.eventId || doc.seatId !== input.seatId) {
    throw new AppError(422, "IDEMPOTENCY_MISMATCH", "Ten klucz idempotencji użyto już dla innego fotela.");
  }
  return { reservationId: doc._id, expiresAt: doc.expiresAt.toISOString(), replayed: true };
}

// Rezerwacja fotela (karta B).
// - Atomowość (E01/E02): fotel to dokument o _id `${eventId}|${seatId}`. Zajęcie go to
//   warunkowy upsert: przejdzie tylko, gdy fotela nie ma albo jego blokada wygasła.
//   Gdy ktoś go trzyma, upsert próbuje wstawić duplikat _id i baza odrzuca drugi zapis.
// - Idempotencja (E02): klient wysyła Idempotency-Key; ponowienie zwraca tę samą rezerwację.
// - Transakcja: blokada fotela i rekord rezerwacji powstają razem albo wcale.
export async function reserve(input: ReservationInput, idempotencyKey?: string): Promise<ReserveResult> {
  const { client } = await getDb();
  const { reservations, seats } = await collections();

  if (idempotencyKey) {
    const existing = await reservations.findOne({ idempotencyKey }, { maxTimeMS: config.dbOpTimeoutMs });
    if (existing) return replayOf(existing, input);
  }

  const event = await getEventDoc(input.eventId);
  if (!isSeatInHall(input.seatId, event.layout)) {
    throw badRequest(`W sali "${event.hall}" nie ma fotela ${input.seatId}.`);
  }
  if (event.startsAt.getTime() <= Date.now()) {
    throw new AppError(409, "EVENT_STARTED", "Ten seans już się rozpoczął.");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.reservationTtlMs);
  const reservationId = randomUUID();
  const key = seatKey(input.eventId, input.seatId);

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const previous = await seats.findOneAndUpdate(
        { _id: key, status: "held", expiresAt: { $lte: now } },
        {
          $set: {
            eventId: input.eventId,
            seatId: input.seatId,
            status: "held",
            reservationId,
            expiresAt,
            updatedAt: now,
          },
        },
        { upsert: true, returnDocument: "before", session },
      );
      // Fotel przejęty po wygasłej rezerwacji: domykamy jej status.
      if (previous) {
        await reservations.updateOne(
          { _id: previous.reservationId, status: "held" },
          { $set: { status: "expired" } },
          { session },
        );
      }
      await reservations.insertOne(
        {
          _id: reservationId,
          eventId: input.eventId,
          seatId: input.seatId,
          customerName: input.customerName,
          email: input.email,
          status: "held",
          expiresAt,
          createdAt: now,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        { session },
      );
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Równoległe ponowienie z tym samym kluczem mogło wygrać wyścig: oddajemy jego wynik.
    if (idempotencyKey) {
      const existing = await reservations.findOne({ idempotencyKey });
      if (existing) return replayOf(existing, input);
    }
    const field = duplicateKeyField(err);
    if (field === "_id" || field === undefined) {
      // Identyczne żądanie bez klucza (podwójny klik, retry innego klienta API): ten sam fotel
      // trzyma już ważna rezerwacja tej samej osoby, więc to ponowienie, a nie nowa rezerwacja.
      const same = await reservations.findOne({
        eventId: input.eventId,
        seatId: input.seatId,
        email: input.email,
        customerName: input.customerName,
        status: "held",
        expiresAt: { $gt: new Date() },
      });
      if (same) return { reservationId: same._id, expiresAt: same.expiresAt.toISOString(), replayed: true };
      throw new AppError(409, "SEAT_TAKEN", `Fotel ${input.seatId} jest już zajęty. Wybierz inny.`);
    }
    throw err;
  } finally {
    await session.endSession();
  }

  return { reservationId, expiresAt: expiresAt.toISOString(), replayed: false };
}

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // bez 0/O i 1/I

function ticketCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `KP-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

function parseReservationId(id: string) {
  if (!RESERVATION_ID.test(id)) throw notFound("rezerwacja");
  return id;
}

// Zakup (karta C). Idempotentny z natury: warunkowy zapis "held i niewygasła -> purchased".
// Ponowne kliknięcie albo retry widzi status "purchased" i dostaje ten sam kod.
// W tej samej transakcji trafia do kolejki zadanie wysłania biletu mailem (transactional outbox),
// więc nie ma stanu "kupione, ale zadanie zginęło".
export async function purchase(rawId: string): Promise<{ code: string; replayed: boolean }> {
  const reservationId = parseReservationId(rawId);
  const { client } = await getDb();
  const { reservations, seats, jobs } = await collections();
  const now = new Date();
  const code = ticketCode();

  const session = client.startSession();
  try {
    let result: { code: string; replayed: boolean } | undefined;
    await session.withTransaction(async () => {
      const updated = await reservations.findOneAndUpdate(
        { _id: reservationId, status: "held", expiresAt: { $gt: now } },
        { $set: { status: "purchased", purchasedAt: now, code } },
        { returnDocument: "after", session },
      );

      if (!updated) {
        const existing = await reservations.findOne({ _id: reservationId }, { session });
        if (!existing) throw notFound("rezerwacja");
        if (existing.status === "purchased" && existing.code) {
          result = { code: existing.code, replayed: true };
          return;
        }
        throw new AppError(410, "RESERVATION_EXPIRED", "Rezerwacja wygasła, fotel wrócił do puli.");
      }

      const seat = await seats.updateOne(
        { _id: seatKey(updated.eventId, updated.seatId), reservationId, status: "held" },
        { $set: { status: "sold", expiresAt: null, updatedAt: now } },
        { session },
      );
      // Fotel przejęty przez kogoś innego po wygaśnięciu: transakcja się wycofa, bilet nie powstanie.
      if (seat.matchedCount !== 1) {
        throw new AppError(410, "RESERVATION_EXPIRED", "Rezerwacja wygasła, fotel wrócił do puli.");
      }

      await jobs.insertOne(
        {
          _id: `ticket-email:${reservationId}`,
          topic: "ticket-email",
          payload: { reservationId },
          status: "pending",
          deliveryCount: 0,
          visibleAt: now,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      result = { code, replayed: false };
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export async function getReservation(rawId: string): Promise<ReservationView> {
  const reservationId = parseReservationId(rawId);
  const { reservations, jobs } = await collections();
  const doc = await reservations.findOne({ _id: reservationId }, { maxTimeMS: config.dbOpTimeoutMs });
  if (!doc) throw notFound("rezerwacja");

  const now = new Date();
  const event = await getEventDoc(doc.eventId);
  const status = doc.status === "held" && doc.expiresAt <= now ? "expired" : doc.status;

  let emailStatus: EmailStatus = "none";
  if (doc.status === "purchased") {
    const job = await jobs.findOne({ _id: `ticket-email:${reservationId}` }, { projection: { status: 1 } });
    emailStatus = job?.status === "done" ? "sent" : job?.status === "dead" ? "failed" : "pending";
  }

  return {
    reservationId: doc._id,
    eventId: doc.eventId,
    seatId: doc.seatId,
    customerName: doc.customerName,
    emailMasked: maskEmail(doc.email),
    status,
    expiresAt: doc.expiresAt.toISOString(),
    code: doc.code ?? null,
    purchasedAt: doc.purchasedAt?.toISOString() ?? null,
    emailStatus,
    event: toEvent(event),
    serverTime: now.toISOString(),
  };
}

// Sprzątanie wygasłych rezerwacji (praca w tle). Poprawność nie zależy od niego:
// zapytania i tak traktują wygasłe blokady jak wolne. Operacje są warunkowe,
// więc wielokrotne uruchomienie nic nie psuje.
export async function sweepExpired(now = new Date()) {
  const { reservations, seats } = await collections();
  const [expired, released] = await Promise.all([
    reservations.updateMany({ status: "held", expiresAt: { $lte: now } }, { $set: { status: "expired" } }),
    seats.deleteMany({ status: "held", expiresAt: { $lte: now } }),
  ]);
  return { expired: expired.modifiedCount, released: released.deletedCount };
}
