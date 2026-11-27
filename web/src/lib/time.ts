/** Calendar helpers. Business dates are 'YYYY-MM-DD' in Europe/Amsterdam. */
export const TZ = 'Europe/Amsterdam';

export function todayLocal(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isoWeekday(date: string): number {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function weekStartOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function monthOf(date: string) {
  return date.slice(0, 7);
}

export function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
const fWeekday = fmt({ weekday: 'long' });
const fWeekdayShort = fmt({ weekday: 'short' });
const fDayMonth = fmt({ day: 'numeric', month: 'short' });
const fFull = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fMonth = fmt({ month: 'long', year: 'numeric' });
const d = (s: string) => new Date(`${s}T12:00:00Z`);

export const weekdayName = (s: string) => fWeekday.format(d(s));
export const weekdayShort = (s: string) => fWeekdayShort.format(d(s));
export const dayMonth = (s: string) => fDayMonth.format(d(s));
export const fullDate = (s: string) => fFull.format(d(s));
export const monthName = (month: string) => fMonth.format(d(`${month}-01`));

export function weekLabel(weekStart: string) {
  const end = addDays(weekStart, 6);
  return `${dayMonth(weekStart)} – ${dayMonth(end)} ${end.slice(0, 4)}`;
}

export function isoWeekNumber(date: string): number {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const fInstant = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export function instant(iso: string | null | undefined) {
  return iso ? fInstant.format(new Date(iso)) : '';
}

export function relative(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return instant(iso);
}

export function hours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}

export const SHIFTS = [
  { slot: 1, start: '09:00', end: '12:00' },
  { slot: 2, start: '12:00', end: '15:00' },
  { slot: 3, start: '15:00', end: '18:00' },
  { slot: 4, start: '18:00', end: '21:00' },
];
export const shiftTime = (slot: number) => {
  const s = SHIFTS.find((x) => x.slot === slot);
  return s ? `${s.start}–${s.end}` : '';
};
