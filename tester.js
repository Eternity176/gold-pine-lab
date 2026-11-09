// tester.js — shared Strategy Tester math (plain script, no imports).
// Loads in: browser main thread (<script>), pine-worker.js (importScripts),
// Node tools (import side-effect). Attaches to globalThis.GoldTester.
// Inputs are PineTS closed-trade objects (entry/exit bar index, price, size,
// profit) + candles; the lab parity script (tools/run_parity.py) mirrors the
// same math in Python — see PARITY.md for the comparison.
//
// R:R note: PineTS Trade carries no per-trade stop/risk, so realized R:R is
// reported as the payoff ratio avgWin$/|avgLoss$|. That EQUALS R:R exactly when
// risk/trade is constant (fixed-% risk, e.g. R7 risk 1%), and is a close
// approximation otherwise. Expectancy gate (>0) is checked on mean pnl$ (same
// sign as expectancy in R). PARITY.md quantifies the deviation vs the lab.
(function () {
  "use strict";

  // trades: [{entry_bar_index, exit_bar_index, entry_price, exit_price, size, profit, dir}]
  //   dir: +1 long / -1 short (derived from size sign if missing).
  // candles: {close: Float64Array|Array, timeMs: Array<number>} (time = bar OPEN, ms).
  // Returns Float64Array equity per bar (mark-to-market at close, ffilled).
  function buildEquityCurve(trades, candles, initial) {
    var n = candles.close.length;
    var eq = new Float64Array(n);
    for (var i = 0; i < n; i++) eq[i] = NaN;
    var realized = initial;
    var sorted = trades.slice().sort(function (a, b) { return a.entry_bar_index - b.entry_bar_index; });
    for (var t = 0; t < sorted.length; t++) {
      var tr = sorted[t];
      var dir = tr.dir || (tr.size < 0 ? -1 : 1);
      var size = Math.abs(tr.size);
      var eb = tr.entry_bar_index, xb = tr.exit_bar_index;
      if (eb == null || xb == null || eb >= n) continue;
      xb = Math.min(xb, n - 1);
      var base = realized;
      for (var b = eb; b < xb; b++) {
        eq[b] = base + (candles.close[b] - tr.entry_price) * dir * size;
      }
      realized += tr.profit;
      eq[xb] = realized;
    }
    // forward-fill within the series; before the first mark use initial.
    var last = initial;
    for (var j = 0; j < n; j++) {
      if (isNaN(eq[j])) eq[j] = last; else last = eq[j];
    }
    return eq;
  }

  // Monthly % returns from month-end equity (UTC months), lab gate_metrics port.
  function monthlyReturns(eq, timeMs, i0, i1, initial) {
    var months = [];
    var prevEq = initial;
    var curKey = null, curEq = initial;
    function flush() {
      if (curKey !== null) { months.push(curEq / prevEq - 1); prevEq = curEq; }
    }
    for (var i = i0; i < i1; i++) {
      var d = new Date(timeMs[i]);
      var key = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (curKey === null) curKey = key;
      if (key !== curKey) { flush(); curKey = key; }
      curEq = eq[i];
    }
    flush();
    return months;
  }

  function gateMetrics(trades, eq, timeMs, startMs, endMs, initial) {
    initial = initial || 10000;
    var n = trades.length;
    var days = Math.max((endMs - startMs) / 86400000, 1);
    var i0 = 0, i1 = timeMs.length;
    while (i0 < timeMs.length && timeMs[i0] < startMs) i0++;
    while (i1 > 0 && timeMs[i1 - 1] >= endMs) i1--;
    var segEnd = i1 > 0 ? eq[i1 - 1] : initial;
    var net = segEnd - initial;
    var months = monthlyReturns(eq, timeMs, i0, i1, initial);
    var avgM = months.length ? months.reduce(function (a, b) { return a + b; }, 0) / months.length * 100 : 0;
    var worstM = months.length ? Math.min.apply(null, months) * 100 : 0;
    var maxDd = 0, peak = -Infinity;
    for (var i = i0; i < i1; i++) {
      if (eq[i] > peak) peak = eq[i];
      if (peak > 0) maxDd = Math.max(maxDd, (peak - eq[i]) / peak * 100);
    }
    var wins = 0, gw = 0, gl = 0, sumPnl = 0, maxConsLoss = 0, cur = 0;
    var winSum = 0, lossSum = 0, nWin = 0, nLoss = 0;
    var byTime = trades.slice().sort(function (a, b) { return (a.exit_time || 0) - (b.exit_time || 0); });
    for (var t = 0; t < byTime.length; t++) {
      var p = byTime[t].profit || 0;
      sumPnl += p;
      if (p > 0) { wins++; gw += p; winSum += p; nWin++; cur = 0; }
      else if (p < 0) { gl += -p; lossSum += p; nLoss++; cur++; maxConsLoss = Math.max(maxConsLoss, cur); }
      else cur = 0;
    }
    var pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
    var wr = n ? wins / n * 100 : 0;
    // Realized R:R ~= payoff ratio (see header note).
    var avgWin = nWin ? winSum / nWin : 0;
    var avgLoss = nLoss ? lossSum / nLoss : 0;
    var rr = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : (avgWin > 0 ? Infinity : NaN);
    var expR = n ? sumPnl / n : 0; // $/trade (gate uses sign only)
    var gates = {
      monthly_ge_20: avgM >= 20,
      dd_le_10: maxDd <= 10,
      rr_ge_15: isFinite(rr) && rr >= 1.5,
      pf_ge_15: pf >= 1.5,
      freq_ge_1: n / days >= 1,
      worst_month_ge_m10: worstM >= -10,
      expectancy_pos: expR > 0,
      sample_ge_240: n >= 240
    };
    var passed = 0;
    for (var k in gates) if (gates[k]) passed++;
    return {
      trades: n, win_rate: wr, profit_factor: pf, realized_RR: rr,
      expectancy_usd: expR, net_usd: net, net_pct: net / initial * 100,
      avg_monthly_pct: avgM, worst_month_pct: worstM, max_dd_pct: maxDd,
      trades_per_day: n / days, max_consec_losses: maxConsLoss,
      n_months: months.length, gates: gates, n_gates_passed: passed,
      passes_all: passed === 8
    };
  }

  // Full IS/OS split for the platform (IS 2023-01-01→2025-01-01, OS 2025-01-01→2025-11-05).
  // ONE continuous run: IS metrics use the run equity directly (run starts at
  // IS start, $10k). OS metrics REBASE equity to $10k at the split (scale factor
  // = 10000 / eq[split-1]) so OS reads as its own $10k account, matching the lab's
  // per-period simulation. % metrics (monthly, DD) are scale-invariant; $ PnL is
  // rebased. Trades spanning the split count in IS (by entry time).
  function splitMetrics(trades, eq, timeMs, initial) {
    initial = initial || 10000;
    var IS_START = Date.UTC(2023, 0, 1), SPLIT = Date.UTC(2025, 0, 1), OS_END = Date.UTC(2025, 10, 5);
    function inRange(t, a, b) { return t.filter(function (tr) { return tr.entry_time >= a && tr.entry_time < b; }); }
    var isTrades = inRange(trades, IS_START, SPLIT);
    var osTrades = inRange(trades, SPLIT, OS_END);
    var is = gateMetrics(isTrades, eq, timeMs, IS_START, SPLIT, initial);
    var osIdx = 0;
    while (osIdx < timeMs.length && timeMs[osIdx] < SPLIT) osIdx++;
    var eqOS = new Float64Array(eq.length);
    var base = osIdx > 0 ? eq[osIdx - 1] : initial;
    var factor = base > 0 ? initial / base : 1;
    for (var i = 0; i < eq.length; i++) eqOS[i] = eq[i] * factor;
    var os = gateMetrics(osTrades, eqOS, timeMs, SPLIT, OS_END, initial);
    return { is: is, os: os, os_rebase_factor: factor };
  }

  globalThis.GoldTester = { buildEquityCurve: buildEquityCurve, gateMetrics: gateMetrics, splitMetrics: splitMetrics, monthlyReturns: monthlyReturns };
})();
