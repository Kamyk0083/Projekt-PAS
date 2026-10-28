import { collections, type EventDoc } from "./db";
import { config } from "./config";
import { notFound } from "./errors";
import type { CinemaEvent, EventDetails } from "@/lib/types";

export function toEvent(doc: EventDoc): CinemaEvent {
  const { _id, startsAt, ...rest } = doc;
  return { id: _id, startsAt: startsAt.toISOString(), ...rest };
}

export async function listEvents(): Promise<CinemaEvent[]> {
  const { events } = await collections();
  const docs = await events.find({}, { maxTimeMS: config.dbOpTimeoutMs }).sort({ startsAt: 1 }).toArray();
  return docs.map(toEvent);
}

export async function getEventDoc(eventId: string): Promise<EventDoc> {
  const { events } = await collections();
  const doc = await events.findOne({ _id: eventId }, { maxTimeMS: config.dbOpTimeoutMs });
  if (!doc) throw notFound(`seans "${eventId}"`);
  return doc;
}

// Zajęte = kupione albo z ważną (niewygasłą) rezerwacją. Wygasłe rezerwacje
// znikają z mapy natychmiast, niezależnie od tego, kiedy posprząta je worker.
export async function takenSeats(eventId: string, now = new Date()): Promise<string[]> {
  const { seats } = await collections();
  const docs = await seats
    .find(
      { eventId, $or: [{ status: "sold" }, { status: "held", expiresAt: { $gt: now } }] },
      { projection: { seatId: 1 }, maxTimeMS: config.dbOpTimeoutMs },
    )
    .toArray();
  return docs.map((d) => d.seatId).sort();
}

export async function eventDetails(eventId: string): Promise<EventDetails> {
  const doc = await getEventDoc(eventId);
  return { event: toEvent(doc), takenSeats: await takenSeats(eventId) };
}

export async function takenCounts(): Promise<Record<string, number>> {
  const { seats } = await collections();
  const now = new Date();
  const rows = await seats
    .aggregate<{ _id: string; n: number }>(
      [
        { $match: { $or: [{ status: "sold" }, { status: "held", expiresAt: { $gt: now } }] } },
        { $group: { _id: "$eventId", n: { $sum: 1 } } },
      ],
      { maxTimeMS: config.dbOpTimeoutMs },
    )
    .toArray();
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}
