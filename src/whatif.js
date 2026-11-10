// Fit the simulator from an ORO request log, then forecast cycle time for draft
// versions of the process (parallel checks, skipped confirmations, staffing, volume).
import { run, CHECKS, criticalCheck } from './sim.js';
import { DAY, OPEN, CLOSE, dayOf, isWeekday, businessDays, fromIso } from './calendar.js';
import { mulberry32 } from './generate.js';

export const quantile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const h = (s.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
};
const median = a => quantile(a, 0.5);
const mod = t => ((t % DAY) + DAY) % DAY;

// minutes between a and b that fall inside a worker's daily window, on weekdays the
// worker was active (days with no activity at all are treated as days out)
export function windowMinutes(a, b, from, to, active = null) {
  if (b <= a) return 0;
  let tot = 0;
  for (let d = dayOf(a); d <= dayOf(b); d++) {
    if (!isWeekday(d) || (active && !active.has(d))) continue;
    const s = Math.max(a, d * DAY + from), e = Math.min(b, d * DAY + to);
    if (e > s) tot += e - s;
  }
  return tot;
}

const POOL_STEP = { compliance: ['confirm'], treasury: ['callback'], leads: ['exception'] };

export function fit(log, fitEndIso) {
  const fitEnd = fromIso(fitEndIso);
  const train = log.filter(r => r.arrival < fitEnd && r.end != null);
  const pools = {};
  for (const [pool, steps] of Object.entries(POOL_STEP)) {
    const tasks = train.flatMap(r => steps.filter(s => r.steps[s]).map(s => r.steps[s]));
    const names = [...new Set(tasks.map(t => t.who))].sort();
    pools[pool] = names.map(name => {
      const mine = tasks.filter(t => t.who === name);
      const starts = mine.map(t => mod(t.start));
      const ends = mine.filter(t => dayOf(t.workEnd) === dayOf(t.start)).map(t => mod(t.workEnd));
      const from = Math.floor(quantile(starts, 0.01) / 30) * 30;
      const to = Math.ceil(quantile(ends, 0.99) / 30) * 30;
      // presence: of the weekdays with a backlog waiting at this worker's window open, on how many did they pick up work?
      let backlogDays = 0, workedDays = 0;
      const d0 = dayOf(fromIso('2026-08-03')), d1 = dayOf(fitEnd) - 1;
      const startDays = new Set(mine.map(t => dayOf(t.start)));
      for (let d = d0; d <= d1; d++) {
        if (!isWeekday(d)) continue;
        const open = d * DAY + from;
        const backlog = tasks.some(t => t.ready < open && t.start >= open);
        if (!backlog) continue;
        backlogDays++; if (startDays.has(d)) workedDays++;
      }
      const active = new Set(mine.flatMap(t => [dayOf(t.start), dayOf(t.workEnd)]));
      return { name, from, to, presence: backlogDays ? workedDays / backlogDays : 1, tasks: mine.length, active };
    });
  }
  const winWork = (t, pool) => { const w = pools[pool].find(x => x.name === t.who); return windowMinutes(t.start, t.workEnd, w.from, w.to, w.active); };
  const emp = {
    triage: train.map(r => r.steps.triage.end - r.steps.triage.start),
    confirm: train.filter(r => r.steps.confirm).map(r => winWork(r.steps.confirm, 'compliance')),
    sanctions: train.map(r => r.steps.sanctions.end - r.steps.sanctions.start),
    callbackWork: train.map(r => winWork(r.steps.callback, 'treasury')),
    supplierDays: train.map(r => businessDays(r.steps.callback.workEnd, r.steps.callback.end)),
    email: train.map(r => r.steps.email.end - r.steps.email.start),
    exception: train.filter(r => r.steps.exception).map(r => winWork(r.steps.exception, 'leads')),
  };
  // naive estimate: sum of each step's median elapsed time (ready -> done), as a process-mining dashboard would show
  const elapsed = id => train.filter(r => r.steps[id]).map(r => businessDays(r.steps[id].ready ?? r.arrival, r.steps[id].end));
  const naiveStep = Object.fromEntries(['triage', 'confirm', ...CHECKS, 'exception'].map(id => [id, median(elapsed(id))]));
  // skip-rule evidence: how often did the reviewer change the agent's domains above a confidence cutoff?
  const skipEvidence = c => { const s = train.filter(r => r.triageConf >= c); const k = s.filter(r => r.reviewerChanged).length; return { n: s.length, k, share: s.length / train.length }; };
  return { pools, emp, naiveStep, skipEvidence, nTrain: train.length, flaggedRate: train.filter(r => r.flagged).length / train.length };
}

export function naiveEstimate(F, design) {
  const s = F.naiveStep;
  const checks = design.parallelChecks ? Math.max(s.sanctions, s.callback, s.email) : s.sanctions + s.callback + s.email;
  const skipShare = design.skipConfirmAbove != null ? F.skipEvidence(design.skipConfirmAbove).share : 0;
  return s.triage + (1 - skipShare) * s.confirm + checks; // the median request is not flagged
}

function resampler(arr, rng) {
  const boot = Array.from(arr, () => arr[Math.floor(rng() * arr.length)]); // bootstrap: parameter uncertainty
  return () => boot[Math.floor(rng() * boot.length)];
}

