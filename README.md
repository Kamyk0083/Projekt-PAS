# Kino Pasaż: kasa biletowa (Projekt PAS S01, etapy I–IV, wariant Kino)

Klient wybiera seans i wolny fotel, rezerwuje go (fotel jest trzymany przez 15 minut i dla innych wygląda na zajęty), może część ceny zapłacić punktami z konta lojalnościowego, resztę dopłaca kartą na stronie Stripe Checkout i po powrocie widzi bilet z kodem oraz podsumowaniem (ile kartą, ile punktami, ile punktów zebrał). To samo podsumowanie dostaje mailem. Jeśli przerwie płatność, wraca do sklepu i może zapłacić jeszcze raz, dopóki rezerwacja jest ważna. Jeśli nie zdąży, rezerwacja przepada, fotel wraca do puli, a punkty wracają na konto.

Od etapu IV wyprzedany seans ma listę oczekujących: klient zapisuje się e-mailem i widzi swoje miejsce w kolejce. Gdy czyjaś rezerwacja wygaśnie, fotel dostaje pierwsza osoba z kolejki (zwykła rezerwacja na 15 minut) i mail z linkiem do zapłaty. Gdy nie zapłaci albo mail do niej nie dojdzie, fotel przechodzi na następną osobę.

Stos: Next.js 16 (App Router, route handlers), MongoDB (transakcje, replica set), Stripe Checkout, Voucherify (punkty) i Resend (maile) — wszystkie trzy w trybie testowym, Motion, Phosphor Icons, Vitest.

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
npm test             # testy API: wyścigi, idempotencja, wygasanie, kolejka, DLQ, limit żądań, płatności, punkty
npm run build
```

### Płatności lokalnie

Klucze tylko w zmiennych środowiskowych serwera (`.env.local`, poza repozytorium): `STRIPE_SECRET_KEY=sk_test_…` i `STRIPE_WEBHOOK_SECRET=whsec_…`. Sekret webhooka podaje Stripe CLI:

```bash
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.expired --forward-to localhost:3000/api/webhooks/stripe
```

Karty testowe: `4242 4242 4242 4242` (udana), `4000 0000 0000 0002` (odmowa), `4000 0025 0000 3155` (3D Secure). Data ważności dowolna w przyszłości, CVC dowolne.

### Punkty i maile lokalnie (etap III)

Klucze tylko w zmiennych środowiskowych serwera (`.env.local`, poza repozytorium):

| Zmienna | Skąd | Po co |
| --- | --- | --- |
| `VOUCHERIFY_APP_ID`, `VOUCHERIFY_SECRET_KEY` | panel Voucherify, projekt **Sandbox**, Project settings > Application keys | konto punktowe klienta |
| `VOUCHERIFY_CAMPAIGN_ID` | kampania lojalnościowa w tym projekcie | karta lojalnościowa klienta (identyfikator klienta to e-mail) |
| `VOUCHERIFY_API_URL` | klaster konta (`api`, `eu1`, `as1`) | adres API |
| `RESEND_API_KEY` | panel Resend | wysyłka biletu |
| `MAIL_FROM` | `Kino Pasaż <onboarding@resend.dev>` | nadawca bez własnej domeny |

**Bez kluczy aplikacja działa**: punkty prowadzi wtedy dostawca symulowany (kolekcja `loyaltySim`), a maile dostawca z etapu I. Reguły, ekrany i testy są identyczne, więc demo i `npm test` nie potrzebują konta ani limitu Sandboxa. Wymuszenie trybu: `LOYALTY_PROVIDER=simulated`, `MAIL_PROVIDER=simulated`.

Adresy do testów Resend (bez własnej domeny tylko one i adres właściciela konta): `delivered@resend.dev` (doręczony) i `bounced@resend.dev` (odrzucony, odbiorca nie istnieje). Po znaku `+` można dopisać etykietę, więc każdy test ma innego klienta: `delivered+jan@resend.dev`.

**Sandbox Voucherify przyjmuje 100 wywołań na godzinę.** Serwer pilnuje tego sam: globalny budżet (domyślnie `VOUCHERIFY_BUDGET_PER_HOUR=80`) w tym samym token buckecie co limit żądań, saldo podpowiadane z krótkiego cache'a (`LOYALTY_CACHE_TTL_SECONDS`), operacje punktowe tylko w tle i nigdy w pętli odpytywania statusu. Zużycie budżetu widać na `/status`.

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

Zmiany w etapie III:

| Karta | Endpoint | Zwraca |
| --- | --- | --- |
| A | `GET /api/loyalty?email=…` (nowy) | `200 { email, points }`: saldo klienta. E-mail, który jeszcze nic nie kupił, dostaje kartę i **1000 punktów powitalnych**. `400` zły e-mail, `503 LOYALTY_UNAVAILABLE` gdy Voucherify nie odpowiada albo budżet wywołań jest wyczerpany |
| B | `POST /api/reservations/:id/checkout` | przyjmuje opcjonalnie `{ points }`. Sesja płatności jest na `amount` pomniejszone o punkty. Odmowy: `400 VALIDATION` (nie-liczba, nie-całkowite, ujemne, więcej niż połowa `amount`), `409 INSUFFICIENT_POINTS` (klient ma za mało), `409 CHECKOUT_IN_PROGRESS` (otwarta płatność na inną kwotę), `503 LOYALTY_UNAVAILABLE`. Bez `points` działa jak w etapie II |
| C | `GET /api/reservations/:id` | dodatkowo `pointsUsed`, `pointsEarned` (po opłaceniu), `pointsValue` i `cardAmount` do podsumowania oraz `loyalty: { balance, maxPoints }` (saldo z cache'a serwera, bez wywołania Voucherify) |
| B | `GET /api/reservations/:id/loyalty` (wewnętrzny) | `{ balance, maxPoints, spendable }`: świeże saldo dla koszyka, bez pokazywania e-maila w przeglądarce |

Zmiany w etapie IV:

| Karta | Endpoint | Zwraca |
| --- | --- | --- |
| A | `GET /api/events` | zawiera wydarzenie testowe `waitlist-test` z dokładnie dwoma miejscami (Sala kameralna, 1 × 2) |
| A | `GET /api/events/:id` | dodatkowo `soldOut`: `true`, gdy każde miejsce jest kupione albo ma ważną rezerwację (także ofertę z listy) |
| A | `POST /api/events/:id/waitlist` `{ email, customerName }` (nowy) | `201 { waitlistId, position }`, `position` od 1. Ten sam e-mail drugi raz: `200` i ten sam wpis. Odmowy: `409 NOT_SOLD_OUT` (są wolne miejsca), `400`, `404`, `409 EVENT_STARTED`, `409 WAITLIST_FULL`, `429` |
| A/B | `GET /api/waitlist/:id` (nowy) | `{ status, position, reservationId?, offerExpiresAt? }`, `status`: `waiting`, `offered`, `done`, `missed`, `left`. `position` od 1 dla czekających, `0` gdy osoba już nie czeka. Dodatkowo `seatId`, `missedReason` (`timeout` albo `undelivered`), `emailMasked`, `serverTime` |
| A | `DELETE /api/waitlist/:id` (nowy) | `200 { waitlistId, status: "left" }`, także z oferty (fotel od razu idzie dalej). Ponowienie zwraca to samo, `404` brak wpisu, `409 ALREADY_PURCHASED` po zakupie |
| C | `POST /api/webhooks/resend` (nowy) | `200 { received: true }`, `400` przy złym podpisie Svix albo starym znaczniku czasu |
| C | `GET /api/reservations/:id` | dodatkowo `fromWaitlist`; `emailStatus` `failed`, gdy Resend zgłosi odbity mail z biletem |

Miejsce dla osoby z listy to zwykła rezerwacja z etapu I (`reservationId`, `expiresAt`, `amount`), więc płaci się za nią tak samo, także punktami. `offerExpiresAt` to `expiresAt` tej rezerwacji.

Błędy mają postać `{ error, errorCode, retryable }` (celowo nie `code`, bo `code` to kod biletu): `400 VALIDATION`, `404 NOT_FOUND`, `409 SEAT_TAKEN`, `410 RESERVATION_EXPIRED`, `422 IDEMPOTENCY_MISMATCH`, `429 RATE_LIMITED` i `503 OVERLOADED / DEPENDENCY_UNAVAILABLE` (oba z `Retry-After`).

`seatId` ma format `"F7"` (rząd A–H, miejsce 1–10). Dane przykładowe: 3 seanse w 2 salach po 8×10 foteli.

## Jak liczymy punkty (etap III)

Wszystkie reguły są w jednej, czystej funkcji (`src/lib/loyalty.ts`), używanej i przez serwer, i przez przeglądarkę, więc przycisk „Zapłać 22 zł” i kwota sesji Stripe'a nie mogą się rozjechać.

| Reguła | Wartość |
| --- | --- |
| kurs | 1 punkt = 1 grosz (100 punktów = 1 zł) |
| punkty na start | 1000 (10 zł) dla e-maila, który nie ma jeszcze karty |
| najwięcej punktami | `floor(amount / 2)`, czyli połowa ceny biletu |
| do dopłaty kartą | `amount − points` |
| punkty za zakup | `floor(cardAmount / 100) × 10`: tylko od części zapłaconej kartą i tylko od pełnych złotych |

Nowy klient wydający wszystko na bilet za 32 zł (wariant Kino): limit 1600 pkt, płaci 1000 pkt (10 zł), dopłaca 22 zł kartą i zbiera 220 pkt. Cena nie jest nigdzie zaszyta: tańszy poranek za 26 zł ma limit 1300 pkt. Reguła „do połowy ceny” gwarantuje przy okazji, że kwota karty nigdy nie zejdzie pod minimum Stripe'a (dla Kina to co najmniej 16 zł).

Kolejność operacji przy zakupie jest ważna: **punkty schodzą z karty przed utworzeniem sesji płatności.** Saldo w Voucherify jest wspólne z aplikacją marketingu i kasami, więc odejmowanie ich po zapłacie oznaczałoby rabat na kredyt. Zakup jest więc sagą z kompensacją, a nie jedną transakcją — opisują ją karty zagrożeń niżej.

## Kontrakt wewnętrzny

**Strony i przepływ między kartami**

| Adres | Karta | Co robi |
| --- | --- | --- |
| `/` | A | repertuar: film, data, godzina, sala, miniatura zajętości sali |
| `/seanse/:eventId?fotel=F7` | A → B | mapa sali (ekran na górze, rzędy A–H). Kliknięcie wolnego fotela otwiera formularz „Rząd F, miejsce 7” |
| `/rezerwacja/:reservationId` | B → C | licznik „Trzymamy Twój fotel jeszcze 14:32”, pole „Użyj punktów” z maksimum i suwakiem, cena zmieniająca się od razu i przycisk z kwotą do dopłaty („Zapłać 22 zł”), potem bilet z kodem i podsumowaniem albo komunikat „Rezerwacja wygasła, fotel wrócił do puli” |
| `/rezerwacja/:reservationId?platnosc=ok` | etap II, C | `success_url`: „Płatność w toku…”, odpytuje `GET /api/reservations/:id` co 1,5 s i sama zamienia się w bilet |
| `/rezerwacja/:reservationId?platnosc=przerwana` | etap II, C | `cancel_url`: licznik dalej biegnie, komunikat o przerwanej płatności i „Zapłać 32 zł jeszcze raz” |
| `/status` | dodatkowa | stan bezpieczników (Stripe, poczta, punkty), budżet wywołań Voucherify, kolejka, DLQ i pule zapytań |

Etap III dokłada do tego:

| Adres | Karta | Co robi |
| --- | --- | --- |
| `/seanse/:eventId` (formularz) | A | po wpisaniu e-maila pokazuje saldo punktów i ile z nich wejdzie w ten bilet (`GET /api/loyalty`) |
| `/rezerwacja/:reservationId` | B | „Użyj punktów”: maksimum to mniejsze z połowy ceny i salda; świeże saldo z `GET /api/reservations/:id/loyalty`, a odmowy (`INSUFFICIENT_POINTS`, `LOYALTY_UNAVAILABLE`) zmieniają pole, nie blokują zakupu |
| `/rezerwacja/:reservationId` (bilet) | C | pod biletem rachunek: cena, zapłacono kartą, zapłacono punktami, punkty za ten zakup — to samo, co w mailu |

**Gdzie zapisujemy użyte i zebrane punkty** (decyzja z kontraktu wewnętrznego): użyte punkty są przypisane do **próby płatności** (`reservations.checkouts[n].points` wraz z `cardAmount` i `pointsState`), a nie do rezerwacji. Dopiero opłacenie przepisuje je na `reservations.pointsUsed` i dolicza `reservations.pointsEarned`. Dzięki temu spóźniony webhook ze starej sesji jest sprawdzany względem kwoty **swojej** próby, a nie aktualnego stanu koszyka, i nie da się wydać biletu po kwocie z poprzedniego rabatu. Saldo klienta trzyma wyłącznie Voucherify.

Między ekranami przekazujemy tylko identyfikatory w adresie (`eventId`, `seatId` w `?fotel=`, `reservationId`). Ekran rezerwacji pobiera resztę z `GET /api/reservations/:id` (`ReservationView` w `src/lib/types.ts`), w tym `serverTime`, żeby licznik nie zależał od zegara klienta.

**Etap IV: lista oczekujących**

| Adres | Karta | Co robi |
| --- | --- | --- |
| `/` | A | wyprzedany seans nie jest wyszarzony, tylko prowadzi do listy („Brak miejsc · lista oczekujących”) |
| `/seanse/:eventId` | A | na wyprzedanym seansie zamiast „Wybierz fotel” karta „Powiadom mnie” → formularz (imię, e-mail) → „Twoje miejsce w kolejce: 2” i „Wypisz mnie”. Odpytuje `GET /api/waitlist/:id` co 4 s |
| `/seanse/:eventId?kolejka=<waitlistId>` | A | link do własnego miejsca w kolejce (też w `localStorage`, więc powrót na stronę pokazuje stan) |
| `/seanse/:eventId?kolejka=…` (oferta) | B | „Zwolniło się miejsce dla Ciebie: Rząd A, miejsce 2”, licznik do `offerExpiresAt` i „Zapłać 32 zł” → `/rezerwacja/:reservationId` |
| `/rezerwacja/:reservationId` | B → C | ten sam ekran płatności co w etapach II–III, z notką „miejsce z listy oczekujących” |

Kontrakt wewnętrzny między kartami (ustalony przez lidera):

- **B → C: „ktoś dostał miejsce”.** Karta B w jednej transakcji zmienia wpis `waiting → offered`, zajmuje fotel, zakłada rezerwację i wstawia zadanie `waitlist-offer:<reservationId>` z `{ reservationId, waitlistId }` do kolejki `jobs` (transactional outbox). Oferta bez zadania maila nie może powstać. Karta C obsługuje zadanie w workerze (`src/server/waitlistMail.ts`).
- **C → B: „mail nie doszedł”.** Karta C woła `offerUndelivered(reservationId)` z `src/server/waitlist.ts`: przy trwałej odmowie wysyłki (`MailRejectedError`) i przy zdarzeniach `email.bounced` / `email.failed` z webhooka Resenda. Karta B zamyka wtedy tylko bieżącą, nieopłaconą ofertę tej rezerwacji (`missed`, `missedReason: "undelivered"`), zwalnia fotel od razu i proponuje go następnej osobie.
- **Termin w mailu.** Karta C ustala go raz, przy pierwszej próbie wysyłki (`waitlist.mailDeadline`), i wtedy przedłuża ofertę do pełnych 15 minut od tej chwili. Ponowienie zadania wysyła identyczną treść.
- **Mail do oferty.** Resend dostaje tagi `kind=waitlist_offer`, `reservation=<id>`, `waitlist=<id>`: same identyfikatory, po których webhook wskazuje ofertę.

Kiedy kolejka się przesuwa. Fotel zwalnia się po cichu (`expiresAt` mija), a Vercel Cron na darmowym planie budzi nas najwyżej raz dziennie. Dlatego kolejka nie czeka na crona, tylko „dogania” stan (`advanceWaitlist`) przy każdym żądaniu dotyczącym seansu: `GET /api/events/:id` (mapę odpytuje każdy oglądający), `POST /api/reservations`, `POST /api/events/:id/waitlist`, `GET /api/waitlist/:id` (odpytuje go strona osoby z listy), `DELETE`, webhook Resenda. Do tego worker w procesie serwera (lokalnie co 3 s) i dzienny cron z `vercel.json` jako siatka bezpieczeństwa. Mail z nowej oferty wychodzi zaraz po odpowiedzi (`after()`), a odpytywanie zleca przebieg workera najwyżej raz na kilka sekund w instancji.

**Model danych (MongoDB)**

| Kolekcja | Klucz | Rola |
| --- | --- | --- |
| `events` | `_id` = eventId | seanse z układem sali |
| `seats` | `_id` = `${eventId}\|${seatId}` | blokada fotela: `held` (z `expiresAt`) albo `sold` |
| `reservations` | `_id` = UUID, unikalny `idempotencyKey` | dane klienta, status `held / paid / expired`, `amount`, kod biletu; `checkouts[]` (próby płatności: numer, punkty, kwota karty, stan punktów, ID i adres sesji Stripe), `payment` (sesja, PaymentIntent, kwota), `pointsUsed` i `pointsEarned` po opłaceniu, `refund` |
| `stripeEvents` | `_id` = ID zdarzenia Stripe | obsłużone webhooki (deduplikacja i ślad), TTL 30 dni |
| `jobs` | `_id` = `<temat>:${reservationId}[:próba]` | kolejka zadań (outbox): `ticket-email`, `loyalty-earn`, `loyalty-release` |
| `loyaltyAccounts` | `_id` = e-mail klienta | ID karty w Voucherify, ślad punktów powitalnych i **cache** salda (nie źródło prawdy) |
| `loyaltySim` | `_id` = ID karty | dostawca punktów symulowany: tylko gdy nie ma kluczy Voucherify |
| `deadLetters` | `_id` = ID zadania | zadania, które przekroczyły limit prób |
| `mails` | `_id` = klucz idempotencji (= ID zadania) | ślad wysłanych maili (nasz lokalny outbox, u Resendu `Idempotency-Key`) |
| `rateBuckets` | `_id` = `scope:ip` | wiadra token bucket z TTL |
| `waitlist` | `_id` = UUID (`waitlistId`) | etap IV: wpis na liście: seans, e-mail, imię, `seq` (kolejność), `status`, `active` (unikalny indeks `eventId + email` tylko dla aktywnych), bieżąca oferta (`reservationId`, `seatId`, `mailDeadline`, `notifiedAt`, `deliveredAt`, `undeliveredAt`), `missedReason` |
| `counters` | `_id` = `waitlist:<eventId>` | licznik kolejności na liście seansu (w transakcji z zapisem) |
| `resendEvents` | `_id` = `svix-id` | obsłużone webhooki Resenda (deduplikacja), TTL 30 dni |

Etap IV dokłada też `reservations.waitlistId` (rezerwacja z oferty), `mails.providerId`, `mails.deliveredAt`, `mails.bouncedAt` i zadanie `waitlist-offer` w `jobs`.

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

**Etap III: Voucherify i Resend jako zależności zewnętrzne**

Nowe zagrożenia dotyczą tego, że punkty są pieniądzem, a saldo jest poza nami.

- *Punkty zdjęte, a płatność nigdy nie przyszła.* Punkty muszą zejść przed utworzeniem sesji (saldo jest wspólne z kasami, więc inaczej dalibyśmy rabat na kredyt). Zakup jest więc sagą, a każda nieudana ścieżka ma kompensację: zwrot punktów zleca `checkout.session.expired`, zmiana liczby punktów przez klienta, zwrot pieniędzy po czasie i siatka bezpieczeństwa `releaseAbandonedPoints` (gdy webhook nie dojdzie). Punkty zwalniamy **dopiero po wygaśnięciu samej sesji Stripe'a**, bo do tego momentu płatność wciąż może przyjść.
- *Stripe pada już po zdjęciu punktów.* Próba zostaje żywa z zarezerwowanymi punktami, więc kolejne „Zapłać” używa jej ponownie (ten sam klucz idempotencji, żadnego drugiego odjęcia) zamiast zakładać nową. Gdy klient zrezygnuje, punkty wrócą po wygaśnięciu sesji.
- *Ten sam rabat zdjęty dwa razy (podwójny klik, równoległe żądania).* Numer próby zajmujemy atomowo (compare-and-swap na liście prób), a przegrane żądanie nie zdejmuje punktów: czeka na wynik zwycięzcy i dostaje tę samą sesję Stripe'a. Test: 5 równoległych żądań, jedno odjęcie z karty.
- *Kolejka dostarcza „co najmniej raz”, więc naliczenie może pójść dwa razy.* Każda operacja na punktach ma marker (`kino:earn:<id>`, `kino:spend:<id>:<próba>`, `kino:release:<id>:<próba>`, `kino:welcome:<email>`) zapisywany w `reason` w Voucherify. Przed ponowieniem zadania sprawdzamy historię karty i pomijamy operację, która już tam jest. Pierwsza próba nie pyta o historię, żeby nie marnować limitu.
- *Nie wiadomo, czy odjęcie przeszło (timeout w pół drogi).* Próba zostaje w stanie `pending`, a zadanie kompensacyjne sprawdza marker: punkty wracają tylko wtedy, gdy naprawdę zeszły. Gdy historii nie da się odczytać, zadanie **nie zgaduje** — idzie do DLQ z komunikatem do sprawdzenia w panelu. Lepiej jeden przypadek do ręcznej decyzji niż ciche podwojenie salda.
- *Punkty powitalne naliczone dwa razy.* Założenie konta jest zabezpieczone warunkowym zapisem w naszej bazie (duplikat klucza = ktoś inny już to robi), a przerwane zakładanie dokończy się po sprawdzeniu historii karty. Test: 5 równoległych pierwszych wejść daje dokładnie 1000 punktów.
- *Klient podmienia `points` w przeglądarce.* Liczbę punktów waliduje serwer (całkowita, nieujemna, najwyżej połowa `amount` z bazy), a saldo rozstrzyga Voucherify. Kwota sesji liczona jest wyłącznie na serwerze, z ceny zapisanej w rezerwacji.
- *Zapłacona kwota nie zgadza się z rabatem.* Webhook porównuje `amount_total` z `cardAmount` **tej konkretnej próby** (nie z aktualnym stanem rezerwacji) i walutę z `pln`. Niezgodność nie wydaje biletu.
- *Marketing zmienia saldo w tej samej chwili.* Źródłem prawdy jest Voucherify, nasze saldo to cache z krótkim TTL, odświeżany przy każdej naszej operacji. Decyzji o wydaniu punktów nigdy nie podejmujemy na podstawie starego cache'a: przy wątpliwości czytamy saldo na nowo, a samo odjęcie jest warunkowe po stronie Voucherify (nie da się zejść poniżej zera) i wraca do klienta jako `409`, nie `500`.
- *Sandbox przyjmuje 100 wywołań na godzinę.* Globalny budżet w token buckecie (80/h, wspólny dla instancji) odmawia, zanim żądanie wyjdzie, i daje `503` z `Retry-After`. Endpoint odpytywany w pętli (`GET /api/reservations/:id`) nie dotyka Voucherify wcale: saldo bierze z cache'a. Saldo w formularzu pytamy raz na adres, po opuszczeniu pola.
- *Voucherify nie odpowiada.* Timeout 6 s, bezpiecznik `loyalty` (po serii awarii od razu `503 LOYALTY_UNAVAILABLE`), a interfejs degraduje się łagodnie: pole punktów zamienia się w komunikat, zakup za pełną cenę kartą działa dalej i punkty za niego naliczymy w tle. Awaria punktów nigdy nie blokuje sprzedaży biletu.
- *Resend nie odpowiada albo odrzuca adres.* Wysyłka idzie przez tę samą kolejkę co w etapie I: timeout, bezpiecznik `mailer`, retry z backoffem i DLQ. Odmowa trwała (brak własnej domeny, adres poza listą testową, `bounced@resend.dev`) nie jest awarią zależności: nie liczy się do bezpiecznika i nie jest ponawiana, więc jeden zły adres nie blokuje wysyłki pozostałym. Bilet i kod są gotowe od razu i nie zależą od maila, a strona biletu mówi prawdę o jego stanie (`emailStatus`).
- *Mail wysłany dwa razy.* Klucz idempotencji = ID zadania, honorowany i przez Resend (24 h), i przez nasz lokalny outbox `mails`.
- *Awaria jednej usługi blokuje drugą.* Worker pobiera zadania tylko dla tych zależności, których bezpiecznik przepuszcza, więc leżące Voucherify nie wstrzymuje maili, a leżący Resend nie wstrzymuje punktów.
- *Wyciek kluczy.* `VOUCHERIFY_*` i `RESEND_API_KEY` tylko w env serwera, poza repo (`.gitignore` na `.env*`), kod obu usług wyłącznie w `src/server`. Bez kluczy wchodzą dostawcy symulowani, więc nikt nie musi wklejać sekretów, żeby uruchomić projekt.
- *Dane osobowe u zewnętrznych dostawców.* Do Voucherify idzie tylko e-mail (jako identyfikator karty), do Resendu e-mail i treść biletu. Nic więcej: ani imię w logach, ani ID rezerwacji na `/status` (jest jak link do biletu). W interfejsie e-mail jest maskowany, a w komunikatach DLQ identyfikatory wycinamy.

**Etap IV: lista oczekujących i Resend jako zależność zewnętrzna**

- *Wyprzedane, a na sali puste miejsca.* Rezerwacja wygasa bez żadnego zdarzenia, więc nikt się o tym nie dowiadywał. Teraz każde żądanie dotyczące seansu najpierw zamyka skończone oferty i oddaje wolne fotele kolejnym osobom z listy. Poprawność nie zależy od tego, kiedy to się stanie: wygasła blokada jest wolna od razu, a pierwsze żądanie po wygaśnięciu daje fotel kolejce.
- *Vercel Cron raz dziennie.* Nie opieramy na nim niczego: kolejkę przesuwają żądania (mapa sali, strona osoby z listy, webhook), mail wychodzi przez `after()` zaraz po ofercie. Cron w `vercel.json` (raz dziennie) to tylko siatka bezpieczeństwa.
- *Przypadkowy klient zgarnia zwolniony fotel przed kolejką.* `POST /api/reservations` przesuwa kolejkę przed rezerwacją, więc wolny fotel jest już ofertą dla pierwszej osoby z listy i obcy dostaje `409 SEAT_TAKEN`. Test: rezerwacja zwolnionego fotela przez kogoś spoza listy.
- *Dwie instancje (albo dwa odpytania) rozdają ten sam fotel.* Oferta to jedna transakcja: warunkowa zmiana wpisu `waiting → offered` i warunkowy upsert fotela jak w etapie I. Przegrany wyścig dostaje konflikt i bierze następny wpis albo fotel. W jednej instancji przebiegi dla seansu są współdzielone. Test: 10 równoległych przebiegów bez współdzielenia daje jedną ofertę, zgodnie z kolejnością.
- *Kolejność i miejsce w kolejce.* Numer z licznika w tej samej transakcji co zapis, więc dwa jednoczesne zapisy nie dostaną tego samego numeru, a zwrócone `position` jest dokładne. Test: 8 równoległych zapisów dostaje 1–8.
- *Podwójny klik „Zapisz mnie”, retry.* Unikalny indeks na aktywny wpis `(eventId, email)`: ponowienie zwraca ten sam `waitlistId` (`200`, `Idempotent-Replayed`). Po wypisaniu albo przegapieniu można zapisać się znowu, na koniec kolejki.
- *Zalew zapisów (fałszywe adresy, które blokują kolejkę).* Limit żądań na IP (`429`), limit aktywnych wpisów na seans (`WAITLIST_MAX_PER_EVENT`, `409 WAITLIST_FULL`). Adres, który nie istnieje, odbija się i od razu oddaje fotel dalej, zamiast trzymać go 15 minut.
- *Osoba z listy nie płaci.* Oferta to zwykła rezerwacja z tym samym czasem. Po jej wygaśnięciu wpis przechodzi w `missed` (`timeout`), a fotel dostaje następna osoba.
- *Mail nie dochodzi.* Trwała odmowa przy wysyłce (zły adres, adres spoza listy testowej Resenda) i zdarzenie `email.bounced` z webhooka zamykają ofertę od razu (`missed`, `undelivered`) i dają fotel następnej osobie. Spóźniony bounce po zapłacie nie odbiera biletu, bo zamykamy tylko bieżącą, nieopłaconą ofertę tej rezerwacji.
- *Podrobiony webhook Resenda („mail odbity”), żeby komuś odebrać miejsce.* Podpis Svix: HMAC-SHA256 z sekretu `RESEND_WEBHOOK_SECRET` po `svix-id.svix-timestamp.surowe ciało`, porównanie w stałym czasie, znacznik czasu najwyżej 5 minut od teraz (powtórzenie starego żądania). Bez tego `400` i żadnej zmiany. Ciało ponad 256 KB odrzucamy.
- *Svix ponawia webhook albo przysyła go dwa razy, zdarzenia w dowolnej kolejności.* Rejestr `resendEvents` po `svix-id` i warunki na stan oferty: powtórka nic nie zmienia. Mail obcy (inny projekt na tym samym koncie) jest ignorowany z `200`.
- *Resend leży albo odpowiada `429` (limit wywołań na sekundę).* Ta sama kolejka co w etapie III: timeout, bezpiecznik `mailer`, retry z backoffem, DLQ. Gdy mail z ofertą nie zdążył wyjść z naszej winy, a czas oferty minął, osoba nie traci miejsca w kolejce: wraca na swoje miejsce i dostaje ofertę jeszcze raz. Inaczej awaria dostawcy „spaliłaby” po kolei całą kolejkę.
- *Mail dochodzi z opóźnieniem i daje „masz jeszcze 40 sekund”.* Termin w mailu ustalamy przy pierwszej próbie wysyłki i wtedy przedłużamy ofertę do pełnych 15 minut od maila (rezerwacja i fotel w jednej transakcji). Ekran płatności przed ogłoszeniem „wygasła” pyta serwer, czy termin się nie przesunął.
- *Mail z ofertą wysłany dwa razy.* Klucz idempotencji = ID zadania, honorowany przez Resend i przez nasz outbox `mails` (sprawdzany przed wysyłką). Treść ponowienia jest identyczna, bo termin jest zapisany.
- *Wypisanie w trakcie oferty.* `DELETE` w każdej chwili. Z oferty: rezerwacja `expired`, fotel wraca od razu i idzie do następnej osoby. Gdy płatność za tę ofertę przyjdzie po czasie, działa etap II: fotel wolny to sprzedaż, zajęty to zwrot pieniędzy i punktów.
- *Płatność punktami za miejsce z listy.* Oferta jest zwykłą rezerwacją, więc działa cała saga z etapu III. Opłacenie w tej samej transakcji zmienia wpis na `done`.
- *Seans się zaczął.* Po rozpoczęciu nie rozdajemy ofert i nie przyjmujemy zapisów (`409 EVENT_STARTED`).
- *Dane osobowe.* `waitlistId` działa jak link (UUID): kto go zna, widzi stan i może się wypisać, ale nie zobaczy adresu (maskowany). Do Resenda idzie e-mail, imię i treść oferty, w tagach tylko identyfikatory. `/status` pokazuje same liczby.

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

Skrypt sprawdza zakup bez płatności z etapu I, więc na czas tego testu serwer potrzebuje `LEGACY_PURCHASE_WITHOUT_PAYMENT=true`. Testy w `tests/api.test.ts` i `tests/criteria.test.ts` ustawiają tę flagę same, a `tests/payments.test.ts` i `tests/loyalty.test.ts` sprawdzają etapy II i III bez niej.

## Etap III: co sprawdzają testy

`tests/loyalty.test.ts` (24 przypadki). Voucherify i Stripe są atrapami, ale cała nasza logika jest prawdziwa.

| Obszar | Co jest sprawdzone |
| --- | --- |
| konto punktowe | nowy e-mail dostaje 1000 pkt i tylko raz, także przy 5 równoległych pierwszych wejściach; klient z kartą założoną wcześniej zachowuje swoje saldo; zły e-mail to `400`; zmiana salda poza nami jest widoczna po wygaśnięciu cache'a |
| płatność punktami | 1000 pkt na bilecie za 32 zł daje sesję na 22 zł i zdejmuje punkty z karty; dokładnie połowa ceny przechodzi; więcej niż połowa, więcej niż saldo, ułamek, liczba ujemna i `"1000"` to odmowy 4xx, które nie ruszają salda; 5 równoległych kliknięć zdejmuje punkty raz; zmiana liczby punktów wygasza starą sesję i oddaje punkty; brak `points` działa jak etap II |
| rozliczenie i mail | `pointsUsed` 1000 i `pointsEarned` 220 dla biletu za 32 zł; zakup bez punktów daje 320; worker dopisuje punkty na karcie, a ponowienie zadania ich nie dubluje; mail zawiera kod i podsumowanie (22 zł kartą, 1000 pkt, +220 pkt); adres odrzucony na stałe trafia do DLQ, a bilet zostaje dostępny |
| punkty nie przepadają | wygaśnięcie sesji zwraca punkty; porzucona płatność jest sprzątana po wygaśnięciu sesji; powtórka webhooka nie nalicza drugi raz; kwota niezgodna z rabatem tej próby nie wydaje biletu; zwrot pieniędzy po czasie zwraca też punkty |
| awaria Voucherify | `503` na saldzie i na płatności punktami, zakup za pełną cenę kartą działa dalej; niepewne odjęcie (timeout) kończy się kompensacją po sprawdzeniu markera, a bez śladu w historii nie zwracamy nic |

## Etap IV: co sprawdzają testy

`tests/waitlist.test.ts` (21 przypadków). Stripe i Voucherify są atrapami, poczta symulowana, a webhook Resenda podpisujemy prawdziwym algorytmem Svix. Upływ 2 minut symulujemy, przesuwając `expiresAt` w bazie.

| Obszar | Co jest sprawdzone |
| --- | --- |
| A. zapis | `waitlist-test` ma 2 miejsca; `soldOut` false/true; odmowy 4xx (niewyprzedany, zły e-mail, brak imienia, brak seansu) bez zapisu w bazie; pozycje od 1, ten sam e-mail to ten sam wpis; 8 równoległych zapisów to pozycje 1–8; wypisanie, przesunięcie kolejki, powtórny DELETE, ponowny zapis na koniec |
| B. oferta | po wygaśnięciu rezerwacji pierwsza osoba ma zwykłą rezerwację na 2 minuty, druga czeka; obcy nie przejmie fotela; 10 równoległych przebiegów daje jedną ofertę; brak zapłaty to `missed` i fotel dla następnej osoby; płatność punktami za ofertę (sesja na 22 zł, `done`, bilet); wypisanie z oferty oddaje fotel od razu; oferta bez wysłanego maila wraca do tej samej osoby |
| C. mail i webhook | mail ma nazwę wydarzenia, miejsce, link do zapłaty i godzinę; spóźniony mail daje pełne 2 minuty od wysyłki; adres odrzucony przy wysyłce to `undelivered` i mail do następnej osoby; podpisany `email.bounced` (z tagami i bez) zamyka ofertę, powtórka nic nie zmienia; podróbka, stary znacznik czasu i brak podpisu to `400`; bounce po zapłacie nie odbiera biletu; `email.delivered` zapisuje doręczenie |

Ten sam scenariusz po HTTP na działającym serwerze (krótki TTL, worker w procesie): zapis, wygaśnięcie, oferty, odbicie przy wysyłce, wypisanie, podpisany i podrobiony webhook, brak zapłaty.

### Wdrożenie: warunek wstępny

- **Trwała baza jest obowiązkowa.** Baza w pamięci nadaje się tylko lokalnie; na Vercelu każda instancja funkcji miałaby własną bazę. Ustaw `MONGODB_URI` na MongoDB Atlas (darmowy klaster M0 to replica set i obsługuje transakcje).
- **Tryb testowy:** na czas testów ustaw `RESERVATION_TTL_SECONDS=120`. Skrypt chaosu ostrzega, gdy `expiresAt` wypada dalej niż za 2 minuty, a ustawiony czas widać też na `/status`.
- **Etap IV:** w panelu Resend > Webhooks dodaj endpoint `https://<adres>/api/webhooks/resend` (zdarzenia `email.bounced`, `email.delivered`, opcjonalnie `email.failed`), a jego sekret `whsec_…` wpisz w `RESEND_WEBHOOK_SECRET`. Stan widać na `/status`. `vercel.json` ma cron raz dziennie (tyle pozwala darmowy plan); kolejka od niego nie zależy.
- Na serverless worker nie działa w tle stale: mail wysyła się zaraz po zakupie (`after()`), a resztę zadań obsługuje `GET /api/cron/worker`. Kryteria od workera nie zależą.
- **Etap III:** `VOUCHERIFY_*`, `RESEND_API_KEY` i `MAIL_FROM` ustaw w Vercel > Settings > Environment Variables (nigdy w repo). Bez nich wdrożenie wstaje, ale punkty i maile są symulowane i widać to na `/status`. Zwroty punktów i naliczenia są zadaniami w kolejce, więc na serverless warto mieć crona na `GET /api/cron/worker`: bez niego kompensacje poczekają do następnego żądania, które obudzi workera.

## Struktura

```
src/app            strony i route handlers (API)
src/server         logika serwera: baza, rezerwacje, płatności (Stripe), punkty (Voucherify), poczta (Resend),
                   lista oczekujących (waitlist.ts, waitlistMail.ts, resendWebhook.ts),
                   kolejka, worker, bezpiecznik, limiter, bulkhead
src/components     UI: mapa sali, formularz, licznik, bilet, stan systemu
src/client         klient API odporny na błędy, hooki
src/lib            wspólne typy, geometria sali, formatowanie, reguły punktów
tests              testy API (Vitest + MongoDB w pamięci; Stripe, Voucherify i Resend jako atrapy)
```
