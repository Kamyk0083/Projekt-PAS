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
  // Rozliczenie z programem lojalnościowym (etap III). 1 punkt = 1 grosz.
  pointsUsed: number; // punkty wydane na ten bilet (przed zapłatą: zdjęte na bieżącą próbę)
  pointsEarned: number; // punkty za ten zakup, dopisane po opłaceniu (wcześniej 0)
  pointsValue: number; // wartość pointsUsed w groszach
  cardAmount: number; // do dopłaty kartą: amount - pointsValue
  loyalty: {
    balance: number | null; // saldo z cache'a serwera; null, gdy nic jeszcze nie wiemy
    maxPoints: number; // najwięcej punktów na ten bilet (połowa ceny)
  };
  expiresAt: string;
  code?: string; // tylko gdy status = "paid"
  purchasedAt: string | null; // chwila opłacenia
  refund: "pending" | "succeeded" | null; // płatność po czasie, gdy fotel miał już innego właściciela
  emailStatus: EmailStatus;
  event: CinemaEvent;
  serverTime: string; // do korekty przesunięcia zegara klienta
};

// GET /api/loyalty?email=... (karta A)
export type LoyaltyView = { email: string; points: number };

export type ApiErrorBody = {
  error: string;
  errorCode: string; // nie "code": w kontrakcie "code" to kod biletu
  retryable?: boolean;
};
