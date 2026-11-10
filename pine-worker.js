// pine-worker.js — Web Worker: runs PineTS on candle data + computes Strategy
// Tester metrics (GoldTester) with the 8 R7 gates, IS/OS split.
//   in:  {type:'run', code, times:Uint32Array, open/high/low/close:Float32Array,
//         symbol, timeframe, initialCapital}
//   out: {type:'result', plots, tables, labels, lines, boxes, strategy, gates, ...}
//        {type:'error', message, line} | {type:'progress', msg}
// Plots are downsampled to <= 20000 points per series for postMessage size;
// trades + equity curve are returned in full (trades) / downsampled (curve).
//
// MAINTENANCE: when you change this file, also bump WORKER_VERSION in app.js.
// The worker is created once per page load and REUSED for every run, so a
// browser tab opened before the deploy keeps running the OLD worker until
// the page reloads — and the ?v= query forces a fresh fetch even then
// (2026-11-10: a stale pre-closeTime worker showed signals in old history
// but zero in realtime, exactly the pre-fix bug).
//
// Speed (2026-11-09): the worker is REUSED across runs (app.js keeps one
// worker alive) and the compiled Pine script is cached — changing the data
// window (preview 20k <-> full 1M) does NOT recompile. PineTS exposes this
// as runPretranspiled(transpiledFn, inputs): pine._transpiledCode holds the
// transpiled function after a pine.run(). Verified in Node (tools/test_cache_tmp.mjs):
// cached run on 20k bars gives byte-identical trades + plots vs fresh pine.run().

// --- CSP-safe Function shim -------------------------------------------------
// PineTS compiles Pine to JS and executes it via `new Function(...)` (2 call
// sites in vendor/pinets.min.browser.js). Hosts whose CSP blocks 'unsafe-eval'
// (the old artifact host did) make that throw. The shim detects a blocked
// Function constructor and replaces it with a version that loads the same
// code as a blob: URL via importScripts — blob: is an allowed script source,
// and loading a script is NOT string evaluation, so it passes the CSP.
// On Vercel / GitHub Pages there is no CSP blocking eval, so the native
// Function is used and the shim stays dormant.
(function installFunctionShim() {
  let ok = true;
  try { new Function('return 1')(); } catch (e) { ok = false; }
  if (ok) return;
  let counter = 0;
  function FunctionShim(...args) {
    const body = args.length ? args[args.length - 1] : '';
    const params = args.slice(0, -1);
    const id = '__pine_fn_' + (++counter) + '_' + Math.random().toString(36).slice(2);
    const src = 'self.' + id + ' = function(' + params.join(',') + ') {\n' + body + '\n};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try { importScripts(url); } finally { URL.revokeObjectURL(url); }
    const fn = self[id];
    try { delete self[id]; } catch (e) { /* ignore */ }
    return fn;
  }
  self.Function = FunctionShim;
})();

importScripts('vendor/pinets.min.browser.js', 'tester.js');

// Compiled-script cache: { code, fn, inputs }. Keyed by exact source text.
const compileCache = { code: null, fn: null, inputs: null };

const T = globalThis.GoldTester;
const MAX_PLOT_POINTS = 20000;
const MAX_CURVE_POINTS = 5000;

function isValid(v) { return v !== null && v !== undefined && typeof v === 'number' && !Number.isNaN(v); }

function downsamplePlot(data, maxPts) {
  // data: [{time, value, options?}] — keep stride sampling + always keep
  // last point. Per-point options are preserved: `c` = the point's own
  // color (PineTS puts series colors here, e.g. a Smart Trail that is
  // green when up and red when down), `text`/`shape`/`loc` = plotshape
  // metadata (label glyph, shape kind, AboveBar/BelowBar). Without these
  // the chart can only draw one flat color per plot and cannot tell a
  // barcolor plot (values all `true`) from a plotshape.
  const mapPt = (p) => {
    const o = { t: p.time, v: p.value };
    const po = p.options;
    if (po) {
      if (po.color) o.c = po.color;
      if (po.text) o.text = po.text;
      if (po.shape) o.shape = po.shape;
      if (po.location) o.loc = po.location;
    }
    return o;
  };
  const n = data.length;
  if (n <= maxPts) return data.map(mapPt);
  const stride = Math.ceil(n / maxPts);
  const out = [];
  for (let i = 0; i < n; i += stride) out.push(mapPt(data[i]));
  const last = data[n - 1];
  if (out[out.length - 1].t !== last.time) out.push(mapPt(last));
  return out;
}

