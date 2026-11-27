// Etap IV: lista oczekujących. Stripe i Voucherify są atrapami (jak w etapie III), poczta to
// dostawca symulowany, a webhook Resenda jest podpisywany prawdziwym algorytmem Svix.
// Upływ 2 minut symulujemy, przesuwając expiresAt w bazie, zamiast czekać.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import Stripe from "stripe";

const stripeCalls = vi.hoisted(() => ({ sessions: [] as { params: Record<string, unknown>; key?: string }[] }));
const voucherify = vi.hoisted(() => ({ members: new Map<string, { balance: number; markers: string[] }>() }));

vi.mock("@/server/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/stripe")>();
  const byKey = new Map<string, { id: string; url: string }>();
  const fake = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
          stripeCalls.sessions.push({ params, key: opts?.idempotencyKey });
          const key = opts?.idempotencyKey ?? String(Math.random());
          if (!byKey.has(key)) {
            const id = `cs_test_wl_${byKey.size + 1}_${Date.now()}`;
            byKey.set(key, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
          }
          return byKey.get(key)!;
        },
        expire: async (id: string) => ({ id, status: "expired" }),
      },
    },
    refunds: { create: async () => ({ id: `re_test_${Date.now()}` }) },
  };
  return { ...actual, callStripe: async (_what: string, fn: (s: unknown) => Promise<unknown>) => fn(fake) };
});

vi.mock("@/server/voucherify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/voucherify")>();
  const cardOf = (email: string) => `card-${email}`;
  const emailOf = (memberId: string) => memberId.replace(/^card-/, "");
  return {
    ...actual,
    loyaltyConfigured: () => true,
    budgetSnapshot: async () => ({ capacity: 80, remaining: 80 }),
    findMemberId: async (email: string) => (voucherify.members.has(email) ? cardOf(email) : null),
    createMember: async (email: string) => {
      if (!voucherify.members.has(email)) voucherify.members.set(email, { balance: 0, markers: [] });
      return cardOf(email);
    },
    readBalance: async (memberId: string) => voucherify.members.get(emailOf(memberId))?.balance ?? 0,
    adjustBalance: async (memberId: string, points: number, marker: string) => {
      const member = voucherify.members.get(emailOf(memberId));
      if (!member) throw new Error("brak karty");
      if (member.balance + points < 0) throw new actual.InsufficientPointsError("insufficient funds");
      member.balance += points;
      member.markers.push(marker);
      return member.balance;
    },
    hasTransaction: async (memberId: string, marker: string) =>
      voucherify.members.get(emailOf(memberId))?.markers.includes(marker) ?? false,
  };
});

import { closeDb, collections } from "@/server/db";
import { GET as listEventsRoute } from "@/app/api/events/route";
import { GET as eventRoute } from "@/app/api/events/[id]/route";
import { POST as joinRoute } from "@/app/api/events/[id]/waitlist/route";
import { DELETE as leaveRoute, GET as waitlistRoute } from "@/app/api/waitlist/[id]/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import { GET as reservationRoute } from "@/app/api/reservations/[id]/route";
import { GET as loyaltyRoute } from "@/app/api/loyalty/route";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { POST as stripeWebhookRoute } from "@/app/api/webhooks/stripe/route";
import { POST as resendWebhookRoute } from "@/app/api/webhooks/resend/route";
import { runWorkerTick, stopWorker } from "@/server/worker";
import { advanceWaitlistUnshared } from "@/server/waitlist";
import { totalSeats } from "@/lib/hall";

const EVENT = "waitlist-test";
const PRICE = 3200;
const STRIPE_SECRET = "whsec_test_kino_pasaz";
const RESEND_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const TTL_MS = 120_000;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let seq = 0;
const email = (label: string) => `delivered+${label}${++seq}.${Date.now()}@resend.dev`;

// ---- pomocnicy: API ---------------------------------------------------------------

async function eventInfo(id = EVENT) {
  const res = await eventRoute(new Request(`http://test/api/events/${id}`), ctx(id));
  return res.json();
}

async function reserve(seatId: string, who: string, eventId = EVENT) {
  const res = await createReservation(
    new Request("http://test/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, seatId, customerName: "Ola Testowa", email: who }),
    }),
    undefined as never,
  );
  return { status: res.status, body: await res.json() };
}

