// Discrete-event simulation of one ORO process ("Proposal Risk-Domain Triage").
// The same engine produces the synthetic history (with the true parameters) and the
// what-if forecasts (with parameters fitted from that history).
import { addWork, OPEN, CLOSE, dayOf } from './calendar.js';

export const STEPS = [
  { id: 'triage',    n: 1, name: 'Triage risk domains',                     kind: 'agent',    icon: 'system' },
  { id: 'confirm',   n: 2, name: 'Compliance reviewer confirms domains',    kind: 'human',    pool: 'compliance', icon: 'review' },
  { id: 'sanctions', n: 3, name: 'Sanctions and adverse media screening',   kind: 'external', icon: 'system' },
  { id: 'callback',  n: 4, name: 'Bank verification callback',              kind: 'human+external', pool: 'treasury', icon: 'system' },
  { id: 'email',     n: 5, name: 'Email or domain check',                   kind: 'agent',    icon: 'system' },
  { id: 'exception', n: 6, name: 'Compliance exception decision',           kind: 'human',    pool: 'leads', icon: 'approval' },
];
export const CHECKS = ['sanctions', 'callback', 'email'];

// ---------- tiny binary heap ----------
class Heap {
  constructor() { this.a = []; this.seq = 0; }
  push(t, fn) { const a = this.a; a.push({ t, s: this.seq++, fn }); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && this.lt(a[l], a[m])) m = l; if (r < a.length && this.lt(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } } return top; }
  lt(x, y) { return x.t < y.t || (x.t === y.t && x.s < y.s); }
  get size() { return this.a.length; }
}

// design: { parallelChecks: bool, skipConfirmAbove: number|null }
// pools: { compliance: [{ name, from, to, present(day) }], treasury: [...], leads: [...] }
// draw: { triage(), confirm(), sanctions(), callbackWork(), supplierDays(), email(), exception() } -> minutes (supplierDays -> business days)
// requests: [{ id, arrival, triageConf, flagged }]
export function run(requests, design, pools, draw) {
  const heap = new Heap();
  const recs = new Map();
  const state = {};
  for (const [name, workers] of Object.entries(pools)) {
    state[name] = { queue: [], workers: workers.map(w => ({ ...w, busyUntil: -Infinity, busy: false, workMin: 0 })) };
  }

  function dispatch(poolName, now) {
    const P = state[poolName];
    while (P.queue.length) {
      let best = null, bestStart = Infinity;
      for (const w of P.workers) {
        if (w.busy) continue;
        const st = addWork(now, 0, w.from, w.to, w.present);
        if (st < bestStart) { bestStart = st; best = w; }
      }
      if (!best) return;
      const task = P.queue.shift();
      best.busy = true;
      const end = addWork(bestStart, task.work, best.from, best.to, best.present);
      best.workMin += task.work;
      task.rec.start = bestStart; task.rec.who = best.name;
      heap.push(end, () => { best.busy = false; task.rec.workEnd = end; task.done(end); dispatch(poolName, end); });
    }
  }
  function human(poolName, now, work, rec, done) {
    rec.ready = now;
    state[poolName].queue.push({ work, rec, done });
    dispatch(poolName, now);
  }

  for (const req of requests) {
    const R = { id: req.id, arrival: req.arrival, triageConf: req.triageConf, flagged: req.flagged, steps: {} };
    recs.set(req.id, R);
    heap.push(req.arrival, () => {
      const t0 = req.arrival;
      const tri = (R.steps.triage = { ready: t0, start: t0 });
      tri.end = t0 + draw.triage();
      heap.push(tri.end, () => afterTriage(tri.end));
    });
    const afterTriage = (t) => {
      if (design.skipConfirmAbove != null && req.triageConf >= design.skipConfirmAbove) { R.skippedConfirm = true; return checks(t); }
      const c = (R.steps.confirm = {});
      human('compliance', t, draw.confirm(), c, (end) => { c.end = end; checks(end); });
    };
    const runCheck = (id, t, done) => {
      if (id === 'sanctions') { const s = (R.steps.sanctions = { ready: t, start: t }); s.end = t + draw.sanctions(); heap.push(s.end, () => done(s.end)); }
      else if (id === 'email') { const s = (R.steps.email = { ready: t, start: t }); s.end = t + draw.email(); heap.push(s.end, () => done(s.end)); }
      else {
        const s = (R.steps.callback = {});
        human('treasury', t, draw.callbackWork(), s, (workEnd) => {
          s.end = addWork(workEnd, draw.supplierDays() * 480, OPEN, CLOSE); // supplier answers in business hours
          heap.push(s.end, () => done(s.end));
        });
      }
    };
    const checks = (t) => {
      if (design.parallelChecks) {
        let left = CHECKS.length, last = t;
        for (const id of CHECKS) runCheck(id, t, (end) => { last = Math.max(last, end); if (--left === 0) afterChecks(last); });
      } else {
        runCheck('sanctions', t, (e1) => runCheck('callback', e1, (e2) => runCheck('email', e2, (e3) => afterChecks(e3))));
      }
    };
    const afterChecks = (t) => {
      R.checksDone = t;
      if (!req.flagged) { R.end = t; return; }
      const x = (R.steps.exception = {});
      human('leads', t, draw.exception(), x, (end) => { x.end = end; R.end = end; });
    };
  }
  let guard = 0;
  while (heap.size && guard++ < 5e6) heap.pop().fn();
  const util = {};
  for (const [name, P] of Object.entries(state)) util[name] = P.workers.map(w => ({ name: w.name, workMin: w.workMin }));
  return { recs: [...recs.values()], util };
}

// Which check finished last (the critical branch) for a parallel run.
export function criticalCheck(rec) {
  let best = null, t = -Infinity;
  for (const id of CHECKS) { const s = rec.steps[id]; if (s && s.end > t) { t = s.end; best = id; } }
  return best;
}
export { dayOf };
