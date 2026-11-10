import { generateLog, WINDOW } from './src/generate.js';
import { fit, forecast, actualStats, ksDistance } from './src/whatif.js';
import { STEPS } from './src/sim.js';

const LOG = generateLog();
const F = fit(LOG, WINDOW.fitEnd);
const W = { windowStart: WINDOW.testStart, windowEnd: WINDOW.end };
const ACT = actualStats(LOG, W.windowStart, W.windowEnd);
const REPS = 40;
const cache = new Map();
const fc = s => { const k = JSON.stringify(s); if (!cache.has(k)) cache.set(k, forecast(F, LOG, s, { ...W, reps: REPS })); return cache.get(k); };
const CUR = fc({});

const q = new URLSearchParams(location.search);
const state = {
  parallel: q.get('parallel') === '1',
  skip: ['0.95', '0.9'].includes(q.get('skip')) ? +q.get('skip') : null,
  treasury: [0, 60, 120].includes(+q.get('treasury')) ? +q.get('treasury') : 0,
  volume: ['1', '1.15', '1.3'].includes(q.get('volume')) ? +q.get('volume') : 1.3,
};
const scenario = () => ({ parallelChecks: state.parallel, skipConfirmAbove: state.skip, extraTreasuryMin: state.treasury, volume: state.volume });

const d2 = x => x.toFixed(2);
const d1 = x => x.toFixed(1);
const pct = x => `${Math.round(x * 100)}%`;
const day = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const hrs = m => `${m / 60} h`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const POOL_LABEL = { compliance: 'Compliance reviewers', treasury: 'Treasury (bank callbacks)', leads: 'Compliance lead' };

// tooltip
const tip = document.getElementById('tip');
document.addEventListener('mousemove', ev => {
  const t = ev.target.closest('[data-tip]');
  if (!t) { tip.classList.remove('on'); return; }
  tip.innerHTML = t.getAttribute('data-tip'); tip.classList.add('on');
  tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (ev.clientY + 14) + 'px';
});

function describe(s) {
  const parts = [];
  if (s.volume > 1) parts.push(`<b>+${Math.round((s.volume - 1) * 100)}% request volume</b>${s.volume >= 1.3 ? ' (SAP Ariba extension rollout)' : ''}`);
  if (s.parallelChecks) parts.push('<b>checks 3–5 in parallel</b>');
  if (s.skipConfirmAbove != null) parts.push(`<b>skip step 2 when triage confidence ≥ ${s.skipConfirmAbove}</b>`);
  if (s.extraTreasuryMin) parts.push(`<b>+${s.extraTreasuryMin / 60} h/day treasury callback time</b>`);
  return parts.length ? parts.join(', ') : '<b>no changes</b> (draft equals the published process)';
}

