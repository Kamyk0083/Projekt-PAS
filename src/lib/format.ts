const TZ = "Europe/Warsaw";

const timeFmt = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const shortDayFmt = new Intl.DateTimeFormat("pl-PL", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatDay = (iso: string) => dayFmt.format(new Date(iso));
export const formatShortDay = (iso: string) => shortDayFmt.format(new Date(iso));
export const dayKey = (iso: string | Date) => keyFmt.format(new Date(iso));

export function relativeDayLabel(iso: string, now = new Date()): string {
  const key = dayKey(iso);
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 86_400_000));
  const full = formatDay(iso);
  if (key === today) return `Dziś, ${full}`;
  if (key === tomorrow) return `Jutro, ${full}`;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function pluralSeats(n: number): string {
  if (n === 1) return "wolny fotel";
  const last = n % 10;
  const lastTwo = n % 100;
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return "wolne fotele";
  return "wolnych foteli";
}

export function posterUrl(seed: string, w = 480, h = 640) {
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
}
