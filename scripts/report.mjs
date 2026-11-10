import { generateLog, WINDOW, TRUE_POOLS } from '../src/generate.js';
import { fit, forecast, actualStats, ksDistance } from '../src/whatif.js';
const t0 = Date.now();
const log = generateLog();
const F = fit(log, WINDOW.fitEnd);
const W = { windowStart: WINDOW.testStart, windowEnd: WINDOW.end };
const f2 = x => x.toFixed(2);
console.log('log', log.length, 'train', F.nTrain, 'flagged', f2(F.flaggedRate));
for (const [p, ws] of Object.entries(F.pools)) console.log('pool', p, ws.map(w => `${w.name} ${w.from/60}-${w.to/60}h presence ${f2(w.presence)} (true out ${TRUE_POOLS[p].find(x=>x.name===w.name).out})`).join(' | '));
const A = actualStats(log, W.windowStart, W.windowEnd);
console.log('ACTUAL test window n', A.n, 'p50', f2(A.p50), 'p90', f2(A.p90), 'mean', f2(A.mean));
const scen = {
  asis: {}, parallel: { parallelChecks: true }, skip90: { skipConfirmAbove: 0.9 },
  vol130: { volume: 1.3 }, vol130_plus2h: { volume: 1.3, extraTreasuryMin: 120 }, vol130_parallel: { volume: 1.3, parallelChecks: true },
  parallel_skip_plus: { parallelChecks: true, skipConfirmAbove: 0.9, extraTreasuryMin: 120 },
};
for (const [k, s] of Object.entries(scen)) {
  const R = forecast(F, log, s, { ...W, reps: 40 });
  console.log(k.padEnd(20), 'p50', f2(R.p50.mid), `[${f2(R.p50.lo)}-${f2(R.p50.hi)}]`, 'p90', f2(R.p90.mid), `[${f2(R.p90.lo)}-${f2(R.p90.hi)}]`, 'naive', f2(R.naive), 'util', JSON.stringify(Object.fromEntries(Object.entries(R.util).map(([a,b])=>[a,+b.toFixed(2)]))), R.critical ? 'crit '+JSON.stringify(Object.fromEntries(Object.entries(R.critical).map(([a,b])=>[a,+b.toFixed(2)]))) : '', k==='asis' ? 'KS '+f2(ksDistance(R.pooled, A.cts)) : '');
}
const sk = F.skipEvidence(0.9); console.log('skip>=0.9 share', f2(sk.share), 'changed', sk.k, '/', sk.n);
console.log('ms', Date.now() - t0);
