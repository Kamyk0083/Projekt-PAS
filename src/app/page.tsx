import Link from "next/link";
import { connection } from "next/server";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { listEvents, takenSeats } from "@/server/events";
import { Poster } from "@/components/Poster";
import { SeatDensity } from "@/components/SeatDensity";
import { dayKey, formatDuration, formatTime, pluralSeats, relativeDayLabel } from "@/lib/format";
import { totalSeats } from "@/lib/hall";
import type { CinemaEvent } from "@/lib/types";
import styles from "./page.module.css";

type Screening = CinemaEvent & { taken: string[] };

export default async function RepertoirePage() {
  await connection();
  const events = await listEvents();
  const screenings: Screening[] = await Promise.all(
    events.map(async (e) => ({ ...e, taken: await takenSeats(e.id) })),
  );

  const days = new Map<string, Screening[]>();
  for (const s of screenings) {
    const key = dayKey(s.startsAt);
    days.set(key, [...(days.get(key) ?? []), s]);
  }

  let index = 0;
  return (
    <div className="page">
      <section className={styles.intro}>
        <h1>Repertuar</h1>
        <p>Wybierz seans, potem fotel. Trzymamy go dla Ciebie, dopóki nie kupisz biletu.</p>
      </section>

      {screenings.length === 0 ? (
        <p className={styles.empty}>Na razie nie ma zaplanowanych seansów. Zajrzyj jutro.</p>
      ) : (
        [...days.values()].map((group) => (
          <section key={dayKey(group[0].startsAt)} className={styles.day} aria-labelledby={`d-${group[0].id}`}>
            <h2 id={`d-${group[0].id}`} className={styles.dayLabel}>
              {relativeDayLabel(group[0].startsAt)}
            </h2>
            <ol className={styles.list}>
              {group.map((s) => {
                const i = index++;
                return (
                  <li key={s.id} style={{ "--i": i } as React.CSSProperties}>
                    <ScreeningRow screening={s} lead={i === 0} />
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}

function ScreeningRow({ screening: s, lead }: { screening: Screening; lead: boolean }) {
  const free = totalSeats(s.layout) - s.taken.length;
  return (
    <Link href={`/seanse/${s.id}`} className={`${styles.row} ${lead ? styles.lead : ""}`}>
      <Poster
        seed={s.posterSeed}
        alt={`Kadr z filmu ${s.film}`}
        sizes={lead ? "(min-width: 900px) 240px, 96px" : "96px"}
        priority={lead}
        className={styles.poster}
      />
      <div className={styles.info}>
        <p className={`${styles.time} mono`}>
          <time dateTime={s.startsAt}>{formatTime(s.startsAt)}</time>
        </p>
        <h3 className={styles.title}>{s.film}</h3>
        <p className={styles.meta}>
          {s.genre}, {formatDuration(s.durationMin)}, {s.ageRating}, {s.language}
        </p>
        {lead && <p className={styles.synopsis}>{s.synopsis}</p>}
      </div>
      <div className={styles.hall}>
        <SeatDensity layout={s.layout} taken={s.taken} />
        <p>
          <span className={styles.hallName}>{s.hall}</span>
          <span className={free === 0 ? styles.soldOut : styles.free}>
            {free === 0 ? "Brak wolnych miejsc" : `${free} ${pluralSeats(free)}`}
          </span>
        </p>
      </div>
      <span className={styles.cta}>
        <span className={styles.ctaLabel}>Wybierz fotel</span>
        <ArrowRight size={18} weight="bold" aria-hidden />
      </span>
    </Link>
  );
}
