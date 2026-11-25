import type Stripe from "stripe";
import { collections, getDb, isDuplicateKey, type CheckoutAttempt, type JobDoc, type ReservationDoc } from "./db";
import { config } from "./config";
import { AppError, badRequest, notFound } from "./errors";
import { getEventDoc } from "./events";
import { loyaltyEarnJob, loyaltyReleaseJob, ticketEmailJob } from "./jobs";
import { spendMarker, spendPoints } from "./loyalty";
import { isPaid, parseReservationId, seatKey, ticketCode } from "./reservations";
import { callStripe } from "./stripe";
import { formatDay, formatPrice, formatTime } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import { cardAmountFor, formatPoints, maxPointsFor, pointsEarnedFor, pointsToGrosze, validatePoints } from "@/lib/loyalty";

// Płatności (etap II) i płatność punktami (etap III). Klient płaci na stronie Stripe Checkout,
// a o udanej płatności dowiadujemy się z podpisanego webhooka. Kod biletu powstaje dopiero tam.
//
// Punkty zdejmujemy z karty klienta PRZED utworzeniem sesji, bo saldo w Voucherify jest wspólne
// z aplikacją i kasami: inaczej dalibyśmy zniżkę na kredyt. Zakup staje się więc sagą i wymaga
// kompensacji: punkty wracają, gdy płatność się nie uda (sesja wygasła, klient zmienił zdanie,
// zwrot po czasie). Każda kompensacja to idempotentne zadanie w kolejce.

// Stripe przyjmuje sesję ważną co najmniej 30 minut. Bierzemy minimum z zapasem.
const CHECKOUT_TTL_MS = 31 * 60_000;
// Sesji bliskiej wygaśnięcia nie dajemy klientowi: lepiej od razu założyć nową.
const CHECKOUT_REUSE_MARGIN_MS = 5 * 60_000;

const expired = () => new AppError(410, "RESERVATION_EXPIRED", "Rezerwacja wygasła, fotel wrócił do puli.");
const alreadyPaid = () => new AppError(409, "ALREADY_PAID", "Ta rezerwacja jest już opłacona.");

export type CheckoutResult = { url: string; pointsUsed: number; cardAmount: number };

// ---- Karta A/B: start płatności ---------------------------------------------------------

/**
 * POST /api/reservations/:id/checkout -> { url } strony płatności.
 * - Kwota zawsze z rezerwacji w bazie, nigdy od klienta: klient podaje tylko liczbę punktów.
 * - Punkty: najwyżej połowa ceny (walidacja), resztę dopłaca kartą.
 * - Idempotencja (E02): podwójny klik i retry dostają tę samą sesję. Numer próby rezerwujemy
 *   atomowo w bazie, a do Stripe'a idzie klucz idempotencji `checkout-<id>-<próba>` z tymi samymi
 *   parametrami, więc równoległe żądania dostają od Stripe'a jedną i tę samą sesję.
 * - Po przerwaniu płatności otwarta sesja jest używana ponownie, dopóki jest ważna i dopóki
 *   klient nie zmieni liczby punktów.
 */
