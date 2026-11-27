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
  // Etap IV: każde miejsce kupione albo z ważną rezerwacją (także ofertą dla osoby z listy).
  soldOut: boolean;
};

// Etap IV: lista oczekujących.
export type WaitlistStatus = "waiting" | "offered" | "done" | "missed" | "left";

// POST /api/events/:id/waitlist
export type WaitlistJoin = { waitlistId: string; position: number };

// GET /api/waitlist/:id. `position` liczy się od 1 dla osób czekających; 0 znaczy, że osoba
// nie stoi już w kolejce (ma ofertę, kupiła bilet, przegapiła ją albo się wypisała).
export type WaitlistView = {
  waitlistId: string;
  eventId: string;
  status: WaitlistStatus;
  position: number;
  reservationId?: string; // offered, done i missed: rezerwacja z oferty
  offerExpiresAt?: string; // offered: do kiedy miejsce czeka (expiresAt rezerwacji)
  seatId?: string;
  missedReason?: "timeout" | "undelivered";
  emailMasked: string;
  serverTime: string;
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
  fromWaitlist: boolean; // etap IV: miejsce z listy oczekujących
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
