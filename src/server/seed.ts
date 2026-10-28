import type { Collection } from "mongodb";
import type { EventDoc } from "./db";

const HALL = { rows: 8, seatsPerRow: 10, aisleAfter: 5 };

// Godzina "ścienna" w Warszawie zamieniona na UTC, niezależnie od strefy serwera.
export function warsawDate(dayOffset: number, hour: number, minute: number): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const guess = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + dayOffset, hour, minute));
  // Różnica między UTC a Warszawą w tej konkretnej chwili (uwzględnia czas letni).
  const asWarsaw = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Warsaw" }));
  const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (asWarsaw.getTime() - asUtc.getTime()));
}

export function seedData(): EventDoc[] {
  return [
    {
      _id: "nocny-pociag",
      film: "Nocny pociąg",
      title: "Nocny pociąg",
      genre: "Thriller",
      durationMin: 112,
      ageRating: "16+",
      language: "PL",
      startsAt: warsawDate(1, 18, 15),
      hall: "Sala 1",
      layout: HALL,
      posterSeed: "kino-nocny-pociag",
      synopsis:
        "Ostatni kurs z Gdyni do Zakopanego. Konduktorka zauważa, że jeden z pasażerów nie ma odbicia w szybie.",
    },
    {
      _id: "szum-fal",
      film: "Szum fal",
      title: "Szum fal",
      genre: "Dramat",
      durationMin: 98,
      ageRating: "12+",
      language: "PL",
      startsAt: warsawDate(1, 20, 45),
      hall: "Sala 2",
      layout: HALL,
      posterSeed: "kino-szum-fal",
      synopsis:
        "Dwie siostry wracają na Hel, żeby sprzedać dom po babci. Morze ma w tej sprawie własne zdanie.",
    },
    {
      _id: "orbita-siedem",
      film: "Orbita siedem",
      title: "Orbita siedem",
      genre: "Sci-fi",
      durationMin: 127,
      ageRating: "12+",
      language: "EN, napisy PL",
      startsAt: warsawDate(2, 19, 30),
      hall: "Sala 1",
      layout: HALL,
      posterSeed: "kino-orbita-siedem",
      synopsis:
        "Załoga stacji badawczej odbiera sygnał nadany z Ziemi trzydzieści lat temu. Nadawcą jest jeden z nich.",
    },
  ];
}

// Seed idempotentny: upsert po _id. Daty seansów przesuwają się z każdym startem,
// żeby repertuar zawsze był aktualny.
export async function seedEvents(events: Collection<EventDoc>) {
  await events.bulkWrite(
    seedData().map(({ _id, ...doc }) => ({
      updateOne: { filter: { _id }, update: { $set: doc }, upsert: true },
    })),
  );
}