export async function startCheckout(rawId: string, requestedPoints = 0): Promise<CheckoutResult> {
  const reservationId = parseReservationId(rawId);
  const { reservations } = await collections();
  const doc = await reservations.findOne({ _id: reservationId }, { maxTimeMS: config.dbOpTimeoutMs });
  if (!doc) throw notFound("rezerwacja");
  if (isPaid(doc)) throw alreadyPaid();
  if (doc.status !== "held" || doc.expiresAt <= new Date()) throw expired();

  const points = checkPoints(doc.amount, requestedPoints);
  const attempts = doc.checkouts ?? [];
  const current = attempts.at(-1);
  const alive = Boolean(current && current.expiresAt.getTime() - Date.now() >= CHECKOUT_REUSE_MARGIN_MS);

  // Ta sama intencja (podwójny klik, powrót po przerwanej płatności): ta sama sesja.
  if (alive && current!.points === points) return createSession(doc, current!);

  // Klient zmienił liczbę punktów przy żywej sesji: wygaszamy ją i oddajemy punkty.
  if (alive) await supersede(doc, current!);

  const { attempt, claimed } = await claimAttempt(doc, attempts, points);
  if (attempt.points !== points) {
    // Przegrany wyścig z żądaniem o innej liczbie punktów: nie dopisujemy drugiej sesji.
    throw new AppError(
      409,
      "CHECKOUT_IN_PROGRESS",
      `Masz już otwartą płatność na ${formatPrice(attempt.cardAmount)}. Dokończ ją albo odczekaj chwilę.`,
    );
  }
  if (claimed) {
    await reservePoints(doc, attempt);
    return createSession(doc, attempt);
  }
  // Próbę zajęło równoległe żądanie (podwójny klik): punkty zdejmuje ono, my tylko czekamy
  // na wynik. Inaczej ten sam rabat zszedłby z karty dwa razy.
  return createSession(doc, await awaitReserved(doc._id, attempt));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Czekanie na rozstrzygnięcie zdejmowania punktów przez równoległe żądanie. */
async function awaitReserved(reservationId: string, attempt: CheckoutAttempt): Promise<CheckoutAttempt> {
  if (attempt.points <= 0 || attempt.pointsState === "reserved") return attempt;
  const { reservations } = await collections();
  for (let i = 0; i < 10; i++) {
    const doc = await reservations.findOne({ _id: reservationId });
    const fresh = doc?.checkouts?.find((a) => a.n === attempt.n);
    if (!fresh) throw notFound("rezerwacja");
    if (fresh.pointsState === "reserved" || fresh.pointsState === "consumed") return fresh;
    if (fresh.pointsState === "failed") {
      throw new AppError(409, "POINTS_NOT_RESERVED", "Nie udało się opłacić punktami. Spróbuj ponownie.");
    }
    await sleep(120);
  }
  throw new AppError(503, "CHECKOUT_IN_PROGRESS", "Przygotowujemy płatność. Spróbuj ponownie za chwilę.", {
    retryable: true,
    retryAfterSec: 2,
  });
}

/** Reguły z `src/lib/loyalty.ts` plus komunikaty odmowy. Zawsze po stronie serwera. */
function checkPoints(amount: number, points: number): number {
  switch (validatePoints(amount, points)) {
    case "NOT_INTEGER":
      return badRequestThrow("Liczba punktów musi być liczbą całkowitą.");
    case "NEGATIVE":
      return badRequestThrow("Liczba punktów nie może być ujemna.");
    case "OVER_HALF":
      return badRequestThrow(
        `Punktami zapłacisz najwyżej połowę ceny biletu, czyli ${formatPoints(maxPointsFor(amount))} (${formatPrice(
          pointsToGrosze(maxPointsFor(amount)),
        )}).`,
      );
    default:
      return points;
  }
}

function badRequestThrow(message: string): never {
  throw badRequest(message);
}

/** Atomowe zajęcie kolejnego numeru próby (compare-and-swap na długości listy prób). */
async function claimAttempt(
  doc: ReservationDoc,
  attempts: CheckoutAttempt[],
  points: number,
): Promise<{ attempt: CheckoutAttempt; claimed: boolean }> {
  const { reservations } = await collections();
  const attempt: CheckoutAttempt = {
    n: attempts.length + 1,
    // Pełne sekundy: Stripe przyjmuje znacznik w sekundach, a parametry muszą się zgadzać przy ponowieniu.
    expiresAt: new Date(Math.ceil((Date.now() + CHECKOUT_TTL_MS) / 1000) * 1000),
    points,
    cardAmount: cardAmountFor(doc.amount, points),
    pointsState: points > 0 ? "pending" : "none",
  };
  const unchanged =
    attempts.length === 0
      ? { $or: [{ checkouts: { $exists: false } }, { checkouts: { $size: 0 } }] }
      : { checkouts: { $size: attempts.length } };

  const claimed = await reservations.findOneAndUpdate(
    { _id: doc._id, status: "held", ...unchanged },
    { $push: { checkouts: attempt } },
    { returnDocument: "after", maxTimeMS: config.dbOpTimeoutMs },
  );
  if (claimed) return { attempt, claimed: true };

  // Nie udało się: albo ktoś równolegle zajął próbę, albo rezerwacja zmieniła stan.
  const fresh = await reservations.findOne({ _id: doc._id });
  if (!fresh) throw notFound("rezerwacja");
  if (isPaid(fresh)) throw alreadyPaid();
  const last = (fresh.checkouts ?? []).at(-1);
  if (fresh.status !== "held" || !last) throw expired();
  return { attempt: last, claimed: false };
}

/** Zdjęcie punktów z karty klienta. Stan próby zapisujemy tak, żeby dało się ją skompensować. */
async function reservePoints(doc: ReservationDoc, attempt: CheckoutAttempt): Promise<void> {
  if (attempt.points <= 0) return;
  try {
    await spendPoints(doc.email, attempt.points, spendMarker(doc._id, attempt.n));
    await setAttemptPointsState(doc._id, attempt.n, "reserved");
    attempt.pointsState = "reserved";
  } catch (err) {
    // Odmowa od Voucherify (za mało punktów) albo odrzucone żądanie: nic nie zeszło z karty.
    if (err instanceof AppError && (err.status === 409 || err.status === 502)) {
      await setAttemptPointsState(doc._id, attempt.n, "failed");
      throw err;
    }
    // Niepewność (timeout, usługa nie odpowiada): punkty mogły zejść. Zadanie kompensacyjne
    // sprawdzi marker w historii karty i odda je tylko wtedy, gdy naprawdę zeszły.
    await enqueue(loyaltyReleaseJob(doc._id, attempt.n, doc.email, attempt.points, new Date()));
    throw err;
  }
}

/** Stan punktów danej próby. Używa też worker po udanej kompensacji. */
export async function setAttemptPointsState(
  reservationId: string,
  n: number,
  state: CheckoutAttempt["pointsState"],
) {
  const { reservations } = await collections();
  await reservations.updateOne(
    { _id: reservationId },
    { $set: { "checkouts.$[a].pointsState": state } },
    { arrayFilters: [{ "a.n": n }] },
  );
}

/** Sesja Checkout dla próby. Ten sam klucz idempotencji zwraca od Stripe'a tę samą sesję. */
async function createSession(doc: ReservationDoc, attempt: CheckoutAttempt): Promise<CheckoutResult> {
  const result = { pointsUsed: attempt.points, cardAmount: attempt.cardAmount };
  if (attempt.url) return { url: attempt.url, ...result };

  const { reservations } = await collections();
  const session = await callStripe("checkout.sessions.create", async (stripe) =>
    stripe.checkout.sessions.create(await sessionParams(doc, attempt), {
      idempotencyKey: `checkout-${doc._id}-${attempt.n}`,
    }),
  );
  if (!session.url) throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "Operator płatności nie zwrócił adresu płatności.");

  await reservations.updateOne(
    { _id: doc._id },
    { $set: { "checkouts.$[a].sessionId": session.id, "checkouts.$[a].url": session.url } },
    { arrayFilters: [{ "a.n": attempt.n }] },
  );
  return { url: session.url, ...result };
}

