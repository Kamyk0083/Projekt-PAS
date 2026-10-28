# Kino Pasaż: kasa biletowa (Projekt PAS S01, Etap I, wariant Kino)

Klient wybiera seans i wolny fotel, rezerwuje go (fotel jest trzymany przez 15 minut i dla innych wygląda na zajęty), a potem klika „Kupuję bilet” i dostaje kod. Jeśli nie zdąży, rezerwacja przepada, a fotel wraca do puli.

Stos: Next.js 16 (App Router, route handlers), MongoDB (transakcje, replica set), Motion, Phosphor Icons, Vitest.

## Uruchomienie

```bash
npm install
npm run dev          # http://localhost:3000
```

Bez `MONGODB_URI` aplikacja sama startuje bazę w pamięci (`mongodb-memory-server`, replica set, pierwszy start pobiera binarkę MongoDB). Dane znikają po restarcie. Z własną bazą:

```bash
MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" npm run dev
```

Zmienne środowiskowe opisuje `.env.example`. Najważniejsza: `RESERVATION_TTL_SECONDS` (900 na produkcji, **120 w testach**).

```bash
npm test             # testy API: wyścigi, idempotencja, wygasanie, kolejka, DLQ, limit żądań
npm run build
```

## Wspólny kontrakt API

| Karta | Endpoint | Zwraca |
| --- | --- | --- |
| A | `GET /api/events` | tablica seansów |
| A | `GET /api/events/:id` | `{ event, takenSeats }`: kupione i z ważną rezerwacją, np. `["F7"]` |
| B | `POST /api/reservations` `{ eventId, seatId, customerName, email }` | `201 { reservationId, expiresAt }` |
| C | `POST /api/reservations/:id/purchase` | `200 { code }` albo `410`, gdy rezerwacja wygasła |

Błędy mają postać `{ error, errorCode, retryable }` (celowo nie `code`, bo `code` to kod biletu): `400 VALIDATION`, `404 NOT_FOUND`, `409 SEAT_TAKEN`, `410 RESERVATION_EXPIRED`, `422 IDEMPOTENCY_MISMATCH`, `429 RATE_LIMITED` i `503 OVERLOADED / DEPENDENCY_UNAVAILABLE` (oba z `Retry-After`).

`seatId` ma format `"F7"` (rząd A–H, miejsce 1–10). Dane przykładowe: 3 seanse w 2 salach po 8×10 foteli.

## Kontrakt wewnętrzny

**Strony i przepływ między kartami**

| Adres | Karta | Co robi |
| --- | --- | --- |
| `/` | A | repertuar: film, data, godzina, sala, miniatura zajętości sali |
| `/seanse/:eventId?fotel=F7` | A → B | mapa sali (ekran na górze, rzędy A–H). Kliknięcie wolnego fotela otwiera formularz „Rząd F, miejsce 7” |
| `/rezerwacja/:reservationId` | B → C | licznik „Trzymamy Twój fotel jeszcze 14:32”, przycisk „Kupuję bilet”, potem bilet z kodem albo komunikat „Rezerwacja wygasła, fotel wrócił do puli” |
| `/status` | dodatkowa | stan bezpiecznika, kolejki, DLQ i pul zapytań |

Między ekranami przekazujemy tylko identyfikatory w adresie (`eventId`, `seatId` w `?fotel=`, `reservationId`). Ekran rezerwacji pobiera resztę z `GET /api/reservations/:id` (`ReservationView` w `src/lib/types.ts`), w tym `serverTime`, żeby licznik nie zależał od zegara klienta.

**Model danych (MongoDB)**

| Kolekcja | Klucz | Rola |
| --- | --- | --- |
| `events` | `_id` = eventId | seanse z układem sali |
| `seats` | `_id` = `${eventId}\|${seatId}` | blokada fotela: `held` (z `expiresAt`) albo `sold` |
| `reservations` | `_id` = UUID, unikalny `idempotencyKey` | dane klienta, status `held / purchased / expired`, kod biletu |
| `jobs` | `_id` = `ticket-email:${reservationId}` | kolejka zadań (outbox) |
| `deadLetters` | `_id` = ID zadania | zadania, które przekroczyły limit prób |
| `mails` | `_id` = klucz idempotencji | „skrzynka nadawcza” symulowanego dostawcy maili |
| `rateBuckets` | `_id` = `scope:ip` | wiadra token bucket z TTL |

## Zagrożenia i nasze karty (na podstawie lekcji)

**E02 Powtarzanie operacji**
- *Dwie osoby klikają ten sam fotel.* Fotel to dokument z unikalnym `_id`. Rezerwacja to warunkowy upsert („wolny albo wygasły”), więc baza przepuści tylko jeden zapis. Test: 20 równoległych prób daje 1 × 201 i 19 × 409.
- *Retry po timeoucie albo podwójny klik tworzy dwie rezerwacje.* Klient wysyła `Idempotency-Key` (jeden na intencję). Ponowienie zwraca tę samą rezerwację (`200`, nagłówek `Idempotent-Replayed`), a ten sam klucz dla innego fotela daje `422`.
- *Podwójny zakup.* Zakup to zapis warunkowy `held i niewygasła → purchased`, idempotentny z natury: ponowienie zwraca ten sam kod.
- *Kilka rekordów naraz.* Blokada fotela i rezerwacja oraz zakup, fotel i zadanie w kolejce zmieniają się w jednej transakcji.

