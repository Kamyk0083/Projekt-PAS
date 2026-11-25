// Etap III: program lojalnościowy. Voucherify i Stripe są zastąpione atrapami (bez sieci),
// ale cała logika po naszej stronie jest prawdziwa: punkty powitalne, limit połowy ceny,
// kwota sesji po rabacie, naliczanie od części zapłaconej kartą, kompensacje i mail.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

const stripeCalls = vi.hoisted(() => ({
  sessions: [] as { params: Record<string, unknown>; key?: string }[],
  expired: [] as string[],
  refunds: [] as { params: Record<string, unknown>; key?: string }[],
}));

// Atrapa Voucherify: pamięta salda i markery operacji, jak prawdziwa karta lojalnościowa.
const voucherify = vi.hoisted(() => ({
  members: new Map<string, { balance: number; markers: string[] }>(),
  calls: [] as string[],
  down: false,
}));

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
            const id = `cs_test_${byKey.size + 1}_${Date.now()}`;
            byKey.set(key, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
          }
          return byKey.get(key)!;
        },
        expire: async (id: string) => {
          stripeCalls.expired.push(id);
          return { id, status: "expired" };
        },
      },
    },
    refunds: {
      create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
        stripeCalls.refunds.push({ params, key: opts?.idempotencyKey });
        return { id: `re_test_${stripeCalls.refunds.length}` };
      },
    },
  };
  return { ...actual, callStripe: async (_what: string, fn: (s: unknown) => Promise<unknown>) => fn(fake) };
});

vi.mock("@/server/voucherify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/voucherify")>();
  const { AppError } = await import("@/server/errors");
  const cardOf = (email: string) => `card-${email}`;
  const emailOf = (memberId: string) => memberId.replace(/^card-/, "");
  const check = (what: string) => {
    voucherify.calls.push(what);
    if (voucherify.down) {
      throw new AppError(503, "LOYALTY_UNAVAILABLE", "Program lojalnościowy jest chwilowo niedostępny (test).", {
        retryable: true,
        retryAfterSec: 5,
      });
    }
  };
  return {
    ...actual,
    loyaltyConfigured: () => true,
    budgetSnapshot: async () => ({ capacity: 80, remaining: 80 }),
    findMemberId: async (email: string) => {
      check("find");
      return voucherify.members.has(email) ? cardOf(email) : null;
    },
    createMember: async (email: string) => {
      check("create");
      if (!voucherify.members.has(email)) voucherify.members.set(email, { balance: 0, markers: [] });
      return cardOf(email);
    },
    readBalance: async (memberId: string) => {
      check("read");
      return voucherify.members.get(emailOf(memberId))?.balance ?? 0;
    },
    adjustBalance: async (memberId: string, points: number, marker: string) => {
      check("adjust");
      const member = voucherify.members.get(emailOf(memberId));
      if (!member) throw new Error("brak karty");
      // Jak Voucherify: saldo nie może zejść poniżej zera.
      if (member.balance + points < 0) throw new actual.InsufficientPointsError("insufficient funds");
      member.balance += points;
      member.markers.push(marker);
      return member.balance;
    },
    hasTransaction: async (memberId: string, marker: string) => {
      check("history");
      return voucherify.members.get(emailOf(memberId))?.markers.includes(marker) ?? false;
    },
  };
});

import { closeDb, collections } from "@/server/db";
import { POST as createReservation } from "@/app/api/reservations/route";
import { GET as getReservation } from "@/app/api/reservations/[id]/route";
import { GET as getLoyalty } from "@/app/api/loyalty/route";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { runWorkerTick, stopWorker } from "@/server/worker";

const EVENT = "orbita-siedem"; // bilet za 3200 groszy (32 zł)
const PRICE = 3200;
const SECRET = "whsec_test_kino_pasaz";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let seq = 0;
const freshEmail = () => `delivered+kino${++seq}.${Date.now()}@resend.dev`;

async function reserve(seatId: string, email: string) {
  const res = await createReservation(
    new Request("http://test/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: EVENT, seatId, customerName: "Jan Testowy", email }),
    }),
    undefined as never,
  );
  return { status: res.status, body: await res.json() };
}

function checkout(id: string, points?: number) {
  return checkoutRoute(
    new Request(`http://test/api/reservations/${id}/checkout`, {
      method: "POST",
      ...(points === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify({ points }) }),
    }),
    ctx(id),
  );
}

const view = async (id: string) =>
  (await getReservation(new Request(`http://test/api/reservations/${id}`), ctx(id))).json();

