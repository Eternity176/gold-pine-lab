// data.js — candle data layer for the backtest platform.
// Sources (priority): IndexedDB cache -> bundled data (2023-2025, Dukascopy BID)
//   -> live XAUUSD 1m candles (see fetchLiveCandles) -> CSV upload (fallback).
// Bundled data ships as base64 chunks (data/manifest.json, data/*.b64.N) because
// GitHub Pages cannot host the 20 MB binary .bin files via the push API; the
// .bin files are still used as a fallback for local dev (http.server).
// localStorage is NEVER used for candles.
//
// LIVE = real XAUUSD 1m candles (NOT PAXG — measured 2026-11-09, PAXG traded
// $13-20 BELOW spot, unusable for M1 gold work). Primary: /api/live, a
// same-origin Vercel server function that fetches Dukascopy XAU/USD BID spot
// (true spot, same source as bundled history) with Yahoo GC=F futures as its
// fallback. If the proxy is down, the browser tries Dukascopy json3 directly
// via JSONP (<script> tag, no CORS needed). Spot price (gold-api.com) is
// shown separately as a chip. There is a gap between the bundled end
// (2025-11-04) and the live window (latest ~1000 bars) — live bars are
// appended, not backfilled.
(function () {
  'use strict';

  const DB_NAME = 'gold-pine-lab';
  const STORE = 'candles';
  const META_STORE = 'meta';
  const BIN_YEARS = [2023, 2024, 2025];
  const TF_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '1H': 60, '1D': 1440 };

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, store, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
  function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // Binary format: [uint32 n][uint32 times[n] epoch minutes][float32 o/h/l/c]
  function parseBin(buf) {
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    const times = new Uint32Array(buf, 4, n);
    const off = 4 + 4 * n;
    const open = new Float32Array(buf, off, n);
    const high = new Float32Array(buf, off + 4 * n, n);
    const low = new Float32Array(buf, off + 8 * n, n);
    const close = new Float32Array(buf, off + 12 * n, n);
    return { n, times, open, high, low, close };
  }

  function mergeParts(parts) {
    let n = 0; for (const p of parts) n += p.n;
    const times = new Uint32Array(n), open = new Float32Array(n), high = new Float32Array(n),
      low = new Float32Array(n), close = new Float32Array(n);
    let idx = 0;
    for (const p of parts) {
      times.set(p.times, idx); open.set(p.open, idx); high.set(p.high, idx);
      low.set(p.low, idx); close.set(p.close, idx); idx += p.n;
    }
    return { n, times, open, high, low, close };
  }

  function resample(d, minutes) {
    if (minutes === 1) return d;
    const out = { times: [], open: [], high: [], low: [], close: [] };
    let cur = null;
    for (let i = 0; i < d.n; i++) {
      const bucket = Math.floor(d.times[i] / minutes) * minutes;
      if (!cur || cur.t !== bucket) {
        if (cur) out.times.push(cur.t), out.open.push(cur.o), out.high.push(cur.h), out.low.push(cur.l), out.close.push(cur.c);
        cur = { t: bucket, o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i] };
      } else {
        cur.h = Math.max(cur.h, d.high[i]); cur.l = Math.min(cur.l, d.low[i]); cur.c = d.close[i];
      }
    }
    if (cur) out.times.push(cur.t), out.open.push(cur.o), out.high.push(cur.h), out.low.push(cur.l), out.close.push(cur.c);
    return { n: out.times.length, times: Uint32Array.from(out.times), open: Float32Array.from(out.open), high: Float32Array.from(out.high), low: Float32Array.from(out.low), close: Float32Array.from(out.close) };
  }

  // --- Live XAUUSD candles: /api/live (Vercel server proxy) first, direct
  // Dukascopy json3 JSONP as fallback. Both return REAL XAUUSD (spot or
  // futures) — PAXG is gone (measured $13-20 below spot, 2026-11-09).
  // /api/live response: { source, symbol, basisNote?, bars: [[minute, o, h, l, c]] }.
  // Every attempt records a diagnostic so the UI never shows a generic
  // "Failed to fetch". No public CORS proxy is used as a source.
  const LIVE_PROXY_URL = '/api/live?limit=1000';
  const LIVE_TIMEOUT_MS = 8000;
  const SPOT_URL = 'https://api.gold-api.com/price/XAU'; // spot price only, no candles

  async function fetchWithTimeout(url, ms, opts) {
    const res = await fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Direct Dukascopy json3 via <script> tag (JSONP, no CORS needed).
  // Same endpoint the /api/live proxy uses server-side. Returns rows sorted asc.
  function fetchDukascopyJSONP(limit) {
    return new Promise((resolve, reject) => {
      const cb = '_dukaLive' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart/json3&splits=true&stocks=true'
        + '&time_direction=P&jsonp=' + cb + '&last_update=' + Date.now()
        + '&offer_side=B&instrument=XAU/USD&interval=1MIN&limit=' + limit;
      const script = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout after ' + LIVE_TIMEOUT_MS + 'ms')); }, LIVE_TIMEOUT_MS);
      function cleanup() { clearTimeout(timer); delete window[cb]; if (script.parentNode) script.parentNode.removeChild(script); }
      window[cb] = (arr) => {
        cleanup();
        try {
          if (!Array.isArray(arr) || !arr.length) throw new Error('Dukascopy returned 0 rows');
          const rows = arr.map((r) => [Math.floor(r[0] / 60000), +r[1], +r[2], +r[3], +r[4]])
            .filter((r) => r.every((v) => isFinite(v))).sort((a, b) => a[0] - b[0]);
          if (!rows.length) throw new Error('Dukascopy returned 0 usable rows');
          resolve(rows);
        } catch (e) { reject(e); }
      };
      script.onerror = () => { cleanup(); reject(new Error('script load failed')); };
      script.src = url;
      document.head.appendChild(script);
    });
  }

  // Returns { rows: [[minute, o, h, l, c], ...] sorted asc, feed, diag: [{feed, ok, bars|error}] }.
  // Throws an Error whose message lists every attempt + its reason.
  async function fetchLiveCandles() {
    const diag = [];
    // 1) Same-origin proxy (Dukascopy spot -> Yahoo GC=F futures, server-side).
    try {
      const j = await fetchWithTimeout(LIVE_PROXY_URL, LIVE_TIMEOUT_MS);
      if (!j || !Array.isArray(j.bars) || !j.bars.length) throw new Error('proxy returned 0 rows' + (j && j.error ? ': ' + j.error : ''));
      const rows = j.bars.filter((r) => Array.isArray(r) && r.every((v) => isFinite(v))).sort((a, b) => a[0] - b[0]);
      if (!rows.length) throw new Error('proxy returned 0 usable rows');
      const feed = j.source === 'yahoo-gcf' ? 'Yahoo GC=F (futures)' : 'Dukascopy XAU/USD (spot)';
      diag.push({ feed, ok: true, bars: rows.length });
      return { rows, feed, diag, basisNote: j.basisNote || null };
    } catch (e) {
      const reason = e && e.name === 'TimeoutError' ? 'timeout after ' + LIVE_TIMEOUT_MS + 'ms'
        : (e && e.message) || String(e);
      diag.push({ feed: '/api/live proxy', ok: false, error: reason });
    }
    // 2) Direct Dukascopy JSONP from the browser (no CORS needed).
    try {
      const rows = await fetchDukascopyJSONP(1000);
      diag.push({ feed: 'Dukascopy XAU/USD (spot, JSONP)', ok: true, bars: rows.length });
      return { rows, feed: 'Dukascopy XAU/USD (spot, JSONP)', diag };
    } catch (e) {
      diag.push({ feed: 'Dukascopy JSONP', ok: false, error: (e && e.message) || String(e) });
    }
    const err = new Error('All live sources failed — ' + diag.map((d) => d.feed + ': ' + d.error).join(' · '));
    err.diag = diag;
    throw err;
  }

  // Spot XAU price (gold-api.com). Best-effort, never blocks candle fetching.
  async function fetchSpotXAU() {
    try {
      const j = await fetchWithTimeout(SPOT_URL, 5000);
      if (j && isFinite(j.price)) return { price: +j.price, at: Date.now() };
    } catch (e) { /* ignore */ }
    return null;
  }

  // Merge live rows into an M1 series. Rows are sorted ascending by minute.
  // - row minute already present  -> update that bar in place (forming bar:
  //   open stays, high/low/close take the live values).
  // - row minute newer than last  -> append.
  // - row minute older than first -> skip (should not happen).
  // Returns a NEW series object (updates are written into copies of the arrays
  // only when appending; in-place updates mutate the passed-in arrays, which
  // are the in-memory state copy, not the IndexedDB cache).
  function mergeLiveRows(m1, rows) {
    const times = m1.times;
    let updated = 0;
    const appends = [];
    const seen = new Set();
    for (const r of rows) {
      const minute = r[0];
      if (seen.has(minute)) continue;
      seen.add(minute);
      // binary search for minute in times
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] === minute) { idx = mid; break; }
        if (times[mid] < minute) lo = mid + 1; else hi = mid - 1;
      }
      if (idx >= 0) {
        m1.high[idx] = Math.max(m1.high[idx], r[2]);
        m1.low[idx] = Math.min(m1.low[idx], r[3]);
        m1.close[idx] = r[4];
        updated++;
      } else if (minute > times[times.length - 1]) {
        appends.push(r);
      }
    }
    if (!appends.length) return { data: m1, appended: 0, updated };
    const n = m1.n + appends.length;
    const nt = new Uint32Array(n), no = new Float32Array(n), nh = new Float32Array(n),
      nl = new Float32Array(n), nc = new Float32Array(n);
    nt.set(times); no.set(m1.open); nh.set(m1.high); nl.set(m1.low); nc.set(m1.close);
    appends.forEach((r, i) => {
      const j = m1.n + i;
      nt[j] = r[0]; no[j] = r[1]; nh[j] = r[2]; nl[j] = r[3]; nc[j] = r[4];
    });
    return { data: { n, times: nt, open: no, high: nh, low: nl, close: nc }, appended: appends.length, updated };
  }

  // CSV upload: columns time,open,high,low,close,volume — time ISO UTC or epoch ms.
  function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw new Error('CSV rỗng hoặc thiếu dữ liệu');
    const header = lines[0].toLowerCase().split(',').map((s) => s.trim());
    const ci = (name) => header.indexOf(name);
    const ti = ci('time'), oi = ci('open'), hi = ci('high'), li = ci('low'), cl = ci('close');
    if (ti < 0 || oi < 0 || hi < 0 || li < 0 || cl < 0) throw new Error('CSV cần cột: time,open,high,low,close');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(',');
      if (f.length < 5) continue;
      let t = Number(f[ti]);
      if (!isFinite(t)) t = Date.parse(f[ti]);
      if (!isFinite(t)) continue;
      const ms = t > 1e12 ? t : t * 1000;
      const o = parseFloat(f[oi]), h = parseFloat(f[hi]), l = parseFloat(f[li]), c = parseFloat(f[cl]);
      if (![o, h, l, c].every(isFinite)) continue;
      rows.push([Math.floor(ms / 60000), o, h, l, c]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    const n = rows.length;
    const times = new Uint32Array(n), open = new Float32Array(n), high = new Float32Array(n),
      low = new Float32Array(n), close = new Float32Array(n);
    rows.forEach((r, i) => { times[i] = r[0]; open[i] = r[1]; high[i] = r[2]; low[i] = r[3]; close[i] = r[4]; });
    return { n, times, open, high, low, close };
  }

  // Bundled data as base64 chunks (for hosts that cannot serve the .bin files).
  // data/manifest.json: { "2023": ["2023.b64.0", "2023.b64.1", ...], ... }
  function b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function loadYearChunks(year, onProgress) {
    const res = await fetch('data/manifest.json');
    if (!res.ok) throw new Error('manifest.json HTTP ' + res.status);
    const man = await res.json();
    const files = man[String(year)];
    if (!Array.isArray(files) || !files.length) throw new Error('no chunks listed for ' + year);
    let b64 = '';
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(`Fetching data/${files[i]} (${i + 1}/${files.length})…`);
      const r = await fetch('data/' + files[i]);
      if (!r.ok) throw new Error(files[i] + ' HTTP ' + r.status);
      b64 += await r.text();
    }
    return b64ToArrayBuffer(b64);
  }

  const DataLayer = {
    TF_MINUTES,
    _db: null, _meta: null,
    async init() { this._db = await openDB(); },
    async loadBundled(onProgress) {
      const key = 'XAUUSD:M1:bundled';
      const cached = await idbGet(this._db, STORE, key);
      if (cached && cached.data) {
        const parts = cached.data.map((ab) => parseBin(ab));
        const merged = mergeParts(parts);
        this._meta = { source: 'Bundled binary (IndexedDB cache)', range: [merged.times[0], merged.times[merged.n - 1]], bars: merged.n, updatedAt: cached.savedAt };
        if (onProgress) onProgress('Loaded from IndexedDB cache');
        return merged;
      }
      const parts = [];
      const bufs = [];
      for (const y of BIN_YEARS) {
        if (onProgress) onProgress(`Fetching data/${y}…`);
        let buf = null;
        try { buf = await loadYearChunks(y, onProgress); }
        catch (e) {
          // Fallback for local dev (http.server): the original .bin files.
          if (onProgress) onProgress(`Chunks for ${y} unavailable (${e.message}) — trying data/${y}.bin…`);
          const res = await fetch(`data/${y}.bin`);
          if (!res.ok) throw new Error(`Không tải được data/${y} (chunks: ${e.message}; .bin: HTTP ${res.status}) — mở app qua http server, không mở file:// trực tiếp`);
          buf = await res.arrayBuffer();
        }
        bufs.push(buf);
        parts.push(parseBin(buf));
      }
      const merged = mergeParts(parts);
      try {
        await idbPut(this._db, STORE, { key, data: bufs, savedAt: Date.now() });
      } catch (e) { /* cache best-effort; ignore quota errors */ }
      this._meta = { source: 'Bundled binary (Dukascopy BID, 2023–2025)', range: [merged.times[0], merged.times[merged.n - 1]], bars: merged.n, updatedAt: Date.now() };
      return merged;
    },
    // Live update: fetch PAXG 1m candles from the 4-feed chain and merge them
    // into the bundled series. NEVER throws: on failure it returns the input
    // series unchanged and reports the per-feed diagnostics via onStatus.
    // Returns { data, ok, feed, diag, spot } — callers use .data as the series.
    async liveUpdate(m1, onStatus) {
      const out = { data: m1, ok: false, feed: null, diag: [], spot: null };
      const spotP = fetchSpotXAU(); // starts in parallel; spot never blocks candles
      try {
        const live = await fetchLiveCandles();
        out.feed = live.feed; out.diag = live.diag; out.basisNote = live.basisNote || null;
        const merged = mergeLiveRows(m1, live.rows);
        out.data = merged.data; out.ok = true;
        out.spot = await spotP;
        const lastMin = out.data.times[out.data.n - 1];
        const lastClose = out.data.close[out.data.n - 1];
        this._meta = { source: `Bundled + live (${live.feed})`, range: [out.data.times[0], lastMin], bars: out.data.n, updatedAt: Date.now() };
        this._liveDiag = live.diag;
        this._spot = out.spot;
        if (onStatus) onStatus(`live: ${live.feed} +${merged.appended} bars, ${merged.updated} updated · last ${lastClose.toFixed(2)} @ ${new Date(lastMin * 60000).toISOString().slice(11, 19)} UTC`);
        return out;
      } catch (e) {
        out.diag = (e && e.diag) || [];
        out.spot = await spotP.catch(() => null);
        if (onStatus) onStatus('live failed: ' + (e && e.message ? e.message : String(e)) + ' — still showing bundled 2023–2025 data');
        return out;
      }
    },
    liveDiag() { return this._liveDiag || []; },
    spot() { return this._spot || null; },
    async saveCustom(symbol, data) {
      await idbPut(this._db, STORE, { key: symbol + ':M1:custom', data, savedAt: Date.now() });
    },
    resample,
    parseCSV,
    meta() { return this._meta; },
  };
  globalThis.GoldData = DataLayer;
})();
