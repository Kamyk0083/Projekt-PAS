#!/usr/bin/env node
// Samodzielny "test chaosu" według kryteriów etapu I, po HTTP na działający adres.
// Użycie: node scripts/chaos.mjs https://twoja-firma.vercel.app
// Serwer musi działać w trybie testowym (RESERVATION_TTL_SECONDS=120). Całość trwa ok. 5 minut.
// Uwaga: B5 udaje "inną sieć" nagłówkiem X-Forwarded-For. Na Vercelu ten nagłówek jest nadpisywany,
// więc tam drugi klient też trafi w limit: sprawdź go wtedy ręcznie z innej sieci (np. z telefonu).

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const results = [];
let runId = Date.now().toString(36);

async function call(method, path, body, ip) {
  const headers = { "content-type": "application/json" };
  if (ip) headers["x-forwarded-for"] = ip;
  try {
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
  } catch (err) {
    return { status: 0, json: null, error: String(err) };
  }
}

const person = (n) => ({ customerName: `Chaos ${runId} ${n}`, email: `chaos.${runId}.${n}@example.pl` });
const ok = (s) => s >= 200 && s < 300;
const is4xx = (s) => s >= 400 && s < 500;

function score(id, points, note) {
  results.push({ id, points, note });
  const mark = points === 1 ? "1 pkt  " : points === 0.5 ? "0,5 pkt" : "0 pkt  ";
  console.log(`${mark}  ${id}  ${note}`);
}

// Wolne miejsca z różnych seansów, żeby kolejne uruchomienia nie wchodziły sobie w drogę.
async function freeSeats(n) {
  const events = (await call("GET", "/api/events")).json;
  const out = [];
  for (const e of events) {
    const { takenSeats } = (await call("GET", `/api/events/${e.id}`)).json;
    for (const row of "ABCDEFGH".slice(0, e.layout.rows)) {
      for (let i = 1; i <= e.layout.seatsPerRow; i++) {
        const seatId = `${row}${i}`;
        if (!takenSeats.includes(seatId)) out.push({ eventId: e.id, seatId });
      }
    }
  }
  if (out.length < n) throw new Error("Za mało wolnych miejsc do testu.");
  return out.sort(() => Math.random() - 0.5).slice(0, n);
}

async function takenNow(eventId) {
  return (await call("GET", `/api/events/${eventId}`)).json?.takenSeats ?? [];
}

