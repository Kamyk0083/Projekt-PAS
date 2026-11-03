import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";
import { eventDetails } from "@/server/events";
import { AppError } from "@/server/errors";
import { config } from "@/server/config";
import { Poster } from "@/components/Poster";
import { HallBooking } from "@/components/booking/HallBooking";
import { formatDuration, formatPrice, formatTime, relativeDayLabel } from "@/lib/format";
import { FlowSteps } from "@/components/FlowSteps";
import styles from "./page.module.css";

type Props = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ fotel?: string }>;
};

async function load(eventId: string) {
  try {
    return await eventDetails(decodeURIComponent(eventId));
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const { eventId } = await params;
  const { event } = await load(eventId);
  return { title: `${event.film}, ${formatTime(event.startsAt)}` };
}

export default async function ScreeningPage({ params, searchParams }: Props) {
  await connection();
  const { eventId } = await params;
  const { fotel } = await searchParams;
  const { event, takenSeats } = await load(eventId);

  return (
    <div className="page">
      <div className={styles.topbar}>
        <Link href="/" className={styles.back}>
          <ArrowLeft size={16} weight="bold" aria-hidden />
          Repertuar
        </Link>
        <FlowSteps current={1} />
      </div>

      <header className={styles.head}>
        <Poster seed={event.posterSeed} alt={`Kadr z filmu ${event.film}`} sizes="88px" priority className={styles.poster} />
        <div className={styles.headText}>
          <h1>{event.film}</h1>
          <p className={styles.when}>
            <time dateTime={event.startsAt}>
              {relativeDayLabel(event.startsAt)}, <span className="mono">{formatTime(event.startsAt)}</span>
            </time>
          </p>
          <p className={styles.meta}>
            {event.hall}, {event.genre}, {formatDuration(event.durationMin)}, {event.ageRating}, {event.language}
          </p>
          <p className={styles.price}>
            Bilet <strong>{formatPrice(event.price)}</strong>
          </p>
        </div>
      </header>

      <HallBooking
        event={event}
        initialTaken={takenSeats}
        initialSeat={fotel?.toUpperCase() ?? null}
        ttlMinutes={Math.max(1, Math.round(config.reservationTtlMs / 60_000))}
      />
    </div>
  );
}