/**
 * Zastąpienie żywej sesji (klient zmienił liczbę punktów). Najpierw wygaszamy sesję u Stripe'a,
 * żeby nie dało się zapłacić starej kwoty, i tylko gdy to się uda, oddajemy punkty. Gdy się nie
 * uda, punkty zwolni webhook `checkout.session.expired` albo sprzątanie po wygaśnięciu sesji:
 * nigdy nie oddajemy punktów za sesję, którą wciąż można opłacić.
 */
async function supersede(doc: ReservationDoc, attempt: CheckoutAttempt): Promise<void> {
  const { reservations } = await collections();
  let closed = true;
  if (attempt.sessionId) {
    try {
      await callStripe("checkout.sessions.expire", (stripe) => stripe.checkout.sessions.expire(attempt.sessionId!));
    } catch (err) {
      closed = false;
      console.warn(`[stripe] nie udało się wygasić sesji ${attempt.sessionId}`, err instanceof Error ? err.message : err);
    }
  }
  await reservations.updateOne(
    { _id: doc._id },
    { $set: { "checkouts.$[a].expiresAt": new Date(0) } },
    { arrayFilters: [{ "a.n": attempt.n }] },
  );
  if (closed) await releaseAttempt(doc._id, doc.email, attempt);
}

/** Zadanie zwrotu punktów za próbę, która nie skończy się zapłatą. */
export async function releaseAttempt(reservationId: string, email: string, attempt: CheckoutAttempt): Promise<void> {
  if (attempt.points <= 0) return;
  if (attempt.pointsState !== "reserved" && attempt.pointsState !== "pending") return;
  await enqueue(loyaltyReleaseJob(reservationId, attempt.n, email, attempt.points, new Date()));
}