async function join(who: string, eventId = EVENT, customerName = "Kuba Kolejkowy") {
  const res = await joinRoute(
    new Request(`http://test/api/events/${eventId}/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: who, customerName }),
    }),
    ctx(eventId),
  );
  return { status: res.status, body: await res.json(), replayed: res.headers.get("idempotent-replayed") };
}

async function status(id: string) {
  const res = await waitlistRoute(new Request(`http://test/api/waitlist/${id}`), ctx(id));
  return { code: res.status, ...(await res.json()) };
}

async function leave(id: string) {
  const res = await leaveRoute(new Request(`http://test/api/waitlist/${id}`, { method: "DELETE" }), ctx(id));
  return { status: res.status, body: await res.json() };
}

const reservation = async (id: string) =>
  (await reservationRoute(new Request(`http://test/api/reservations/${id}`), ctx(id))).json();

function checkout(id: string, points?: number) {
  return checkoutRoute(
    new Request(`http://test/api/reservations/${id}/checkout`, {
      method: "POST",
      ...(points === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ points }) }),
    }),
    ctx(id),
  );
}

function stripePaid(reservationId: string, sessionId: string, amount: number) {
  const payload = JSON.stringify({
    id: `evt_wl_${randomUUID()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: reservationId,
        amount_total: amount,
        currency: "pln",
        payment_status: "paid",
        payment_intent: `pi_${sessionId}`,
      },
    },
  });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: STRIPE_SECRET });
  return stripeWebhookRoute(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: payload,
    }),
    undefined as never,
  );
}

/** Webhook Resenda podpisany jak przez Svix. */
function resendWebhook(
  event: unknown,
  opts: { secret?: string; svixId?: string; timestamp?: number; headers?: Record<string, string> } = {},
) {
  const body = JSON.stringify(event);
  const svixId = opts.svixId ?? `msg_${randomUUID()}`;
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((opts.secret ?? RESEND_SECRET).replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${svixId}.${timestamp}.${body}`).digest("base64");
  return resendWebhookRoute(
    new Request("http://test/api/webhooks/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${signature}`,
        ...opts.headers,
      },
      body,
    }),
    undefined as never,
  );
}

const bounceEvent = (emailId: string, tags?: Record<string, string>) => ({
  type: "email.bounced",
  created_at: new Date().toISOString(),
  data: {
    email_id: emailId,
    to: ["bounced@resend.dev"],
    subject: "Zwolniło się miejsce",
    bounce: { type: "Permanent", subType: "General", message: "Odbiorca nie istnieje" },
    ...(tags ? { tags } : {}),
  },
});

// ---- pomocnicy: upływ czasu ------------------------------------------------------

/** Mija czas rezerwacji fotela (zamiast czekać 2 minuty). */
async function expireSeat(seatId: string, eventId = EVENT) {
  const c = await collections();
  const past = new Date(Date.now() - 1000);
  const seat = await c.seats.findOne({ _id: `${eventId}|${seatId}` });
  await c.seats.updateOne({ _id: `${eventId}|${seatId}` }, { $set: { expiresAt: past } });
  if (seat) await c.reservations.updateOne({ _id: seat.reservationId, status: "held" }, { $set: { expiresAt: past } });
}

/** Oba miejsca seansu testowego zarezerwowane: seans wyprzedany. */
async function fillHall() {
  expect((await reserve("A1", email("a1-"))).status).toBe(201);
  expect((await reserve("A2", email("a2-"))).status).toBe(201);
  expect((await eventInfo()).soldOut).toBe(true);
}

const warsawClock = (iso: string) =>
  new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" }).format(new Date(iso));

beforeAll(async () => {
  process.env.WORKER_ENABLED = "false";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.MAILER_FAILURE_RATE = "0";
  process.env.MAILER_LATENCY_MS = "0";
  process.env.MAIL_PROVIDER = "simulated";
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
  process.env.APP_URL = "https://kino.example";
  delete process.env.LEGACY_PURCHASE_WITHOUT_PAYMENT;
  await collections();
});

