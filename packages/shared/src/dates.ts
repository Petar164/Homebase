// Small date helpers. A calendar day is always the text "YYYY-MM-DD", which
// sorts and compares correctly as plain text and has no time zone problems.

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, days: number): string {
  const d = fromYmd(s);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((fromYmd(to).getTime() - fromYmd(from).getTime()) / 864e5);
}

export function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** 1 = Monday ... 7 = Sunday. */
export function weekday(s: string): number {
  return ((fromYmd(s).getDay() + 6) % 7) + 1;
}

export function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthName(ym: string, short = false): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(
    undefined,
    short ? { month: "short" } : { month: "long", year: "numeric" },
  );
}

export function longDate(s: string): string {
  return fromYmd(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** "Today", "Tomorrow", "3 days late" or a short date. */
export function relDay(s: string, today: string): string {
  const d = daysBetween(today, s);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d < 0) return `${-d}${d === -1 ? " day late" : " days late"}`;
  return fromYmd(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** "09:30" -> 570 minutes after midnight. */
export function toMin(t: string): number {
  const [h, m] = String(t || "").split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

export function hm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function parseDate(input: string): string | null {
  const s = String(input).trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}
