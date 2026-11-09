// GET /api/live?limit=1000 — server-side live XAUUSD 1m candles (Vercel fn).
//
// Why a server proxy: the best real-spot sources either block browser CORS
// (Yahoo GC=F sends no CORS headers) or bot-block direct browser calls, so
// the browser asks this same-origin endpoint instead. No key, no credentials.
//
// Chain (first source returning >= 1 row wins):
//   1. Dukascopy XAU/USD BID — TRUE spot forex, same source as the bundled
//      2023-2025 history (perfect continuity). Free public json3 endpoint,
//      JSONP stripped server-side. Verified 2026-11-09: limit=1000 returns
//      1000 rows, newest bar = current minute.
//   2. Yahoo GC=F — COMEX gold futures 1m. Real gold, but FUTURES: trades
//      ~+$3-4 above spot (basis, varies; jumps at contract roll) and has a
//      daily trading halt, so bars can be missing around the halt. Only used
//      when Dukascopy fails. The response says so explicitly.
// PAXG (Binance/Kraken/Gate/OKX) is DELIBERATELY NOT in this chain: measured
// 2026-11-09, PAXG traded $13-20 BELOW spot — unusable for M1 gold work.
//
// Response: { source, symbol, basisNote?, bars: [[minuteEpoch, o, h, l, c]] }
// (bars ascending by minute). On total failure: 502 { error, tried: [...] }.
// No caching: live data must never be served stale.
'use strict';

const DUKA_URL = (nowMs, limit) =>
  'https://freeserv.dukascopy.com/2.0/index.php?path=chart/json3&splits=true&stocks=true'
  + '&time_direction=P&jsonp=_cb&last_update=' + nowMs
  + '&offer_side=B&instrument=XAU/USD&interval=1MIN&limit=' + limit;

const YAHOO_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=5d&includePrePost=false';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };
const FETCH_MS = 8000;

async function fetchText(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function toRowsMinute(bars) {
  // bars: [[minuteEpoch, o, h, l, c]] — sort asc, drop bad rows, dedupe.
  const seen = new Set();
  return bars
    .filter((r) => Array.isArray(r) && r.length >= 5 && r.slice(0, 5).every((v) => isFinite(v)))
    .map((r) => [Math.floor(r[0]), +r[1], +r[2], +r[3], +r[4]])
    .sort((a, b) => a[0] - b[0])
    .filter((r) => (seen.has(r[0]) ? false : (seen.add(r[0]), true)));
}

async function dukascopy(limit) {
  const text = await fetchText(DUKA_URL(Date.now(), limit), {
    ...UA,
    Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index',
  });
  // JSONP: _cb([[ms,o,h,l,c,vol], ...]) newest-first.
  const m = text.match(/_cb\((.*)\);?\s*$/s);
  if (!m) throw new Error('unexpected Dukascopy response');
  const arr = JSON.parse(m[1]);
  if (!Array.isArray(arr) || !arr.length) throw new Error('Dukascopy returned 0 rows');
  const bars = toRowsMinute(arr.map((r) => [Math.floor(r[0] / 60000), r[1], r[2], r[3], r[4]]));
  if (!bars.length) throw new Error('Dukascopy returned 0 usable rows');
  return { source: 'dukascopy', symbol: 'XAU/USD BID (spot)', bars };
}

async function yahooGCF() {
  const text = await fetchText(YAHOO_URL, UA);
  const d = JSON.parse(text);
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r) throw new Error('Yahoo returned no result: ' + (d && d.chart && d.chart.error ? d.chart.error.description : 'unknown'));
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if ([o, h, l, c].every((v) => isFinite(v))) bars.push([Math.floor(ts[i] / 60), o, h, l, c]);
  }
  if (!bars.length) throw new Error('Yahoo GC=F returned 0 usable rows');
  return {
    source: 'yahoo-gcf',
    symbol: 'GC=F (COMEX gold futures)',
    basisNote: 'Futures, not spot: trades a few dollars above XAU/USD spot (basis varies, jumps at roll) and halts daily — bars can be missing around the halt.',
    bars: toRowsMinute(bars),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const limit = Math.max(1, Math.min(2000, parseInt((req.query && req.query.limit) || '1000', 10) || 1000));
  const tried = [];
  for (const fn of [() => dukascopy(limit), yahooGCF]) {
    try {
      const out = await fn();
      res.status(200).end(JSON.stringify(out));
      return;
    } catch (e) {
      tried.push({ source: fn === yahooGCF ? 'yahoo-gcf' : 'dukascopy', error: (e && e.message) || String(e) });
    }
  }
  res.status(502).end(JSON.stringify({ error: 'All live sources failed', tried }));
};
