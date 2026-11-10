// Node runner: run a Pine script on the REAL XAUUSD M1 .bin data via PineTS
// (same engine + same data as the browser platform) and print IS/OS metrics.
// Usage: node tools/run_platform.mjs [script.pine] [maxBars]
//   script defaults to strategies/r7_wpr_ema34.pine; maxBars 0 = all.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PineTS, aggregateCandles } from "pinets";

// MTF provider (mirror of pine-worker.js makeLocalProvider, but using the
// lib's aggregateCandles — verified byte-identical to the worker's hand-rolled
// version on the full 1,008,574-bar history for 15m/60/240/1D). Without this,
// `new PineTS(candles)` leaves ticker/timeframe undefined and every
// request.security call throws; even fixed, HTF security returns chart bars
// 1:1 and H1-dependent strategies silently make 0 trades.
function parseTfMinutes(tf) {
  const s = String(tf);
  let m = s.match(/^(\d+)$/); if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)m$/i); if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)H$/i); if (m) return parseInt(m[1], 10) * 60;
  m = s.match(/^(\d+)D$/i); if (m) return parseInt(m[1], 10) * 1440;
  m = s.match(/^(\d+)W$/i); if (m) return parseInt(m[1], 10) * 10080;
  return 1;
}
function makeLocalProvider(baseCandles, symbol, baseMins) {
  const cache = new Map();
  const syminfo = { pointvalue: 1, mintick: 0.01, currency: "USD", timezone: "UTC", tickerid: symbol, ticker: symbol, description: symbol, type: "commodity", basecurrency: "USD", country: "US", pricescale: 100, minmove: 1, session: "24x7" };
  return {
    getMarketData: async (tickerId, timeframe, limit, sDate, eDate) => {
      const key = String(timeframe);
      if (!cache.has(key)) {
        const mins = parseTfMinutes(key);
        cache.set(key, mins <= baseMins ? baseCandles : aggregateCandles(baseCandles, String(mins), "1m", { calendarGrid: true }));
      }
      let bars = cache.get(key);
      if (sDate != null) bars = bars.filter((b) => b.openTime >= sDate);
      if (eDate != null) bars = bars.filter((b) => b.openTime <= eDate);
      if (limit != null && bars.length > limit) bars = bars.slice(bars.length - limit);
      return bars;
    },
    getSymbolInfo: async (tickerId) => ({ ...syminfo }),
    configure: () => {},
  };
}

await import("../tester.js");
const T = globalThis.GoldTester;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function loadBin(p) {
  const buf = fs.readFileSync(p);
  const n = buf.readUInt32LE(0);
  const t = new Uint32Array(buf.buffer, buf.byteOffset + 4, n);
  const o = new Float32Array(buf.buffer, buf.byteOffset + 4 + 4 * n, n);
  const h = new Float32Array(buf.buffer, buf.byteOffset + 4 + 8 * n, n);
  const l = new Float32Array(buf.buffer, buf.byteOffset + 4 + 12 * n, n);
  const c = new Float32Array(buf.buffer, buf.byteOffset + 4 + 16 * n, n);
  return { n, t, o, h, l, c };
}

const scriptPath = process.argv[2] || path.join(ROOT, "strategies/r7_wpr_ema34.pine");
const maxBars = parseInt(process.argv[3] || "0", 10);
let src = fs.readFileSync(scriptPath, "utf8");
// Optional capital override (parity runs): CAPITAL=100000 node run_platform.mjs ...
const capital = parseFloat(process.env.CAPITAL || "0");
if (capital > 0) src = src.replace("initial_capital=10000", `initial_capital=${capital}`);
const dumpPath = process.env.DUMP_TRADES || "";

const parts = ["2023", "2024", "2025"].map((y) => loadBin(path.join(ROOT, "data", `${y}.bin`)));
const total = parts.reduce((a, p) => a + p.n, 0);
const N = maxBars > 0 ? Math.min(maxBars, total) : total;

const t0 = Date.now();
const candles = new Array(N);
let idx = 0;
for (const p of parts) {
  for (let i = 0; i < p.n && idx < N; i++, idx++) {
    candles[idx] = { open: p.o[i], high: p.h[i], low: p.l[i], close: p.c[i], volume: 0, openTime: p.t[i] * 60000, closeTime: p.t[i] * 60000 + 60000, quoteAssetVolume: 0, numberOfTrades: 0, takerBuyBaseAssetVolume: 0, takerBuyQuoteAssetVolume: 0, ignore: 0 };
  }
}
console.error(`candles built: ${N} in ${Date.now() - t0}ms`);

const pine = new PineTS(makeLocalProvider(candles, "XAUUSD", 1), "XAUUSD", "1m");
const t1 = Date.now();
const ctx = await pine.run(src);
const runMs = Date.now() - t1;
if (ctx.error) { console.error("PINE ERROR:", JSON.stringify(ctx.error)); process.exit(2); }
const plots = ctx.plots || {};
const s = ctx.strategy;

const close = new Float64Array(N);
const timeMs = new Array(N);
for (let i = 0; i < N; i++) { close[i] = candles[i].close; timeMs[i] = candles[i].openTime; }

let out = { script: path.basename(scriptPath), bars: N, runMs, plots: Object.keys(plots) };
if (s) {
  const trades = (s.closedtrades || []).map((tr) => ({
    entry_bar_index: tr.entry_bar_index, exit_bar_index: tr.exit_bar_index,
    entry_price: tr.entry_price, exit_price: tr.exit_price,
    size: tr.size, profit: tr.profit, commission: tr.commission,
    entry_time: tr.entry_time, exit_time: tr.exit_time,
    entry_id: tr.entry_id, exit_id: tr.exit_id,
    dir: tr.size >= 0 ? 1 : -1,
  }));
  const eq = T.buildEquityCurve(trades, { close, timeMs }, s.initial_capital || 10000);
  const split = T.splitMetrics(trades, eq, timeMs, s.initial_capital || 10000);
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify(trades));
  out.strategy = {
    netprofit: s.netprofit, grossprofit: s.grossprofit, grossloss: s.grossloss,
    max_drawdown: s.max_drawdown, max_drawdown_pct: s.max_drawdown_percent_value,
    sharpe: s.sharpe_ratio, sortino: s.sortino_ratio,
    closedtrades: trades.length, open_trades: (s.opentrades || []).length,
    total_commission: trades.reduce((a, t) => a + (t.commission || 0), 0),
    first_trades: trades.slice(0, 3),
  };
  out.is = split.is; out.os = split.os; out.os_rebase_factor = split.os_rebase_factor;
} else {
  out.strategy = null;
}
console.log(JSON.stringify(out, (k, v) => (typeof v === "number" && !isFinite(v) ? String(v) : v), 2));
