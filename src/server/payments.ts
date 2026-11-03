import type Stripe from "stripe";
import { collections, getDb, isDuplicateKey, type ReservationDoc } from "./db";
import { config } from "./config";
import { AppError, notFound } from "./errors";
import { getEventDoc } from "./events";
import { isPaid, parseReservationId, seatKey, ticketCode, ticketEmailJob } from "./reservations";
import { callStripe } from "./stripe";
import { formatDay, formatTime } from "@/lib/format";
import { seatLabel } from "@/lib/hall";

// Płatności (etap II). Klient płaci na stronie Stripe Checkout, a o udanej płatności
// dowiadujemy się z podpisanego webhooka. Kod biletu powstaje dopiero tam.

// Stripe przyjmuje sesję ważną co najmniej 30 minut. Bierzemy minimum z zapasem.
const CHECKOUT_TTL_MS = 31 * 60_000;
// Sesji bliskiej wygaśnięcia nie dajemy klientowi: lepiej od razu założyć nową.
const CHECKOUT_REUSE_MARGIN_MS = 5 * 60_000;

const expired = () => new AppError(410, "RESERVATION_EXPIRED", "Rezerwacja wygasła, fotel wrócił do puli.");

// Karta A. POST /api/reservations/:id/checkout -> { url } strony płatności.
// - Kwota zawsze z rezerwacji w bazie, nigdy od klienta.
// - Idempotencja (E02): podwójny klik i retry dostają tę samą sesję. Numer próby rezerwujemy
//   atomowo w bazie, a do Stripe'a idzie klucz idempotencji `checkout-<id>-<próba>` z tymi samymi
//   parametrami, więc równoległe żądania dostają od Stripe'a jedną i tę samą sesję.
// - Po przerwaniu płatności otwarta sesja jest używana ponownie, dopóki jest ważna.
export async function startCheckout(rawId: string): Promise<{ url: string }> {
  const reservationId = parseReservationId(rawId);
  const { reservations } = await collections();
  let doc = await reservations.findOne({ _id: reservationId }, { maxTimeMS: config.dbOpTimeoutMs });
  if (!doc) throw notFound("rezerwacja");
  if (isPaid(doc)) throw new AppError(409, "ALREADY_PAID", "Ta rezerwacja jest już opłacona.");
  if (doc.status !== "held" || doc.expiresAt <= new Date()) throw expired();

  const now = Date.now();
  const current = doc.checkout;
  if (!current || current.expiresAt.getTime() - now < CHECKOUT_REUSE_MARGIN_MS) {
    const attempt = (current?.attempt ?? 0) + 1;
    // Pełne sekundy: Stripe przyjmuje znacznik w sekundach, a parametry muszą się zgadzać przy ponowieniu.
    const expiresAt = new Date(Math.ceil((now + CHECKOUT_TTL_MS) / 1000) * 1000);
    const claimed = await reservations.findOneAndUpdate(
      { _id: reservationId, status: "held", ...(current ? { "checkout.attempt": current.attempt } : { checkout: { $exists: false } }) },
      { $set: { checkout: { attempt, expiresAt } } },
      { returnDocument: "after", maxTimeMS: config.dbOpTimeoutMs },
    );
    // Przegrany wyścig: inne żądanie właśnie zarezerwowało próbę, używamy jej.
    doc = claimed ?? (await reservations.findOne({ _id: reservationId }));
    if (!doc) throw notFound("rezerwacja");
    if (isPaid(doc)) throw new AppError(409, "ALREADY_PAID", "Ta rezerwacja jest już opłacona.");
    if (doc.status !== "held" || !doc.checkout) throw expired();
  }

  const checkout = doc.checkout!;
  if (checkout.url) return { url: checkout.url };

  const session = await callStripe("checkout.sessions.create", async (stripe) =>
    stripe.checkout.sessions.create(await sessionParams(doc!, checkout.expiresAt), {
      idempotencyKey: `checkout-${reservationId}-${checkout.attempt}`,
    }),
  );
  if (!session.url) throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "Operator płatności nie zwrócił adresu płatności.");

  await reservations.updateOne(
    { _id: reservationId, "checkout.attempt": checkout.attempt },
    { $set: { "checkout.sessionId": session.id, "checkout.url": session.url } },
  );
  return { url: session.url };
}

