// Etap II: płatności Stripe Checkout. Stripe API jest zastąpione atrapą (bez sieci),
// a podpisy webhooków liczymy prawdziwym SDK, więc weryfikacja podpisu jest testowana naprawdę.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

const stripeCalls = vi.hoisted(() => ({
  sessions: [] as { params: Record<string, unknown>; key?: string }[],
  refunds: [] as { params: Record<string, unknown>; key?: string }[],
}));

vi.mock("@/server/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/stripe")>();
  const byKey = new Map<string, { id: string; url: string }>();
  const fake = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
          stripeCalls.sessions.push({ params, key: opts?.idempotencyKey });
          // Jak Stripe: ten sam klucz idempotencji zwraca tę samą sesję.
          const key = opts?.idempotencyKey ?? String(Math.random());
          if (!byKey.has(key)) {
            const id = `cs_test_${byKey.size + 1}_${Date.now()}`;
            byKey.set(key, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
          }
          return byKey.get(key)!;
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

import { closeDb, collections } from "@/server/db";
import { GET as listEvents } from "@/app/api/events/route";
import { GET as getEvent } from "@/app/api/events/[id]/route";
import { POST as createReservation } from "@/app/api/reservations/route";
import { GET as getReservation } from "@/app/api/reservations/[id]/route";
import { POST as checkoutRoute } from "@/app/api/reservations/[id]/checkout/route";
import { POST as purchaseRoute } from "@/app/api/reservations/[id]/purchase/route";
import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { stopWorker } from "@/server/worker";

const EVENT = "orbita-siedem";
const SECRET = "whsec_test_kino_pasaz";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const person = { customerName: "Jan Testowy", email: "jan@example.pl" };

async function reserve(seatId: string, who = person) {
  const res = await createReservation(
    new Request("http://test/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: EVENT, seatId, ...who }),
    }),
    undefined as never,
  );
  return { status: res.status, body: await res.json() };
}

const checkout = (id: string) =>
  checkoutRoute(new Request(`http://test/api/reservations/${id}/checkout`, { method: "POST" }), ctx(id));
const view = async (id: string) => (await getReservation(new Request(`http://test/api/reservations/${id}`), ctx(id))).json();

