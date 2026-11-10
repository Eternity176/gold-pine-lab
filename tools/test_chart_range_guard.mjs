// Test for the chart.js price-range guard (added 2026-11-10 with the Gold
// Trail overlay fix): an overlay=true plot whose values live far from
// price (an oscillator plotted by an overlay=true script) must NOT stretch
// the price axis and squash the candles, while a price-scale overlay plot
// IS included in the range. DOM stubs; the price-axis labels drawn by
// draw() reveal the lo/hi it computed. Run: node tools/test_chart_range_guard.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fillTexts = [];
function makeCanvas(w, h) {
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'fillText') return (text, x, y) => { fillTexts.push({ text: String(text), x, y }); };
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
const T0 = 1760000000; // epoch minutes
for (let i = 0; i < N; i++) {
  times[i] = T0 + i;
  const px = 4000 + 10 * Math.sin(i / 100); // realistic drift, range ~20
  open[i] = px; high[i] = px + 1; low[i] = px - 1; close[i] = px;
}
const candles = { n: N, times, open, high, low, close };
const pts = (fn) => { const a = []; for (let i = 0; i < N; i++) a.push({ t: times[i] * 60000, v: fn(i) }); return a; };
const plots = {
  Osc: pts((i) => -50 + 50 * Math.sin(i / 30)), // oscillator -100..0, overlay=true
  Trail: pts((i) => 4000 + 10 * Math.sin(i / 100) + 3), // price-scale, extends ~2 above candle hi
};
const plotMeta = { Osc: { overlay: true }, Trail: { overlay: true } };
const main = makeCanvas(1000, 500), osc = makeCanvas(1000, 110);
const chart = new Chart(main, osc);
chart.setData(candles, plots, plotMeta, {}, []);
// Price-axis labels are drawn at x = plotW + 6 = (1000 - 64) + 6 = 942.
const axisVals = fillTexts.filter((f) => f.x === 942).map((f) => parseFloat(f.text)).filter((v) => !Number.isNaN(v));
const lo = Math.min(...axisVals), hi = Math.max(...axisVals);
console.log('axis labels:', axisVals.map((v) => v.toFixed(1)).join(', '));
ok('oscillator plot does not stretch range (min stays near price)', lo > 3900, `lo=${lo}`);
ok('oscillator plot does not stretch range (max stays near price)', hi < 4020, `hi=${hi}`);
ok('price-scale overlay plot is still included (max above candle hi)', hi > 4011, `hi=${hi}`);
console.log(fail === 0 ? 'ALL RANGE-GUARD TESTS PASSED' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