const loyaltyOf = (email: string) =>
  getLoyalty(new Request(`http://test/api/loyalty?email=${encodeURIComponent(email)}`), undefined as never);

const balanceOf = (email: string) => voucherify.members.get(email)?.balance ?? null;

function sessionIdFromUrl(url: string) {
  return url.split("/").pop()!;
}

let eventSeq = 0;
function completedEvent(reservationId: string, sessionId: string, amount: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_test_${++eventSeq}_${Date.now()}`,
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
        ...overrides,
      },
    },
  };
}

function sendWebhook(event: unknown, secret = SECRET) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return webhookRoute(
    new Request("http://test/api/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body: payload,
    }),
    undefined as never,
  );
}

/** Pełny zakup: rezerwacja, checkout z punktami i opłacona sesja. */
async function buyWithPoints(seatId: string, email: string, points: number) {
  const { body } = await reserve(seatId, email);
  const res = await checkout(body.reservationId, points);
  expect(res.status).toBe(200);
  const { url } = await res.json();
  await sendWebhook(completedEvent(body.reservationId, sessionIdFromUrl(url), PRICE - points));
  return body.reservationId as string;
}

beforeAll(async () => {
  process.env.WORKER_ENABLED = "false";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.MAILER_FAILURE_RATE = "0";
  process.env.MAILER_LATENCY_MS = "0";
  process.env.MAIL_PROVIDER = "simulated";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.APP_URL = "https://kino.example";
  delete process.env.LEGACY_PURCHASE_WITHOUT_PAYMENT;
  await collections();
});

beforeEach(async () => {
  process.env.RESERVATION_TTL_SECONDS = "120";
  stripeCalls.sessions.length = 0;
  stripeCalls.expired.length = 0;
  stripeCalls.refunds.length = 0;
  voucherify.members.clear();
  voucherify.calls.length = 0;
  voucherify.down = false;
  const c = await collections();
  await Promise.all([
    c.seats.deleteMany({}),
    c.reservations.deleteMany({}),
    c.jobs.deleteMany({}),
    c.deadLetters.deleteMany({}),
    c.mails.deleteMany({}),
    c.stripeEvents.deleteMany({}),
    c.loyaltyAccounts.deleteMany({}),
  ]);
});

afterAll(async () => {
  stopWorker();
  await closeDb();
});

describe("A. Konto punktowe", () => {
  it("nowy e-mail dostaje 1000 punktów, a kolejne wejście ich nie dubluje", async () => {
    const email = freshEmail();
    const first = await loyaltyOf(email);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ email, points: 1000 });

    expect(await (await loyaltyOf(email)).json()).toEqual({ email, points: 1000 });
    expect(balanceOf(email)).toBe(1000);
    expect(voucherify.members.get(email)!.markers.filter((m) => m.startsWith("kino:welcome"))).toHaveLength(1);
  });

  it("równoległe pierwsze wejścia nie naliczają punktów powitalnych dwa razy", async () => {
    const email = freshEmail();
    const results = await Promise.all(Array.from({ length: 5 }, () => loyaltyOf(email)));
    const bodies = await Promise.all(results.map((r) => r.json()));
    // Przegrane wyścigi mogą dostać 503 (konto właśnie powstaje), ale nigdy drugiego tysiąca.
    for (const [i, res] of results.entries()) {
      if (res.status === 200) expect(bodies[i].points).toBe(1000);
      else expect(res.status).toBe(503);
    }
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(balanceOf(email)).toBe(1000);
  });

  it("klient, który już ma kartę w Voucherify, zachowuje swoje saldo", async () => {
    const email = freshEmail();
    voucherify.members.set(email, { balance: 250, markers: [] });
    expect(await (await loyaltyOf(email)).json()).toEqual({ email, points: 250 });
    expect(voucherify.calls).not.toContain("create");
  });

  it("zły albo brakujący e-mail: 400", async () => {
    expect((await getLoyalty(new Request("http://test/api/loyalty"), undefined as never)).status).toBe(400);
    expect((await loyaltyOf("nie-email")).status).toBe(400);
  });

  it("saldo prowadzi Voucherify: zmiana poza nami jest widoczna po wygaśnięciu cache'a", async () => {
    process.env.LOYALTY_CACHE_TTL_SECONDS = "0";
    try {
      const email = freshEmail();
      await loyaltyOf(email);
      // Marketing dosypuje punkty w swojej aplikacji.
      voucherify.members.get(email)!.balance = 1500;
      expect((await (await loyaltyOf(email)).json()).points).toBe(1500);
    } finally {
      delete process.env.LOYALTY_CACHE_TTL_SECONDS;
    }
  });
});

describe("B. Płatność punktami", () => {
  it("1000 punktów na bilecie za 32 zł: sesja na 22 zł, punkty schodzą z karty", async () => {
    const email = freshEmail();
    await loyaltyOf(email); // 1000 punktów powitalnych
    const { body } = await reserve("G1", email);

    const res = await checkout(body.reservationId, 1000);
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const item = (stripeCalls.sessions[0].params.line_items as { price_data: { unit_amount: number } }[])[0];
    expect(item.price_data.unit_amount).toBe(2200);
    expect(balanceOf(email)).toBe(0);
    expect((await view(body.reservationId)).pointsUsed).toBe(1000);
  });

  it("odmowa 4xx: więcej niż połowa ceny, więcej niż saldo, nie-liczba", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("G2", email);

    // Połowa z 3200 to 1600 punktów.
    expect((await checkout(body.reservationId, 1601)).status).toBe(400);
    expect((await checkout(body.reservationId, 10.5)).status).toBe(400);
    expect((await checkout(body.reservationId, -100)).status).toBe(400);
    const tooMany = await checkout(body.reservationId, 1600); // ma tylko 1000
    expect(tooMany.status).toBe(409);
    expect((await tooMany.json()).errorCode).toBe("INSUFFICIENT_POINTS");

    const bad = await checkoutRoute(
      new Request(`http://test/api/reservations/${body.reservationId}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ points: "1000" }),
      }),
      ctx(body.reservationId),
    );
    expect(bad.status).toBe(400);
    // Żadna odmowa nie rusza salda.
    expect(balanceOf(email)).toBe(1000);
    expect(stripeCalls.sessions).toHaveLength(0);
  });

  it("dokładnie połowa ceny przechodzi", async () => {
    const email = freshEmail();
    voucherify.members.set(email, { balance: 5000, markers: [] });
    const { body } = await reserve("G3", email);
    expect((await checkout(body.reservationId, 1600)).status).toBe(200);
    const item = (stripeCalls.sessions[0].params.line_items as { price_data: { unit_amount: number } }[])[0];
    expect(item.price_data.unit_amount).toBe(1600);
    expect(balanceOf(email)).toBe(3400);
  });

  it("podwójny klik i równoległe żądania zdejmują punkty tylko raz", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("G4", email);

    const results = await Promise.all(Array.from({ length: 5 }, () => checkout(body.reservationId, 500)));
    const urls = await Promise.all(results.map((r) => r.json()));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(urls.filter((u) => u.url).map((u) => u.url)).size).toBe(1);
    expect(balanceOf(email)).toBe(500);
  });

  it("zmiana liczby punktów: stara sesja wygasza się, punkty wracają i schodzą od nowa", async () => {
    const email = freshEmail();
    voucherify.members.set(email, { balance: 2000, markers: [] });
    const { body } = await reserve("G5", email);

    const first = await (await checkout(body.reservationId, 1000)).json();
    expect(balanceOf(email)).toBe(1000);

    const second = await (await checkout(body.reservationId, 400)).json();
    expect(second.url).not.toBe(first.url);
    expect(stripeCalls.expired).toEqual([sessionIdFromUrl(first.url)]);
    // Zwrot punktów idzie przez kolejkę (kompensacja), więc dopiero worker go wykonuje.
    await runWorkerTick();
    expect(balanceOf(email)).toBe(1600);

    const item = (stripeCalls.sessions.at(-1)!.params.line_items as { price_data: { unit_amount: number } }[])[0];
    expect(item.price_data.unit_amount).toBe(2800);
  });

  it("bez pola points zachowanie jak w etapie II: pełna kwota, saldo bez zmian", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("G6", email);
    expect((await checkout(body.reservationId)).status).toBe(200);
    const item = (stripeCalls.sessions[0].params.line_items as { price_data: { unit_amount: number } }[])[0];
    expect(item.price_data.unit_amount).toBe(PRICE);
    expect(balanceOf(email)).toBe(1000);
  });
});