let eventSeq = 0;
function completedEvent(reservationId: string, sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_test_${++eventSeq}_${Date.now()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        client_reference_id: reservationId,
        amount_total: 3200,
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

beforeAll(async () => {
  process.env.WORKER_ENABLED = "false";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.MAILER_FAILURE_RATE = "0";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.APP_URL = "https://kino.example";
  delete process.env.LEGACY_PURCHASE_WITHOUT_PAYMENT;
  await collections();
});

beforeEach(async () => {
  process.env.RESERVATION_TTL_SECONDS = "120";
  stripeCalls.sessions.length = 0;
  stripeCalls.refunds.length = 0;
  const c = await collections();
  await Promise.all([
    c.seats.deleteMany({}),
    c.reservations.deleteMany({}),
    c.jobs.deleteMany({}),
    c.stripeEvents.deleteMany({}),
  ]);
});

afterAll(async () => {
  stopWorker();
  await closeDb();
});

describe("A. Cena i checkout", () => {
  it("wydarzenie ma price, rezerwacja zwraca amount z chwili rezerwacji", async () => {
    const events = await (await listEvents(new Request("http://test/api/events"), undefined as never)).json();
    expect(events.every((e: { price: number }) => e.price === 3200)).toBe(true);
    const details = await (await getEvent(new Request(`http://test/api/events/${EVENT}`), ctx(EVENT))).json();
    expect(details.event.price).toBe(3200);

    const { status, body } = await reserve("A1");
    expect(status).toBe(201);
    expect(body.amount).toBe(3200);

    // Zmiana cennika po rezerwacji nie zmienia kwoty do zapłaty.
    const c = await collections();
    await c.events.updateOne({ _id: EVENT }, { $set: { price: 9900 } });
    try {
      expect((await view(body.reservationId)).amount).toBe(3200);
      await checkout(body.reservationId);
      const item = (stripeCalls.sessions[0].params.line_items as { price_data: { unit_amount: number; currency: string } }[])[0];
      expect(item.price_data).toMatchObject({ unit_amount: 3200, currency: "pln" });
    } finally {
      await c.events.updateOne({ _id: EVENT }, { $set: { price: 3200 } });
    }
  });

  it("sesja ma client_reference_id, strony powrotu z APP_URL i zwraca { url }", async () => {
    const { body } = await reserve("A2");
    const res = await checkout(body.reservationId);
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const params = stripeCalls.sessions[0].params;
    expect(params.client_reference_id).toBe(body.reservationId);
    expect(params.mode).toBe("payment");
    expect(params.success_url).toBe(`https://kino.example/rezerwacja/${body.reservationId}?platnosc=ok`);
    expect(params.cancel_url).toBe(`https://kino.example/rezerwacja/${body.reservationId}?platnosc=przerwana`);
  });

  it("podwójny klik i równoległe żądania dają tę samą sesję", async () => {
    const { body } = await reserve("A3");
    const urls = await Promise.all(Array.from({ length: 6 }, () => checkout(body.reservationId).then((r) => r.json())));
    expect(new Set(urls.map((u) => u.url)).size).toBe(1);
    expect(new Set(stripeCalls.sessions.map((s) => s.key)).size).toBe(1);
    // Powrót po przerwaniu płatności: ta sama, nadal ważna sesja.
    const again = await (await checkout(body.reservationId)).json();
    expect(again.url).toBe(urls[0].url);
  });

  it("odmowa 4xx: brak rezerwacji, wygasła, opłacona", async () => {
    expect((await checkout("abc")).status).toBe(404);
    expect((await checkout("00000000-0000-4000-8000-000000000000")).status).toBe(404);

    process.env.RESERVATION_TTL_SECONDS = "1";
    const { body: late } = await reserve("A4");
    await new Promise((r) => setTimeout(r, 1100));
    expect((await checkout(late.reservationId)).status).toBe(410);

    process.env.RESERVATION_TTL_SECONDS = "120";
    const { body } = await reserve("A5");
    const { url } = await (await checkout(body.reservationId)).json();
    const sessionId = url.split("/").pop();
    expect((await sendWebhook(completedEvent(body.reservationId, sessionId))).status).toBe(200);
    const paid = await checkout(body.reservationId);
    expect(paid.status).toBe(409);
    expect((await paid.json()).errorCode).toBe("ALREADY_PAID");
  });
});

describe("B. Webhook", () => {
  it("bez podpisu albo ze złym podpisem: 400 i nic się nie zmienia", async () => {
    const { body } = await reserve("B1");
    const event = completedEvent(body.reservationId, "cs_test_fake");
    const noSig = await webhookRoute(
      new Request("http://test/api/webhooks/stripe", { method: "POST", body: JSON.stringify(event) }),
      undefined as never,
    );
    expect(noSig.status).toBe(400);
    expect((await sendWebhook(event, "whsec_podrobiony")).status).toBe(400);
    expect((await view(body.reservationId)).status).toBe("held");
  });

  it("checkout.session.completed oznacza rezerwację jako opłaconą i daje kod; powtórka nic nie zmienia", async () => {
    const { body } = await reserve("B2");
    const { url } = await (await checkout(body.reservationId)).json();
    const sessionId = url.split("/").pop();
    const event = completedEvent(body.reservationId, sessionId);

    expect((await sendWebhook(event)).status).toBe(200);
    const paid = await view(body.reservationId);
    expect(paid).toMatchObject({ status: "paid", amount: 3200 });
    expect(paid.code).toMatch(/^KP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Stripe dostarcza zdarzenia co najmniej raz: to samo zdarzenie i nowe zdarzenie tej samej sesji.
    expect((await sendWebhook(event)).status).toBe(200);
    expect((await sendWebhook(completedEvent(body.reservationId, sessionId))).status).toBe(200);
    expect((await view(body.reservationId)).code).toBe(paid.code);

    const c = await collections();
    expect(await c.jobs.countDocuments({ _id: `ticket-email:${body.reservationId}` })).toBe(1);
    expect((await c.seats.findOne({ _id: `${EVENT}|B2` }))?.status).toBe("sold");
    expect(stripeCalls.refunds).toHaveLength(0);
  });

  it("zła kwota albo waluta: biletu nie ma", async () => {
    const { body } = await reserve("B3");
    await sendWebhook(completedEvent(body.reservationId, "cs_test_x", { amount_total: 100 }));
    await sendWebhook(completedEvent(body.reservationId, "cs_test_y", { currency: "eur" }));
    const v = await view(body.reservationId);
    expect(v.status).toBe("held");
    expect(v.code).toBeUndefined();
  });

  it("płatność nieukończona (payment_status unpaid) nie wydaje biletu", async () => {
    const { body } = await reserve("B4");
    await sendWebhook(completedEvent(body.reservationId, "cs_test_async", { payment_status: "unpaid" }));
    expect((await view(body.reservationId)).status).toBe("held");
  });

  it("płatność po czasie, fotel wolny: przyjmujemy ją i sprzedajemy fotel", async () => {
    process.env.RESERVATION_TTL_SECONDS = "1";
    const { body } = await reserve("B5");
    await new Promise((r) => setTimeout(r, 1100));
    expect((await view(body.reservationId)).status).toBe("expired");
    await sendWebhook(completedEvent(body.reservationId, "cs_test_late"));
    expect((await view(body.reservationId)).status).toBe("paid");
    expect(stripeCalls.refunds).toHaveLength(0);
  });

  it("płatność po czasie, fotel ma już innego właściciela: zwrot pieniędzy, bez biletu", async () => {
    process.env.RESERVATION_TTL_SECONDS = "1";
    const { body: first } = await reserve("B6");
    await new Promise((r) => setTimeout(r, 1100));
    process.env.RESERVATION_TTL_SECONDS = "120";
    const { status } = await reserve("B6", { customerName: "Ktoś Inny", email: "inny@example.pl" });
    expect(status).toBe(201);

    const event = completedEvent(first.reservationId, "cs_test_conflict");
    expect((await sendWebhook(event)).status).toBe(200);
    expect(await sendWebhook(event).then((r) => r.status)).toBe(200);
    const v = await view(first.reservationId);
    expect(v).toMatchObject({ status: "expired", refund: "succeeded" });
    expect(v.code).toBeUndefined();
    expect(stripeCalls.refunds).toHaveLength(1);
    expect(stripeCalls.refunds[0].key).toBe("refund-cs_test_conflict");
  });

  it("checkout.session.expired: następne „Zapłać” zakłada nową sesję", async () => {
    const { body } = await reserve("B7");
    const { url } = await (await checkout(body.reservationId)).json();
    const sessionId = url.split("/").pop();
    await sendWebhook({
      id: `evt_test_exp_${Date.now()}`,
      object: "event",
      type: "checkout.session.expired",
      data: { object: { id: sessionId, object: "checkout.session", client_reference_id: body.reservationId } },
    });
    const next = await (await checkout(body.reservationId)).json();
    expect(next.url).not.toBe(url);
    expect(stripeCalls.sessions.at(-1)?.key).toBe(`checkout-${body.reservationId}-2`);
  });
});

describe("C. Status i stary zakup", () => {
  it("GET /api/reservations/:id zwraca { status, amount, expiresAt } i code dopiero po opłaceniu", async () => {
    const { body } = await reserve("C1");
    const held = await view(body.reservationId);
    expect(held).toMatchObject({ status: "held", amount: 3200, expiresAt: body.expiresAt });
    expect(held.code).toBeUndefined();
  });

  it("POST /purchase nie wydaje biletu bez płatności (402), po opłaceniu zwraca ten sam kod", async () => {
    const { body } = await reserve("C2");
    const before = await purchaseRoute(new Request("http://test", { method: "POST" }), ctx(body.reservationId));
    expect(before.status).toBe(402);
    await sendWebhook(completedEvent(body.reservationId, "cs_test_c2"));
    const after = await purchaseRoute(new Request("http://test", { method: "POST" }), ctx(body.reservationId));
    expect(after.status).toBe(200);
    expect((await after.json()).code).toBe((await view(body.reservationId)).code);
  });
});
