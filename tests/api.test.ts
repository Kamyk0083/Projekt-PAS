import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, collections } from "@/server/db";
import { GET as listEvents } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import { GET as getReservation } from "@/app/api/reservations/[id]/route";
import { POST as purchaseReservation } from "@/app/api/reservations/[id]/purchase/route";
import { runWorkerTick, stopWorker } from "@/server/worker";

const EVENT = "nocny-pociag";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function post(body: unknown, headers: Record<string, string> = {}) {
  return createReservation(
    new Request("http://test/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    undefined as never,
  );
}

function buy(id: string) {
  return purchaseReservation(new Request(`http://test/api/reservations/${id}/purchase`, { method: "POST" }), ctx(id));
}

async function taken(eventId = EVENT): Promise<string[]> {
  const res = await getEvent(new Request(`http://test/api/events/${eventId}`), ctx(eventId));
  return (await res.json()).takenSeats;
}

const person = { customerName: "Ola Wiśniewska", email: "ola@example.pl" };

beforeAll(async () => {
  process.env.WORKER_ENABLED = "false";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.MAILER_FAILURE_RATE = "0";
  process.env.MAILER_LATENCY_MS = "5";
  await collections();
});

beforeEach(async () => {
  process.env.RESERVATION_TTL_SECONDS = "120";
  const c = await collections();
  await Promise.all([
    c.seats.deleteMany({}),
    c.reservations.deleteMany({}),
    c.jobs.deleteMany({}),
    c.deadLetters.deleteMany({}),
    c.mails.deleteMany({}),
    c.rateBuckets.deleteMany({}),
  ]);
});

afterAll(async () => {
  stopWorker();
  await closeDb();
});

describe("A. wydarzenia i mapa", () => {
  it("zwraca 3 seanse w 2 salach po 8x10 foteli", async () => {
    const res = await listEvents(new Request("http://test/api/events"), undefined as never);
    expect(res.status).toBe(200);
    const events = await res.json();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e: { hall: string }) => e.hall)).size).toBe(2);
    for (const e of events) expect(e.layout).toMatchObject({ rows: 8, seatsPerRow: 10 });
  });

  it("404 dla nieistniejącego seansu", async () => {
    const res = await getEvent(new Request("http://test/api/events/nie-ma"), ctx("nie-ma"));
    expect(res.status).toBe(404);
  });
});

describe("B. rezerwacja", () => {
  it("rezerwuje fotel na czas z konfiguracji i pokazuje go innym jako zajęty", async () => {
    const before = Date.now();
    const res = await post({ eventId: EVENT, seatId: "F7", ...person });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reservationId).toMatch(/[0-9a-f-]{36}/);
    const ttl = new Date(body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(115_000);
    expect(ttl).toBeLessThan(125_000);
    expect(await taken()).toContain("F7");
  });

  it("waliduje dane wejściowe", async () => {
    expect((await post({ eventId: EVENT, seatId: "F7", customerName: "A", email: "x@y.pl" })).status).toBe(400);
    expect((await post({ eventId: EVENT, seatId: "F7", customerName: "Adam", email: "zly-mail" })).status).toBe(400);
    expect((await post({ eventId: EVENT, seatId: "Z99", ...person })).status).toBe(400);
    expect((await post({ eventId: "nie-ma", seatId: "A1", ...person })).status).toBe(404);
  });

  it("przy 20 równoległych próbach o ten sam fotel wygrywa dokładnie jedna", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post({ eventId: EVENT, seatId: "C5", customerName: `Klient ${i}`, email: `k${i}@example.pl` }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    const { reservations } = await collections();
    expect(await reservations.countDocuments({ seatId: "C5" })).toBe(1);
  });

  it("ponowienie z tym samym Idempotency-Key zwraca tę samą rezerwację", async () => {
    const headers = { "Idempotency-Key": "op-123-abcdefgh" };
    const first = await post({ eventId: EVENT, seatId: "D4", ...person }, headers);
    const replays = await Promise.all([1, 2, 3].map(() => post({ eventId: EVENT, seatId: "D4", ...person }, headers)));
    const a = await first.json();
    for (const r of replays) {
      expect(r.status).toBe(200);
      expect((await r.json()).reservationId).toBe(a.reservationId);
    }
    const { reservations } = await collections();
    expect(await reservations.countDocuments({})).toBe(1);
  });

  it("ten sam klucz dla innego fotela to błąd 422", async () => {
    const headers = { "Idempotency-Key": "op-456-abcdefgh" };
    await post({ eventId: EVENT, seatId: "D5", ...person }, headers);
    expect((await post({ eventId: EVENT, seatId: "D6", ...person }, headers)).status).toBe(422);
  });

  it("po wygaśnięciu fotel wraca do puli, a stara rezerwacja nie da się kupić", async () => {
    process.env.RESERVATION_TTL_SECONDS = "1";
    const first = await (await post({ eventId: EVENT, seatId: "H1", ...person })).json();
    await new Promise((r) => setTimeout(r, 1200));
    expect(await taken()).not.toContain("H1");

    const res = await buy(first.reservationId);
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("Rezerwacja wygasła, fotel wrócił do puli.");

    process.env.RESERVATION_TTL_SECONDS = "120";
    const second = await post({ eventId: EVENT, seatId: "H1", customerName: "Jan Nowak", email: "jan@example.pl" });
    expect(second.status).toBe(201);
    const view = await (await getReservation(new Request("http://x"), ctx(first.reservationId))).json();
    expect(view.status).toBe("expired");
  });
});

