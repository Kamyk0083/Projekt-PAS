import { collections, type EventDoc, type ReservationDoc, type WaitlistDoc } from "./db";
import { config } from "./config";
import { MailRejectedError, sendMail } from "./mailer";
import { isPaid } from "./reservations";
import { fixMailDeadline, offerUndelivered } from "./waitlist";
import { formatPrice } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import { formatPoints, maxPointsFor } from "@/lib/loyalty";

// Karta C (etap IV): mail do osoby z listy oczekujących, która dostała miejsce.
// Zawiera nazwę wydarzenia, miejsce, link do zapłaty i godzinę, do której miejsce czeka.
// Gdy mail nie dojdzie, kolejka idzie dalej (offerUndelivered: kontrakt C -> B).

const TZ = "Europe/Warsaw";
const whenFmt = new Intl.DateTimeFormat("pl-PL", { dateStyle: "full", timeStyle: "short", timeZone: TZ });
const clockFmt = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", timeZone: TZ });

export type OfferMail = { subject: string; text: string; html: string };

export const payLink = (reservationId: string) => `${config.appUrl}/rezerwacja/${reservationId}`;
export const waitlistLink = (eventId: string, waitlistId: string) =>
  `${config.appUrl}/seanse/${encodeURIComponent(eventId)}?kolejka=${waitlistId}`;

export function buildOfferMail(
  entry: Pick<WaitlistDoc, "_id" | "customerName" | "eventId">,
  reservation: Pick<ReservationDoc, "_id" | "seatId" | "amount">,
  event: EventDoc | null,
  deadline: Date,
): OfferMail {
  const film = event?.film ?? "seans";
  const when = event ? whenFmt.format(event.startsAt) : "";
  const until = clockFmt.format(deadline);
  const untilDay = dateFmt.format(deadline);
  const seat = seatLabel(reservation.seatId);
  const pay = payLink(reservation._id);
  const leave = waitlistLink(entry.eventId, entry._id);
  const maxPoints = maxPointsFor(reservation.amount);

  const text = [
    `Cześć ${entry.customerName},`,
    "",
    `zwolniło się miejsce na ${film}, na które czekasz na liście oczekujących.`,
    `${when}, ${event?.hall ?? ""}, ${seat}. Cena: ${formatPrice(reservation.amount)}.`,
    "",
    `Miejsce czeka na Ciebie do ${until} (${untilDay}). Zapłać tutaj:`,
    pay,
    "",
    `Możesz zapłacić częściowo punktami, najwyżej ${formatPoints(maxPoints)} (połowa ceny).`,
    "Jeśli nie zapłacisz do tej godziny, miejsce dostanie następna osoba z listy.",
    "",
    `Nie chcesz już tego miejsca? Wypisz się: ${leave}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="pl"><body style="margin:0;padding:24px;background:#0f1117;font-family:Inter,Arial,sans-serif;color:#e7e9ee">
  <div style="max-width:520px;margin:0 auto;background:#171a22;border-radius:16px;overflow:hidden">
    <div style="padding:24px 28px;background:#c6f05c;color:#0f1117">
      <p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Kino Pasaż · lista oczekujących</p>
      <h1 style="margin:6px 0 0;font-size:22px">Zwolniło się miejsce dla Ciebie</h1>
    </div>
    <div style="padding:24px 28px">
      <p style="margin:0 0 4px;font-size:18px;font-weight:600">${escapeHtml(film)}</p>
      <p style="margin:0;color:#9aa3b2">${escapeHtml(when)}</p>
      <p style="margin:4px 0 20px;color:#9aa3b2">${escapeHtml(event?.hall ?? "")}, ${escapeHtml(seat)} · ${escapeHtml(formatPrice(reservation.amount))}</p>
      <div style="padding:16px;border:1px dashed #3a4050;border-radius:12px;text-align:center">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9aa3b2">Miejsce czeka do</p>
        <p style="margin:0;font-size:26px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(until)}</p>
        <p style="margin:4px 0 0;color:#9aa3b2;font-size:13px">${escapeHtml(untilDay)}</p>
      </div>
      <p style="margin:20px 0 0;text-align:center">
        <a href="${escapeHtml(pay)}" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#c6f05c;color:#0f1117;font-weight:600;text-decoration:none">Zapłać ${escapeHtml(formatPrice(reservation.amount))}</a>
      </p>
      <p style="margin:20px 0 0;color:#9aa3b2;font-size:13px">Możesz zapłacić częściowo punktami, najwyżej ${escapeHtml(formatPoints(maxPoints))} (połowa ceny). Jeśli nie zapłacisz do ${escapeHtml(until)}, miejsce dostanie następna osoba z listy.</p>
      <p style="margin:12px 0 0;color:#9aa3b2;font-size:13px">Nie chcesz już tego miejsca? <a href="${escapeHtml(leave)}" style="color:#c6f05c">Wypisz się z listy</a>.</p>
    </div>
  </div>
</body></html>`;

  return { subject: `Zwolniło się miejsce: ${film}, czeka do ${until}`, text, html };
}

/**
 * Zadanie `waitlist-offer:<reservationId>` (kontrakt B -> C). Ponowienie jest bezpieczne:
 * - oferta już nieaktualna (kupione, wypisany, przeszła na kolejną osobę): nic nie wysyłamy,
 * - mail już wyszedł: dostawca i nasz outbox `mails` rozpoznają klucz idempotencji (= ID zadania),
 * - termin w mailu jest ustalony raz, więc ponowienie wysyła identyczną treść.
 */
export async function deliverOfferMail(reservationId: string, jobId: string): Promise<"sent" | "stale"> {
  const { waitlist, reservations, events } = await collections();
  const entry = await waitlist.findOne({ reservationId, status: "offered" });
  if (!entry) return "stale";
  const reservation = await reservations.findOne({ _id: reservationId });
  if (!reservation || isPaid(reservation)) return "stale";
  const now = new Date();
  if (reservation.status !== "held" || reservation.expiresAt <= now) return "stale";

  const deadline = entry.mailDeadline ?? (await fixMailDeadline(entry, reservation));
  if (!deadline) return "stale";

  const event = await events.findOne({ _id: entry.eventId });
  const mail = buildOfferMail(entry, reservation, event, deadline);
  try {
    const sent = await sendMail({
      idempotencyKey: jobId,
      to: entry.email,
      ...mail,
      // Tylko identyfikatory: po nich webhook Resenda wskaże ofertę, gdy mail się odbije.
      tags: [
        { name: "kind", value: "waitlist_offer" },
        { name: "reservation", value: reservationId },
        { name: "waitlist", value: entry._id },
      ],
    });
    await waitlist.updateOne(
      { _id: entry._id, status: "offered", reservationId },
      { $set: { notifiedAt: new Date(), updatedAt: new Date(), ...(sent.providerId ? { mailId: sent.providerId } : {}) } },
    );
  } catch (err) {
    // Odmowa trwała (adres nie istnieje, adres spoza listy testowej Resenda): mail nie dojdzie,
    // więc nie trzymamy fotela przez 15 minut, tylko od razu oddajemy go następnej osobie.
    if (err instanceof MailRejectedError) await offerUndelivered(reservationId);
    throw err;
  }
  return "sent";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