// scenario: { parallelChecks, skipConfirmAbove, extraTreasuryMin (per day, added to the later shift), volume (1 = as-is) }
export function forecast(F, log, scenario, { windowStart, windowEnd, warmupDays = 14, reps = 40, seed = 7 } = {}) {
  const ws = fromIso(windowStart), we = fromIso(windowEnd) + DAY;
  const base = log.filter(r => r.arrival >= ws - warmupDays * DAY && r.arrival < we)
    .map(r => ({ id: r.id, arrival: r.arrival, triageConf: r.triageConf, flagged: r.flagged }));
  const design = { parallelChecks: !!scenario.parallelChecks, skipConfirmAbove: scenario.skipConfirmAbove ?? null };
  const perRep = [], pooled = [], crit = { sanctions: 0, callback: 0, email: 0 }, utilAcc = {};
  const stepWait = {};
  for (let k = 0; k < reps; k++) {
    const rng = mulberry32(seed * 1000 + k);
    // extra volume: bootstrap additional requests from the same window, jittered within the day
    let reqs = base;
    if (scenario.volume && scenario.volume > 1) {
      const extra = [];
      const m = Math.round(base.length * (scenario.volume - 1));
      for (let i = 0; i < m; i++) { const r = base[Math.floor(rng() * base.length)]; extra.push({ ...r, id: r.id + '+' + i, arrival: dayOf(r.arrival) * DAY + 480 + Math.floor(rng() * 660) }); }
      reqs = [...base, ...extra].sort((a, b) => a.arrival - b.arrival);
    }
    const pools = {};
    for (const [p, ws_] of Object.entries(F.pools)) {
      pools[p] = ws_.map((w, i) => {
        const seedW = Math.floor(rng() * 1e9);
        // extra treasury time: the later shift starts earlier
        const from = p === 'treasury' && scenario.extraTreasuryMin && i === ws_.length - 1 ? Math.max(OPEN, w.from - scenario.extraTreasuryMin) : w.from;
        return { name: w.name, from, to: w.to, present: d => mulberry32((seedW + d * 7919) >>> 0)() < w.presence };
      });
    }
    const draw = Object.fromEntries(Object.entries(F.emp).map(([k2, arr]) => [k2, resampler(arr, rng)]));
    const { recs, util } = run(reqs, design, pools, draw);
    const inWin = recs.filter(r => r.arrival >= ws && r.arrival < we);
    const cts = inWin.map(r => businessDays(r.arrival, r.end));
    perRep.push({ p50: quantile(cts, 0.5), p90: quantile(cts, 0.9), mean: cts.reduce((a, b) => a + b, 0) / cts.length, n: cts.length });
    if (k < 10) pooled.push(...cts);
    if (design.parallelChecks) for (const r of inWin) crit[criticalCheck(r)]++;
    for (const r of inWin) for (const [id, s] of Object.entries(r.steps)) {
      const w = (stepWait[id] ||= { wait: 0, total: 0, n: 0 });
      w.wait += s.start != null && s.ready != null ? businessDays(s.ready, s.start) : 0;
      w.total += businessDays(s.ready ?? r.arrival, s.end);
      w.n++;
    }
    // utilization over the window's weekdays: work minutes / scheduled window minutes
    for (const [p, ws_] of Object.entries(util)) {
      let workSum = 0, cap = 0;
      for (const w of ws_) workSum += w.workMin;
      const fp = pools[p];
      const days = [];
      for (let d = dayOf(base[0].arrival); d <= dayOf(we - 1); d++) if (isWeekday(d)) days.push(d);
      for (const w of fp) for (const d of days) if (w.present(d)) cap += w.to - w.from;
      (utilAcc[p] ||= []).push(workSum / cap);
    }
  }
  const pick = key => perRep.map(r => r[key]);
  const band = key => ({ mid: quantile(pick(key), 0.5), lo: quantile(pick(key), 0.05), hi: quantile(pick(key), 0.95) });
  const nCrit = Object.values(crit).reduce((a, b) => a + b, 0);
  return {
    p50: band('p50'), p90: band('p90'), mean: band('mean'), n: perRep[0].n, pooled,
    critical: nCrit ? Object.fromEntries(Object.entries(crit).map(([k, v]) => [k, v / nCrit])) : null,
    util: Object.fromEntries(Object.entries(utilAcc).map(([k, v]) => [k, median(v)])),
    steps: Object.fromEntries(Object.entries(stepWait).map(([k, v]) => [k, { wait: v.wait / v.n, total: v.total / v.n, share: v.n }])),
    naive: naiveEstimate(F, design),
  };
}

export function actualStats(log, windowStart, windowEnd) {
  const ws = fromIso(windowStart), we = fromIso(windowEnd) + DAY;
  const cts = log.filter(r => r.arrival >= ws && r.arrival < we).map(r => businessDays(r.arrival, r.end));
  return { p50: quantile(cts, 0.5), p90: quantile(cts, 0.9), mean: cts.reduce((a, b) => a + b, 0) / cts.length, n: cts.length, cts };
}

// Kolmogorov-Smirnov distance between two samples
export function ksDistance(a, b) {
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  let i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return d;
}