async function main() {
  console.log(`Test chaosu: ${BASE}\n`);
  const pre = await call("GET", "/api/events");
  if (!ok(pre.status) || !Array.isArray(pre.json)) throw new Error(`GET /api/events zwraca ${pre.status}`);

  const seats = await freeSeats(14);
  const [sB1a, sB1b, sB2, sC1, sA2, sB4, sC4late, sC4early, ...sC2] = seats;

  // ---- A1
  const a1 = await call("GET", "/api/events/nie-ma-takiego");
  score("A1", is4xx(a1.status) ? 1 : a1.status === 200 ? 0.5 : 0, `status ${a1.status}`);

  // ---- B3
  const bad = [
    { eventId: "nie-ma-takiego", seatId: "A1", ...person("b3") },
    { eventId: sB2.eventId, seatId: "Z99", ...person("b3") },
    { eventId: sB2.eventId, seatId: sB2.seatId, customerName: "", email: "x@example.pl" },
    { eventId: sB2.eventId, seatId: sB2.seatId, customerName: "Adam", email: "" },
  ];
  const b3 = await Promise.all(bad.map((b) => call("POST", "/api/reservations", b)));
  const leaked = (await takenNow(sB2.eventId)).includes(sB2.seatId);
  const b3s = b3.map((r) => r.status);
  score("B3", leaked ? 0 : b3s.every(is4xx) ? 1 : 0.5, `statusy ${b3s.join(", ")}${leaked ? ", ZAPISANO!" : ""}`);

  // ---- B1
  const bodyA = { ...sB1a, ...person("b1a") };
  const s1 = await call("POST", "/api/reservations", bodyA);
  const s2 = await call("POST", "/api/reservations", bodyA);
  const bodyB = { ...sB1b, ...person("b1b") };
  const [p1, p2] = await Promise.all([call("POST", "/api/reservations", bodyB), call("POST", "/api/reservations", bodyB)]);
  const sameSeq = ok(s1.status) && ok(s2.status) && s1.json.reservationId === s2.json.reservationId;
  const samePar = ok(p1.status) && ok(p2.status) && p1.json.reservationId === p2.json.reservationId;
  const anyServer = [s1, s2, p1, p2].some((r) => r.status >= 500 || r.status === 0);
  score(
    "B1",
    anyServer ? 0 : sameSeq && samePar ? 1 : 0.5,
    `po kolei ${s1.status}/${s2.status}, równolegle ${p1.status}/${p2.status}`,
  );

  // ---- B2
  const b2 = await Promise.all(
    Array.from({ length: 20 }, (_, i) => call("POST", "/api/reservations", { ...sB2, ...person(`b2-${i}`) })),
  );
  const b2ok = b2.filter((r) => ok(r.status)).length;
  const b2srv = b2.filter((r) => r.status >= 500 || r.status === 0).length;
  score("B2", b2ok === 1 && b2srv === 0 ? 1 : b2ok === 1 ? 0.5 : 0, `2xx: ${b2ok}, 5xx: ${b2srv}`);

  // ---- C1
  const c1r = await call("POST", "/api/reservations", { ...sC1, ...person("c1") });
  const id = c1r.json?.reservationId;
  const [c1a, c1b] = await Promise.all([call("POST", `/api/reservations/${id}/purchase`), call("POST", `/api/reservations/${id}/purchase`)]);
  const c1c = await call("POST", `/api/reservations/${id}/purchase`);
  const codes = [c1a, c1b, c1c].map((r) => r.json?.code);
  const c1srv = [c1a, c1b, c1c].some((r) => r.status >= 500);
  score(
    "C1",
    c1srv ? 0 : codes.every((c) => c && c === codes[0]) ? 1 : new Set(codes.filter(Boolean)).size === 1 ? 0.5 : 0,
    `kody ${codes.join(", ")}`,
  );

  // ---- C3
  const c3 = await Promise.all([
    call("POST", "/api/reservations/abc/purchase"),
    call("POST", "/api/reservations/00000000-0000-4000-8000-000000000000/purchase"),
  ]);
  const c3s = c3.map((r) => r.status);
  score("C3", c3s.every(is4xx) ? 1 : c3.some((r) => r.json?.code) ? 0 : 0.5, `statusy ${c3s.join(", ")}`);

  // ---- czasowe: A2, B4, C2 (5 rund), C4 z jednym wspólnym oczekiwaniem
  console.log("\nCzekam na wygaśnięcie rezerwacji (ok. 2 min)...");
  const resA2 = (await call("POST", "/api/reservations", { ...sA2, ...person("a2") })).json;
  const resB4 = (await call("POST", "/api/reservations", { ...sB4, ...person("b4x") })).json;
  const resLate = (await call("POST", "/api/reservations", { ...sC4late, ...person("c4late") })).json;
  const resEarly = (await call("POST", "/api/reservations", { ...sC4early, ...person("c4early") })).json;
  const earlyBuy = await call("POST", `/api/reservations/${resEarly.reservationId}/purchase`);
  const resC2 = [];
  for (const s of sC2) resC2.push({ seat: s, res: (await call("POST", "/api/reservations", { ...s, ...person("c2x") })).json });
  const ttl = Date.parse(resA2.expiresAt) - Date.now();
  if (ttl > 5 * 60_000) console.log(`UWAGA: expiresAt za ${Math.round(ttl / 1000)} s. Tryb testowy (2 min) nie jest włączony!`);

  // C2: w chwili wygaśnięcia zakup X i rezerwacja Y, równolegle
  const c2 = await Promise.all(
    resC2.map(async ({ seat, res }, i) => {
      await sleep(Date.parse(res.expiresAt) - Date.now() + (i % 3) * 5 - 5);
      const [x, y] = await Promise.all([
        call("POST", `/api/reservations/${res.reservationId}/purchase`),
        call("POST", "/api/reservations", { ...seat, ...person(`c2y-${i}`) }, `198.51.100.${10 + i}`),
      ]);
      return { x: x.status, y: y.status };
    }),
  );
  const twoOwners = c2.some((r) => ok(r.x) && ok(r.y));
  const c2srv = c2.some((r) => r.x >= 500 || r.y >= 500);
  score("C2", twoOwners ? 0 : c2srv ? 0.5 : 1, c2.map((r) => `X${r.x}/Y${r.y}`).join(" "));

  // A2: sam odczyt zaraz po expiresAt
  await sleep(Date.parse(resA2.expiresAt) - Date.now() + 1000);
  let goneAfter = null;
  for (let t = 1; t <= 125; t++) {
    if (!(await takenNow(sA2.eventId)).includes(sA2.seatId)) {
      goneAfter = (Date.now() - Date.parse(resA2.expiresAt)) / 1000;
      break;
    }
    await sleep(1000);
  }
  score("A2", goneAfter === null ? 0 : goneAfter <= 15 ? 1 : 0.5, goneAfter === null ? "nie znika" : `znika po ${goneAfter.toFixed(1)} s`);

  // B4: inna osoba rezerwuje to samo miejsce
  const b4 = await call("POST", "/api/reservations", { ...sB4, ...person("b4y") }, "198.51.100.99");
  const b4delay = (Date.now() - Date.parse(resB4.expiresAt)) / 1000;
  score("B4", ok(b4.status) ? (b4delay <= 15 ? 1 : 0.5) : 0, `status ${b4.status} po ${b4delay.toFixed(1)} s`);

  // C4: zakup po czasie + kupione miejsce zajęte także po kolejnych 2 min
  const late = await call("POST", `/api/reservations/${resLate.reservationId}/purchase`);
  console.log("Czekam kolejne 2 min (C4: czy kupione miejsce zostaje zajęte)...");
  await sleep(125_000);
  const stillTaken = (await takenNow(sC4early.eventId)).includes(sC4early.seatId);
  const c4 = !ok(earlyBuy.status) ? 0 : late.json?.code || !stillTaken ? 0 : is4xx(late.status) ? 1 : 0.5;
  score("C4", c4, `zakup po czasie ${late.status}, kupione miejsce ${stillTaken ? "zajęte" : "ZWOLNIONE"}`);

  // ---- B5 na końcu, bo opróżnia limit dla tego IP
  const spam = await freeSeats(101);
  const spamRes = [];
  let other;
  for (let i = 0; i < 100; i++) {
    spamRes.push(call("POST", "/api/reservations", { ...spam[i], ...person("b5") }, "192.0.2.10"));
    if (i === 60) other = call("POST", "/api/reservations", { ...spam[100], ...person("b5-inny") }, "203.0.113.77");
    await sleep(100);
  }
  const all = await Promise.all(spamRes);
  const limited = all.filter((r) => r.status === 429);
  const withHeader = limited.filter((r) => Number(r.retryAfter) > 0).length;
  const otherRes = await other;
  const b5srv = all.some((r) => r.status >= 500);
  const b5 =
    b5srv || limited.length === 0 ? 0 : withHeader === limited.length && ok(otherRes.status) ? 1 : 0.5;
  score("B5", b5, `429: ${limited.length}/100 (z Retry-After: ${withHeader}), drugi klient: ${otherRes.status}`);

  const sum = results.reduce((s, r) => s + r.points, 0);
  const chaos = Math.round(((3 * sum) / 11) * 2) / 2;
  console.log(`\nSuma: ${sum} / 11  ->  test chaosu: ${chaos} / 3`);
}

main().catch((err) => {
  console.error("Przerwano:", err.message);
  process.exit(1);
});