/** Wstawienie zadania poza transakcją: ten sam klucz oznacza, że już jest w kolejce. */
async function enqueue(job: JobDoc): Promise<void> {
  const { jobs } = await collections();
  try {
    await jobs.insertOne(job);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
}

async function sessionParams(doc: ReservationDoc, attempt: CheckoutAttempt): Promise<Stripe.Checkout.SessionCreateParams> {
  const event = await getEventDoc(doc.eventId);
  const startsAt = event.startsAt.toISOString();
  const returnUrl = `${config.appUrl}/rezerwacja/${doc._id}`;
  const seat = `${formatDay(startsAt)}, ${formatTime(startsAt)}, ${event.hall}, ${seatLabel(doc.seatId)}`;
  return {
    mode: "payment",
    locale: "pl",
    // Dzięki temu w webhooku wiemy, której rezerwacji dotyczy płatność.
    client_reference_id: doc._id,
    metadata: { reservationId: doc._id, attempt: String(attempt.n), points: String(attempt.points) },
    payment_intent_data: { metadata: { reservationId: doc._id } },
    customer_email: doc.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "pln",
          // Kwota po odjęciu punktów. Liczona na serwerze z ceny zapisanej w rezerwacji.
          unit_amount: attempt.cardAmount,
          product_data: {
            name: `Bilet: ${event.film}`,
            description: attempt.points > 0 ? `${seat} (po rabacie ${formatPrice(pointsToGrosze(attempt.points))} za punkty)` : seat,
          },
        },
      },
    ],
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
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

/** Sesja wygasła niezapłacona: punkty wracają na kartę, a następne „Zapłać” założy nową sesję. */
async function forgetSession(session: Stripe.Checkout.Session): Promise<Outcome> {
  const { reservations } = await collections();
  // Nowa sesja dostanie kolejny numer próby, więc i nowy klucz idempotencji: stary klucz
  // zwróciłby od Stripe'a tę samą, wygasłą sesję.
  const doc = await reservations.findOneAndUpdate(
    { "checkouts.sessionId": session.id },
    { $set: { "checkouts.$[a].expiresAt": new Date(0) } },
    { arrayFilters: [{ "a.sessionId": session.id }], returnDocument: "after" },
  );
  const attempt = doc?.checkouts?.find((a) => a.sessionId === session.id);
  if (doc && attempt && !isPaid(doc)) await releaseAttempt(doc._id, doc.email, attempt);
  return "session-expired";
}

/** Próba, której dotyczy płatność. Bez niej nie wiadomo, jaka kwota była umówiona. */
function attemptFor(doc: ReservationDoc, session: Stripe.Checkout.Session): CheckoutAttempt | undefined {
  const attempts = doc.checkouts ?? [];
  return (
    attempts.find((a) => a.sessionId === session.id) ??
    // Zapis ID sesji mógł nie dojść (awaria między Stripe'em a naszą bazą): wtedy
    // ratujemy się jedyną próbą bez sesji o zgadzającej się kwocie.
    attempts.find((a) => !a.sessionId && a.cardAmount === session.amount_total)
  );
}