describe("C. zakup", () => {
  it("zakup zwraca kod, a ponowienie ten sam kod (idempotentnie)", async () => {
    const { reservationId } = await (await post({ eventId: EVENT, seatId: "E3", ...person })).json();
    const res = await buy(reservationId);
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect(code).toMatch(/^KP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const again = await Promise.all([buy(reservationId), buy(reservationId)]);
    for (const r of again) expect((await r.json()).code).toBe(code);
    expect(await taken()).toContain("E3");
  });

  it("kupiony fotel nie wraca do puli nawet po czasie rezerwacji", async () => {
    process.env.RESERVATION_TTL_SECONDS = "1";
    const { reservationId } = await (await post({ eventId: EVENT, seatId: "B2", ...person })).json();
    await buy(reservationId);
    await new Promise((r) => setTimeout(r, 1200));
    await runWorkerTick();
    expect(await taken()).toContain("B2");
    expect((await post({ eventId: EVENT, seatId: "B2", ...person })).status).toBe(409);
  });

  it("404 dla nieznanej rezerwacji", async () => {
    expect((await buy("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("praca w tle", () => {
  it("zakup trafia do kolejki, worker wysyła dokładnie jeden mail", async () => {
    const { reservationId } = await (await post({ eventId: EVENT, seatId: "A1", ...person })).json();
    await buy(reservationId);
    await runWorkerTick();
    await runWorkerTick();
    const c = await collections();
    expect(await c.mails.countDocuments()).toBe(1);
    const view = await (await getReservation(new Request("http://x"), ctx(reservationId))).json();
    expect(view.emailStatus).toBe("sent");
  });

  it("zatruta wiadomość trafia do DLQ i nie blokuje kolejki", async () => {
    const c = await collections();
    const now = new Date();
    await c.jobs.insertOne({
      _id: "ticket-email:poison",
      topic: "ticket-email",
      payload: { reservationId: "nie-istnieje" },
      status: "pending",
      deliveryCount: 0,
      visibleAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await runWorkerTick();
    expect(await c.deadLetters.countDocuments({ _id: "ticket-email:poison" })).toBe(1);
    expect((await c.jobs.findOne({ _id: "ticket-email:poison" }))?.status).toBe("dead");
  });
});

describe("przeciążenie", () => {
  it("limit żądań odpowiada 429 z Retry-After", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_CAPACITY = "3";
    process.env.RATE_LIMIT_REFILL_PER_SEC = "0.1";
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await post({ eventId: EVENT, seatId: `G${i + 1}`, ...person }, { "x-forwarded-for": "10.0.0.9" });
        statuses.push(res.status);
        if (res.status === 429) expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      expect(statuses).toEqual([201, 201, 201, 429, 429]);
    } finally {
      process.env.RATE_LIMIT_ENABLED = "false";
    }
  });
});
