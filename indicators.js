// indicators.js — built-in TradingView-style indicators, pure JS math.
// No DOM, no Pine: computed on the current candle series (any timeframe) and
// drawn by chart.js as bar-indexed series (Float64Array, NaN = no value).
// All closed-bar only: values[i] uses bars 0..i, never the future.
// VWAP is deliberately absent: the bundled data has no volume (OHLC only).
(function () {
  'use strict';

  // Float32 storage: prices ~4100.123 need ~7 significant digits — Float32
  // holds that (error ~0.0001, invisible on the chart) and halves the memory
  // bandwidth of a full 1M-bar compute vs Float64. All math stays Float64.
  const N = (n) => new Float32Array(n).fill(NaN);

  // All rolling helpers are NaN-aware: a NaN inside the window does not
  // poison the sum (the old code let one leading NaN kill SMA/EMA forever —
  // that broke MACD signal and Stoch %D, which are SMAs/EMAs of derived
  // series that start with NaNs). A value is emitted only once the last
  // `len` inputs are all valid (matches Pine ta.sma/ta.stdev).
  function smaArr(src, n, len) {
    const out = N(n);
    if (len < 1 || len > n) return out;
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (!Number.isNaN(v)) { sum += v; cnt++; }
      if (i >= len) { const o = src[i - len]; if (!Number.isNaN(o)) { sum -= o; cnt--; } }
      if (cnt === len) out[i] = sum / len;
    }
    return out;
  }

  // Pine-style EMA: seeded with the FIRST valid value (ta.ema), not with an
  // SMA — matches TradingView. A NaN input yields NaN for that bar but does
  // not reset the state.
  function emaArr(src, n, len) {
    const out = N(n);
    if (len < 1) return out;
    const k = 2 / (len + 1);
    let prev = NaN;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (Number.isNaN(v)) { out[i] = NaN; continue; }
      if (Number.isNaN(prev)) prev = v;
      else prev = prev + k * (v - prev);
      out[i] = prev;
    }
    return out;
  }

  // Wilder's RMA (RSI, ATR): same Pine-style seeding as EMA, alpha = 1/len.
  function rmaArr(src, n, len) {
    const out = N(n);
    if (len < 1) return out;
    const k = 1 / len;
    let prev = NaN;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (Number.isNaN(v)) { out[i] = NaN; continue; }
      if (Number.isNaN(prev)) prev = v;
      else prev = prev + k * (v - prev);
      out[i] = prev;
    }
    return out;
  }

  function rollingStd(src, n, len) {
    // Population std (matches Pine ta.stdev). NaN-aware like smaArr.
    const out = N(n);
    if (len < 1 || len > n) return out;
    let sum = 0, sumSq = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (!Number.isNaN(v)) { sum += v; sumSq += v * v; cnt++; }
      if (i >= len) { const o = src[i - len]; if (!Number.isNaN(o)) { sum -= o; sumSq -= o * o; cnt--; } }
      if (cnt === len) {
        const mean = sum / len;
        out[i] = Math.sqrt(Math.max(0, sumSq / len - mean * mean));
      }
    }
    return out;
  }

  // Sliding-window max/min in O(n) via a monotonic deque. The deque is a
  // ring buffer (head/tail indices) — Array.shift() would make it O(n^2).
  function highestArr(src, n, len) {
    const out = N(n);
    const dq = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) {
      while (qt > qh && src[dq[qt - 1]] <= src[i]) qt--;
      dq[qt++] = i;
      if (dq[qh] <= i - len) qh++;
      if (i >= len - 1) out[i] = src[dq[qh]];
    }
    return out;
  }
  function lowestArr(src, n, len) {
    const out = N(n);
    const dq = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) {
      while (qt > qh && src[dq[qt - 1]] >= src[i]) qt--;
      dq[qt++] = i;
      if (dq[qh] <= i - len) qh++;
      if (i >= len - 1) out[i] = src[dq[qh]];
    }
    return out;
  }

  function atrArr(c, len) {
    const n = c.n, tr = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i === 0) tr[i] = c.high[i] - c.low[i];
      else tr[i] = Math.max(c.high[i] - c.low[i], Math.abs(c.high[i] - c.close[i - 1]), Math.abs(c.low[i] - c.close[i - 1]));
    }
    return rmaArr(tr, n, len);
  }

  function splitSign(values, n) {
    const up = N(n), dn = N(n);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (typeof v !== 'number' || Number.isNaN(v)) continue;
      if (v >= 0) up[i] = v; else dn[i] = v;
    }
    return [up, dn];
  }

  const DEFS = [
    {
      id: 'sma', name: 'Moving Average', overlay: true,
      params: [{ key: 'length', label: 'Length', def: 20, min: 1, max: 500, step: 1 }],
      compute(c, p) {
        return [{ key: 'sma', label: `MA ${p.length}`, overlay: true, color: '#2962ff', values: smaArr(c.close, c.n, p.length) }];
      },
    },
    {
      id: 'ema', name: 'Exponential MA', overlay: true,
      params: [{ key: 'length', label: 'Length', def: 20, min: 1, max: 500, step: 1 }],
      compute(c, p) {
        return [{ key: 'ema', label: `EMA ${p.length}`, overlay: true, color: '#ff9800', values: emaArr(c.close, c.n, p.length) }];
      },
    },
    {
      id: 'bb', name: 'Bollinger Bands', overlay: true,
      params: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 500, step: 1 },
        { key: 'mult', label: 'StdDev', def: 2.0, min: 0.1, max: 5, step: 0.1 },
      ],
      compute(c, p) {
        const mid = smaArr(c.close, c.n, p.length);
        const sd = rollingStd(c.close, c.n, p.length);
        const up = N(c.n), lo = N(c.n);
        for (let i = 0; i < c.n; i++) {
          if (Number.isNaN(mid[i])) continue;
          up[i] = mid[i] + p.mult * sd[i];
          lo[i] = mid[i] - p.mult * sd[i];
        }
        return [
          { key: 'bb-upper', label: `BB ${p.length} ${p.mult} upper`, overlay: true, color: '#2962ff', values: up },
          { key: 'bb-basis', label: `BB ${p.length} ${p.mult} basis`, overlay: true, color: '#ff9800', values: mid },
          { key: 'bb-lower', label: `BB ${p.length} ${p.mult} lower`, overlay: true, color: '#2962ff', values: lo },
        ];
      },
    },
    {
      id: 'rsi', name: 'Relative Strength Index', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 }],
      compute(c, p) {
        const n = c.n, len = p.length;
        const gain = new Float64Array(n).fill(NaN), loss = new Float64Array(n).fill(NaN);
        for (let i = 1; i < n; i++) { // bar 0 has no change (Pine ta.change = na)
          const ch = c.close[i] - c.close[i - 1];
          gain[i] = Math.max(0, ch); loss[i] = Math.max(0, -ch);
        }
        const ag = rmaArr(gain, n, len), al = rmaArr(loss, n, len);
        const out = N(n);
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(ag[i])) continue;
          if (al[i] === 0) out[i] = ag[i] > 0 ? 100 : 50;
          else out[i] = 100 - 100 / (1 + ag[i] / al[i]);
        }
        return [{ key: 'rsi', label: `RSI ${len}`, overlay: false, pane: `RSI ${len}`, color: '#7e57c2', values: out,
          levels: [{ v: 70, color: '#787b86' }, { v: 30, color: '#787b86' }] }];
      },
    },
    {
      id: 'macd', name: 'MACD', overlay: false,
      params: [
        { key: 'fast', label: 'Fast', def: 12, min: 1, max: 200, step: 1 },
        { key: 'slow', label: 'Slow', def: 26, min: 1, max: 200, step: 1 },
        { key: 'signal', label: 'Signal', def: 9, min: 1, max: 200, step: 1 },
      ],
      compute(c, p) {
        const n = c.n;
        const ef = emaArr(c.close, n, p.fast), es = emaArr(c.close, n, p.slow);
        const macd = N(n);
        for (let i = 0; i < n; i++) macd[i] = (Number.isNaN(ef[i]) || Number.isNaN(es[i])) ? NaN : ef[i] - es[i];
        const sig = emaArr(macd, n, p.signal);
        const hist = N(n);
        for (let i = 0; i < n; i++) hist[i] = (Number.isNaN(macd[i]) || Number.isNaN(sig[i])) ? NaN : macd[i] - sig[i];
        const [hUp, hDn] = splitSign(hist, n);
        const pane = `MACD ${p.fast} ${p.slow} ${p.signal}`;
        return [
          { key: 'macd', label: 'MACD', overlay: false, pane, color: '#2962ff', values: macd },
          { key: 'macd-signal', label: 'Signal', overlay: false, pane, color: '#ff9800', values: sig },
          { key: 'macd-hist-up', label: 'Hist', overlay: false, pane, color: '#089981', style: 'histogram', values: hUp },
          { key: 'macd-hist-dn', label: 'Hist', overlay: false, pane, color: '#f23645', style: 'histogram', values: hDn },
        ];
      },
    },
    {
      id: 'stoch', name: 'Stochastic', overlay: false,
      params: [
        { key: 'k', label: '%K length', def: 14, min: 1, max: 200, step: 1 },
        { key: 'smoothK', label: '%K smooth', def: 3, min: 1, max: 50, step: 1 },
        { key: 'smoothD', label: '%D smooth', def: 3, min: 1, max: 50, step: 1 },
      ],
      compute(c, p) {
        const n = c.n;
        const hh = highestArr(c.high, n, p.k), ll = lowestArr(c.low, n, p.k);
        const raw = N(n);
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(hh[i])) continue;
          raw[i] = hh[i] === ll[i] ? 50 : 100 * (c.close[i] - ll[i]) / (hh[i] - ll[i]);
        }
        const k = smaArr(raw, n, p.smoothK);
        const d = smaArr(k, n, p.smoothD);
        const pane = `Stoch ${p.k} ${p.smoothK} ${p.smoothD}`;
        return [
          { key: 'stoch-k', label: '%K', overlay: false, pane, color: '#2962ff', values: k,
            levels: [{ v: 80, color: '#787b86' }, { v: 20, color: '#787b86' }] },
          { key: 'stoch-d', label: '%D', overlay: false, pane, color: '#ff9800', values: d },
        ];
      },
    },
    {
      id: 'atr', name: 'Average True Range', overlay: false,
      params: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 }],
      compute(c, p) {
        return [{ key: 'atr', label: `ATR ${p.length}`, overlay: false, pane: `ATR ${p.length}`, color: '#00bcd4', values: atrArr(c, p.length) }];
      },
    },
    {
      id: 'supertrend', name: 'Supertrend', overlay: true,
      params: [
        { key: 'atrLength', label: 'ATR length', def: 14, min: 1, max: 200, step: 1 },
        { key: 'factor', label: 'Factor', def: 3.0, min: 0.1, max: 10, step: 0.1 },
      ],
      compute(c, p) {
        const n = c.n;
        const atr = atrArr(c, p.atrLength);
        const up = N(n), dn = N(n);
        let fUp = NaN, fLo = NaN, trend = 1; // 1 = up, -1 = down
        let started = false;
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(atr[i])) continue;
          const hl2 = (c.high[i] + c.low[i]) / 2;
          const bUp = hl2 + p.factor * atr[i], bLo = hl2 - p.factor * atr[i];
          if (!started) { fUp = bUp; fLo = bLo; started = true; }
          else {
            fUp = (bUp < fUp || c.close[i - 1] > fUp) ? bUp : fUp;
            fLo = (bLo > fLo || c.close[i - 1] < fLo) ? bLo : fLo;
            if (trend === 1 && c.close[i] < fLo) trend = -1;
            else if (trend === -1 && c.close[i] > fUp) trend = 1;
          }
          if (trend === 1) up[i] = fLo; else dn[i] = fUp;
        }
        return [
          { key: 'st-up', label: `Supertrend ${p.atrLength} ${p.factor} (up)`, overlay: true, color: '#089981', values: up },
          { key: 'st-dn', label: `Supertrend ${p.atrLength} ${p.factor} (down)`, overlay: true, color: '#f23645', values: dn },
        ];
      },
    },
  ];

  function defaults(def) {
    const p = {};
    for (const par of def.params) p[par.key] = par.def;
    return p;
  }

  // active: [{ id, params }] -> flat series list (each with .owner = active entry index)
  function computeAll(candles, active) {
    const out = [];
    (active || []).forEach((a, ai) => {
      const def = DEFS.find((d) => d.id === a.id);
      if (!def) return;
      const params = { ...defaults(def), ...(a.params || {}) };
      for (const s of def.compute(candles, params)) { s.owner = ai; out.push(s); }
    });
    return out;
  }

  globalThis.GoldIndicators = { defs: DEFS, defaults, computeAll };
})();