beforeEach(async () => {
  process.env.RESERVATION_TTL_SECONDS = "120";
  stripeCalls.sessions.length = 0;
  voucherify.members.clear();
  const c = await collections();
  await Promise.all([
    c.seats.deleteMany({}),
    c.reservations.deleteMany({}),
    c.jobs.deleteMany({}),
    c.deadLetters.deleteMany({}),
    c.mails.deleteMany({}),
    c.stripeEvents.deleteMany({}),
    c.loyaltyAccounts.deleteMany({}),
    c.waitlist.deleteMany({}),
    c.counters.deleteMany({}),
    c.resendEvents.deleteMany({}),
  ]);
});

afterAll(async () => {
  stopWorker();
  await closeDb();
});

// ---- Karta A ------------------------------------------------------------------------

describe("A. Zapis na listę i miejsce w kolejce", () => {
  it("GET /api/events zawiera wydarzenie waitlist-test z dokładnie dwoma miejscami", async () => {
    const events = await (await listEventsRoute(new Request("http://test/api/events"), undefined as never)).json();
    const test = events.find((e: { id: string }) => e.id === EVENT);
    expect(test).toBeTruthy();
    expect(totalSeats(test.layout)).toBe(2);
  });

  it("soldOut: false, dopóki jest wolne miejsce, i true, gdy oba mają ważną rezerwację", async () => {
    expect(await eventInfo()).toMatchObject({ soldOut: false, takenSeats: [] });
    await reserve("A1", email("x"));
    expect(await eventInfo()).toMatchObject({ soldOut: false, takenSeats: ["A1"] });
    await reserve("A2", email("y"));
    expect(await eventInfo()).toMatchObject({ soldOut: true, takenSeats: ["A1", "A2"] });
    // Zwykły seans też ma pole soldOut.
    expect((await eventInfo("nocny-pociag")).soldOut).toBe(false);
  });

  it("odmowy 4xx: seans niewyprzedany, zły e-mail, brak imienia, nie ma seansu; nic nie trafia do bazy", async () => {
    const notSoldOut = await join(email("a"));
    expect(notSoldOut.status).toBe(409);
    expect(notSoldOut.body.errorCode).toBe("NOT_SOLD_OUT");

    await fillHall();
    expect((await join("to-nie-email")).status).toBe(400);
    expect((await join(email("b"), EVENT, "")).status).toBe(400);
    expect((await join(email("c"), "nie-ma-takiego")).status).toBe(404);
    expect(await (await collections()).waitlist.countDocuments()).toBe(0);
  });

  it("zapis zwraca waitlistId i miejsce od 1; ta sama osoba drugi raz dostaje ten sam wpis", async () => {
    await fillHall();
    const ola = email("ola");
    const first = await join(ola);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ waitlistId: expect.any(String), position: 1 });

    const second = await join(email("jan"));
    expect(second.body.position).toBe(2);

    const again = await join(ola.toUpperCase());
    expect(again.status).toBe(200);
    expect(again.replayed).toBe("true");
    expect(again.body).toEqual(first.body);

    expect(await status(first.body.waitlistId)).toMatchObject({ code: 200, status: "waiting", position: 1 });
    expect(await status(second.body.waitlistId)).toMatchObject({ status: "waiting", position: 2 });
  });

  it("równoległe zapisy dostają różne, kolejne miejsca", async () => {
    await fillHall();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => join(email(`p${i}-`))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.map((r) => r.body.position).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("wypisanie: status left, kolejka się przesuwa, ponowne DELETE daje to samo, zły id to 404", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;

    expect(await leave(a)).toEqual({ status: 200, body: { waitlistId: a, status: "left" } });
    expect(await status(a)).toMatchObject({ status: "left", position: 0 });
    expect(await status(b)).toMatchObject({ status: "waiting", position: 1 });
    expect((await leave(a)).body.status).toBe("left");

    expect((await leave(randomUUID())).status).toBe(404);
    expect((await leave("abc")).status).toBe(404);
    expect((await status("abc")).code).toBe(404);

    // Po wypisaniu można zapisać się jeszcze raz: na koniec kolejki.
    const back = await join((await (await collections()).waitlist.findOne({ _id: a }))!.email);
    expect(back.status).toBe(201);
    expect(back.body.waitlistId).not.toBe(a);
    expect(back.body.position).toBe(2);
  });
});

// ---- Karta B ------------------------------------------------------------------------

