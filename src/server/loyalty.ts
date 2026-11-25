import { collections, isDuplicateKey, type LoyaltyAccountDoc } from "./db";
import { config } from "./config";
import { AppError } from "./errors";
import {
  InsufficientPointsError,
  adjustBalance,
  createMember,
  findMemberId,
  hasTransaction,
  readBalance,
} from "./voucherify";
import { WELCOME_POINTS } from "@/lib/loyalty";

// Konto punktowe klienta (karta A). Identyfikatorem jest e-mail.
//
// Źródłem prawdy o saldzie jest Voucherify, nie nasza baza: w `loyaltyAccounts` trzymamy
// tylko ID karty, ślad przyznania punktów powitalnych i krótki cache salda do podpowiedzi
// w interfejsie. Każda nasza operacja (wydanie, naliczenie) odświeża cache wartością
// zwróconą przez Voucherify, więc rozjechać się może tylko zmiana zrobiona poza nami
// (marketing w aplikacji albo kasa) i najdalej na czas `LOYALTY_CACHE_TTL_SECONDS`.
//
// Markery operacji (pole `reason` w Voucherify) pozwalają po ponowieniu zadania poznać
// własny zapis i nie naliczyć punktów dwa razy.

export const earnMarker = (reservationId: string) => `kino:earn:${reservationId}`;
export const spendMarker = (reservationId: string, attempt: number) => `kino:spend:${reservationId}:${attempt}`;
export const releaseMarker = (reservationId: string, attempt: number) => `kino:release:${reservationId}:${attempt}`;
const welcomeMarker = (email: string) => `kino:welcome:${email}`;

const insufficient = (available: number) =>
  new AppError(409, "INSUFFICIENT_POINTS", `Na koncie masz ${available} pkt, to za mało na tę opłatę punktami.`);

const beingCreated = () =>
  new AppError(503, "LOYALTY_BUSY", "Zakładamy Twoje konto punktowe. Spróbuj ponownie za chwilę.", {
    retryable: true,
    retryAfterSec: 2,
  });