async function sessionParams(doc: ReservationDoc, expiresAt: Date): Promise<Stripe.Checkout.SessionCreateParams> {
  const event = await getEventDoc(doc.eventId);
  const startsAt = event.startsAt.toISOString();
  const returnUrl = `${config.appUrl}/rezerwacja/${doc._id}`;
  return {
    mode: "payment",
    locale: "pl",
    // Dzięki temu w webhooku wiemy, której rezerwacji dotyczy płatność.
    client_reference_id: doc._id,
    metadata: { reservationId: doc._id },
    payment_intent_data: { metadata: { reservationId: doc._id } },
    customer_email: doc.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "pln",
          unit_amount: doc.amount,
          product_data: {
            name: `Bilet: ${event.film}`,
            description: `${formatDay(startsAt)}, ${formatTime(startsAt)}, ${event.hall}, ${seatLabel(doc.seatId)}`,
          },
        },
      },
    ],
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    // Strona płatności w barwach kina: ciemne tło sali, limonkowy przycisk jak u nas.
    branding_settings: {
      display_name: "Kino Pasaż",
      background_color: "#0f1117",
      button_color: "#c6f05c",
      border_style: "pill",
      font_family: "inter",
    },
    custom_text: {
      submit: {
        message: `Fotel trzymamy do ${formatTime(doc.expiresAt.toISOString())}. Kod biletu zobaczysz zaraz po zapłacie.`,
      },
    },
    // Strony powrotu (karta C). Adres bazowy z konfiguracji serwera, nie z nagłówka Host.
    success_url: `${returnUrl}?platnosc=ok`,
    cancel_url: `${returnUrl}?platnosc=przerwana`,
  };
}

// ---- Karta B: webhook --------------------------------------------------------------------

type Outcome = "paid" | "already-paid" | "refunded" | "ignored" | "mismatch" | "session-expired";

// Obsługa zdarzenia. Stripe dostarcza zdarzenia co najmniej raz i w dowolnej kolejności,
// więc każda gałąź jest idempotentna: powtórka zdarzenia niczego nie zmienia.
export async function handleStripeEvent(event: Stripe.Event): Promise<Outcome> {
  const { stripeEvents } = await collections();
  const seen = await stripeEvents.findOne({ _id: event.id }, { maxTimeMS: config.dbOpTimeoutMs });
  if (seen) return seen.outcome as Outcome;

  let outcome: Outcome = "ignored";
  let reservationId: string | null = null;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      reservationId = session.client_reference_id;
      // Płatności odroczone (np. przelew) kończą sesję przed zapłatą: czekamy na async_payment_succeeded.
      if (session.payment_status === "paid") outcome = await fulfill(session);
      break;
    }
    case "checkout.session.expired": {
      const session = event.data.object;
      reservationId = session.client_reference_id;
      outcome = await forgetSession(session);
      break;
    }
  }

  // Zapis po obsłudze: gdy obsługa padnie, Stripe ponowi zdarzenie i spróbujemy jeszcze raz.
  try {
    await stripeEvents.insertOne({ _id: event.id, type: event.type, reservationId, outcome, receivedAt: new Date() });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  return outcome;
}

async function forgetSession(session: Stripe.Checkout.Session): Promise<Outcome> {
  const { reservations } = await collections();
  // Następne kliknięcie "Zapłać" założy nową sesję (kolejny numer próby, więc i nowy klucz
  // idempotencji: stary klucz zwróciłby od Stripe'a tę samą, wygasłą sesję).
  await reservations.updateOne({ "checkout.sessionId": session.id }, { $set: { "checkout.expiresAt": new Date(0) } });
  return "session-expired";
}