// ---------- left column: controls ----------
function renderCtrl() {
  const totalTreasury = F.pools.treasury.reduce((a, w) => a + (w.to - w.from), 0);
  const sel = (id, label, opts, val) => `<div class="fld"><label for="${id}">${label}</label><select id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
  const staff = Object.entries(F.pools).map(([p, ws]) => `<tr><td class="pool" colspan="2">${POOL_LABEL[p]}</td></tr>` + ws.map(w => `<tr><td>${w.name}</td><td class="r">${String(w.from / 60).padStart(2, '0')}:00–${w.to / 60}:00 · in ${pct(w.presence)}</td></tr>`).join('')).join('');
  document.getElementById('ctrl').innerHTML = `
    <h4>What-if on this process</h4>
    <p class="hint">Replays ${ACT.n} requests from ${day(W.windowStart)}–${day(W.windowEnd)} through the draft, using times and staffing learned from the request log.</p>
    ${sel('volume', 'Request volume', [[1, 'As today'], [1.15, '+15%'], [1.3, '+30% (SAP Ariba rollout)']], state.volume)}
    ${sel('parallel', 'Steps 3–5 (screening, callback, email check)', [[0, 'One after another (published)'], [1, 'Run in parallel']], state.parallel ? 1 : 0)}
    ${sel('skip', 'Step 2: compliance confirmation', [['', 'Always (published)'], [0.95, 'Skip if confidence ≥ 0.95'], [0.9, 'Skip if confidence ≥ 0.90']], state.skip ?? '')}
    ${sel('treasury', 'Treasury callback hours per day', [[0, `As today (${hrs(totalTreasury)})`], [60, `+1 h (${hrs(totalTreasury + 60)})`], [120, `+2 h (${hrs(totalTreasury + 120)})`]], state.treasury)}
    <button class="btn primary" id="runbtn">Run simulation</button>
    <div class="staff"><h4>Learned from the log</h4>
      <p class="hint">${F.nTrain} completed requests, ${day(WINDOW.start)}–${day(WINDOW.fitEnd)}. Working hours from when each person picks up tasks; "in" = share of backlog days they worked.</p>
      <table>${staff}</table></div>`;
  for (const id of ['volume', 'parallel', 'skip', 'treasury']) document.getElementById(id).addEventListener('change', e => {
    const v = e.target.value;
    if (id === 'volume') state.volume = +v; if (id === 'parallel') state.parallel = v === '1';
    if (id === 'skip') state.skip = v === '' ? null : +v; if (id === 'treasury') state.treasury = +v;
    render();
  });
  document.getElementById('runbtn').addEventListener('click', () => render());
}

// ---------- canvas ----------
const ICON = { system: 'play', review: 'clipboard', approval: 'circle-check' };
function stepCard(st, R, opts = {}) {
  const s = R.steps[st.id] || { wait: 0, total: 0 };
  const sum = Object.values(R.steps).reduce((a, x) => a + x.total, 0);
  const share = sum ? s.total / sum : 0;
  const heat = share > 0.45 ? 'hot' : share > 0.2 ? 'warm' : 'ok';
  const icon = st.id === 'triage' ? 'scan-search' : ICON[st.icon];
  let chips = '';
  if (opts.skipped) chips = `<span class="chip off">skipped for ${pct(opts.skipShare)}</span><span class="chip">${d2(s.total)} d avg when run</span>`;
  else {
    chips = `<span class="chip ${heat}" data-tip="Average elapsed time in this step per request (business days), ${pct(share)} of the time spent in steps">${d2(s.total)} d avg</span>`;
    if (st.pool) chips += `<span class="chip" data-tip="Average time waiting in the ${POOL_LABEL[st.pool].toLowerCase()} queue before someone picks it up">wait ${d2(s.wait)} d</span><span class="chip">${POOL_LABEL[st.pool]} · ${pct(R.util[st.pool])} load</span>`;
  }
  return `<div class="step"><div class="no">${st.n}</div><div class="card"><div class="nm"><i data-lucide="${icon}" class="ic-${st.icon}"></i>${st.name}</div><div class="meta">${chips}</div></div><span class="more">···</span></div>`;
}
function renderCanvas(R, s) {
  const by = Object.fromEntries(STEPS.map(x => [x.id, x]));
  const skipShare = s.skipConfirmAbove != null ? F.skipEvidence(s.skipConfirmAbove).share : 0;
  let h = `<div class="pill"><b>START</b><span>Input: 2 forms</span></div>`;
  h += stepCard(by.triage, R);
  h += stepCard(by.confirm, R, s.skipConfirmAbove != null ? { skipped: true, skipShare } : {});
  if (s.parallelChecks) {
    h += `<div class="par"><div class="plabel">PARALLEL · all three start together${R.critical ? ` · callback finishes last in ${pct(R.critical.callback)}` : ''}</div><div class="row">${['sanctions', 'callback', 'email'].map(id => stepCard(by[id], R)).join('')}</div></div>`;
  } else {
    h += ['sanctions', 'callback', 'email'].map(id => stepCard(by[id], R)).join('');
  }
  h += stepCard(by.exception, R);
  h += `<div class="cond">Step 6 runs only when a check is flagged (${pct(F.flaggedRate)} of requests)</div>`;
  h += `<div class="pill end" style="margin-top:12px"><b>END</b><span style="color:var(--ink-2)">Output</span></div>`;
  document.getElementById('canvas').innerHTML = h;
}

// ---------- results ----------
function ecdfPath(vals, x, y) {
  const s = [...vals].sort((a, b) => a - b);
  let d = '', n = s.length;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 300))) d += `${d ? 'L' : 'M'}${x(s[i]).toFixed(1)},${y((i + 1) / n).toFixed(1)}`;
  return d + `L${x(s[n - 1]).toFixed(1)},${y(1).toFixed(1)}`;
}
function chartDist(cur, draft, same) {
  const Wd = 480, H = 168, padL = 28, padB = 22, top = 6;
  const xmax = Math.ceil(Math.max(cur.p90.hi, draft.p90.hi) * 1.35);
  const x = v => padL + (Wd - padL - 6) * Math.min(v, xmax) / xmax;
  const y = p => top + (H - padB - top) * (1 - p);
  let s = `<svg class="chart" viewBox="0 0 ${Wd} ${H}">`;
  for (const p of [0, 0.5, 0.9]) s += `<line x1="${padL}" x2="${Wd - 6}" y1="${y(p)}" y2="${y(p)}" stroke="#eef0ea"/><text x="${padL - 4}" y="${y(p) + 3.5}" text-anchor="end">${p === 0.5 ? 'p50' : p === 0.9 ? 'p90' : pct(p)}</text>`;
  const step = xmax <= 8 ? 1 : 2;
  for (let v = 0; v <= xmax; v += step) s += `<text x="${x(v)}" y="${H - 6}" text-anchor="middle">${v}d</text>`;
  s += `<path d="${ecdfPath(ACT.cts, x, y)}" fill="none" stroke="#2b2b2e" stroke-width="1.2" stroke-dasharray="3 3"/>`;
  s += `<path d="${ecdfPath(cur.pooled, x, y)}" fill="none" stroke="#9b9a9f" stroke-width="1.8"/>`;
  if (!same) s += `<path d="${ecdfPath(draft.pooled, x, y)}" fill="none" stroke="${draft.p90.mid > cur.p90.mid * 1.1 ? 'var(--red)' : 'var(--green)'}" stroke-width="2"/>`;
  return s + '</svg>';
}
function deltaTag(a, b) {
  const r = b / a - 1;
  if (Math.abs(r) < 0.05) return `<span class="delta flat">±${Math.round(Math.abs(r) * 100)}%</span>`;
  return `<span class="delta ${r > 0 ? 'up' : 'down'}">${r > 0 ? '+' : '−'}${Math.round(Math.abs(r) * 100)}%</span>`;
}
function renderResults(R, s) {
  const same = JSON.stringify(s) === JSON.stringify({ parallelChecks: false, skipConfirmAbove: null, extraTreasuryMin: 0, volume: 1 });
  const tile = (k, key) => `<div class="tile"><div class="k">${k}</div><div class="v"><span class="from" data-tip="Published process, simulated">${d2(CUR[key].mid)}</span><span style="color:var(--ink-3)">→</span><span class="to">${d2(R[key].mid)} d</span>${deltaTag(CUR[key].mid, R[key].mid)}</div><div class="ci">business days · 90% range across ${REPS} runs ${d2(R[key].lo)}–${d2(R[key].hi)}</div></div>`;
  const ubar = p => {
    const u = R.util[p], c = CUR.util[p];
    const cls = u >= 1 ? 'hot' : u >= 0.85 ? 'warm' : '';
    return `<div class="ubar" data-tip="${esc(POOL_LABEL[p])}: work arriving ÷ hours scheduled in the queue. Published: ${pct(c)}."><span>${POOL_LABEL[p]}</span><span class="tr"><b class="${cls}" style="width:${Math.min(100, u / 1.3 * 100)}%"></b><i style="left:${100 / 1.3}%"></i></span><span class="pct ${cls}">${pct(u)}</span></div>`;
  };
  const ks = ksDistance(CUR.pooled, ACT.cts);
  const backOk = ACT.p50 >= CUR.p50.lo && ACT.p50 <= CUR.p50.hi && ACT.p90 >= CUR.p90.lo && ACT.p90 <= CUR.p90.hi;
  const worst = Object.entries(R.util).sort((a, b) => b[1] - a[1])[0];
  let insight = '';
  if (worst[1] >= 1) insight = `<div class="note sec"><b>${POOL_LABEL[worst[0]]} would be at ${pct(worst[1])} of scheduled time.</b> Work arrives faster than it can be done, so the queue grows through the window. A sum of step medians (what a dashboard average gives) still says <b>${d2(R.naive)} d</b>, because it can't see queues.</div>`;
  else insight = `<div class="note sec">A sum of step medians (what a dashboard average gives) says <b>${d2(R.naive)} d</b> for this draft vs <b>${d2(CUR.naive)} d</b> today. The simulation adds queueing, parallel joins and absences.</div>`;
  let extra = '';
  if (s.parallelChecks && R.critical) extra += `<div class="note sec"><b>Critical branch:</b> the bank verification callback finished last in ${pct(R.critical.callback)} of requests, sanctions screening in ${pct(R.critical.sanctions)}. Parallel checks only help as much as the callback allows.</div>`;
  if (s.skipConfirmAbove != null) {
    const e = F.skipEvidence(s.skipConfirmAbove);
    extra += `<div class="note sec"><b>Risk of skipping step 2:</b> reviewers changed the agent's risk domains on ${e.k} of ${e.n} past requests at confidence ≥ ${s.skipConfirmAbove} (${(100 * e.k / e.n).toFixed(1)}%). Those would go to screening with the agent's domains.</div>`;
  }
  document.getElementById('results').innerHTML = `
    <div class="rh"><h3>Simulation</h3><span class="sub">${REPS} runs · ${ACT.n} requests${s.volume > 1 ? ` + ${Math.round((s.volume - 1) * 100)}% resampled` : ''} · ${day(W.windowStart)}–${day(W.windowEnd)}</span></div>
    <p class="scen">Draft vs published: ${describe(s)}.</p>
    <div class="tiles">${tile('Median cycle time (intake to done)', 'p50')}${tile('90th percentile cycle time', 'p90')}</div>
    <div class="sec"><h5>Cycle time distribution<span class="lg"><span><i style="background:#9b9a9f"></i>Published</span>${same ? '' : `<span><i style="background:${R.p90.mid > CUR.p90.mid * 1.1 ? 'var(--red)' : 'var(--green)'}"></i>Draft</span>`}<span><i style="border-top:1.5px dashed #2b2b2e;height:0;background:none"></i>Actual, ${day(W.windowStart)}–${day(W.windowEnd)}</span></span></h5>${chartDist(CUR, R, same)}</div>
    <div class="sec"><h5>Queue load<span class="lg">line = 100% of scheduled hours</span></h5>${ubar('compliance')}${ubar('treasury')}${ubar('leads')}</div>
    ${insight}${extra}
    <div class="note sec ${backOk ? 'ok' : ''}"><b>Backtest ${backOk ? 'passed' : 'missed'}.</b> Fitted only on requests before ${day(WINDOW.fitEnd)}, the published process was forecast at p50 ${d2(CUR.p50.mid)} d (${d2(CUR.p50.lo)}–${d2(CUR.p50.hi)}) and p90 ${d2(CUR.p90.mid)} d (${d2(CUR.p90.lo)}–${d2(CUR.p90.hi)}) for ${day(W.windowStart)}–${day(W.windowEnd)}. Actual: <b>${d2(ACT.p50)} d</b> and <b>${d2(ACT.p90)} d</b> (KS distance ${d2(ks)}).</div>`;
}

function render() {
  const s = scenario();
  const R = fc(s);
  renderCanvas(R, s); renderResults(R, s);
  if (window.lucide) window.lucide.createIcons();
}
renderCtrl();
render();
