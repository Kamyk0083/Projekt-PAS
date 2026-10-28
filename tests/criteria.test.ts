// Ataki z "Kryteriów etapu I", 1:1. Każdy test sprawdza wariant za 1 pkt.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, collections } from "@/server/db";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import { POST as purchaseReservation } from "@/app/api/reservations/[id]/purchase/route";
import { stopWorker } from "@/server/worker";

const EVENT = "szum-fal";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

type Body = { eventId: string; seatId: string; customerName: string; email: string };

function reserve(body: Partial<Body>, ip = "203.0.113.1") {
  return createReservation(
    new Request("http://test/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
    undefined as never,
  );
}

function buy(id: string, ip = "203.0.113.1") {
  return purchaseReservation(
    new Request(`http://test/api/reservations/${id}/purchase`, { method: "POST", headers: { "x-forwarded-for": ip } }),
    ctx(id),
  );
}

async function taken(eventId = EVENT): Promise<string[]> {
  const res = await getEvent(new Request(`http://test/api/events/${eventId}`), ctx(eventId));
  return (await res.json()).takenSeats;
}

const person = (n: number) => ({ customerName: `Klient ${n}`, email: `klient${n}@example.pl` });

beforeAll(async () => {
  process.env.WORKER_ENABLED = "false";
  process.env.MAILER_FAILURE_RATE = "0";
  process.env.MAILER_LATENCY_MS = "5";
  await collections();
});

beforeEach(async () => {
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.RESERVATION_TTL_SECONDS = "120";
  const c = await collections();
  await Promise.all([
    c.seats.deleteMany({}),
    c.reservations.deleteMany({}),
    c.jobs.deleteMany({}),
    c.rateBuckets.deleteMany({}),
  ]);
});

afterAll(async () => {
  stopWorker();
  await closeDb();
});

describe("A. Wydarzenia i mapa", () => {
  it("A1: GET /api/events/nie-ma-takiego -> 4xx", async () => {
    const res = await getEvent(new Request("http://test/api/events/nie-ma-takiego"), ctx("nie-ma-takiego"));
    expect(res.status).toBe(404);
  });

  it("A2: zaraz po expiresAt miejsca nie ma w takenSeats", async () => {
    process.env.RESERVATION_TTL_SECONDS = "2";
    const { expiresAt } = await (await reserve({ eventId: EVENT, seatId: "A1", ...person(1) })).json();
    expect(await taken()).toContain("A1");
    await sleep(Date.parse(expiresAt) - Date.now() + 50);
    expect(await taken()).not.toContain("A1");
  });
});

describe("B. Rezerwacja", () => {
  it("B1: identyczny POST 2x po kolei -> ta sama rezerwacja", async () => {
    const body = { eventId: EVENT, seatId: "B1", ...person(1) };
    const first = await reserve(body);
    const second = await reserve(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).reservationId).toBe((await first.json()).reservationId);
    const { reservations } = await collections();
    expect(await reservations.countDocuments({})).toBe(1);
  });

  it("B1: identyczny POST 2x równolegle -> jedna rezerwacja, obie odpowiedzi ją zwracają", async () => {
    const body = { eventId: EVENT, seatId: "B2", ...person(2) };
    const [a, b] = await Promise.all([reserve(body), reserve(body)]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 300)).toBe(true);
    expect((await a.json()).reservationId).toBe((await b.json()).reservationId);
    const { reservations } = await collections();
    expect(await reservations.countDocuments({})).toBe(1);
  });

  it("B2: 20 równoczesnych rezerwacji od różnych klientów -> dokładnie jedna 2xx, reszta 4xx", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => reserve({ eventId: EVENT, seatId: "C3", ...person(i) }, `198.51.100.${i}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s >= 200 && s < 300)).toHaveLength(1);
    expect(statuses.filter((s) => s >= 400 && s < 500)).toHaveLength(19);
  });

  it("B3: zły request -> 4xx i nic nie zapisane", async () => {
    const bad: Partial<Body>[] = [
      { eventId: "nie-ma", seatId: "A1", ...person(1) },
      { eventId: EVENT, seatId: "Z99", ...person(1) },
      { eventId: EVENT, seatId: "A11", ...person(1) },
      { eventId: EVENT, seatId: "A1", customerName: "", email: "a@example.pl" },
      { eventId: EVENT, seatId: "A1", customerName: "Adam", email: "" },
      { eventId: EVENT, seatId: "A1", customerName: "   ", email: "a@example.pl" },
      { eventId: EVENT, seatId: "A1" },
      {},
    ];
    for (const body of bad) {
      const res = await reserve(body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(body)).toBeLessThan(500);
    }
    const raw = await createReservation(
      new Request("http://test/api/reservations", { method: "POST", body: "{to nie json" }),
      undefined as never,
    );
    expect(raw.status).toBe(400);
    const c = await collections();
    expect(await c.reservations.countDocuments({})).toBe(0);
    expect(await c.seats.countDocuments({})).toBe(0);
  });

  it("B4: po wygaśnięciu inna osoba od razu rezerwuje to samo miejsce", async () => {
    process.env.RESERVATION_TTL_SECONDS = "2";
    const { expiresAt } = await (await reserve({ eventId: EVENT, seatId: "D4", ...person(1) })).json();
    await sleep(Date.parse(expiresAt) - Date.now() + 50);
    const res = await reserve({ eventId: EVENT, seatId: "D4", ...person(2) });
    expect(res.status).toBe(201);
  });

  it("B5: 100 rezerwacji w 10 s od jednego klienta -> 429 z Retry-After, drugi klient bez problemu", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    delete process.env.RATE_LIMIT_CAPACITY;
    delete process.env.RATE_LIMIT_REFILL_PER_SEC;
    const seats = ["szum-fal", "nocny-pociag", "orbita-siedem"].flatMap((eventId) =>
      "ABCDEFGH".split("").flatMap((row) => Array.from({ length: 10 }, (_, i) => ({ eventId, seatId: `${row}${i + 1}` }))),
    );
    const spammer: Promise<Response>[] = [];
    let other: Promise<Response> | undefined;
    for (let i = 0; i < 100; i++) {
      spammer.push(reserve({ ...seats[i], ...person(500) }, "192.0.2.10"));
      if (i === 60) other = reserve({ eventId: "orbita-siedem", seatId: "H10", ...person(7) }, "203.0.113.77");
      await sleep(100);
    }
    const responses = await Promise.all(spammer);
    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    for (const r of limited) expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(responses.every((r) => r.status < 500)).toBe(true);
    expect((await other!).status).toBe(201);
  }, 30_000);
});

describe("C. Zakup", () => {
  it("C1: zakup 2x po kolei i równolegle -> ten sam kod, jeden bilet", async () => {
    const { reservationId } = await (await reserve({ eventId: EVENT, seatId: "E5", ...person(1) })).json();
    const parallel = await Promise.all([buy(reservationId), buy(reservationId)]);
    const codes = await Promise.all(parallel.map(async (r) => [r.status, (await r.json()).code]));
    expect(codes[0][0]).toBe(200);
    expect(codes[1][0]).toBe(200);
    expect(codes[0][1]).toBe(codes[1][1]);
    const again = await buy(reservationId);
    expect((await again.json()).code).toBe(codes[0][1]);
    const c = await collections();
    expect(await c.jobs.countDocuments({})).toBe(1);
  });

  it("C2: 5 razy w chwili wygaśnięcia zakup X i rezerwacja Y -> zawsze jeden właściciel, bez 5xx", async () => {
    process.env.RESERVATION_TTL_SECONDS = "1";
    for (let round = 0; round < 5; round++) {
      const seatId = `F${round + 1}`;
      const { reservationId, expiresAt } = await (await reserve({ eventId: EVENT, seatId, ...person(1) })).json();
      await sleep(Date.parse(expiresAt) - Date.now() + (round % 3) - 1); // tuż przed, w chwili, tuż po
      const [x, y] = await Promise.all([buy(reservationId), reserve({ eventId: EVENT, seatId, ...person(2) }, "198.51.100.200")]);
      expect(x.status).toBeLessThan(500);
      expect(y.status).toBeLessThan(500);
      const xOwns = x.status === 200;
      const yOwns = y.status === 201;
      expect(xOwns !== yOwns, `runda ${round}: X=${x.status} Y=${y.status}`).toBe(true);

      const { seats, reservations } = await collections();
      const seat = await seats.findOne({ _id: `${EVENT}|${seatId}` });
      const owner = await reservations.findOne({ _id: seat!.reservationId });
      expect(owner!.customerName).toBe(xOwns ? "Klient 1" : "Klient 2");
      expect(
        await reservations.countDocuments({
          seatId,
          $or: [{ status: "purchased" }, { status: "held", expiresAt: { $gt: new Date() } }],
        }),
      ).toBeLessThanOrEqual(1);
    }
  });

  it("C3: zakup nieistniejącej rezerwacji i błędnego id -> 4xx", async () => {
    for (const id of ["abc", "00000000-0000-4000-8000-000000000000", "", "../../etc"]) {
      const res = await buy(id);
      expect(await res.clone().json()).not.toHaveProperty("code");
      expect(res.status, id).toBeGreaterThanOrEqual(400);
      expect(res.status, id).toBeLessThan(500);
    }
  });

  it("C4: zakup po czasie -> 4xx; kupione przed czasem miejsce zostaje zajęte", async () => {
    process.env.RESERVATION_TTL_SECONDS = "1";
    const late = await (await reserve({ eventId: EVENT, seatId: "G1", ...person(1) })).json();
    const early = await (await reserve({ eventId: EVENT, seatId: "G2", ...person(2) })).json();
    expect((await buy(early.reservationId)).status).toBe(200);
    await sleep(Date.parse(late.expiresAt) - Date.now() + 100);
    const res = await buy(late.reservationId);
    expect(res.status).toBe(410);
    expect(await res.json()).not.toHaveProperty("code"); // odmowa nie może wyglądać jak bilet
    await sleep(1500); // dłużej niż czas rezerwacji
    const now = await taken();
    expect(now).toContain("G2");
    expect(now).not.toContain("G1");
    expect((await reserve({ eventId: EVENT, seatId: "G2", ...person(3) })).status).toBe(409);
  });
});