function seriesStats(data) {
  let valid = 0, last = null, firstIdx = -1;
  for (let i = 0; i < data.length; i++) {
    const v = data[i].value;
    if (isValid(v) || v === true || v === false) { valid++; last = v; if (firstIdx < 0) firstIdx = i; }
  }
  return { points: data.length, valid, last, firstIdx };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;
  const t0 = Date.now();
  try {
    const n = msg.times.length;
    // PineTS derives barstate.isconfirmed from each bar's closeTime
    // (closeTime <= Date.now()). The candles we pass have no closeTime, so
    // PineTS falls back to openTime + 1 day — on any recent window (last bar
    // within a day of now) EVERY bar reads as unconfirmed, and any script
    // gating on barstate.isconfirmed (e.g. the LuxAlgo clone's
    // confirmOnClose) produces zero signals. Set closeTime = openTime +
    // the bar's own interval: closed bars confirm, the forming bar does
    // not — exactly TradingView's semantics. (Found 2026-11-10: the clone
    // gave 0 signals on 1000 live bars while its raw triggers were true on
    // 293/319 bars; isconfirmed was 0/1000 until closeTime was set.)
    const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1H': 60, '1D': 1440 };
    const tfMs = (TF_MINUTES[msg.timeframe] || 1) * 60000;
    const candles = new Array(n);
    for (let i = 0; i < n; i++) {
      const openTime = msg.times[i] * 60000;
      candles[i] = { open: msg.open[i], high: msg.high[i], low: msg.low[i], close: msg.close[i], volume: 0, openTime, closeTime: openTime + tfMs };
    }
    const pine = new PineTSLib.PineTS(candles);
    let ctx;
    if (compileCache.code === msg.code && typeof compileCache.fn === 'function') {
      // Same script as the previous run — reuse the transpiled function.
      self.postMessage({ type: 'progress', msg: `Compiled script cached — running on ${n.toLocaleString()} bars…` });
      try {
        ctx = await pine.runPretranspiled(compileCache.fn, compileCache.inputs || {});
      } catch (e) {
        // Cache path failed (should not happen) — fall back to a full compile.
        self.postMessage({ type: 'progress', msg: 'Cached run failed — recompiling…' });
        compileCache.code = null; compileCache.fn = null; compileCache.inputs = null;
        ctx = await pine.run(msg.code);
      }
    } else {
      self.postMessage({ type: 'progress', msg: `Compiling Pine…` });
      ctx = await pine.run(msg.code);
    }
    if (ctx.error) {
      self.postMessage({ type: 'error', message: String(ctx.error.message || ctx.error), line: ctx.error.line || null, runMs: Date.now() - t0 });
      return;
    }
    // Cache the transpiled function for the next run (same code, new window).
    if (typeof pine._transpiledCode === 'function') {
      compileCache.code = msg.code;
      compileCache.fn = pine._transpiledCode;
      compileCache.inputs = ctx.inputs || {};
    }
    self.postMessage({ type: 'progress', msg: `Computing Tester metrics…` });
    const plots = {};
    const plotMeta = {};
    for (const key of Object.keys(ctx.plots || {})) {
      if (key.startsWith('__')) continue; // drawings/tables handled separately
      const p = ctx.plots[key];
      const data = p.data || [];
      // Boolean plots (plotshape / barcolor) carry no information in their
      // `false` points — the chart skips them. Filter to `true` only before
      // downsampling so stride sampling can never drop a real signal.
      const isBoolPlot = data.some((d) => d.value === true || d.value === false);
      const plotData = isBoolPlot ? data.filter((d) => d.value === true) : data;
      plots[key] = downsamplePlot(plotData, MAX_PLOT_POINTS);
      plotMeta[key] = { title: p.title || key, overlay: p.options ? p.options.overlay !== false : true, color: p.options && p.options.color, style: p.options && p.options.style, ...seriesStats(data) };
    }
    // Drawings: PineTS keeps only the FINAL active set (single-entry series).
    const draw = (k) => {
      const p = ctx.plots && ctx.plots[k];
      if (!p || !p.data || !p.data.length) return [];
      const v = p.data[0].value;
      return Array.isArray(v) ? v : [];
    };
    const tables = draw('__tables__');
    const labels = draw('__labels__');
    const lines = draw('__lines__');
    const boxes = draw('__boxes__');
    const out = { type: 'result', bars: n, runMs: Date.now() - t0, plots, plotMeta, tables, labels, lines, boxes, symbol: msg.symbol, timeframe: msg.timeframe };
    const s = ctx.strategy;
    if (s) {
      const trades = (s.closedtrades || []).map((tr) => ({
        entry_bar_index: tr.entry_bar_index, exit_bar_index: tr.exit_bar_index,
        entry_price: tr.entry_price, exit_price: tr.exit_price,
        size: tr.size, profit: tr.profit, commission: tr.commission || 0,
        entry_time: tr.entry_time, exit_time: tr.exit_time,
        entry_id: tr.entry_id, exit_id: tr.exit_id,
        dir: tr.size >= 0 ? 1 : -1,
      }));
      const close = new Float64Array(n);
      const timeMs = new Array(n);
      for (let i = 0; i < n; i++) { close[i] = candles[i].close; timeMs[i] = candles[i].openTime; }
      const capital = s.initial_capital || msg.initialCapital || 10000;
      const eq = T.buildEquityCurve(trades, { close, timeMs }, capital);
      const split = T.splitMetrics(trades, eq, timeMs, capital);
      // Downsample equity curve for display.
      const curve = [];
      const stride = Math.max(1, Math.ceil(eq.length / MAX_CURVE_POINTS));
      for (let i = 0; i < eq.length; i += stride) curve.push({ t: timeMs[i], e: eq[i] });
      if (curve[curve.length - 1].t !== timeMs[n - 1]) curve.push({ t: timeMs[n - 1], e: eq[n - 1] });
      out.strategy = {
        netprofit: s.netprofit, grossprofit: s.grossprofit, grossloss: s.grossloss,
        max_drawdown: s.max_drawdown, max_drawdown_pct: s.max_drawdown_percent_value,
        sharpe: s.sharpe_ratio, sortino: s.sortino_ratio,
        closedtrades: trades.length, open_trades: (s.opentrades || []).length,
        total_commission: trades.reduce((a, t) => a + (t.commission || 0), 0),
        initial_capital: capital,
      };
      out.trades = trades;
      out.equityCurve = curve;
      out.is = split.is; out.os = split.os; out.os_rebase_factor = split.os_rebase_factor;
    }
    out.runMs = Date.now() - t0;
    self.postMessage(out);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err), runMs: Date.now() - t0 });
  }
};
