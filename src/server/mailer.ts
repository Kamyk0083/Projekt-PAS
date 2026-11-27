import { randomUUID } from "node:crypto";
import { collections, isDuplicateKey } from "./db";
import { config } from "./config";
import { CircuitBreaker } from "./circuitBreaker";

// Dostawca poczty. Od etapu III domyślnie Resend (tryb testowy), a bez klucza wersja
// symulowana z etapu I, żeby aplikacja i testy dawały się uruchomić bez konta.
// Niezależnie od dostawcy wysyłka ma: timeout, bezpiecznik, idempotencję po kluczu
// (= ID zadania w kolejce) i lokalny ślad w kolekcji `mails`.
//
// Uwaga o Resendzie bez własnej domeny: wysyłka z onboarding@resend.dev dociera tylko
// na adres właściciela konta i na adresy testowe (delivered@resend.dev, bounced@resend.dev,
// z dowolną etykietą po "+"). Każde inne odrzucenie jest trwałe: takiego zadania nie ma
// sensu ponawiać, więc idzie prosto do DLQ i widać je na /status i na stronie biletu.

// tags: etykiety Resenda (tylko identyfikatory, bez danych osobowych). Wracają w webhooku,
// więc zdarzenie "mail odbity" da się przypisać do oferty z listy oczekujących (etap IV).
export type Mail = {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  tags?: { name: string; value: string }[];
};

export type SentMail = { providerId?: string; replayed: boolean };

/** Awaria chwilowa: warto ponowić (liczy się do bezpiecznika). */
export class MailerUnavailableError extends Error {}
/** Odmowa trwała: ponawianie nic nie da (zły adres, niezweryfikowana domena, walidacja). */
export class MailRejectedError extends Error {}

const g = globalThis as typeof globalThis & { __kinoMailBreaker?: CircuitBreaker };

export const mailBreaker =
  g.__kinoMailBreaker ??
  (g.__kinoMailBreaker = new CircuitBreaker("mailer", {
    windowSize: 10,
    minimumRequests: 4,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30_000,
  }));

export const mailProvider = () => config.mail.provider;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** Ślad wysyłki u nas: drugi mail z tym samym kluczem nie wychodzi (E02). */
async function recordSent(mail: Mail, providerId?: string) {
  const { mails } = await collections();
  try {
    await mails.insertOne({
      _id: mail.idempotencyKey,
      to: mail.to,
      subject: mail.subject,
      body: mail.text,
      sentAt: new Date(),
      ...(providerId ? { providerId } : {}),
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err; // już zapisany: ponowienie nic nie zmienia
  }
}

// ---- Resend -----------------------------------------------------------------

const PERMANENT_STATUS = new Set([400, 401, 403, 404, 422]);

async function resendSend(mail: Mail): Promise<string | undefined> {
  const { apiKey, from, timeoutMs } = config.mail;
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Resend pamięta klucz 24 h: powtórka tego samego zadania nie wyśle drugiego maila.
        "Idempotency-Key": mail.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.tags?.length ? { tags: mail.tags } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    throw new MailerUnavailableError(err instanceof Error ? err.message : "Resend nie odpowiada");
  }

  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { id?: string } | null;
    await recordSent(mail, body?.id);
    return body?.id;
  }

  const body = (await res.json().catch(() => null)) as { message?: string; name?: string } | null;
  const message = `Resend ${res.status}: ${body?.message ?? body?.name ?? res.statusText}`;
  if (PERMANENT_STATUS.has(res.status)) throw new MailRejectedError(message);
  // 429 i 5xx to awarie chwilowe; 409 oznacza, że ten sam klucz jest właśnie w obróbce.
  throw new MailerUnavailableError(message);
}

// ---- Dostawca symulowany ----------------------------------------------------

async function simulatedSend(mail: Mail): Promise<string> {
  const { failureRate, latencyMs } = config.mailer;
  // Rozrzut opóźnienia: czasem dostawca odpowiada dużo wolniej niż zwykle.
  const jitter = Math.random() < 0.05 ? latencyMs * 8 : Math.random() * latencyMs;
  await sleep(latencyMs / 2 + jitter, AbortSignal.timeout(config.mailer.timeoutMs));
  if (Math.random() < failureRate) throw new MailerUnavailableError("SMTP 421: service not available");
  // Jak w Resendzie: adres, który nie istnieje, odrzuca wiadomość na stałe.
  if (/^bounced(\+|@)/.test(mail.to)) throw new MailRejectedError("Odbiorca nie istnieje (symulacja).");
  // ID jak u Resenda, żeby zdarzenia webhooka dało się odtworzyć także bez konta.
  const providerId = `sim_${randomUUID()}`;
  await recordSent(mail, providerId);
  return providerId;
}

/**
 * Mail z tym kluczem już wyszedł (nasz lokalny outbox). Ponowienie zadania po udanej wysyłce
 * nie wysyła go drugi raz, nawet gdy treść by się różniła (Resend odrzuciłby wtedy klucz: 409).
 */
export async function sentMail(idempotencyKey: string) {
  const { mails } = await collections();
  return mails.findOne({ _id: idempotencyKey });
}

// Każde wywołanie: timeout (nie czekamy dłużej niż ustawiony limit) + bezpiecznik.
export async function sendMail(mail: Mail): Promise<SentMail> {
  const previous = await sentMail(mail.idempotencyKey);
  if (previous) return { providerId: previous.providerId, replayed: true };
  const outcome = await mailBreaker.fire<{ rejected: MailRejectedError } | { providerId?: string }>(async () => {
    try {
      const providerId = config.mail.provider === "resend" ? await resendSend(mail) : await simulatedSend(mail);
      return { providerId };
    } catch (err) {
      // Odmowa trwała to nie awaria zależności: nie wolno jej otwierać bezpiecznika,
      // bo jeden zły adres zablokowałby wysyłkę wszystkim pozostałym.
      if (err instanceof MailRejectedError) return { rejected: err };
      throw err;
    }
  });
  if ("rejected" in outcome) throw outcome.rejected;
  return { providerId: outcome.providerId, replayed: false };
}
