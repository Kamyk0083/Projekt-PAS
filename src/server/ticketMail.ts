import type { EventDoc, ReservationDoc } from "./db";
import { formatPrice } from "@/lib/format";
import { seatLabel } from "@/lib/hall";
import { formatPoints, pointsToGrosze } from "@/lib/loyalty";

// Karta C: treść maila z biletem i podsumowaniem zakupu. To samo podsumowanie
// (ile kartą, ile punktami, ile punktów zebrane) pokazuje strona biletu.

const when = (event: EventDoc | null) =>
  event
    ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Warsaw" }).format(
        event.startsAt,
      )
    : "";

export type TicketMail = { subject: string; text: string; html: string };

export function buildTicketMail(reservation: ReservationDoc, event: EventDoc | null): TicketMail {
  const film = event?.film ?? "seans";
  const pointsUsed = reservation.pointsUsed ?? 0;
  const pointsEarned = reservation.pointsEarned ?? 0;
  const cardAmount = reservation.amount - pointsToGrosze(pointsUsed);

  const rows: [string, string][] = [
    ["Cena biletu", formatPrice(reservation.amount)],
    ["Zapłacono kartą", formatPrice(cardAmount)],
  ];
  if (pointsUsed > 0) {
    rows.push(["Zapłacono punktami", `${formatPoints(pointsUsed)} (${formatPrice(pointsToGrosze(pointsUsed))})`]);
  }
  rows.push(["Punkty za ten zakup", `+${formatPoints(pointsEarned)}`]);

  const text = [
    `Cześć ${reservation.customerName},`,
    "",
    `oto Twój bilet na ${film}.`,
    `${when(event)}, ${event?.hall ?? ""}, ${seatLabel(reservation.seatId)}.`,
    `Kod biletu: ${reservation.code}`,
    "",
    "Podsumowanie:",
    ...rows.map(([label, value]) => `- ${label.toLowerCase()}: ${value}`),
    "",
    pointsUsed > 0
      ? "Punkty już zeszły z Twojego konta, a nowe dopisaliśmy po zapłacie."
      : "Punkty za ten zakup dopisaliśmy do Twojego konta.",
    "Pokaż kod przy wejściu do sali. Do zobaczenia w Pasażu!",
  ].join("\n");

  const html = `<!doctype html>
<html lang="pl"><body style="margin:0;padding:24px;background:#0f1117;font-family:Inter,Arial,sans-serif;color:#e7e9ee">
  <div style="max-width:520px;margin:0 auto;background:#171a22;border-radius:16px;overflow:hidden">
    <div style="padding:24px 28px;background:#c6f05c;color:#0f1117">
      <p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase">Kino Pasaż</p>
      <h1 style="margin:6px 0 0;font-size:22px">Bilet jest Twój</h1>
    </div>
    <div style="padding:24px 28px">
      <p style="margin:0 0 4px;font-size:18px;font-weight:600">${escapeHtml(film)}</p>
      <p style="margin:0;color:#9aa3b2">${escapeHtml(when(event))}</p>
      <p style="margin:4px 0 20px;color:#9aa3b2">${escapeHtml(event?.hall ?? "")}, ${escapeHtml(seatLabel(reservation.seatId))}</p>
      <div style="padding:16px;border:1px dashed #3a4050;border-radius:12px;text-align:center">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9aa3b2">Kod biletu</p>
        <p style="margin:0;font-size:26px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em">${escapeHtml(reservation.code ?? "")}</p>
      </div>
      <table style="width:100%;margin-top:20px;border-collapse:collapse;font-size:14px">
        ${rows
          .map(
            ([label, value], i) =>
              `<tr><td style="padding:8px 0;color:#9aa3b2;border-top:${i ? "1px solid #262b36" : "none"}">${escapeHtml(label)}</td><td style="padding:8px 0;text-align:right;border-top:${i ? "1px solid #262b36" : "none"}">${escapeHtml(value)}</td></tr>`,
          )
          .join("")}
      </table>
      <p style="margin:20px 0 0;color:#9aa3b2;font-size:13px">Pokaż kod przy wejściu do sali. Do zobaczenia w Pasażu!</p>
    </div>
  </div>
</body></html>`;

  return { subject: `Twój bilet: ${film} (${reservation.code})`, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