describe("C. Rozliczenie, naliczanie i mail", () => {
  it("opłacony bilet: pointsUsed i pointsEarned liczone od części zapłaconej kartą", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const id = await buyWithPoints("C1", email, 1000);

    const paid = await view(id);
    expect(paid).toMatchObject({
      status: "paid",
      amount: 3200,
      pointsUsed: 1000,
      pointsEarned: 220, // 22 zł kartą x 10 punktów
      cardAmount: 2200,
      pointsValue: 1000,
    });
    expect(paid.code).toMatch(/^KP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("zakup bez punktów nalicza punkty od pełnej kwoty", async () => {
    const email = freshEmail();
    const { body } = await reserve("C2", email);
    const { url } = await (await checkout(body.reservationId)).json();
    await sendWebhook(completedEvent(body.reservationId, sessionIdFromUrl(url), PRICE));
    expect((await view(body.reservationId)).pointsEarned).toBe(320);
  });

  it("worker dopisuje punkty na karcie w Voucherify, a ponowienie zadania ich nie dubluje", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const id = await buyWithPoints("C3", email, 1000);
    expect(balanceOf(email)).toBe(0);

    await runWorkerTick();
    expect(balanceOf(email)).toBe(220);

    // Kolejka dostarcza "co najmniej raz": powtórka tego samego zadania nie może naliczyć drugi raz.
    const c = await collections();
    await c.jobs.updateOne(
      { _id: `loyalty-earn:${id}` },
      { $set: { status: "pending", visibleAt: new Date(0), deliveryCount: 2, issuedAt: new Date() } },
    );
    await runWorkerTick();
    expect(balanceOf(email)).toBe(220);
    expect((await c.jobs.findOne({ _id: `loyalty-earn:${id}` }))?.status).toBe("done");
  });

  it("mail z biletem zawiera kod i podsumowanie: kartą, punktami, zebrane punkty", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const id = await buyWithPoints("C4", email, 1000);
    await runWorkerTick();

    const c = await collections();
    const mails = await c.mails.find({ to: email }).toArray();
    expect(mails).toHaveLength(1);
    const { code } = await view(id);
    // Intl wstawia niełamliwą spację przed "zł": normalizujemy ją na potrzeby asercji.
    const body = mails[0].body.replace(/ /g, " ");
    expect(body).toContain(code);
    expect(body).toContain("22 zł"); // zapłacone kartą
    expect(body).toContain("1000"); // zapłacone punktami
    expect(body).toContain("220"); // punkty za zakup
    expect((await view(id)).emailStatus).toBe("sent");
  });

  it("odbiorca odrzucony na stałe: zadanie idzie do DLQ, bilet zostaje dostępny", async () => {
    const email = `bounced+kino${++seq}@resend.dev`;
    const id = await buyWithPoints("C5", email, 0);
    await runWorkerTick();

    const c = await collections();
    expect(await c.deadLetters.countDocuments({ _id: `ticket-email:${id}` })).toBe(1);
    const v = await view(id);
    expect(v.emailStatus).toBe("failed");
    expect(v.code).toBeTruthy(); // kod biletu nie zależy od maila
  });
});

