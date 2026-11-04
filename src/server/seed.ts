import type { Collection } from "mongodb";
import type { EventDoc } from "./db";

const HALL = { rows: 8, seatsPerRow: 10, aisleAfter: 5 };
// Wariant Kino: jedna cena za fotel na seans, w groszach.
const PRICE = 3200;

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

type Film = Omit<EventDoc, "_id" | "title" | "startsAt" | "hall" | "layout" | "price"> & { price?: number };

const FILMS = {
  "nocny-pociag": {
    film: "Nocny pociąg",
    genre: "Thriller",
    durationMin: 112,
    ageRating: "16+",
    language: "PL",
    posterSeed: "kino-nocny-pociag",
    synopsis:
      "Ostatni kurs z Gdyni do Zakopanego. Konduktorka zauważa, że jeden z pasażerów nie ma odbicia w szybie.",
  },
  "szum-fal": {
    film: "Szum fal",
    genre: "Dramat",
    durationMin: 98,
    ageRating: "12+",
    language: "PL",
    posterSeed: "kino-szum-fal",
    synopsis:
      "Dwie siostry wracają na Hel, żeby sprzedać dom po babci. Morze ma w tej sprawie własne zdanie.",
  },
  "orbita-siedem": {
    film: "Orbita siedem",
    genre: "Sci-fi",
    durationMin: 127,
    ageRating: "12+",
    language: "EN, napisy PL",
    posterSeed: "kino-orbita-siedem",
    synopsis:
      "Załoga stacji badawczej odbiera sygnał nadany z Ziemi trzydzieści lat temu. Nadawcą jest jeden z nich.",
  },
  "cien-nad-wisla": {
    film: "Cień nad Wisłą",
    genre: "Kryminał",
    durationMin: 118,
    ageRating: "16+",
    language: "PL",
    posterSeed: "kino-cien-nad-wisla",
    synopsis:
      "Warszawa, mroźny styczeń. Emerytowana komisarz dostaje pocztówkę od człowieka, którego sama pochowała.",
  },
  "ostatnie-lato": {
    film: "Ostatnie lato w Sopocie",
    genre: "Romans",
    durationMin: 109,
    ageRating: "12+",
    language: "PL",
    posterSeed: "kino-ostatnie-lato",
    synopsis:
      "Ratownik z molo i studentka architektury mają trzy tygodnie, zanim każde wróci do swojego życia.",
  },
  "tryb-offline": {
    film: "Tryb offline",
    genre: "Komedia",
    durationMin: 104,
    ageRating: "12+",
    language: "PL",
    posterSeed: "kino-tryb-offline",
    synopsis:
      "Influencerka zakłada się, że wytrzyma miesiąc bez telefonu na mazurskiej wsi. Wieś nie ma zasięgu ani litości.",
  },
  "maly-wielki-smok": {
    film: "Mały wielki smok",
    genre: "Animacja",
    durationMin: 85,
    ageRating: "b.o.",
    language: "Dubbing PL",
    posterSeed: "kino-maly-wielki-smok",
    price: 2600,
    synopsis:
      "Smok Wawelski junior nie umie zionąć ogniem, za to świetnie piecze obwarzanki. Kraków właśnie potrzebuje bohatera.",
  },
} satisfies Record<string, Film>;

type FilmId = keyof typeof FILMS;

// [film, dzień (1 = jutro), sala, godzina, minuta, opcjonalne stałe _id]
// Trzy pierwotne seanse zachowują swoje identyfikatory (używają ich testy i istniejące rezerwacje).
const SCHEDULE: [FilmId, number, 1 | 2, number, number, string?][] = [
  // jutro
  ["maly-wielki-smok", 1, 1, 13, 0],
  ["tryb-offline", 1, 1, 15, 30],
  ["nocny-pociag", 1, 1, 18, 15, "nocny-pociag"],
  ["cien-nad-wisla", 1, 1, 21, 0],
  ["maly-wielki-smok", 1, 2, 12, 30],
  ["ostatnie-lato", 1, 2, 15, 45],
  ["orbita-siedem", 1, 2, 18, 0],
  ["szum-fal", 1, 2, 20, 45, "szum-fal"],
  // pojutrze
  ["maly-wielki-smok", 2, 1, 12, 0],
  ["ostatnie-lato", 2, 1, 14, 15],
  ["tryb-offline", 2, 1, 16, 45],
  ["orbita-siedem", 2, 1, 19, 30, "orbita-siedem"],
  ["szum-fal", 2, 2, 13, 30],
  ["cien-nad-wisla", 2, 2, 17, 0],
  ["nocny-pociag", 2, 2, 20, 15],
  // za trzy dni
  ["maly-wielki-smok", 3, 1, 11, 30],
  ["orbita-siedem", 3, 1, 14, 0],
  ["szum-fal", 3, 1, 17, 30],
  ["tryb-offline", 3, 1, 20, 0],
  ["nocny-pociag", 3, 2, 15, 0],
  ["ostatnie-lato", 3, 2, 18, 0],
  ["cien-nad-wisla", 3, 2, 20, 30],
];

export function seedData(): EventDoc[] {
  return SCHEDULE.map(([filmId, day, hall, hour, minute, fixedId]) => {
    const { price, ...film }: Film = FILMS[filmId];
    return {
      _id: fixedId ?? `${filmId}-d${day}-${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
      ...film,
      title: film.film,
      startsAt: warsawDate(day, hour, minute),
      hall: `Sala ${hall}`,
      layout: HALL,
      price: price ?? PRICE,
    };
  });
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