// Opłacenie rezerwacji. W jednej transakcji: fotel -> sold, rezerwacja -> paid z kodem biletu
// i rozliczeniem punktów, zadania do kolejki (transactional outbox jak w etapie I).
// Sesja Checkout żyje minimum 30 minut, a rezerwacja 15, więc płatność może przyjść po czasie:
// - fotel nadal nasz albo wolny: przyjmujemy płatność i sprzedajemy fotel,
// - fotel ma już innego właściciela: oddajemy pieniądze i punkty.
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

  const attempt = attemptFor(doc, session);
  // Kwota i waluta muszą się zgadzać z tym, co umówiliśmy dla TEJ sesji (cena minus punkty
  // zdjęte na tę próbę), a nie z aktualnym stanem rezerwacji. Inaczej nie wydajemy biletu.
  const expected = attempt ? attempt.cardAmount : doc.amount;
  if (session.amount_total !== expected || session.currency !== "pln") {
    console.error(
      `[stripe] sesja ${session.id}: kwota ${session.amount_total} ${session.currency}, oczekiwano ${expected} pln`,
    );
    return "mismatch";
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);

  if (isPaid(doc)) {
    // Ta sama płatność drugi raz (powtórka webhooka) albo druga, osobna płatność za ten sam bilet.
    if (doc.payment?.sessionId === session.id || !paymentIntentId) return "already-paid";
    return refund(doc, session.id, paymentIntentId, attempt);
  }

  const pointsUsed = attempt?.points ?? 0;
  const pointsEarned = pointsEarnedFor(expected);
  // Punkty zdążyły wrócić na kartę (sesja uznana za martwą, a jednak opłacona): rabat trzeba
  // odjąć jeszcze raz, bo klient zapłacił kartą mniej. Idzie to jedną operacją netto.
  const released = attempt?.pointsState === "released";
  if (released) {
    console.warn(`[loyalty] rezerwacja ${doc._id.slice(0, 8)}…: opłacona sesja po zwrocie punktów, koryguję saldo`);
  }
  const earnNet = released ? pointsEarned - pointsUsed : pointsEarned;

  const now = new Date();
  const code = ticketCode();
  const dbSession = client.startSession();
  try {
    await dbSession.withTransaction(async () => {
      const previous = await seats.findOneAndUpdate(
        {
          _id: seatKey(doc.eventId, doc.seatId),
          $or: [{ reservationId: doc._id }, { status: "held", expiresAt: { $lte: now } }],
        },
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
            pointsUsed,
            pointsEarned,
            payment: { sessionId: session.id, paymentIntentId, amount: session.amount_total!, paidAt: now },
            ...(attempt ? { "checkouts.$[a].pointsState": pointsUsed > 0 ? "consumed" : "none" } : {}),
          },
        },
        { session: dbSession, ...(attempt ? { arrayFilters: [{ "a.n": attempt.n }] } : {}) },
      );
      if (updated.matchedCount !== 1) throw new AlreadyHandled();

      const queue: JobDoc[] = [ticketEmailJob(doc._id, now)];
      // Punkty za zakup liczymy tylko od części zapłaconej kartą (karta A).
      if (earnNet !== 0) queue.push(loyaltyEarnJob(doc._id, doc.email, earnNet, now));
      // Punkty zdjęte na inne, porzucone próby nie mogą przepaść.
      for (const other of doc.checkouts ?? []) {
        if (other.n !== attempt?.n && (other.pointsState === "reserved" || other.pointsState === "pending")) {
          queue.push(loyaltyReleaseJob(doc._id, other.n, doc.email, other.points, now));
        }
      }
      await jobs.insertMany(queue, { session: dbSession });
    });
    return "paid";
  } catch (err) {
    if (err instanceof AlreadyHandled) return "already-paid";
    // Duplikat _id fotela: trzyma go ważna rezerwacja kogoś innego albo jest sprzedany.
    if (isDuplicateKey(err) && paymentIntentId) return refund(doc, session.id, paymentIntentId, attempt);
    throw err;
  } finally {
    await dbSession.endSession();
  }
}

class AlreadyHandled extends Error {}

/** Zwrot pieniędzy (i punktów) za płatność, której nie da się zrealizować. */
async function refund(
  doc: ReservationDoc,
  sessionId: string,
  paymentIntentId: string,
  attempt: CheckoutAttempt | undefined,
): Promise<Outcome> {
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
    // Pieniądze wracają, więc punkty też: klient nie dostał nic w zamian.
    if (attempt) await releaseAttempt(doc._id, doc.email, attempt);
  }
  console.warn(`[stripe] zwrot ${result.id} dla rezerwacji ${doc._id.slice(0, 8)}…`);
  return "refunded";
}

// ---- Sprzątanie: punkty nie mogą zostać w zawieszeniu -----------------------------------

/**
 * Siatka bezpieczeństwa (E04/E06): gdy webhook `checkout.session.expired` nie dojdzie,
 * punkty i tak wrócą. Zwalniamy je dopiero po wygaśnięciu samej sesji z zapasem, bo do
 * tego czasu płatność wciąż może przyjść.
 */
export async function releaseAbandonedPoints(now = new Date(), limit = 20): Promise<number> {
  const { reservations } = await collections();
  const deadline = new Date(now.getTime() - 5 * 60_000);
  const docs = await reservations
    .find(
      {
        status: { $in: ["held", "expired"] },
        checkouts: { $elemMatch: { pointsState: { $in: ["reserved", "pending"] }, expiresAt: { $lte: deadline } } },
      },
      { limit, maxTimeMS: config.dbOpTimeoutMs },
    )
    .toArray();

  let queued = 0;
  for (const doc of docs) {
    for (const attempt of doc.checkouts ?? []) {
      if (attempt.expiresAt > deadline) continue;
      if (attempt.pointsState !== "reserved" && attempt.pointsState !== "pending") continue;
      await releaseAttempt(doc._id, doc.email, attempt);
      queued++;
    }
  }
  return queued;
}
