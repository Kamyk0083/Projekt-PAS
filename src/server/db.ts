import { MongoClient, type Db, type Collection, MongoServerError } from "mongodb";
import { config } from "./config";
import { seedEvents } from "./seed";
import type { HallLayout } from "@/lib/hall";

// ---- Dokumenty w bazie -------------------------------------------------------

export type EventDoc = {
  _id: string;
  film: string;
  title: string;
  genre: string;
  durationMin: number;
  ageRating: string;
  language: string;
  startsAt: Date;
  hall: string;
  layout: HallLayout;
  posterSeed: string;
  synopsis: string;
  price: number; // cena fotela w groszach (3200 = 32 zł)
};

// Jeden dokument na fotel w danym seansie. _id = `${eventId}|${seatId}`,
// więc unikalność _id gwarantuje, że fotel ma najwyżej jednego właściciela.
export type SeatDoc = {
  _id: string;
  eventId: string;
  seatId: string;
  status: "held" | "sold";
  reservationId: string;
  expiresAt: Date | null;
  updatedAt: Date;
};

// Jedna próba płatności. Trzymamy całą historię prób, bo punkty rezerwujemy PRZED
// utworzeniem sesji Stripe'a, a spóźniony webhook ze starej sesji musi być sprawdzony
// względem kwoty swojej własnej próby, nie tej aktualnej (etap III).
export type CheckoutAttempt = {
  n: number;
  expiresAt: Date;
  points: number; // punkty zdjęte z karty klienta na tę próbę
  cardAmount: number; // kwota, na jaką ma być sesja Stripe'a (amount - points)
  // "pending": wywołanie do Voucherify mogło wyjść, ale nie znamy wyniku (kompensacja sprawdzi marker).
  pointsState: "none" | "pending" | "reserved" | "released" | "consumed" | "failed";
  sessionId?: string;
  url?: string;
};

export type ReservationDoc = {
  _id: string;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  // "purchased" to stan z etapu I (dane sprzed płatności); w API widać go jako "paid".
  status: "held" | "paid" | "purchased" | "expired";
  amount: number; // cena w groszach zapisana w chwili rezerwacji, potem już się nie zmienia
  currency: "pln";
  expiresAt: Date;
  createdAt: Date;
  purchasedAt?: Date; // chwila opłacenia (nazwa z etapu I)
  code?: string;
  idempotencyKey?: string;
  // Próby płatności, od najstarszej. Ostatnia jest bieżąca.
  checkouts?: CheckoutAttempt[];
  payment?: { sessionId: string; paymentIntentId: string | null; amount: number; paidAt: Date };
  // Rozliczenie punktów opłaconego biletu (etap III).
  pointsUsed?: number;
  pointsEarned?: number;
  // Płatność, która przyszła, gdy fotel miał już innego właściciela: oddajemy pieniądze.
  refund?: { sessionId: string; paymentIntentId: string; status: "pending" | "succeeded"; refundId?: string };
  // Etap IV: rezerwacja założona dla osoby z listy oczekujących (oferta miejsca).
  waitlistId?: string;
};

// Wpis na liście oczekujących (etap IV). Kolejność wyznacza `seq` (licznik na seans), a nie
// zegar, więc dwa zapisy w tej samej milisekundzie też mają jednoznaczną kolejność.
// - waiting: czeka w kolejce,
// - offered: ma zarezerwowane miejsce (zwykła rezerwacja `reservationId`) i mail z linkiem,
// - done: kupił bilet, missed: nie zapłacił na czas albo mail do niego nie doszedł, left: wypisał się.
export type WaitlistStatus = "waiting" | "offered" | "done" | "missed" | "left";

export type WaitlistDoc = {
  _id: string; // UUID = waitlistId (działa jak link: kto go zna, widzi stan i może się wypisać)
  eventId: string;
  email: string;
  customerName: string;
  seq: number;
  status: WaitlistStatus;
  // true dla waiting i offered: unikalny indeks (eventId, email) tylko dla aktywnych wpisów,
  // więc ta sama osoba nie zajmie dwóch miejsc w kolejce, ale po wypisaniu może wrócić.
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  offers: number; // ile razy dostał ofertę (powtórka, gdy mail nie wyszedł z naszej winy)
  // Bieżąca (albo ostatnia) oferta:
  reservationId?: string;
  seatId?: string;
  offeredAt?: Date;
  // Karta C: termin podany w mailu (ustalany raz, przy pierwszej próbie wysyłki), chwila
  // przekazania maila do Resenda, jego ID tam i los maila z webhooka.
  mailDeadline?: Date;
  notifiedAt?: Date;
  mailId?: string;
  deliveredAt?: Date;
  undeliveredAt?: Date;
  missedReason?: "timeout" | "undelivered";
  finishedAt?: Date;
};

