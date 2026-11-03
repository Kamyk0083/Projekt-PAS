# Kino Pasaż: kasa biletowa (Projekt PAS S01, etapy I i II, wariant Kino)

Klient wybiera seans i wolny fotel, rezerwuje go (fotel jest trzymany przez 15 minut i dla innych wygląda na zajęty), klika „Zapłać 32 zł”, płaci kartą na stronie Stripe Checkout i po powrocie widzi bilet z kodem. Jeśli przerwie płatność, wraca do sklepu i może zapłacić jeszcze raz, dopóki rezerwacja jest ważna. Jeśli nie zdąży, rezerwacja przepada, a fotel wraca do puli.

Stos: Next.js 16 (App Router, route handlers), MongoDB (transakcje, replica set), Stripe Checkout (tryb testowy), Motion, Phosphor Icons, Vitest.

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
npm test             # testy API: wyścigi, idempotencja, wygasanie, kolejka, DLQ, limit żądań, płatności
npm run build
```

### Płatności lokalnie

Klucze tylko w zmiennych środowiskowych serwera (`.env.local`, poza repozytorium): `STRIPE_SECRET_KEY=sk_test_…` i `STRIPE_WEBHOOK_SECRET=whsec_…`. Sekret webhooka podaje Stripe CLI:

```bash
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.expired --forward-to localhost:3000/api/webhooks/stripe
```

Karty testowe: `4242 4242 4242 4242` (udana), `4000 0000 0000 0002` (odmowa), `4000 0025 0000 3155` (3D Secure). Data ważności dowolna w przyszłości, CVC dowolne.

Na Vercelu: endpoint `https://<adres>/api/webhooks/stripe` dodany w panelu Stripe (tryb testowy, zdarzenia `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`), jego sekret w `STRIPE_WEBHOOK_SECRET`.

## Wspólny kontrakt API

| Karta | Endpoint | Zwraca |
| --- | --- | --- |
| A | `GET /api/events` | tablica seansów |
| A | `GET /api/events/:id` | `{ event, takenSeats }`: kupione i z ważną rezerwacją, np. `["F7"]` |
| B | `POST /api/reservations` `{ eventId, seatId, customerName, email }` | `201 { reservationId, expiresAt }` |
| C | `POST /api/reservations/:id/purchase` | etap I. Od etapu II: `200 { code }` tylko dla opłaconej rezerwacji, `402` przed zapłatą, `410` po wygaśnięciu |

Zmiany w etapie II:

| Karta | Endpoint | Zwraca |
| --- | --- | --- |
| A | `GET /api/events`, `GET /api/events/:id` | wydarzenie ma pole `price` (grosze, 3200 = 32 zł) |
| A | `POST /api/reservations` | dodatkowo `amount`: cena z chwili rezerwacji, potem się nie zmienia |
| A | `POST /api/reservations/:id/checkout` | `200 { url }` strony Stripe'a albo `404`, `409 ALREADY_PAID`, `410 RESERVATION_EXPIRED` |
| B | `POST /api/webhooks/stripe` | `200 { received: true }`, `400` przy złym podpisie |
| C | `GET /api/reservations/:id` | `{ status, amount, expiresAt, code? }`, `status` to `held`, `paid` albo `expired` |

Błędy mają postać `{ error, errorCode, retryable }` (celowo nie `code`, bo `code` to kod biletu): `400 VALIDATION`, `404 NOT_FOUND`, `409 SEAT_TAKEN`, `410 RESERVATION_EXPIRED`, `422 IDEMPOTENCY_MISMATCH`, `429 RATE_LIMITED` i `503 OVERLOADED / DEPENDENCY_UNAVAILABLE` (oba z `Retry-After`).

`seatId` ma format `"F7"` (rząd A–H, miejsce 1–10). Dane przykładowe: 3 seanse w 2 salach po 8×10 foteli.

## Kontrakt wewnętrzny

**Strony i przepływ między kartami**

