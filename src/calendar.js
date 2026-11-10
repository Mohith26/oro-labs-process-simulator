// Business-time helpers. Time t is minutes since Monday 2026-08-03 00:00 (local).
// Work happens Mon-Fri; each worker has a daily window [from, to) in minutes of day.
export const T0 = Date.UTC(2026, 7, 3); // Mon Aug 3 2026
export const DAY = 1440;
export const OPEN = 540, CLOSE = 1020; // 9:00-17:00 office day

export const dayOf = t => Math.floor(t / DAY);
export const isWeekday = d => ((d % 7) + 7) % 7 < 5;
export const toDate = t => new Date(T0 + t * 60000);
export const iso = t => toDate(t).toISOString().slice(0, 10);
export const fromIso = s => Math.round((Date.parse(s + 'T00:00:00Z') - T0) / 60000);

// Advance from t by `mins` of work inside a daily window, skipping weekends and days
// for which present(day) is false. Returns the finish time.
export function addWork(t, mins, from = OPEN, to = CLOSE, present = () => true) {
  let left = mins;
  for (let guard = 0; guard < 4000; guard++) {
    const d = dayOf(t);
    const m = t - d * DAY;
    if (!isWeekday(d) || !present(d) || m >= to) { t = (d + 1) * DAY + from; continue; }
    if (m < from) { t = d * DAY + from; continue; }
    const avail = to - m;
    if (left <= avail) return t + left;
    left -= avail; t = (d + 1) * DAY + from;
  }
  return t;
}

// Office minutes (9-17, Mon-Fri) between a and b: the unit for "business days" (480 min).
export function officeMinutes(a, b) {
  if (b <= a) return 0;
  let total = 0, d = dayOf(a);
  const dEnd = dayOf(b);
  for (; d <= dEnd; d++) {
    if (!isWeekday(d)) continue;
    const s = Math.max(a, d * DAY + OPEN), e = Math.min(b, d * DAY + CLOSE);
    if (e > s) total += e - s;
  }
  return total;
}
export const businessDays = (a, b) => officeMinutes(a, b) / 480;
