// Seeded synthetic history for one ORO process, produced by the simulation engine with
// "true" parameters. The what-if model never sees these parameters: it only sees the log.
import { run } from './sim.js';
import { DAY, fromIso, dayOf, isWeekday } from './calendar.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export const lognormal = (rng, median, sigma) => median * Math.exp(sigma * gauss(rng));

export const WINDOW = {
  start: '2026-08-03',      // first request in the log
  fitEnd: '2026-10-09',     // model is fitted on requests that arrived before this date (10 weeks)
  testStart: '2026-10-12',  // backtest window: Oct 12 - Oct 30 (3 weeks)
  end: '2026-10-30',
};

// True staffing: who works the queue, which hours of the day, and how often they are out.
export const TRUE_POOLS = {
  compliance: [
    { name: 'Priya Natarajan', from: 540, to: 780, out: 0.08 },  // 9:00-13:00
    { name: 'Daniel Okafor', from: 780, to: 1020, out: 0.10 },   // 13:00-17:00
    { name: 'Lena Hoffmann', from: 600, to: 840, out: 0.12 },    // 10:00-14:00
  ],
  treasury: [
    { name: 'Marcus Lee', from: 540, to: 720, out: 0.08 },       // 9:00-12:00
    { name: 'Sofia Ruiz', from: 840, to: 1020, out: 0.10 },      // 14:00-17:00
  ],
  leads: [{ name: 'Hannah Becker', from: 600, to: 780, out: 0.10 }], // 10:00-13:00
};

export function presenceFn(seed, out) {
  // deterministic absence calendar: worker is out on a day with probability `out`
  return (day) => { const r = mulberry32((seed * 7919 + day * 104729) >>> 0)(); return r >= out; };
}

export function makeRequests(seed = 20261030) {
  const rng = mulberry32(seed);
  const d0 = dayOf(fromIso(WINDOW.start)), d1 = dayOf(fromIso(WINDOW.end));
  const reqs = []; let id = 3100;
  for (let d = d0; d <= d1; d++) {
    if (!isWeekday(d)) continue;
    const dow = d % 7;
    const qEnd = d >= dayOf(fromIso('2026-09-21')) && d <= dayOf(fromIso('2026-09-30'));
    const lam = 17 * (dow === 0 ? 1.3 : dow === 4 ? 0.8 : 1) * (qEnd ? 1.35 : 1) * (1 + 0.12 * (d - d0) / (d1 - d0));
    const n = Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss(rng)));
    for (let j = 0; j < n; j++) {
      const arrival = d * DAY + 480 + Math.floor(rng() * 660); // 8:00 - 19:00
      const triageConf = Math.min(0.999, Math.max(0.3, 1 - Math.abs(0.13 * gauss(rng)) - 0.05 * rng()));
      // the reviewer changes the agent's risk domains more often when triage confidence is low
      const reviewerChanged = rng() < 0.45 * Math.pow(1 - triageConf, 1.6) + 0.004;
      const flagged = rng() < 0.11 + (reviewerChanged ? 0.25 : 0);
      reqs.push({ id: `ORO-${id++}`, arrival, triageConf: Math.round(triageConf * 1000) / 1000, reviewerChanged, flagged });
    }
  }
  return reqs.sort((a, b) => a.arrival - b.arrival);
}

export function generateLog(seed = 20261030) {
  const reqs = makeRequests(seed);
  const rng = mulberry32(seed + 1);
  const pools = {};
  let k = 0;
  for (const [p, ws] of Object.entries(TRUE_POOLS)) pools[p] = ws.map(w => ({ name: w.name, from: w.from, to: w.to, present: presenceFn(seed + 11 * ++k, w.out) }));
  const draw = {
    triage: () => lognormal(rng, 3, 0.5),
    confirm: () => lognormal(rng, 14, 0.55),
    sanctions: () => lognormal(rng, 75, 0.9),        // third-party screening provider, calendar minutes
    callbackWork: () => lognormal(rng, 12, 0.5),
    supplierDays: () => lognormal(rng, 0.7, 0.85),   // supplier confirms bank details, business days
    email: () => lognormal(rng, 2, 0.4),
    exception: () => lognormal(rng, 30, 0.6),
  };
  const { recs } = run(reqs, { parallelChecks: false, skipConfirmAbove: null }, pools, draw);
  const byId = new Map(reqs.map(r => [r.id, r]));
  for (const r of recs) r.reviewerChanged = byId.get(r.id).reviewerChanged;
  return recs;
}
