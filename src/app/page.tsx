import Link from "next/link";
import { connection } from "next/server";
import { listEvents, takenCounts } from "@/server/events";
import { Poster } from "@/components/Poster";
import { dayKey, dayTab, formatDuration, formatPrice, formatTime, pluralSeats, relativeDayLabel } from "@/lib/format";
import { totalSeats } from "@/lib/hall";
import type { CinemaEvent } from "@/lib/types";
import styles from "./page.module.css";

type Screening = CinemaEvent & { free: number; capacity: number };

type Film = {
  key: string; // posterSeed: wspólny dla wszystkich seansów jednego filmu
  info: Screening;
  screenings: Screening[];
};

type Props = { searchParams: Promise<{ dzien?: string }> };

function groupByFilm(screenings: Screening[]): Film[] {
  const films = new Map<string, Film>();
  for (const s of screenings) {
    const film = films.get(s.posterSeed);
    if (film) film.screenings.push(s);
    else films.set(s.posterSeed, { key: s.posterSeed, info: s, screenings: [s] });
  }
  return [...films.values()];
}

const anchor = (key: string) => `film-${key}`;

export default async function RepertoirePage({ searchParams }: Props) {
  await connection();
  const { dzien } = await searchParams;
  const [events, counts] = await Promise.all([listEvents(), takenCounts()]);

  const screenings: Screening[] = events.map((e) => {
    const capacity = totalSeats(e.layout);
    return { ...e, capacity, free: capacity - (counts[e.id] ?? 0) };
  });

  if (screenings.length === 0) {
    return (
      <div className="page">
        <Intro />
        <p className={styles.empty}>Na razie nie ma zaplanowanych seansów. Zajrzyj jutro.</p>
      </div>
    );
  }

  const days = [...new Set(screenings.map((s) => dayKey(s.startsAt)))];
  const selected = dzien && days.includes(dzien) ? dzien : days[0];
  const daySample = screenings.find((s) => dayKey(s.startsAt) === selected)!;
  const allFilms = groupByFilm(screenings);
  const dayFilms = groupByFilm(screenings.filter((s) => dayKey(s.startsAt) === selected));

  return (
    <div className="page">
      <Intro />

      <section className={styles.onScreen} aria-labelledby="na-ekranie">
        <h2 id="na-ekranie" className={styles.sectionTitle}>
          Na ekranie
        </h2>
        <ol className={styles.strip}>
          {allFilms.map((f, i) => (
            <li key={f.key} style={{ "--i": i } as React.CSSProperties}>
              <Link
                href={`/?dzien=${dayKey(f.screenings[0].startsAt)}#${anchor(f.key)}`}
                className={styles.stripCard}
                scroll={false}
              >
                <div className={styles.stripPosterWrap}>
                  <Poster
                    seed={f.key}
                    alt=""
                    sizes="(min-width: 760px) 200px, 150px"
                    priority={i < 4}
                    className={styles.stripPoster}
                  />
                  <span className={styles.badge}>{f.info.ageRating}</span>
                </div>
                <span className={styles.stripTitle}>{f.info.film}</span>
                <span className={styles.stripMeta}>{f.info.genre}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.repertoire} aria-labelledby="repertuar">
        <div className={styles.repHead}>
          <h2 id="repertuar" className={styles.sectionTitle}>
            Repertuar
          </h2>
          <nav aria-label="Wybierz dzień" className={styles.days}>
            {days.map((key) => {
              const sample = screenings.find((s) => dayKey(s.startsAt) === key)!;
              const { weekday, date } = dayTab(sample.startsAt);
              const active = key === selected;
              return (
                <Link
                  key={key}
                  href={`/?dzien=${key}`}
                  scroll={false}
                  className={`${styles.dayTab} ${active ? styles.dayActive : ""}`}
                  aria-current={active ? "date" : undefined}
                >
                  <span className={styles.dayWeekday}>{weekday}</span>
                  <span className={styles.dayDate}>{date}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <p className={styles.dayLabel}>
          {relativeDayLabel(daySample.startsAt)}, {dayFilms.length} {dayFilms.length === 1 ? "film" : dayFilms.length < 5 ? "filmy" : "filmów"}
        </p>

        <ol className={styles.films} key={selected}>
          {dayFilms.map((f, i) => (
            <li key={f.key} id={anchor(f.key)} style={{ "--i": i } as React.CSSProperties}>
              <FilmCard film={f} priority={i < 2} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Intro() {
  return (
    <section className={styles.intro}>
      <h1>Kino Pasaż</h1>
      <p>Wybierz film i godzinę, potem fotel. Trzymamy go dla Ciebie, a bilet opłacisz kartą online.</p>
    </section>
  );
}

function FilmCard({ film: { info, screenings }, priority }: { film: Film; priority: boolean }) {
  return (
    <article className={styles.film} aria-labelledby={`t-${info.posterSeed}`}>
      <Poster
        seed={info.posterSeed}
        alt={`Kadr z filmu ${info.film}`}
        sizes="(min-width: 760px) 180px, 104px"
        priority={priority}
        className={styles.filmPoster}
      />
      <div className={styles.filmBody}>
        <header className={styles.filmHead}>
          <h3 id={`t-${info.posterSeed}`} className={styles.filmTitle}>
            {info.film}
          </h3>
          <p className={styles.filmMeta}>
            <span className={styles.age}>{info.ageRating}</span>
            <span>{info.genre}</span>
            <span aria-hidden>·</span>
            <span>{formatDuration(info.durationMin)}</span>
            <span aria-hidden>·</span>
            <span>{info.language}</span>
          </p>
        </header>
        <p className={styles.synopsis}>{info.synopsis}</p>

        <ul className={styles.times} aria-label={`Seanse filmu ${info.film}`}>
          {screenings.map((s) => (
            <li key={s.id}>
              <Showtime screening={s} />
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function Showtime({ screening: s }: { screening: Screening }) {
  const soldOut = s.free <= 0;
  const occupancy = Math.round(((s.capacity - s.free) / s.capacity) * 100);
  const content = (
    <>
      <time className={`${styles.clock} mono`} dateTime={s.startsAt}>
        {formatTime(s.startsAt)}
      </time>
      <span className={styles.timeHall}>
        {s.hall} · {formatPrice(s.price)}
      </span>
      <span className={styles.fill} aria-hidden>
        <span style={{ width: `${occupancy}%` }} />
      </span>
      <span className={soldOut ? styles.soldOut : styles.freeSeats}>
        {soldOut ? "Brak miejsc" : `${s.free} ${pluralSeats(s.free)}`}
      </span>
    </>
  );

  if (soldOut) {
    return (
      <span className={`${styles.time} ${styles.timeDisabled}`} aria-disabled="true">
        {content}
      </span>
    );
  }
  return (
    <Link href={`/seanse/${s.id}`} className={styles.time} aria-label={`${formatTime(s.startsAt)}, ${s.hall}, ${s.free} ${pluralSeats(s.free)}. Wybierz fotel`}>
      {content}
    </Link>
  );
}
