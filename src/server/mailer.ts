import { collections, isDuplicateKey } from "./db";
import { config } from "./config";
import { CircuitBreaker } from "./circuitBreaker";

// Symulowany zewnętrzny dostawca maili: bywa wolny i bywa niedostępny
// (MAILER_FAILURE_RATE, MAILER_LATENCY_MS). "Skrzynka nadawcza" to kolekcja `mails`.
// Dostawca przyjmuje klucz idempotencji: drugi mail z tym samym kluczem nie wychodzi (E02).

export type Mail = { idempotencyKey: string; to: string; subject: string; body: string };

export class MailerUnavailableError extends Error {}

const g = globalThis as typeof globalThis & { __kinoMailBreaker?: CircuitBreaker };

export const mailBreaker =
  g.__kinoMailBreaker ??
  (g.__kinoMailBreaker = new CircuitBreaker("mailer", {
    windowSize: 10,
    minimumRequests: 4,
    errorThresholdPercentage: 50,
    resetTimeoutMs: 30_000,
  }));

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

async function providerSend(mail: Mail, signal: AbortSignal) {
  const { failureRate, latencyMs } = config.mailer;
  // Rozrzut opóźnienia: czasem dostawca odpowiada dużo wolniej niż zwykle.
  const jitter = Math.random() < 0.05 ? latencyMs * 8 : Math.random() * latencyMs;
  await sleep(latencyMs / 2 + jitter, signal);
  if (Math.random() < failureRate) throw new MailerUnavailableError("SMTP 421: service not available");

  const { mails } = await collections();
  try {
    await mails.insertOne({ _id: mail.idempotencyKey, to: mail.to, subject: mail.subject, body: mail.body, sentAt: new Date() });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err; // już wysłany: ponowienie nic nie zmienia
  }
}

// Każde wywołanie: timeout (nie czekamy dłużej niż MAILER_TIMEOUT_MS) + bezpiecznik.
export function sendMail(mail: Mail): Promise<void> {
  return mailBreaker.fire(() => providerSend(mail, AbortSignal.timeout(config.mailer.timeoutMs)));
}