| Adres | Karta | Co robi |
| --- | --- | --- |
| `/` | A | repertuar: film, data, godzina, sala, miniatura zajętości sali |
| `/seanse/:eventId?fotel=F7` | A → B | mapa sali (ekran na górze, rzędy A–H). Kliknięcie wolnego fotela otwiera formularz „Rząd F, miejsce 7” |
| `/rezerwacja/:reservationId` | B → C | licznik „Trzymamy Twój fotel jeszcze 14:32”, cena i przycisk „Zapłać 32 zł” (przejście do Stripe'a), potem bilet z kodem albo komunikat „Rezerwacja wygasła, fotel wrócił do puli” |
| `/rezerwacja/:reservationId?platnosc=ok` | etap II, C | `success_url`: „Płatność w toku…”, odpytuje `GET /api/reservations/:id` co 1,5 s i sama zamienia się w bilet |
| `/rezerwacja/:reservationId?platnosc=przerwana` | etap II, C | `cancel_url`: licznik dalej biegnie, komunikat o przerwanej płatności i „Zapłać 32 zł jeszcze raz” |
| `/status` | dodatkowa | stan bezpiecznika, kolejki, DLQ i pul zapytań |

Między ekranami przekazujemy tylko identyfikatory w adresie (`eventId`, `seatId` w `?fotel=`, `reservationId`). Ekran rezerwacji pobiera resztę z `GET /api/reservations/:id` (`ReservationView` w `src/lib/types.ts`), w tym `serverTime`, żeby licznik nie zależał od zegara klienta.

**Model danych (MongoDB)**

| Kolekcja | Klucz | Rola |
| --- | --- | --- |
| `events` | `_id` = eventId | seanse z układem sali |
| `seats` | `_id` = `${eventId}\|${seatId}` | blokada fotela: `held` (z `expiresAt`) albo `sold` |
| `reservations` | `_id` = UUID, unikalny `idempotencyKey` | dane klienta, status `held / paid / expired`, `amount`, kod biletu; `checkout` (numer próby, ID i adres sesji Stripe), `payment` (sesja, PaymentIntent, kwota), `refund` |
| `stripeEvents` | `_id` = ID zdarzenia Stripe | obsłużone webhooki (deduplikacja i ślad), TTL 30 dni |
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

**Etap II: Stripe jako zależność zewnętrzna**
- *Podrobiony webhook („płatność udana”) od kogoś innego niż Stripe.* Każde zdarzenie weryfikujemy podpisem (`Stripe.webhooks.constructEvent` na surowym ciele `request.text()`, tolerancja 5 min przeciw powtórzeniu starego żądania). Bez poprawnego podpisu `400` i żadnej zmiany.
- *Klient zmienia kwotę.* Kwota idzie do Stripe'a z rezerwacji w bazie, nigdy z przeglądarki, a webhook sprawdza `amount_total` i walutę `pln`. Niezgodność nie wydaje biletu.
- *Wyciek kluczy.* `STRIPE_SECRET_KEY` i `STRIPE_WEBHOOK_SECRET` tylko w env serwera, poza repo (`.gitignore` na `.env*`), kod Stripe'a wyłącznie w `src/server`. Klucz inny niż testowy (`sk_test_`/`rk_test_`) wyłącza płatności zamiast pobrać prawdziwe pieniądze.
- *Bilet bez płatności.* Kod powstaje dopiero w webhooku. Stary `POST /purchase` z etapu I nie wydaje biletu bez zapłaty (`402`), chyba że do testów etapu I ustawisz `LEGACY_PURCHASE_WITHOUT_PAYMENT=true`.
- *Stripe ponawia zdarzenie albo przysyła je dwa razy.* Obsługa jest idempotentna: warunkowy zapis `held → paid` w transakcji, rejestr `stripeEvents`, a zadanie maila ma stały `_id`. Powtórka nic nie zmienia.
- *Podwójny klik „Zapłać” albo retry.* Numer próby rezerwujemy atomowo w bazie, a do Stripe'a idzie klucz idempotencji `checkout-<id>-<próba>` z identycznymi parametrami: równoległe żądania dostają tę samą sesję. Po przerwaniu płatności wraca ta sama, nadal ważna sesja.
- *Płatność po czasie.* Sesja Checkout żyje minimum 30 minut, rezerwacja 15. Gdy pieniądze przyjdą po wygaśnięciu, a fotel jest wolny, sprzedajemy go. Gdy fotel ma już innego właściciela, robimy zwrot (`refunds.create` z kluczem `refund-<sesja>`) i klient widzi „Płatność dotarła po czasie, zwróciliśmy 32 zł”.
- *Stripe nie odpowiada.* Timeout 8 s na wywołanie, 2 ponowienia w SDK (z kluczem idempotencji), bezpiecznik `stripe`: po serii awarii od razu `503 PAYMENTS_UNAVAILABLE` z `Retry-After`, a przycisk pokazuje komunikat i „Zapłać jeszcze raz”. Rezerwacja i licznik działają dalej.
- *Webhook spóźnia się albo nie dochodzi.* Strona powrotu nie zakłada sukcesu: pokazuje „Płatność w toku…” i odpytuje status, a po 20 s mówi wprost, że potwierdzenie się opóźnia i nie trzeba płacić drugi raz. Gdy webhook zwróci `5xx`, Stripe ponawia go do 3 dni.
- *Open redirect przez nagłówek Host.* Adresy powrotu budujemy z `APP_URL` / zmiennych Vercela, a nie z nagłówka żądania.
- *Zalew żądań do checkoutu albo webhooka.* Checkout ma własne wiadro limitera na IP (`429`), webhook przechodzi przez load shedding i pulę zapisów oraz odrzuca ciało większe niż 256 KB.

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

Skrypt sprawdza zakup bez płatności z etapu I, więc na czas tego testu serwer potrzebuje `LEGACY_PURCHASE_WITHOUT_PAYMENT=true`. Testy w `tests/api.test.ts` i `tests/criteria.test.ts` ustawiają tę flagę same, a `tests/payments.test.ts` sprawdza etap II bez niej.

### Wdrożenie: warunek wstępny

- **Trwała baza jest obowiązkowa.** Baza w pamięci nadaje się tylko lokalnie; na Vercelu każda instancja funkcji miałaby własną bazę. Ustaw `MONGODB_URI` na MongoDB Atlas (darmowy klaster M0 to replica set i obsługuje transakcje).
- **Tryb testowy:** na czas testów ustaw `RESERVATION_TTL_SECONDS=120`. Skrypt chaosu ostrzega, gdy `expiresAt` wypada dalej niż za 2 minuty, a ustawiony czas widać też na `/status`.
- Na serverless worker nie działa w tle stale: mail wysyła się zaraz po zakupie (`after()`), a resztę zadań obsługuje `GET /api/cron/worker`. Kryteria od workera nie zależą.

## Struktura

```
src/app            strony i route handlers (API)
src/server         logika serwera: baza, rezerwacje, płatności (Stripe), kolejka, worker, bezpiecznik, limiter, bulkhead
src/components     UI: mapa sali, formularz, licznik, bilet, stan systemu
src/client         klient API odporny na błędy, hooki
src/lib            wspólne typy, geometria sali, formatowanie
tests              testy API (Vitest + MongoDB w pamięci)
```
