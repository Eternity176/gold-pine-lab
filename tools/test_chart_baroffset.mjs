// Test for the chart.js barOffset fix (added 2026-11-10 with the Gold
// Trail label fix): PineTS reports label/line/box positions and trade
// entry_bar_index as bar indices RELATIVE to the run window (a 20k
// preview's bar 0 is the full series' bar n-20000). Without the offset
// they all pile up at the left edge of the chart. app.js passes
// barOffset via setData opts; the chart adds it to bar-index drawings.
// DOM stubs. Run: node tools/test_chart_baroffset.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fillTexts = [];
const moveTos = [];
function makeCanvas(w, h) {
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (text, x, y) => { fillTexts.push({ text: String(text), x, y }); };
      if (k === 'moveTo') return (x, y) => { moveTos.push({ x, y }); };
      if (typeof k === 'string') return (...a) => {};
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const listeners = {};
  const cv = { width: 0, height: 0, clientWidth: w, clientHeight: h, style: {},
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, ev) { for (const f of (listeners[t] || [])) f({ ...ev, currentTarget: cv }); },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) };
  return cv;
}
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
globalThis.document = { createElement: () => makeCanvas(100, 100) };
require('/home/hatch/workspace/backtest-platform/chart.js');
const Chart = globalThis.GoldChart;
let fail = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' ' + extra)); if (!cond) fail++; };

const N = 1000;
const times = new Uint32Array(N), open = new Float32Array(N), high = new Float32Array(N), low = new Float32Array(N), close = new Float32Array(N);
const T0 = 1760000000;
for (let i = 0; i < N; i++) { times[i] = T0 + i; open[i] = 4000; high[i] = 4001; low[i] = 3999; close[i] = 4000; }
const candles = { n: N, times, open, high, low, close };
const main = makeCanvas(1000, 500), osc = makeCanvas(1000, 110);
const chart = new Chart(main, osc);

// Window-relative bar 100, full-series offset 500 -> full-series bar 600.
const labels = [{ x: 100, xloc: 'bi', y: 4000, text: 'BUY', color: '#00F5D4', textcolor: '#04211D' }];
const trades = [{ entry_bar_index: 100, dir: 1 }];
chart.setData(candles, {}, {}, { labels, lines: [], boxes: [] }, trades, { barOffset: 500 });
// View covering full-series bar 600: window 451..750.
chart.viewBars = 300; chart.endIdx = 750;
fillTexts.length = 0; moveTos.length = 0;
chart.draw();

// 1. _drawX adds the offset for bar-index drawings.
ok('_drawX(100, bi) with offset 500 == _xAtIdx(600)', Math.abs(chart._drawX(100, 'bi') - chart._xAtIdx(600)) < 0.01, `_drawX=${chart._drawX(100, 'bi')} _xAtIdx(600)=${chart._xAtIdx(600)}`);
// 2. Time-based drawings are unaffected by the offset.
const t600 = times[600] * 60000;
ok('_drawX(time, bar_time) ignores the offset', Math.abs(chart._drawX(t600, 'bar_time') - chart._xAtIdx(600)) < 0.01);
// 3. The BUY label is drawn at the offset position, not the left edge.
const buy = fillTexts.find((f) => f.text === 'BUY');
ok('BUY label drawn at full-series bar 600', !!buy && Math.abs(buy.x - chart._xAtIdx(600)) < 1, buy ? `x=${buy.x} expected~${chart._xAtIdx(600).toFixed(1)}` : 'label not drawn');
ok('BUY label NOT at the old wrong position (bar 100)', !buy || Math.abs(buy.x - chart._xAtIdx(100)) > 50, buy ? `x=${buy.x} wrong~${chart._xAtIdx(100).toFixed(1)}` : '');
// 4. The trade-entry triangle is drawn at the offset position.
const tri = moveTos.find((m) => Math.abs(m.x - chart._xAtIdx(600)) < 1);
ok('trade triangle drawn at full-series bar 600', !!tri, tri ? `x=${tri.x}` : 'no moveTo at bar 600');
// 5. No offset (full run) still works: bar 100 maps to bar 100.
chart.setData(candles, {}, {}, { labels, lines: [], boxes: [] }, trades, { barOffset: 0 });
ok('_drawX(100, bi) with offset 0 == _xAtIdx(100)', Math.abs(chart._drawX(100, 'bi') - chart._xAtIdx(100)) < 0.01);
console.log(fail === 0 ? 'ALL BAROFFSET TESTS PASSED' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