type Account = LoyaltyAccountDoc & { memberId: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Konto klienta: znajduje kartę w Voucherify, a gdy jej nie ma, zakłada ją i przyznaje
 * punkty powitalne. Założenie konta jest zabezpieczone przed równoległym wywołaniem
 * warunkowym zapisem w naszej bazie (duplikat klucza = ktoś inny już to robi), więc
 * 1000 punktów powitalnych nie dostanie nikt dwa razy.
 */
async function account(email: string): Promise<Account> {
  const { loyaltyAccounts } = await collections();
  const existing = await loyaltyAccounts.findOne({ _id: email }, { maxTimeMS: config.dbOpTimeoutMs });
  if (existing?.memberId) return ensureWelcome(existing as Account);

  if (!existing) {
    try {
      await loyaltyAccounts.insertOne({ _id: email, createdAt: new Date() });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Przegrany wyścig: poczekajmy chwilę na kartę od zwycięzcy.
      for (let i = 0; i < 4; i++) {
        await sleep(150);
        const doc = await loyaltyAccounts.findOne({ _id: email });
        if (doc?.memberId) return ensureWelcome(doc as Account);
      }
      throw beingCreated();
    }
  }

  // Karta mogła już istnieć w Voucherify (marketing w aplikacji albo w kasie):
  // wtedy obowiązuje jej realne saldo i nie dosypujemy punktów powitalnych.
  const found = await findMemberId(email);
  if (found) {
    const doc = await loyaltyAccounts.findOneAndUpdate(
      { _id: email },
      { $set: { memberId: found, existedBefore: true } },
      { returnDocument: "after" },
    );
    return doc as Account;
  }

  const memberId = await createMember(email);
  const doc = await loyaltyAccounts.findOneAndUpdate(
    { _id: email },
    { $set: { memberId, existedBefore: false } },
    { returnDocument: "after" },
  );
  // Karta jest świeżo założona, więc historii nie trzeba sprawdzać: nikt nie zdążył
  // nic na niej zapisać. Oszczędza jedno wywołanie z limitu Sandboxa.
  return ensureWelcome(doc as Account, { fresh: true });
}

/**
 * Punkty powitalne. Oddzielny krok, bo między założeniem karty a ich naliczeniem
 * Voucherify może przestać odpowiadać; wtedy przy następnym wejściu dokończymy,
 * sprawdzając wcześniej historię karty, żeby nie naliczyć ich dwa razy.
 */
async function ensureWelcome(acc: Account, opts: { fresh?: boolean } = {}): Promise<Account> {
  if (acc.welcomeGrantedAt || acc.existedBefore) return acc;
  const { loyaltyAccounts } = await collections();
  const marker = welcomeMarker(acc._id);

  if (!opts.fresh) {
    // Wracamy po przerwanym zakładaniu konta: punkty mogły już wyjść.
    const already = await hasTransaction(acc.memberId, marker);
    if (already === true) {
      const doc = await loyaltyAccounts.findOneAndUpdate(
        { _id: acc._id },
        { $set: { welcomeGrantedAt: new Date() } },
        { returnDocument: "after" },
      );
      return (doc ?? acc) as Account;
    }
    if (already === null) {
      // Nie wiadomo, czy punkty już są: lepiej nie zgadywać drugim naliczeniem.
      console.warn(`[loyalty] nie udało się sprawdzić historii karty ${acc.memberId}: pomijam punkty powitalne`);
      return acc;
    }
  }

  const balance = await adjustBalance(acc.memberId, WELCOME_POINTS, marker);
  const doc = await loyaltyAccounts.findOneAndUpdate(
    { _id: acc._id },
    { $set: { welcomeGrantedAt: new Date(), balance, balanceAt: new Date() } },
    { returnDocument: "after" },
  );
  return (doc ?? acc) as Account;
}

async function cacheBalance(email: string, balance: number) {
  const { loyaltyAccounts } = await collections();
  await loyaltyAccounts.updateOne({ _id: email }, { $set: { balance, balanceAt: new Date() } });
}

/** Saldo punktów klienta. Czyta z Voucherify, chyba że cache jest świeży. */
export async function loyaltyBalance(email: string, maxAgeMs = config.loyalty.cacheTtlMs): Promise<number> {
  const acc = await account(email);
  if (acc.balance !== undefined && acc.balanceAt && Date.now() - acc.balanceAt.getTime() <= maxAgeMs) {
    return acc.balance;
  }
  const balance = await readBalance(acc.memberId);
  await cacheBalance(email, balance);
  return balance;
}

/** Saldo bez ruszania Voucherify (podpowiedź w UI). `null`, gdy nic jeszcze nie wiemy. */
export async function cachedBalance(email: string): Promise<number | null> {
  const { loyaltyAccounts } = await collections();
  const doc = await loyaltyAccounts.findOne({ _id: email }, { projection: { balance: 1 } });
  return doc?.balance ?? null;
}

/**
 * Wydanie punktów przy zakupie (karta B). Odmowa 409, gdy klient ich nie ma.
 * Dla pewności to Voucherify decyduje, czy odjęcie przejdzie: nasze saldo to tylko cache.
 */
export async function spendPoints(email: string, points: number, marker: string): Promise<number> {
  if (points <= 0) return 0;
  const acc = await account(email);

  // Szybka odmowa bez wywołania API, ale nigdy na podstawie starego cache'a.
  if (acc.balance !== undefined && acc.balance < points) {
    const fresh = await readBalance(acc.memberId);
    await cacheBalance(email, fresh);
    if (fresh < points) throw insufficient(fresh);
  }

  try {
    const balance = await adjustBalance(acc.memberId, -points, marker);
    await cacheBalance(email, balance);
    return balance;
  } catch (err) {
    if (err instanceof InsufficientPointsError) {
      const fresh = await readBalance(acc.memberId).catch(() => 0);
      await cacheBalance(email, fresh).catch(() => undefined);
      throw insufficient(fresh);
    }
    throw err;
  }
}

/** Naliczenie punktów (za zakup albo zwrot niewykorzystanych). */
export async function grantPoints(email: string, points: number, marker: string): Promise<number> {
  if (points <= 0) return 0;
  const acc = await account(email);
  const balance = await adjustBalance(acc.memberId, points, marker);
  await cacheBalance(email, balance);
  return balance;
}

/**
 * Czy operacja z tym markerem już trafiła do Voucherify? Pytamy tylko przed ponowieniem
 * zadania z kolejki (dostarczanie "co najmniej raz"). `null` = nie dało się ustalić.
 */
export async function markerApplied(email: string, marker: string): Promise<boolean | null> {
  const { loyaltyAccounts } = await collections();
  const doc = await loyaltyAccounts.findOne({ _id: email }, { projection: { memberId: 1 } });
  if (!doc?.memberId) return false;
  return hasTransaction(doc.memberId, marker);
}