describe("D. Punkty nie mogą przepaść ani zostać wydane dwa razy", () => {
  it("wygaśnięcie sesji płatności zwraca punkty na kartę", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("D1", email);
    const { url } = await (await checkout(body.reservationId, 600)).json();
    expect(balanceOf(email)).toBe(400);

    await sendWebhook({
      id: `evt_test_exp_${Date.now()}`,
      object: "event",
      type: "checkout.session.expired",
      data: {
        object: { id: sessionIdFromUrl(url), object: "checkout.session", client_reference_id: body.reservationId },
      },
    });
    await runWorkerTick();
    expect(balanceOf(email)).toBe(1000);
    expect((await view(body.reservationId)).pointsUsed).toBe(0);
  });

  it("porzucona płatność: po wygaśnięciu sesji sprzątanie samo oddaje punkty", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("D2", email);
    await checkout(body.reservationId, 300);
    expect(balanceOf(email)).toBe(700);

    // Przesuwamy koniec sesji Stripe'a w przeszłość: po nim płatność nie może już przyjść.
    const c = await collections();
    await c.reservations.updateOne(
      { _id: body.reservationId },
      { $set: { "checkouts.0.expiresAt": new Date(Date.now() - 10 * 60_000) } },
    );
    await runWorkerTick();
    expect(balanceOf(email)).toBe(1000);
    expect((await c.reservations.findOne({ _id: body.reservationId }))?.checkouts?.[0].pointsState).toBe("released");
  });

  it("powtórka webhooka nie nalicza punktów drugi raz", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("D3", email);
    const { url } = await (await checkout(body.reservationId, 1000)).json();
    const event = completedEvent(body.reservationId, sessionIdFromUrl(url), 2200);

    expect((await sendWebhook(event)).status).toBe(200);
    expect((await sendWebhook(event)).status).toBe(200);
    expect((await sendWebhook(completedEvent(body.reservationId, sessionIdFromUrl(url), 2200))).status).toBe(200);
    await runWorkerTick();
    await runWorkerTick();

    expect(balanceOf(email)).toBe(220);
    const c = await collections();
    expect(await c.jobs.countDocuments({ topic: "loyalty-earn" })).toBe(1);
  });

  it("kwota sesji musi zgadzać się z rabatem tej próby: podrobiona kwota nie wydaje biletu", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("D4", email);
    const { url } = await (await checkout(body.reservationId, 1000)).json();

    // Klient "zapłacił" mniej, niż wynikało z rabatu.
    await sendWebhook(completedEvent(body.reservationId, sessionIdFromUrl(url), 100));
    const v = await view(body.reservationId);
    expect(v.status).toBe("held");
    expect(v.code).toBeUndefined();
  });

  it("zwrot pieniędzy po czasie zwraca też punkty", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    process.env.RESERVATION_TTL_SECONDS = "1";
    const { body: late } = await reserve("D5", email);
    const { url } = await (await checkout(late.reservationId, 1000)).json();
    expect(balanceOf(email)).toBe(0);
    await new Promise((r) => setTimeout(r, 1100));

    // Fotel przejmuje ktoś inny, więc spóźnionej płatności nie da się zrealizować.
    process.env.RESERVATION_TTL_SECONDS = "120";
    expect((await reserve("D5", freshEmail())).status).toBe(201);

    await sendWebhook(completedEvent(late.reservationId, sessionIdFromUrl(url), 2200));
    await runWorkerTick();
    expect(stripeCalls.refunds).toHaveLength(1);
    expect(balanceOf(email)).toBe(1000);
    expect((await view(late.reservationId)).refund).toBe("succeeded");
  });
});