// Opłacenie rezerwacji. W jednej transakcji: fotel -> sold, rezerwacja -> paid z kodem biletu,
// zadanie wysłania biletu do kolejki (transactional outbox jak w etapie I).
// Sesja Checkout żyje minimum 30 minut, a rezerwacja 15, więc płatność może przyjść po czasie:
// - fotel nadal nasz albo wolny: przyjmujemy płatność i sprzedajemy fotel,
// - fotel ma już innego właściciela: oddajemy pieniądze (refund z kluczem idempotencji).
async function fulfill(session: Stripe.Checkout.Session): Promise<Outcome> {
  const id = session.client_reference_id;
  const { client } = await getDb();
  const { reservations, seats, jobs } = await collections();
  const doc = id && /^[0-9a-f-]{36}$/i.test(id) ? await reservations.findOne({ _id: id }) : null;
  if (!doc) {
    // Zdarzenie z tego samego konta Stripe, ale nie z naszego sklepu.
    console.warn(`[stripe] sesja ${session.id} bez znanej rezerwacji`);
    return "ignored";
  }

  // Kwota i waluta muszą się zgadzać z rezerwacją. Inaczej nie wydajemy biletu.
  if (session.amount_total !== doc.amount || session.currency !== "pln") {
    console.error(`[stripe] sesja ${session.id}: kwota ${session.amount_total} ${session.currency}, oczekiwano ${doc.amount} pln`);
    return "mismatch";
  }

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  if (isPaid(doc)) {
    // Ta sama płatność drugi raz (powtórka webhooka) albo druga, osobna płatność za ten sam bilet.
    if (doc.payment?.sessionId === session.id || !paymentIntentId) return "already-paid";
    return refund(doc, session.id, paymentIntentId);
  }

  const now = new Date();
  const code = ticketCode();
  const dbSession = client.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const previous = await seats.findOneAndUpdate(
        { _id: seatKey(doc.eventId, doc.seatId), $or: [{ reservationId: doc._id }, { status: "held", expiresAt: { $lte: now } }] },
        {
          $set: {
            eventId: doc.eventId,
            seatId: doc.seatId,
            status: "sold",
            reservationId: doc._id,
            expiresAt: null,
            updatedAt: now,
          },
        },
        { upsert: true, returnDocument: "before", session: dbSession },
      );
      if (previous && previous.reservationId !== doc._id) {
        await reservations.updateOne(
          { _id: previous.reservationId, status: "held" },
          { $set: { status: "expired" } },
          { session: dbSession },
        );
      }
      const updated = await reservations.updateOne(
        { _id: doc._id, status: { $in: ["held", "expired"] } },
        {
          $set: {
            status: "paid",
            purchasedAt: now,
            code,
            payment: { sessionId: session.id, paymentIntentId, amount: session.amount_total!, paidAt: now },
          },
        },
        { session: dbSession },
      );
      if (updated.matchedCount !== 1) throw new AlreadyHandled();
      await jobs.insertOne(ticketEmailJob(doc._id, now), { session: dbSession });
    });
    return "paid";
  } catch (err) {
    if (err instanceof AlreadyHandled) return "already-paid";
    // Duplikat _id fotela: trzyma go ważna rezerwacja kogoś innego albo jest sprzedany.
    if (isDuplicateKey(err) && paymentIntentId) return refund(doc, session.id, paymentIntentId);
    throw err;
  } finally {
    await dbSession.endSession();
  }
}

class AlreadyHandled extends Error {}

async function refund(doc: ReservationDoc, sessionId: string, paymentIntentId: string): Promise<Outcome> {
  const { reservations } = await collections();
  const paidForThis = isPaid(doc);
  // Najpierw zapis intencji: gdy Stripe nie odpowie, webhook zwróci 5xx, Stripe go ponowi,
  // a klucz idempotencji sprawi, że pieniądze wrócą dokładnie raz.
  if (!paidForThis) {
    await reservations.updateOne(
      { _id: doc._id, status: { $in: ["held", "expired"] } },
      { $set: { status: "expired", refund: { sessionId, paymentIntentId, status: "pending" } } },
    );
  }
  const result = await callStripe("refunds.create", (stripe) =>
    stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        ...(paidForThis ? { reason: "duplicate" as const } : {}),
        metadata: { reservationId: doc._id },
      },
      { idempotencyKey: `refund-${sessionId}` },
    ),
  );
  if (!paidForThis) {
    await reservations.updateOne(
      { _id: doc._id, "refund.sessionId": sessionId },
      { $set: { "refund.status": "succeeded", "refund.refundId": result.id } },
    );
  }
  console.warn(`[stripe] zwrot ${result.id} dla rezerwacji ${doc._id.slice(0, 8)}…`);
  return "refunded";
}
