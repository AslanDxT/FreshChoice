/**
 * Date/time strategy
 * - Business dates are local calendar dates in Europe/Amsterdam, written 'YYYY-MM-DD'.
 * - Shift times are local wall-clock times 'HH:MM'.
 * - Instants (shift start/end, breaks, sessions) are UTC epoch milliseconds / timestamptz.
 * - Converting local -> instant always goes through the IANA zone, so DST is handled.
 */
export const BUSINESS_TZ = 'Europe/Amsterdam';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(ms: number) {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of the business timezone from UTC at the given instant, in minutes. */
export function tzOffsetMinutes(ms: number): number {
  const p = zonedParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function isDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Local date + local time in Europe/Amsterdam -> UTC epoch ms. */
export function localToUtcMs(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - tzOffsetMinutes(guess) * 60000;
  // Second pass corrects guesses that landed on the other side of a DST switch.
  const corrected = guess - tzOffsetMinutes(result) * 60000;
  if (corrected !== result) result = corrected;
  return result;
}

/** UTC epoch ms -> local 'YYYY-MM-DD' in the business timezone. */
export function localDateOf(ms: number): string {
  const p = zonedParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC epoch ms -> local 'HH:MM'. */
export function localTimeOf(ms: number): string {
  const p = zonedParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function todayLocal(now = Date.now()): string {
  return localDateOf(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function weekStartOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isWeekend(date: string): boolean {
  return isoWeekday(date) >= 6;
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

export function minutesOfTime(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