// Licznik kolejności na liście oczekujących danego seansu.
export type CounterDoc = { _id: string; seq: number };

// Zdarzenia od Resenda (webhook Svix), które już obsłużyliśmy: deduplikacja i ślad.
export type ResendEventDoc = {
  _id: string; // svix-id
  type: string;
  emailId: string | null;
  outcome: string;
  receivedAt: Date;
};

// Konto punktowe klienta po naszej stronie. Saldo prowadzi Voucherify: tutaj trzymamy
// tylko ID karty, ślad punktów powitalnych i krótkotrwały cache salda do podpowiedzi w UI.
export type LoyaltyAccountDoc = {
  _id: string; // e-mail klienta (identyfikator w Voucherify)
  memberId?: string;
  welcomeGrantedAt?: Date;
  existedBefore?: boolean;
  balance?: number;
  balanceAt?: Date;
  createdAt: Date;
};

// Dostawca symulowany punktów (gdy nie ma kluczy Voucherify): demo i testy bez konta.
export type LoyaltySimDoc = {
  _id: string; // memberId
  email: string;
  balance: number;
  transactions: { marker: string; points: number; at: Date }[];
};

// Zdarzenia od Stripe'a, które już obsłużyliśmy (deduplikacja webhooków i ślad audytowy).
export type StripeEventDoc = {
  _id: string; // event.id
  type: string;
  reservationId: string | null;
  outcome: string;
  receivedAt: Date;
};

// ticket-email: wysyłka biletu (etap I/II/III).
// loyalty-earn: naliczenie punktów za zakup; loyalty-release: zwrot punktów, za które
// nie doszło do zapłaty (kompensacja). Oba dotykają Voucherify, więc idą przez kolejkę.
// waitlist-offer (etap IV): mail do osoby z listy, która dostała miejsce (karta B -> karta C).
export type JobTopic = "ticket-email" | "loyalty-earn" | "loyalty-release" | "waitlist-offer";

export type JobDoc = {
  _id: string;
  topic: JobTopic;
  payload: { reservationId: string; email?: string; points?: number; attempt?: number; waitlistId?: string };
  status: "pending" | "processing" | "done" | "dead";
  deliveryCount: number;
  visibleAt: Date;
  createdAt: Date;
  updatedAt: Date;
  // Znacznik "żądanie do zależności mogło wyjść": po ponowieniu nie wolno zgadywać.
  issuedAt?: Date;
  lastError?: string;
};

export type DeadLetterDoc = {
  _id: string;
  topic: string;
  payload: unknown;
  deliveryCount: number;
  lastError: string;
  failedAt: Date;
};

export type MailDoc = {
  _id: string; // klucz idempotencji u dostawcy maili (= ID zadania w kolejce)
  to: string;
  subject: string;
  body: string;
  sentAt: Date;
  providerId?: string; // ID wiadomości u dostawcy (Resend), do powiązania ze zdarzeniami
  // Los maila z webhooka Resenda (etap IV).
  deliveredAt?: Date;
  bouncedAt?: Date;
};

export type RateBucketDoc = {
  _id: string;
  tokens: number;
  updatedAt: Date;
  expireAt: Date;
};

export type Collections = {
  events: Collection<EventDoc>;
  seats: Collection<SeatDoc>;
  reservations: Collection<ReservationDoc>;
  jobs: Collection<JobDoc>;
  deadLetters: Collection<DeadLetterDoc>;
  mails: Collection<MailDoc>;
  rateBuckets: Collection<RateBucketDoc>;
  stripeEvents: Collection<StripeEventDoc>;
  loyaltyAccounts: Collection<LoyaltyAccountDoc>;
  loyaltySim: Collection<LoyaltySimDoc>;
  waitlist: Collection<WaitlistDoc>;
  counters: Collection<CounterDoc>;
  resendEvents: Collection<ResendEventDoc>;
};

type DbState = { client: MongoClient; db: Db; cols: Collections; memory: boolean };

// Cache na globalThis: przeżywa hot reload w dev i współdzieli połączenie.
const g = globalThis as typeof globalThis & {
  __kinoDb?: Promise<DbState>;
  __kinoMemoryServer?: { stop: () => Promise<unknown> };
};

