// Kontrakt danych przesyłanych między API a ekranami (kontrakt wewnętrzny).

import type { HallLayout } from "./hall";

export type CinemaEvent = {
  id: string;
  film: string;
  title: string; // nazwa wydarzenia wyświetlana w liście (film + wersja)
  genre: string;
  durationMin: number;
  ageRating: string;
  language: string;
  startsAt: string; // ISO 8601
  hall: string; // np. "Sala 1"
  layout: HallLayout;
  posterSeed: string;
  synopsis: string;
  price: number; // cena fotela w groszach (3200 = 32 zł)
};

export type EventDetails = {
  event: CinemaEvent;
  takenSeats: string[];
};

export type ReservationStatus = "held" | "paid" | "expired";

export type EmailStatus = "none" | "pending" | "sent" | "failed";

export type ReservationView = {
  reservationId: string;
  eventId: string;
  seatId: string;
  customerName: string;
  emailMasked: string;
  status: ReservationStatus;
  amount: number; // w groszach, zapisane w chwili rezerwacji
  currency: "pln";
  expiresAt: string;
  code?: string; // tylko gdy status = "paid"
  purchasedAt: string | null; // chwila opłacenia
  refund: "pending" | "succeeded" | null; // płatność po czasie, gdy fotel miał już innego właściciela
  emailStatus: EmailStatus;
  event: CinemaEvent;
  serverTime: string; // do korekty przesunięcia zegara klienta
};

export type ApiErrorBody = {
  error: string;
  errorCode: string; // nie "code": w kontrakcie "code" to kod biletu
  retryable?: boolean;
};