describe("B. Zwolnione miejsce dla pierwszej osoby z kolejki", () => {
  it("rezerwacja wygasa: pierwsza osoba dostaje zwykłą rezerwację na 2 minuty, druga czeka dalej", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;

    await expireSeat("A1");
    const before = Date.now();
    const offer = await status(a);
    expect(offer).toMatchObject({ status: "offered", position: 0, reservationId: expect.any(String), seatId: "A1" });
    const left = Date.parse(offer.offerExpiresAt) - before;
    expect(left).toBeGreaterThan(TTL_MS - 5_000);
    expect(left).toBeLessThanOrEqual(TTL_MS + 1_000);

    const r = await reservation(offer.reservationId);
    expect(r).toMatchObject({ status: "held", seatId: "A1", amount: PRICE, fromWaitlist: true });
    expect(r.expiresAt).toBe(offer.offerExpiresAt);
    expect(await status(b)).toMatchObject({ status: "waiting", position: 1 });
    // Fotel jest zajęty przez ofertę, więc seans wciąż jest wyprzedany.
    expect((await eventInfo()).soldOut).toBe(true);
  });

  it("przypadkowy klient nie przejmie zwolnionego fotela, gdy ktoś czeka na liście", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    await expireSeat("A1");

    // Nikt jeszcze nie odpytał kolejki: pierwsze żądanie to rezerwacja kogoś z zewnątrz.
    const snatch = await reserve("A1", email("intruz"));
    expect(snatch.status).toBe(409);
    expect(snatch.body.errorCode).toBe("SEAT_TAKEN");
    expect(await status(a)).toMatchObject({ status: "offered", seatId: "A1" });
  });

  it("dwie instancje naraz rozdają zwolniony fotel tylko raz i zgodnie z kolejnością", async () => {
    await fillHall();
    const ids = [];
    for (const label of ["a", "b", "c"]) ids.push((await join(email(label))).body.waitlistId);
    await expireSeat("A2");

    await Promise.all(Array.from({ length: 10 }, () => advanceWaitlistUnshared(EVENT)));

    const c = await collections();
    expect(await c.reservations.countDocuments({ waitlistId: { $exists: true } })).toBe(1);
    expect(await c.jobs.countDocuments({ topic: "waitlist-offer" })).toBe(1);
    expect(await status(ids[0])).toMatchObject({ status: "offered", seatId: "A2" });
    expect(await status(ids[1])).toMatchObject({ status: "waiting", position: 1 });
    expect(await status(ids[2])).toMatchObject({ status: "waiting", position: 2 });
  });

  it("nie zapłacił na czas: status missed, a miejsce dostaje następna osoba", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;
    await expireSeat("A1");
    const offerA = await status(a);
    await runWorkerTick(); // mail z ofertą wychodzi

    await expireSeat("A1");
    expect(await status(a)).toMatchObject({
      status: "missed",
      missedReason: "timeout",
      position: 0,
      reservationId: offerA.reservationId,
    });
    expect((await reservation(offerA.reservationId)).status).toBe("expired");
    const offerB = await status(b);
    expect(offerB).toMatchObject({ status: "offered", seatId: "A1" });
    expect(offerB.reservationId).not.toBe(offerA.reservationId);
  });

  it("miejsce z listy da się opłacić punktami: done i bilet z rozliczeniem", async () => {
    await fillHall();
    const who = email("punkty");
    await loyaltyRoute(new Request(`http://test/api/loyalty?email=${encodeURIComponent(who)}`), undefined as never);
    const a = (await join(who)).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);

    const res = await checkout(reservationId, 1000);
    expect(res.status).toBe(200);
    const { url, cardAmount } = await res.json();
    expect(cardAmount).toBe(PRICE - 1000);
    expect(voucherify.members.get(who)!.balance).toBe(0);

    expect((await stripePaid(reservationId, url.split("/").pop(), PRICE - 1000)).status).toBe(200);
    expect(await reservation(reservationId)).toMatchObject({
      status: "paid",
      pointsUsed: 1000,
      pointsEarned: 220,
      code: expect.stringMatching(/^KP-/),
      fromWaitlist: true,
    });
    expect(await status(a)).toMatchObject({ status: "done", position: 0, reservationId });
    // Kupionego biletu nie da się "wypisać".
    expect((await leave(a)).status).toBe(409);
  });

  it("wypisanie z oferty od razu oddaje fotel następnej osobie", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;
    await expireSeat("A1");
    const offerA = await status(a);
    expect(offerA.status).toBe("offered");

    expect((await leave(a)).body.status).toBe("left");
    expect((await reservation(offerA.reservationId)).status).toBe("expired");
    expect(await status(b)).toMatchObject({ status: "offered", seatId: "A1" });
  });

  it("oferta, której mail nie zdążył wyjść z naszej winy, nie przepada: osoba wraca na swoje miejsce", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;
    await expireSeat("A1");
    const first = await status(a);
    // Worker nie wysłał maila (np. Resend leżał), a czas oferty minął.
    await expireSeat("A1");

    const again = await status(a);
    expect(again).toMatchObject({ status: "offered", seatId: "A1" });
    expect(again.reservationId).not.toBe(first.reservationId);
    expect(await status(b)).toMatchObject({ status: "waiting", position: 1 });
    expect((await (await collections()).waitlist.findOne({ _id: a }))!.offers).toBe(2);
  });
});

