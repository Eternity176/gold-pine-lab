// Test chart.js: barcolor tinting (no triangle spam), series-color line
// segments, plotshape label boxes. DOM stubs.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function makeCtx() {
  const calls = { fills: 0, strokes: 0, texts: [] };
  const ctx = new Proxy({ _calls: calls }, {
    get(t, k) {
      if (k === 'measureText') return (s) => { calls.texts.push(s); return { width: s.length * 6 }; };
      if (k === 'fill') return (...a) => { calls.fills++; };
      if (k === 'stroke') return (...a) => { calls.strokes++; };
      if (k === '_calls') return calls;
      if (typeof k === 'string') return (...a) => {};
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return ctx;
}
function makeCanvas(w, h) {
  const listeners = {};
  const ctx = makeCtx();
  const cv = { width: 0, height: 0, clientWidth: w, clientHeight: h, style: {}, _listeners: listeners, _ctx: ctx,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    getContext() { return ctx; },
    getBoundingClientRect() { return { left: 0, top: 0, width: w, height: h }; } };
  return cv;
}
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
globalThis.document = { createElement: () => makeCanvas(100, 100) };
require('/home/hatch/workspace/backtest-platform/chart.js');
const Chart = globalThis.GoldChart;
let fail = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' ' + extra)); if (!cond) fail++; };

const N = 500;
const times = new Uint32Array(N), open = new Float32Array(N), high = new Float32Array(N), low = new Float32Array(N), close = new Float32Array(N);
for (let i = 0; i < N; i++) { times[i] = i; open[i] = 4000; high[i] = 4001; low[i] = 3999; close[i] = 4000 + (i % 2 ? 1 : -1); }
const candles = { n: N, times, open, high, low, close };

// Clone-like plots: barcolor (all true, per-point colors), a series-color
// line (green then red), a label plotshape with metadata, an xcross.
const plots = {
  'Candle Coloring': Array.from({ length: N }, (_, i) => ({ t: i * 60000, v: true, c: i % 3 === 0 ? '#00e676' : i % 3 === 1 ? '#ff1744' : '#7e57c2' })),
  'Smart Trail': Array.from({ length: N }, (_, i) => ({ t: i * 60000, v: 4000 + Math.sin(i / 20), c: i < 250 ? '#00e676' : '#ff1744' })),
  'Long': [{ t: 250 * 60000, v: true, c: '#089981', text: '▲', shape: 'shape_label_up', loc: 'BelowBar' },
           { t: 300 * 60000, v: true, c: '#089981', text: '▲+', shape: 'shape_label_up', loc: 'BelowBar' }],
  'Short': [{ t: 350 * 60000, v: true, c: '#f23645', text: '▼+', shape: 'shape_label_down', loc: 'AboveBar' }],
  'Exit X': [{ t: 400 * 60000, v: true, c: '#2962ff', shape: 'shape_xcross', loc: 'AboveBar' }],
};
const plotMeta = {
  'Candle Coloring': { title: 'Candle Coloring', overlay: true, color: '#7e57c2', style: 'barcolor' },
  'Smart Trail': { title: 'Smart Trail', overlay: true, color: '#ff1744' },
  'Long': { title: 'Long', overlay: true, color: '#089981', style: 'shape' },
  'Short': { title: 'Short', overlay: true, color: '#f23645', style: 'shape' },
  'Exit X': { title: 'Exit X', overlay: true, color: '#2962ff', style: 'shape' },
};
const main = makeCanvas(1000, 500), osc = makeCanvas(1000, 110);
const chart = new Chart(main, osc);
chart.setData(candles, plots, plotMeta, {}, []);

// _barColor: last barcolor plot wins; colors follow the per-point pattern.
ok('_barColor built from barcolor plot', chart._barColor && chart._barColor[0] === '#00e676' && chart._barColor[1] === '#ff1744' && chart._barColor[2] === '#7e57c2',
   JSON.stringify(chart._barColor && chart._barColor.slice(0, 3)));
ok('_plotCols built for series-color line', chart._plotCols['Smart Trail'] && chart._plotCols['Smart Trail'][0] === '#00e676' && chart._plotCols['Smart Trail'][300] === '#ff1744');
ok('no _plotVals for bool plots (barcolor/shape stay point-based)', !chart._plotVals['Candle Coloring'] && !chart._plotVals['Long'] && !!chart._plotVals['Smart Trail']);

// draw() must not throw with label boxes + xcross + tinted candles.
let threw = null;
try { chart.draw(); } catch (e) { threw = e; }
ok('draw() runs with barcolor + series colors + label shapes', threw === null, threw && threw.message);

// Label glyphs must be drawn as text (▲, ▲+, ▼+), not just triangles.
const texts = main._ctx._calls.texts;
ok('label glyphs rendered as text', texts.includes('▲') && texts.includes('▲+') && texts.includes('▼+'), JSON.stringify(texts.slice(0, 12)));
console.log(fail === 0 ? 'ALL CHART3 TESTS PASSED' : fail + ' FAILURES');