async function resolveUri(): Promise<{ uri: string; memory: boolean }> {
  if (config.mongoUri) return { uri: config.mongoUri, memory: false };
  // Na Vercelu baza w pamięci nie ma sensu (każda instancja miałaby własną): głośny błąd zamiast cichej awarii.
  if (process.env.VERCEL) throw new Error("Brak MONGODB_URI: ustaw ją w Vercel > Settings > Environment Variables.");
  // Brak MONGODB_URI: baza w pamięci jako replica set (transakcje wymagają repl setu).
  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  g.__kinoMemoryServer = replSet;
  console.warn("[db] MONGODB_URI nie ustawione: używam bazy w pamięci (dane znikną po restarcie).");
  return { uri: replSet.getUri(), memory: true };
}

async function init(): Promise<DbState> {
  const { uri, memory } = await resolveUri();
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
    socketTimeoutMS: 10_000,
    // Serverless ma wiele krótkich instancji, a darmowy Atlas (M0) limit ~500 połączeń.
    maxPoolSize: process.env.VERCEL ? 10 : 50,
    retryWrites: true,
    retryReads: true,
  });
  await client.connect();
  const db = client.db(config.mongoDb);
  const cols: Collections = {
    events: db.collection<EventDoc>("events"),
    seats: db.collection<SeatDoc>("seats"),
    reservations: db.collection<ReservationDoc>("reservations"),
    jobs: db.collection<JobDoc>("jobs"),
    deadLetters: db.collection<DeadLetterDoc>("deadLetters"),
    mails: db.collection<MailDoc>("mails"),
    rateBuckets: db.collection<RateBucketDoc>("rateBuckets"),
    stripeEvents: db.collection<StripeEventDoc>("stripeEvents"),
    loyaltyAccounts: db.collection<LoyaltyAccountDoc>("loyaltyAccounts"),
    loyaltySim: db.collection<LoyaltySimDoc>("loyaltySim"),
    waitlist: db.collection<WaitlistDoc>("waitlist"),
    counters: db.collection<CounterDoc>("counters"),
    resendEvents: db.collection<ResendEventDoc>("resendEvents"),
  };
  await ensureIndexes(cols);
  await seedEvents(cols.events);
  return { client, db, cols, memory };
}

async function ensureIndexes(cols: Collections) {
  await Promise.all([
    cols.seats.createIndex({ eventId: 1, status: 1, expiresAt: 1 }),
    cols.reservations.createIndex(
      { idempotencyKey: 1 },
      { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
    ),
    cols.reservations.createIndex({ status: 1, expiresAt: 1 }),
    cols.jobs.createIndex({ status: 1, visibleAt: 1 }),
    // Wiadra limitera sprzątają się same po okresie bezczynności.
    cols.rateBuckets.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
    cols.reservations.createIndex({ "checkouts.sessionId": 1 }, { sparse: true }),
    // Zwrot punktów po wygaśnięciu rezerwacji: szukamy tylko tych z zarezerwowanymi punktami.
    cols.reservations.createIndex({ "checkouts.pointsState": 1, expiresAt: 1 }, { sparse: true }),
    cols.loyaltySim.createIndex({ email: 1 }),
    // Stripe ponawia zdarzenia najwyżej przez 3 dni, więc 30 dni pamięci w zupełności wystarcza.
    cols.stripeEvents.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }),
    // Etap IV: kolejka seansu w kolejności zapisu i jeden aktywny wpis na e-mail w seansie.
    cols.waitlist.createIndex({ eventId: 1, status: 1, seq: 1 }),
    cols.waitlist.createIndex(
      { eventId: 1, email: 1 },
      { unique: true, partialFilterExpression: { active: true } },
    ),
    cols.waitlist.createIndex({ reservationId: 1 }, { sparse: true }),
    // Webhook Resenda wskazuje mail po jego ID u dostawcy.
    cols.mails.createIndex({ providerId: 1 }, { sparse: true }),
    // Svix ponawia webhook najwyżej przez kilka dni.
    cols.resendEvents.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 }),
  ]);
}

export function getDb(): Promise<DbState> {
  if (!g.__kinoDb) {
    g.__kinoDb = init().catch((err) => {
      g.__kinoDb = undefined; // kolejne żądanie spróbuje ponownie
      throw err;
    });
  }
  return g.__kinoDb;
}

export async function collections(): Promise<Collections> {
  return (await getDb()).cols;
}

export async function closeDb() {
  const state = await g.__kinoDb?.catch(() => undefined);
  g.__kinoDb = undefined;
  await state?.client.close();
  await g.__kinoMemoryServer?.stop();
  g.__kinoMemoryServer = undefined;
}

export function isDuplicateKey(err: unknown): err is MongoServerError {
  return err instanceof MongoServerError && err.code === 11000;
}

export function duplicateKeyField(err: MongoServerError): string | undefined {
  const pattern = (err as MongoServerError & { keyPattern?: Record<string, unknown> }).keyPattern;
  return pattern ? Object.keys(pattern)[0] : undefined;
}
