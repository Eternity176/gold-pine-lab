// Regression suite for chart.js: wheel anchor, zoomBy, goToLatest,
// preserveView, empty plots — the behaviours the barcolor/series-color
// change must not break. DOM stubs. Run: node tools/test_chart_regression.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function makeCanvas(w, h) {
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
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

const N = 100000;
const times = new Uint32Array(N), open = new Float32Array(N), high = new Float32Array(N), low = new Float32Array(N), close = new Float32Array(N);
for (let i = 0; i < N; i++) { times[i] = i; open[i] = 4000; high[i] = 4001; low[i] = 3999; close[i] = 4000 + Math.sin(i / 50); }
const candles = { n: N, times, open, high, low, close };
const main = makeCanvas(1000, 500), osc = makeCanvas(1000, 110);
const chart = new Chart(main, osc);

// 1. Empty plots: setData + draw must not throw; default view 300 + offset 10.
chart.setData(candles, {}, {}, {}, []);
let threw = null;
try { chart.draw(); } catch (e) { threw = e; }
ok('empty plots: setData + draw run', threw === null, threw && threw.message);
ok('default view 300 bars + 10-bar right offset', chart.viewBars === 300 && chart.endIdx === N - 1 + 10, `viewBars=${chart.viewBars} endIdx=${chart.endIdx}`);

// 2. Wheel anchor: 20 zoom-out notches + 20 zoom-in, anchor bar unchanged.
const anchorX = 500;
let anchorBar = chart._idxAtX(anchorX);
const vb0 = chart.viewBars;
for (let k = 0; k < 20; k++) main.fire('wheel', { deltaY: 120, deltaMode: 0, clientX: anchorX, preventDefault() {} });
const vbOut = chart.viewBars;
for (let k = 0; k < 20; k++) main.fire('wheel', { deltaY: -120, deltaMode: 0, clientX: anchorX, preventDefault() {} });
ok('wheel: 20 out + 20 in, anchor bar unchanged', chart._idxAtX(anchorX) === anchorBar, `was ${anchorBar}, now ${chart._idxAtX(anchorX)}`);
ok('wheel: zoomed out far then back (~300 bars)', vbOut > 10000 && Math.abs(chart.viewBars - vb0) < 5, `vbOut=${vbOut} vbBack=${chart.viewBars}`);

// 3. zoomBy + goToLatest.
chart.zoomBy(0.8);
ok('zoomBy(0.8) -> 240 bars', chart.viewBars === 240, `viewBars=${chart.viewBars}`);
chart.zoomBy(1.25);
ok('zoomBy(1.25) -> 300 bars', chart.viewBars === 300, `viewBars=${chart.viewBars}`);
chart.setData(candles, {}, {}, {}, []);
chart.viewBars = 75; chart.endIdx = 50000; // panned back
chart.goToLatest();
ok('goToLatest keeps zoom, end at last bar + offset', chart.viewBars === 75 && chart.endIdx === N - 1 + 10, `viewBars=${chart.viewBars} endIdx=${chart.endIdx}`);

// 4. preserveView: live append keeps position / offset.
chart.setData(candles, {}, {}, {}, []);
const n2 = N + 100;
const t2 = new Uint32Array(n2), o2 = new Float32Array(n2), h2 = new Float32Array(n2), l2 = new Float32Array(n2), c2 = new Float32Array(n2);
t2.set(times); o2.set(open); h2.set(high); l2.set(low); c2.set(close);
for (let i = N; i < n2; i++) { t2[i] = i; o2[i] = 4000; h2[i] = 4001; l2[i] = 3999; c2[i] = 4000; }
chart.setData({ n: n2, times: t2, open: o2, high: h2, low: l2, close: c2 }, {}, {}, {}, [], { preserveView: true });
ok('preserveView keeps 10-bar offset at right edge', chart.endIdx === n2 - 1 + 10 && chart.viewBars === 300, `endIdx=${chart.endIdx} viewBars=${chart.viewBars}`);

// 5. draw() with endIdx past the last bar (offset region) must not crash.
chart.endIdx = n2 - 1 + 10; chart.viewBars = 50;
threw = null;
try { chart.draw(); } catch (e) { threw = e; }
ok('draw() with endIdx past last bar', threw === null, threw && threw.message);

console.log(fail === 0 ? 'ALL REGRESSION TESTS PASSED' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