// ---- Karta C ------------------------------------------------------------------------

describe("C. Powiadomienie mailem i webhook Resenda", () => {
  it("mail: nazwa wydarzenia, miejsce, link do zapłaty i godzina, do której miejsce czeka", async () => {
    await fillHall();
    const who = email("mail");
    const a = (await join(who)).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);
    await runWorkerTick();

    const c = await collections();
    const mail = await c.mails.findOne({ _id: `waitlist-offer:${reservationId}` });
    expect(mail).toBeTruthy();
    expect(mail!.to).toBe(who);
    expect(mail!.subject).toContain("Pokaz testowy: lista oczekujących");
    expect(mail!.body).toContain("Rząd A, miejsce 1");
    expect(mail!.body).toContain(`https://kino.example/rezerwacja/${reservationId}`);

    const offer = await status(a);
    expect(mail!.body).toContain(`Miejsce czeka na Ciebie do ${warsawClock(offer.offerExpiresAt)}`);
    expect((await c.waitlist.findOne({ _id: a }))!.notifiedAt).toBeInstanceOf(Date);
    expect((await c.jobs.findOne({ _id: `waitlist-offer:${reservationId}` }))!.status).toBe("done");
  });

  it("mail spóźniony przez kolejkę: miejsce czeka pełne 2 minuty od wysłania", async () => {
    await fillHall();
    const a = (await join(email("late"))).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);
    // Poczta leżała: z 2 minut zostało 20 sekund, zanim mail wyszedł.
    const c = await collections();
    const soon = new Date(Date.now() + 20_000);
    await c.reservations.updateOne({ _id: reservationId }, { $set: { expiresAt: soon } });
    await c.seats.updateOne({ _id: `${EVENT}|A1` }, { $set: { expiresAt: soon } });

    const sentAt = Date.now();
    await runWorkerTick();
    const offer = await status(a);
    expect(Date.parse(offer.offerExpiresAt) - sentAt).toBeGreaterThan(TTL_MS - 5_000);
    expect((await reservation(reservationId)).expiresAt).toBe(offer.offerExpiresAt);
    expect((await c.seats.findOne({ _id: `${EVENT}|A1` }))!.expiresAt!.toISOString()).toBe(offer.offerExpiresAt);
    const mail = await c.mails.findOne({ _id: `waitlist-offer:${reservationId}` });
    expect(mail!.body).toContain(warsawClock(offer.offerExpiresAt));
  });

  it("adres odrzucony na stałe przy wysyłce: missed od razu, miejsce i mail dla następnej osoby", async () => {
    await fillHall();
    const a = (await join(`bounced+wl${++seq}@resend.dev`)).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;
    await expireSeat("A1");
    const offerA = await status(a);
    await runWorkerTick();

    const c = await collections();
    expect(await c.deadLetters.countDocuments({ _id: `waitlist-offer:${offerA.reservationId}` })).toBe(1);
    expect(await status(a)).toMatchObject({ status: "missed", missedReason: "undelivered" });
    const offerB = await status(b);
    expect(offerB).toMatchObject({ status: "offered", seatId: "A1" });

    await runWorkerTick();
    expect(await c.mails.countDocuments({ _id: `waitlist-offer:${offerB.reservationId}` })).toBe(1);
  });

  it("webhook email.bounced: oferta przepada, miejsce dostaje następna osoba; powtórka nic nie zmienia", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    const b = (await join(email("b"))).body.waitlistId;
    await expireSeat("A1");
    const offerA = await status(a);
    await runWorkerTick();
    const c = await collections();
    const mail = await c.mails.findOne({ _id: `waitlist-offer:${offerA.reservationId}` });
    expect(mail!.providerId).toBeTruthy();

    const event = bounceEvent(mail!.providerId!, { kind: "waitlist_offer", reservation: offerA.reservationId, waitlist: a });
    const res = await resendWebhook(event, { svixId: "msg_bounce_1" });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("offer-missed");

    expect(await status(a)).toMatchObject({ status: "missed", missedReason: "undelivered" });
    expect((await reservation(offerA.reservationId)).status).toBe("expired");
    const offerB = await status(b);
    expect(offerB).toMatchObject({ status: "offered", seatId: "A1" });

    // Svix dostarcza co najmniej raz: ta sama wiadomość drugi raz nie rusza oferty osoby B.
    expect((await resendWebhook(event, { svixId: "msg_bounce_1" })).status).toBe(200);
    expect((await status(b)).reservationId).toBe(offerB.reservationId);
    expect((await c.mails.findOne({ providerId: mail!.providerId }))!.bouncedAt).toBeInstanceOf(Date);
  });

  it("odbicie bez tagów rozpoznajemy po ID maila w naszym outboksie", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);
    await runWorkerTick();
    const mail = await (await collections()).mails.findOne({ _id: `waitlist-offer:${reservationId}` });

    const res = await resendWebhook(bounceEvent(mail!.providerId!));
    expect((await res.json()).outcome).toBe("offer-missed");
    expect(await status(a)).toMatchObject({ status: "missed", missedReason: "undelivered" });
  });

  it("podrobiony, przestarzały albo niepodpisany webhook: 400 i żadnej zmiany", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);
    await runWorkerTick();
    const mail = await (await collections()).mails.findOne({ _id: `waitlist-offer:${reservationId}` });
    const event = bounceEvent(mail!.providerId!);

    const forged = await resendWebhook(event, { secret: `whsec_${randomBytes(24).toString("base64")}` });
    expect(forged.status).toBe(400);
    const replayed = await resendWebhook(event, { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 });
    expect(replayed.status).toBe(400);
    const unsigned = await resendWebhookRoute(
      new Request("http://test/api/webhooks/resend", { method: "POST", body: JSON.stringify(event) }),
      undefined as never,
    );
    expect(unsigned.status).toBe(400);

    expect(await status(a)).toMatchObject({ status: "offered", reservationId });
  });

  it("spóźniony bounce po zapłacie nie odbiera biletu", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);
    await runWorkerTick();
    const { url } = await (await checkout(reservationId)).json();
    await stripePaid(reservationId, url.split("/").pop(), PRICE);
    const mail = await (await collections()).mails.findOne({ _id: `waitlist-offer:${reservationId}` });

    const res = await resendWebhook(bounceEvent(mail!.providerId!));
    expect(res.status).toBe(200);
    expect(await status(a)).toMatchObject({ status: "done", reservationId });
    expect((await reservation(reservationId)).status).toBe("paid");
  });

  it("email.delivered zapisuje doręczenie, a zdarzenie o obcym mailu jest ignorowane", async () => {
    await fillHall();
    const a = (await join(email("a"))).body.waitlistId;
    await expireSeat("A1");
    const { reservationId } = await status(a);
    await runWorkerTick();
    const c = await collections();
    const mail = await c.mails.findOne({ _id: `waitlist-offer:${reservationId}` });

    const delivered = await resendWebhook({ type: "email.delivered", data: { email_id: mail!.providerId } });
    expect((await delivered.json()).outcome).toBe("delivered");
    expect((await c.waitlist.findOne({ _id: a }))!.deliveredAt).toBeInstanceOf(Date);

    const foreign = await resendWebhook(bounceEvent(randomUUID()));
    expect(foreign.status).toBe(200);
    expect((await foreign.json()).outcome).toBe("ignored");
    expect(await status(a)).toMatchObject({ status: "offered" });
  });
});
