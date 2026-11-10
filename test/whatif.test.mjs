import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWork, officeMinutes, fromIso, DAY } from '../src/calendar.js';
import { run } from '../src/sim.js';
import { generateLog, makeRequests, WINDOW, TRUE_POOLS, presenceFn } from '../src/generate.js';
import { fit, forecast, actualStats, ksDistance, quantile, windowMinutes } from '../src/whatif.js';
import { dayOf, isWeekday } from '../src/calendar.js';

const LOG = generateLog();
const F = fit(LOG, WINDOW.fitEnd);
const W = { windowStart: WINDOW.testStart, windowEnd: WINDOW.end };

test('business calendar: work rolls over the weekend and office minutes skip nights', () => {
  const fri1630 = fromIso('2026-08-07') + 16 * 60 + 30;
  const end = addWork(fri1630, 60);                       // 30 min Friday + 30 min Monday
  assert.equal(end, fromIso('2026-08-10') + 9 * 60 + 30);
  assert.equal(officeMinutes(fri1630, end), 60);
  assert.equal(officeMinutes(fromIso('2026-08-08'), fromIso('2026-08-10')), 0); // weekend
  assert.equal(windowMinutes(fromIso('2026-08-10') + 600, fromIso('2026-08-11') + 600, 540, 720), 120 + 60);
});

test('engine: FIFO queue on one worker, and parallel = max of branches when nobody waits', () => {
  const pools = { compliance: [{ name: 'a', from: 0, to: 1440, present: () => true }], treasury: Array.from({ length: 50 }, (_, i) => ({ name: 't' + i, from: 0, to: 1440, present: () => true })), leads: [{ name: 'l', from: 0, to: 1440, present: () => true }] };
  const draw = { triage: () => 5, confirm: () => 60, sanctions: () => 100, callbackWork: () => 10, supplierDays: () => 0, email: () => 3, exception: () => 20 };
  const mon = fromIso('2026-08-10');
  const reqs = [{ id: 'A', arrival: mon + 600, triageConf: 0.5, flagged: false }, { id: 'B', arrival: mon + 601, triageConf: 0.5, flagged: false }];
  const seq = run(reqs, { parallelChecks: false }, pools, draw).recs;
  const A = seq.find(r => r.id === 'A'), B = seq.find(r => r.id === 'B');
  assert.equal(A.steps.confirm.start, mon + 605);
  assert.equal(B.steps.confirm.start, A.steps.confirm.workEnd, 'B waits for A on the single reviewer');
  const par = run(reqs, { parallelChecks: true }, pools, draw).recs.find(r => r.id === 'A');
  const confirmEnd = par.steps.confirm.end;
  // supplier answers within office hours, so the callback ends after its 10 min of work
  assert.equal(par.end - confirmEnd, Math.max(100, 10, 3));
  assert.equal(A.end - A.steps.confirm.end, 100 + 10 + 3);
});

test('generator: every request completes; deterministic', () => {
  assert.ok(LOG.length > 1000);
  assert.ok(LOG.every(r => r.end > r.arrival));
  const again = generateLog();
  assert.deepEqual(again.slice(0, 20).map(r => r.end), LOG.slice(0, 20).map(r => r.end));
  assert.equal(makeRequests().length, LOG.length);
});

test('fit recovers staffing and work times from the log alone', () => {
  for (const [p, ws] of Object.entries(TRUE_POOLS)) {
    for (const w of ws) {
      const f = F.pools[p].find(x => x.name === w.name);
      assert.equal(f.from, w.from, `${w.name} window start`);
      assert.equal(f.to, w.to, `${w.name} window end`);
    }
  }
  // presence vs the realized absence calendar over the fit window
  let k = 0;
  for (const [p, ws] of Object.entries(TRUE_POOLS)) for (const w of ws) {
    k++;
    const pres = presenceFn(20261030 + 11 * k, w.out);
    let n = 0, on = 0;
    for (let d = dayOf(fromIso(WINDOW.start)); d < dayOf(fromIso(WINDOW.fitEnd)); d++) if (isWeekday(d)) { n++; if (pres(d)) on++; }
    const est = F.pools[p].find(x => x.name === w.name).presence;
    assert.ok(Math.abs(est - on / n) < 0.06, `${w.name} presence ${est} vs ${on / n}`);
  }
  const med = a => quantile(a, 0.5);
  assert.ok(Math.abs(med(F.emp.confirm) / 14 - 1) < 0.1);
  assert.ok(Math.abs(med(F.emp.callbackWork) / 12 - 1) < 0.1);
  assert.ok(Math.abs(med(F.emp.supplierDays) / 0.7 - 1) < 0.1);
});

test('backtest: as-is forecast for the held-out weeks covers the actual p50 and p90', () => {
  const A = actualStats(LOG, W.windowStart, W.windowEnd);
  const R = forecast(F, LOG, {}, { ...W, reps: 40 });
  assert.ok(A.p50 >= R.p50.lo && A.p50 <= R.p50.hi, `p50 ${A.p50} vs [${R.p50.lo}, ${R.p50.hi}]`);
  assert.ok(A.p90 >= R.p90.lo && A.p90 <= R.p90.hi, `p90 ${A.p90} vs [${R.p90.lo}, ${R.p90.hi}]`);
  assert.ok(ksDistance(R.pooled, A.cts) < 0.12);
});

test('what-ifs move in the right direction and the naive estimate cannot see load', () => {
  const base = forecast(F, LOG, {}, { ...W, reps: 30 });
  const vol = forecast(F, LOG, { volume: 1.3 }, { ...W, reps: 30 });
  const volPlus = forecast(F, LOG, { volume: 1.3, extraTreasuryMin: 120 }, { ...W, reps: 30 });
  const par = forecast(F, LOG, { parallelChecks: true }, { ...W, reps: 30 });
  assert.ok(vol.p90.mid > base.p90.mid * 1.3, 'volume pushes the tail out');
  assert.ok(volPlus.p90.mid < vol.p90.mid, 'more treasury time pulls it back');
  assert.ok(vol.util.treasury > 1 && base.util.treasury < 0.9);
  assert.ok(par.p50.mid <= base.p50.mid);
  assert.ok(par.critical.callback > 0.9, 'callback is the critical branch');
  assert.equal(vol.naive, base.naive, 'sum of medians ignores volume');
});

test('utilization matches offered load (work arriving / time scheduled)', () => {
  const R = forecast(F, LOG, {}, { ...W, reps: 20 });
  const ws = fromIso(W.windowStart) - 14 * DAY, we = fromIso(W.windowEnd) + DAY;
  const n = LOG.filter(r => r.arrival >= ws && r.arrival < we).length;
  const meanWork = F.emp.callbackWork.reduce((a, b) => a + b, 0) / F.emp.callbackWork.length;
  let cap = 0;
  for (let d = dayOf(ws); d <= dayOf(we - 1); d++) if (isWeekday(d)) for (const w of F.pools.treasury) cap += (w.to - w.from) * w.presence;
  const offered = n * meanWork / cap;
  assert.ok(Math.abs(R.util.treasury - offered) / offered < 0.12, `${R.util.treasury} vs ${offered}`);
});

test('forecasts are deterministic for a seed', () => {
  const a = forecast(F, LOG, { parallelChecks: true }, { ...W, reps: 8, seed: 3 });
  const b = forecast(F, LOG, { parallelChecks: true }, { ...W, reps: 8, seed: 3 });
  assert.equal(a.p90.mid, b.p90.mid);
});