describe("E. Voucherify jako zależność zewnętrzna", () => {
  it("gdy Voucherify nie odpowiada: saldo i płatność punktami dają 503, zakup kartą działa", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("E1", email);
    voucherify.down = true;

    expect((await loyaltyOf(freshEmail())).status).toBe(503);
    const refused = await checkout(body.reservationId, 500);
    expect(refused.status).toBe(503);
    expect((await refused.json()).errorCode).toBe("LOYALTY_UNAVAILABLE");

    // Łagodna degradacja: pełna cena kartą nie dotyka Voucherify.
    const full = await checkout(body.reservationId);
    expect(full.status).toBe(200);
    const item = (stripeCalls.sessions.at(-1)!.params.line_items as { price_data: { unit_amount: number } }[])[0];
    expect(item.price_data.unit_amount).toBe(PRICE);
  });

  it("niepewne zdjęcie punktów (timeout) kończy się kompensacją, nie cichą stratą", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("E2", email);

    // Punkty zeszły, ale odpowiedź nie wróciła do nas: taka próba zostaje w stanie "pending".
    const c = await collections();
    voucherify.members.get(email)!.balance = 400;
    voucherify.members.get(email)!.markers.push(`kino:spend:${body.reservationId}:1`);
    await c.reservations.updateOne(
      { _id: body.reservationId },
      {
        $push: {
          checkouts: {
            n: 1,
            expiresAt: new Date(Date.now() - 10 * 60_000),
            points: 600,
            cardAmount: 2600,
            pointsState: "pending",
          },
        },
      },
    );

    await runWorkerTick();
    // Marker w historii karty dowodzi, że punkty zeszły, więc wracają.
    expect(balanceOf(email)).toBe(1000);
    expect((await c.reservations.findOne({ _id: body.reservationId }))?.checkouts?.[0].pointsState).toBe("released");
  });

  it("niepewne zdjęcie punktów bez śladu w historii: nic nie zwracamy", async () => {
    const email = freshEmail();
    await loyaltyOf(email);
    const { body } = await reserve("E3", email);

    const c = await collections();
    await c.reservations.updateOne(
      { _id: body.reservationId },
      {
        $push: {
          checkouts: {
            n: 1,
            expiresAt: new Date(Date.now() - 10 * 60_000),
            points: 600,
            cardAmount: 2600,
            pointsState: "pending",
          },
        },
      },
    );

    await runWorkerTick();
    expect(balanceOf(email)).toBe(1000); // bez zmian: punkty nigdy nie zeszły
    expect((await c.reservations.findOne({ _id: body.reservationId }))?.checkouts?.[0].pointsState).toBe("failed");
  });
});
