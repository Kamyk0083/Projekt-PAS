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
};

export type EventDetails = {
  event: CinemaEvent;
  takenSeats: string[];
};

export type ReservationStatus = "held" | "purchased" | "expired";

export type EmailStatus = "none" | "pending" | "sent" | "failed";

export type ReservationView = {
  reservationId: string;
  eventId: string;
  seatId: string;
  customerName: string;
  emailMasked: string;
  status: ReservationStatus;
  expiresAt: string;
  code: string | null;
  purchasedAt: string | null;
  emailStatus: EmailStatus;
  event: CinemaEvent;
  serverTime: string; // do korekty przesunięcia zegara klienta
};

export type ApiErrorBody = {
  error: string;
  code: string;
  retryable?: boolean;
};