**E04 Gdy zależność pada**
- Timeout na każdym wywołaniu: `fetch` w kliencie (`AbortSignal.timeout`), operacje bazy (`maxTimeMS`, `serverSelectionTimeoutMS`) i dostawca maili.
- Circuit breaker dostawcy maili (CLOSED → OPEN → HALF_OPEN). Gdy jest otwarty, worker w ogóle nie pobiera zadań mailowych.
- Fallback, który nie kłamie: bilet i kod są gotowe od razu i nie zależą od maila. Dostawca maili jest symulowany (wymagania nie każą nic wysyłać), więc interfejs nie obiecuje wysyłki, tylko każe zachować kod.
- Łagodna degradacja: gdy odświeżenie planu sali się nie uda, zostaje ostatni znany stan z komunikatem. Gdy baza nie odpowiada, dostajesz szybkie `503` z `Retry-After` i stronę z przyciskiem „Spróbuj ponownie”.

**E05 Przeciążenie**
- Rate limiting: token bucket na IP dla rezerwacji i zakupów, trzymany w bazie, więc wspólny dla wielu instancji. Doliczenie i pobranie żetonu to jedna atomowa operacja. Odpowiedź to `429 + Retry-After`.
- Load shedding: globalny limit żądań w toku, powyżej niego od razu `503`.
- Bulkhead: osobne pule dla odczytów (plan sali) i zapisów (rezerwacja, zakup) z ograniczoną kolejką. Zalew odczytów nie zablokuje kupowania.
- Klient ponawia tylko błędy chwilowe (sieć, 429, 5xx), z wykładniczym backoffem, jitterem i poszanowaniem `Retry-After`.

**E06 Praca w tle**
- Wysyłka biletu mailem nie blokuje zakupu. Zadanie trafia do kolekcji `jobs` w tej samej transakcji co zakup (transactional outbox).
- Worker (w procesie serwera przez `instrumentation.ts`, albo `GET /api/cron/worker` dla crona) przejmuje zadanie z visibility timeout i robi ack dopiero po pracy (at-least-once).
- Duplikaty: dostawca deduplikuje po kluczu idempotencji równym ID zadania, więc mail wychodzi raz.
- Retry z backoffem, limit 5 prób, potem dead letter queue. Zatruta wiadomość nie blokuje kolejki.
- Sprzątanie wygasłych rezerwacji to też praca w tle, ale poprawność od niej nie zależy: zapytania i tak traktują wygasłe blokady jak wolne fotele.

## Kryteria etapu I: jak je spełniamy

| Kryterium | Zachowanie | Test |
| --- | --- | --- |
| A1 | `GET /api/events/nie-ma-takiego` → `404` | `tests/criteria.test.ts` |
| A2 | `takenSeats` filtruje po `expiresAt > teraz`, więc miejsce znika natychmiast, bez czekania na workera | jw. |
| B1 | identyczny POST (z kluczem albo bez) zwraca tę samą rezerwację (`201`, potem `200`), także równolegle | jw. |
| B2 | 20 równoczesnych prób: dokładnie jedna `201`, reszta `409` | jw. |
| B3 | złe wydarzenie `404`, złe miejsce, puste imię i e-mail oraz zły JSON `400`; nic nie trafia do bazy | jw. |
| B4 | wygasła blokada jest od razu do przejęcia (warunkowy upsert) | jw. |
| B5 | token bucket na IP (40 naraz, +2/s): 100 żądań w 10 s dostaje `429` z `Retry-After`, a inny IP rezerwuje normalnie | jw. |
| C1 | zakup 2× po kolei i równolegle zwraca ten sam kod i tworzy jeden bilet | jw. |
| C2 | zakup X i rezerwacja Y w chwili wygaśnięcia: transakcje na tym samym dokumencie fotela, zawsze jeden właściciel, bez `5xx` | jw. (5 rund) |
| C3 | `abc` i nieistniejące id → `404` | jw. |
| C4 | zakup po czasie → `410`; kupiony fotel ma status `sold` i nigdy nie wraca do puli | jw. |

Sprawdzenie na żywym adresie (te same ataki po HTTP, ok. 5 minut):

```bash
node scripts/chaos.mjs https://adres-firmy.example
```

### Wdrożenie: warunek wstępny

- **Trwała baza jest obowiązkowa.** Baza w pamięci nadaje się tylko lokalnie; na Vercelu każda instancja funkcji miałaby własną bazę. Ustaw `MONGODB_URI` na MongoDB Atlas (darmowy klaster M0 to replica set i obsługuje transakcje).
- **Tryb testowy:** na czas testów ustaw `RESERVATION_TTL_SECONDS=120`. Skrypt chaosu ostrzega, gdy `expiresAt` wypada dalej niż za 2 minuty, a ustawiony czas widać też na `/status`.
- Na serverless worker nie działa w tle stale: mail wysyła się zaraz po zakupie (`after()`), a resztę zadań obsługuje `GET /api/cron/worker`. Kryteria od workera nie zależą.

## Struktura

```
src/app            strony i route handlers (API)
src/server         logika serwera: baza, rezerwacje, kolejka, worker, bezpiecznik, limiter, bulkhead
src/components     UI: mapa sali, formularz, licznik, bilet, stan systemu
src/client         klient API odporny na błędy, hooki
src/lib            wspólne typy, geometria sali, formatowanie
tests              testy API (Vitest + MongoDB w pamięci)
```
