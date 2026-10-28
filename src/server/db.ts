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

export type ReservationDoc = {
  _id: string;
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  status: "held" | "purchased" | "expired";
  expiresAt: Date;
  createdAt: Date;
  purchasedAt?: Date;
  code?: string;
  idempotencyKey?: string;
};

export type JobDoc = {
  _id: string;
  topic: "ticket-email";
  payload: { reservationId: string };
  status: "pending" | "processing" | "done" | "dead";
  deliveryCount: number;
  visibleAt: Date;
  createdAt: Date;
  updatedAt: Date;
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
  _id: string; // klucz idempotencji u "dostawcy" maili
  to: string;
  subject: string;
  body: string;
  sentAt: Date;
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
