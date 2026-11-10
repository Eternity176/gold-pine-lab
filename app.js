// app.js — UI wiring for the backtest platform.
// State: candles (M1, full), timeframe, plots, strategy result. Worker: pine-worker.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-US');

  const state = {
    m1: null, tf: '1m', candles: null, symbol: 'XAUUSD',
    result: null, worker: null, running: false, chartType: 'candles',
    maxBars: 20000, // preview default: last 20k bars (fast). 0 = all (Run full).
    liveOn: false, liveTimer: null, pendingPreview: true, runTimer: null, runStartedAt: 0,
    barOffset: 0, // index in state.candles where the last run's window starts
    // (preview: n - maxBars; full run: 0). The chart adds it to PineTS's
    // window-relative bar indices (labels, lines, boxes, trade entries).
  };

  let chart = null;
  let worker = null;
  let lastRunCode = null; // editor content of the last run (auto live re-runs only when unchanged)
  let lastRunN = 0; // full-series bar count at the last run (auto re-run only when new bars arrived)
  let autoLiveRun = false; // true while a live-triggered preview re-run is in flight

  const PREVIEW_BARS = 20000;

  function setStatus(msg) { $('statusBar').textContent = msg; }
  function setDataStatus() {
    const m = GoldData.meta();
    if (!m) { $('dataStatus').textContent = 'No data'; return; }
    const r0 = new Date(m.range[0] * 60000).toISOString().slice(0, 10);
    const r1 = new Date(m.range[1] * 60000).toISOString().slice(0, 10);
    $('dataStatus').textContent = `${m.source} · ${r0} → ${r1} · ${fmtInt(m.bars)} bars · updated ${new Date(m.updatedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }

  function currentCandles() {
    const minutes = GoldData.TF_MINUTES[state.tf] || 1;
    return GoldData.resample(state.m1, minutes);
  }

  function refreshChart(preserveView) {
    state.candles = currentCandles();
    const r = state.result;
    if (r) {
      chart.setData(state.candles, r.plots, r.plotMeta, { labels: r.labels, lines: r.lines, boxes: r.boxes }, r.trades || [], { preserveView: !!preserveView, barOffset: state.barOffset });
    } else {
      chart.setData(state.candles, {}, {}, {}, [], { preserveView: !!preserveView, barOffset: state.barOffset });
    }
    // Built-in indicators: recomputed on the current timeframe series, drawn
    // as bar-indexed series alongside the Pine plots.
    const indSeries = GoldIndicators.computeAll(state.candles, state.activeIndicators);
    chart.setIndicators(indSeries);
    renderIndLegend(indSeries);
    renderTables(r);
    $('barCount').textContent = `${fmtInt(state.candles.n)} bars · ${state.symbol} ${state.tf}`;
  }

  // ---------- Built-in indicators ----------
  const IND_LS_KEY = 'gold-pine-lab:indicators';
  function saveIndicators() {
    try { localStorage.setItem(IND_LS_KEY, JSON.stringify(state.activeIndicators)); } catch (e) { /* ignore */ }
  }
  function loadIndicators() {
    try {
      const raw = localStorage.getItem(IND_LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      state.activeIndicators = Array.isArray(arr)
        ? arr.filter((a) => a && GoldIndicators.defs.some((d) => d.id === a.id)).map((a) => ({ id: a.id, params: a.params || {} }))
        : [];
    } catch (e) { state.activeIndicators = []; }
  }
  function indLabel(a) {
    const def = GoldIndicators.defs.find((d) => d.id === a.id);
    if (!def) return a.id;
    const p = { ...GoldIndicators.defaults(def), ...(a.params || {}) };
    const parts = def.params.map((par) => p[par.key]);
    return `${def.name} ${parts.join(' ')}`;
  }
  function renderIndLegend(indSeries) {
    const el = $('indLegend');
    if (!el) return;
    el.innerHTML = '';
    state.activeIndicators.forEach((a, i) => {
      const def = GoldIndicators.defs.find((d) => d.id === a.id);
      if (!def) return;
      const chip = document.createElement('span');
      chip.className = 'ind-chip';
      const first = (indSeries || []).find((s) => s.owner === i);
      const dot = document.createElement('i');
      dot.style.background = (first && first.color) || '#2962ff';
      chip.appendChild(dot);
      const txt = document.createElement('span');
      txt.textContent = indLabel(a);
      chip.appendChild(txt);
      const x = document.createElement('b');
      x.textContent = '✕';
      x.title = 'Remove indicator';
      x.onclick = (ev) => { ev.stopPropagation(); removeIndicator(i); };
      chip.appendChild(x);
      el.appendChild(chip);
    });
  }
  function renderIndPanel() {
    const panel = $('indPanel');
    if (!panel) return;
    panel.innerHTML = '';
    const h1 = document.createElement('div');
    h1.className = 'ind-panel-title';
    h1.textContent = 'Add indicator';
    panel.appendChild(h1);
    for (const def of GoldIndicators.defs) {
      const b = document.createElement('button');
      b.className = 'ind-add';
      b.textContent = def.name + (def.overlay ? ' (overlay)' : ' (pane)');
      b.onclick = () => { addIndicator(def.id); };
      panel.appendChild(b);
    }
    if (state.activeIndicators.length) {
      const h2 = document.createElement('div');
      h2.className = 'ind-panel-title';
      h2.textContent = 'Active — click a value to change it';
      panel.appendChild(h2);
      state.activeIndicators.forEach((a, i) => {
        const def = GoldIndicators.defs.find((d) => d.id === a.id);
        if (!def) return;
        const row = document.createElement('div');
        row.className = 'ind-row';
        const nm = document.createElement('span');
        nm.className = 'ind-row-name';
        nm.textContent = def.name;
        row.appendChild(nm);
        const params = { ...GoldIndicators.defaults(def), ...(a.params || {}) };
        for (const par of def.params) {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.title = par.label;
          inp.value = params[par.key];
          inp.min = par.min; inp.max = par.max; inp.step = par.step;
          inp.onchange = () => {
            let v = parseFloat(inp.value);
            if (!isFinite(v)) v = par.def;
            v = Math.min(par.max, Math.max(par.min, v));
            inp.value = v;
            a.params = { ...params, [par.key]: v };
            saveIndicators();
            refreshChart(true);
            renderIndPanel();
          };
          row.appendChild(inp);
        }
        const x = document.createElement('button');
        x.className = 'ind-remove';
        x.textContent = '✕';
        x.title = 'Remove';
        x.onclick = () => removeIndicator(i);
        row.appendChild(x);
        panel.appendChild(row);
      });
    }
  }
  function addIndicator(id) {
    const def = GoldIndicators.defs.find((d) => d.id === id);
    if (!def) return;
    state.activeIndicators.push({ id, params: GoldIndicators.defaults(def) });
    saveIndicators();
    refreshChart(true);
    renderIndPanel();
    setStatus(`Added ${def.name} — see the chart legend (top-left) to remove it.`);
  }
  function removeIndicator(i) {
    state.activeIndicators.splice(i, 1);
    saveIndicators();
    refreshChart(true);
    renderIndPanel();
  }

  function renderTables(r) {
    const wrap = $('tableOverlay');
    wrap.innerHTML = '';
    if (!r || !r.tables || !r.tables.length) return;
    for (const t of r.tables) {
      if (t._deleted) continue;
      const div = document.createElement('div');
      div.className = 'pine-table';
      div.style.position = 'absolute';
      const pos = t.position || 'bottom_right';
      if (pos.includes('bottom')) div.style.bottom = '26px'; else div.style.top = '6px';
      if (pos.includes('right')) div.style.right = '70px'; else div.style.left = '8px';
      const table = document.createElement('table');
      const cells = t.cells || [];
      cells.forEach((row) => {
        const tr = document.createElement('tr');
        row.forEach((c) => {
          const td = document.createElement('td');
          td.textContent = c.text || '';
          td.style.color = c.text_color || '#d1d4dc';
          td.style.background = c.bgcolor || '#1e222d';
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      div.appendChild(table);
      wrap.appendChild(div);
    }
  }

  // One worker is kept alive across runs: it caches the compiled Pine script,
  // so changing the data window (preview <-> full) does not recompile.
  // Cancel = terminate the worker (the cache is lost, the next run recompiles).
  // WORKER_VERSION: bump this whenever pine-worker.js changes. The worker is
  // created once per page load and reused, so without the ?v= query a tab
  // opened before a deploy keeps the OLD worker (stale logic) until reload.
  const WORKER_VERSION = '20261110-mtf-provider';
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('pine-worker.js?v=' + WORKER_VERSION);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') { setStatus(msg.msg + runElapsed()); return; }
      if (msg.type === 'error') {
        autoLiveRun = false;
        stopRunUI();
        showConsoleError(msg.message, msg.line);
        setStatus('Error — see console below editor');
        return;
      }
      if (msg.type === 'result') {
        stopRunUI();
        msg.preview = state.pendingPreview;
        if (autoLiveRun) {
          // Auto re-run for live bars: refresh ONLY the plots so the Pine
          // pane follows live data. The old Tester numbers (strategy,
          // equity, IS/OS gates, trades) are kept — a preview re-run must
          // never clobber a full-history result.
          autoLiveRun = false;
          const prev = state.result;
          state.result = prev
            ? { ...prev, plots: msg.plots, plotMeta: msg.plotMeta, labels: msg.labels, lines: msg.lines, boxes: msg.boxes, tables: msg.tables }
            : msg;
          hideConsoleError();
          refreshChart(true);
          renderTester(state.result);
          setStatus(`Live: Pine plots updated to live bars (${fmtInt(msg.bars)} bars).`);
          return;
        }
        state.result = msg;
        hideConsoleError();
        refreshChart();
        renderTester(msg);
        setStatus(`Done in ${(msg.runMs / 1000).toFixed(1)}s · ${fmtInt(msg.bars)} bars${msg.preview ? ' (preview — last ' + fmtInt(msg.bars) + ' bars)' : ' (full history)'} · ${msg.strategy ? fmtInt(msg.strategy.closedtrades) + ' trades' : 'indicator'}`);
      }
    };
    worker.onerror = (e) => {
      autoLiveRun = false;
      stopRunUI();
      showConsoleError('Worker error: ' + (e.message || e.filename || 'unknown'));
    };
    return worker;
  }

  function runElapsed() {
    return state.runStartedAt ? ` · ${((Date.now() - state.runStartedAt) / 1000).toFixed(1)}s` : '';
  }
  function startRunUI() {
    state.running = true;
    state.runStartedAt = Date.now();
    $('runBtn').textContent = '■ Cancel';
    $('runBtn2').textContent = '■ Cancel';
    state.runTimer = setInterval(() => { if (state.running) setStatus('Running Pine…' + runElapsed()); }, 250);
  }
  function stopRunUI() {
    state.running = false;
    if (state.runTimer) { clearInterval(state.runTimer); state.runTimer = null; }
    $('runBtn').textContent = '▶ Run';
    $('runBtn2').textContent = '▶ Run / Add to chart';
  }
  function cancelRun() {
    if (worker) { worker.terminate(); worker = null; }
    autoLiveRun = false;
    stopRunUI();
    setStatus('Cancelled — press Run to try again.');
  }

  // full=false: preview = last `maxBars` bars (default 20k, ~1–2s).
  // full=true:  entire history (1,008,574 bars, minutes for heavy scripts) — Tester numbers.
  function runScript(full) {
    if (state.running) { cancelRun(); return; } // Run button doubles as Cancel
    if (!state.m1) { showConsoleError('Data not loaded yet.'); return; }
    const code = $('editor').value;
    if (!code.trim()) { showConsoleError('Editor is empty — paste a Pine script first.'); return; }
    const candles = state.candles;
    const n = candles.n;
    let maxBars = full ? 0 : parseInt($('maxBars').value, 10);
    if (!full && (!maxBars || maxBars <= 0)) maxBars = PREVIEW_BARS;
    state.pendingPreview = !full && maxBars > 0 && maxBars < n;
    if (state.pendingPreview) {
      const s = n - maxBars;
      state.barOffset = s; // preview window starts at full-series bar s
      const sliced = {
        n: maxBars,
        times: candles.times.slice(s), open: candles.open.slice(s),
        high: candles.high.slice(s), low: candles.low.slice(s), close: candles.close.slice(s),
      };
      return sendRun(code, sliced);
    }
    state.barOffset = 0; // full run covers the whole series
    sendRun(code, candles);
  }
  function sendRun(code, candles) {
    const w = getWorker();
    lastRunCode = code;
    lastRunN = state.candles ? state.candles.n : 0;
    startRunUI();
    setStatus('Running Pine…');
    // Transfer buffers (copies are fine; worker rebuilds candle objects).
    w.postMessage({
      type: 'run', code,
      times: candles.times, open: candles.open, high: candles.high, low: candles.low, close: candles.close,
      symbol: state.symbol, timeframe: state.tf,
      initialCapital: parseFloat($('capital').value) || 10000,
    });
  }

  function showConsoleError(msg, line) {
    const el = $('consoleOut');
    el.style.display = 'block';
    el.textContent = (line ? `Line ${line}: ` : '') + msg;
    el.className = 'console-err';
  }
  function hideConsoleError() { const el = $('consoleOut'); el.style.display = 'none'; el.textContent = ''; }

  // ---------- Strategy Tester ----------
  let tradePage = 0;
  const TRADES_PER_PAGE = 100;
  function renderTester(msg) {
    const s = msg.strategy;
    $('testerEmpty').style.display = s ? 'none' : 'block';
    $('testerBody').style.display = s ? 'block' : 'none';
    if (!s) {
      $('metricsCards').innerHTML = '';
      $('gatesTable').innerHTML = '';
      $('tradesTable').innerHTML = '';
      const pb = $('previewBanner');
      if (pb) pb.style.display = 'none';
      return;
    }
    // Preview runs (last 20k bars) show window-local numbers only — the 8 gates
    // and IS/OS split are meaningless on a 20k window, so they are hidden until
    // a full-history run. The banner + Run full button live in the Tester tab.
    const pb = $('previewBanner');
    if (pb) {
      if (msg.preview) {
        pb.style.display = 'block';
        pb.innerHTML = `PREVIEW — last ${fmtInt(msg.bars)} bars only. Metrics below are window-local, NOT full-history Tester numbers. ` +
          `<button id="runFullFromTester" style="margin-left:8px">Run full history (1M bars)</button>`;
        const b = $('runFullFromTester');
        if (b) b.onclick = () => runScript(true);
      } else {
        pb.style.display = 'none';
        pb.innerHTML = '';
      }
    }
    const cards = [
      ['Net Profit', '$' + fmt(s.netprofit), s.netprofit >= 0 ? 'pos' : 'neg'],
      ['Trades', fmtInt(s.closedtrades), ''],
      ['Max Drawdown', fmt(s.max_drawdown) + ' (' + fmt(s.max_drawdown_pct, 1) + '%)', 'neg'],
      ['Total commission', '$' + fmt(s.total_commission), ''],
      ['Sharpe', fmt(s.sharpe, 2), ''],
      ['Sortino', fmt(s.sortino, 2), ''],
      ['Initial capital', '$' + fmt(s.initial_capital, 0), ''],
    ];
    $('metricsCards').innerHTML = cards.map(([k, v, cls]) =>
      `<div class="metric-card"><div class="metric-label">${k}${msg.preview ? ' (last ' + fmtInt(msg.bars) + ' bars)' : ''}</div><div class="metric-value ${cls}">${v}</div></div>`).join('');
    drawEquity(msg.equityCurve, msg.is, msg.os);
    if (msg.preview) {
      $('gatesTable').innerHTML = `<div class="note">8-gate IS/OS verdicts need a full-history run — press <b>Run full history</b> above (or the “Run full” button in the editor bar).</div>`;
    } else {
      renderGates(msg);
    }
    tradePage = 0;
    renderTrades(msg);
  }

  function gateRow(label, v, pass, fmtFn) {
    return `<tr><td>${label}</td><td class="num">${fmtFn(v)}</td><td class="gate ${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</td></tr>`;
  }
  function renderGates(msg) {
    const rows = [
      ['Monthly avg ≥ 20%', 'avg_monthly_pct', (v) => fmt(v, 2) + '%', 'monthly_ge_20'],
      ['Max equity DD ≤ 10%', 'max_dd_pct', (v) => fmt(v, 2) + '%', 'dd_le_10'],
      ['Realized R:R ≥ 1.5', 'realized_RR', (v) => fmt(v, 2), 'rr_ge_15'],
      ['Trades/day ≥ 1', 'trades_per_day', (v) => fmt(v, 2), 'freq_ge_1'],
      ['Profit factor ≥ 1.5', 'profit_factor', (v) => fmt(v, 2), 'pf_ge_15'],
      ['Expectancy > 0', 'expectancy_usd', (v) => '$' + fmt(v, 2), 'expectancy_pos'],
      ['Worst month ≥ −10%', 'worst_month_pct', (v) => fmt(v, 2) + '%', 'worst_month_ge_m10'],
      ['Sample ≥ 240 trades', 'trades', (v) => fmtInt(v), 'sample_ge_240'],
    ];
    const col = (m) => rows.map(([label, key, f, g]) => gateRow(label, m[key], m.gates[g], f)).join('');
    $('gatesTable').innerHTML = `
      <table class="gates">
        <thead><tr><th>Gate</th><th>IS 2023–24</th><th></th><th>OS 2025</th><th></th></tr></thead>
        <tbody>
          ${rows.map(([label, key, f, g]) => `<tr><td>${label}</td>
            <td class="num">${f(msg.is[key])}</td><td class="gate ${msg.is.gates[g] ? 'pass' : 'fail'}">${msg.is.gates[g] ? 'PASS' : 'FAIL'}</td>
            <td class="num">${f(msg.os[key])}</td><td class="gate ${msg.os.gates[g] ? 'pass' : 'fail'}">${msg.os.gates[g] ? 'PASS' : 'FAIL'}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="verdict">IS verdict: <b class="${msg.is.passes_all ? 'pass' : 'fail'}">${msg.is.n_gates_passed}/8 ${msg.is.passes_all ? '— PASS' : '— FAIL'}</b>
      &nbsp;·&nbsp; OS verdict: <b class="${msg.os.passes_all ? 'pass' : 'fail'}">${msg.os.n_gates_passed}/8 ${msg.os.passes_all ? '— PASS' : '— FAIL'}</b>
      &nbsp;·&nbsp; OS rebased to $10k at split (factor ${fmt(msg.os_rebase_factor, 4)}).</div>
      <div class="note">Realized R:R is the payoff ratio avgWin/|avgLoss| — exact when risk/trade is constant (see README). Commission $0.055/side ($0.11/oz RT). Gap-fill exits: PineTS fills at the open when the open gaps beyond SL/TP (verified synthetically).</div>`;
  }

  function renderTrades(msg) {
    const trades = msg.trades || [];
    const pages = Math.max(1, Math.ceil(trades.length / TRADES_PER_PAGE));
    tradePage = Math.min(tradePage, pages - 1);
    const slice = trades.slice(tradePage * TRADES_PER_PAGE, (tradePage + 1) * TRADES_PER_PAGE);
    const rows = slice.map((t) => {
      const r = t.size !== 0 ? (t.profit / Math.abs(t.size) / Math.max(0.01, Math.abs(t.entry_price - t.exit_price))) : 0;
      const entry = new Date(t.entry_time).toISOString().slice(0, 16).replace('T', ' ');
      const exit = new Date(t.exit_time).toISOString().slice(0, 16).replace('T', ' ');
      return `<tr><td>${entry}</td><td>${exit}</td><td class="${t.dir > 0 ? 'pos' : 'neg'}">${t.dir > 0 ? 'LONG' : 'SHORT'}</td>
        <td class="num">${fmt(t.entry_price)}</td><td class="num">${fmt(t.exit_price)}</td>
        <td class="num">${fmt(t.size, 1)}</td><td class="num ${t.profit >= 0 ? 'pos' : 'neg'}">${fmt(t.profit)}</td></tr>`;
    }).join('');
    $('tradesTable').innerHTML = `
      <table class="trades"><thead><tr><th>Entry time (UTC)</th><th>Exit time</th><th>Dir</th>
      <th class="num">Entry</th><th class="num">Exit</th><th class="num">Size (oz)</th><th class="num">P&amp;L ($)</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="pager"><button id="prevPage" ${tradePage === 0 ? 'disabled' : ''}>← Prev</button>
      <span>Page ${tradePage + 1} / ${pages} · ${fmtInt(trades.length)} trades</span>
      <button id="nextPage" ${tradePage >= pages - 1 ? 'disabled' : ''}>Next →</button>
      <button id="exportCsv">Export CSV</button></div>`;
    $('prevPage').onclick = () => { tradePage--; renderTrades(msg); };
    $('nextPage').onclick = () => { tradePage++; renderTrades(msg); };
    $('exportCsv').onclick = () => exportCSV(msg);
  }

  function exportCSV(msg) {
    const trades = msg.trades || [];
    const head = 'entry_time_utc,exit_time_utc,dir,entry_price,exit_price,size_oz,profit_usd,commission_usd,entry_id,exit_id\n';
    const lines = trades.map((t) =>
      [new Date(t.entry_time).toISOString(), new Date(t.exit_time).toISOString(),
        t.dir > 0 ? 'LONG' : 'SHORT', t.entry_price, t.exit_price, t.size, t.profit, t.commission || 0, t.entry_id, t.exit_id].join(','));
    const blob = new Blob([head + lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${state.symbol}_${state.tf}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    const mg = [msg.is, msg.os];
    const mhead = 'period,trades,win_rate,profit_factor,realized_RR,avg_monthly_pct,worst_month_pct,max_dd_pct,trades_per_day,net_usd,gates_passed\n';
    const mlines = ['IS', 'OS'].map((p, i) => {
      const m = mg[i];
      return [p, m.trades, m.win_rate, m.profit_factor, m.realized_RR, m.avg_monthly_pct, m.worst_month_pct, m.max_dd_pct, m.trades_per_day, m.net_usd, m.n_gates_passed].join(',');
    });
    const blob2 = new Blob([mhead + mlines.join('\n')], { type: 'text/csv' });
    const b = document.createElement('a');
    b.href = URL.createObjectURL(blob2);
    b.download = `metrics_${state.symbol}_${state.tf}_${Date.now()}.csv`;
    b.click();
    URL.revokeObjectURL(b.href);
  }

  function drawEquity(curve, isM, osM) {
    const cv = $('equityCanvas');
    if (!cv || !curve || !curve.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, w, h);
    let lo = Infinity, hi = -Infinity;
    for (const p of curve) { lo = Math.min(lo, p.e); hi = Math.max(hi, p.e); }
    if (!isFinite(lo)) return;
    const pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    const xOf = (i) => 46 + i / (curve.length - 1) * (w - 56);
    const yOf = (v) => 8 + (hi - v) / (hi - lo) * (h - 30);
    // IS/OS split line at 2025-01-01
    const splitMs = Date.UTC(2025, 0, 1);
    let si = curve.findIndex((p) => p.t >= splitMs);
    if (si > 0) {
      ctx.strokeStyle = '#787b86'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(xOf(si), 0); ctx.lineTo(xOf(si), h - 20); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#787b86'; ctx.font = '11px sans-serif';
      ctx.fillText('IS | OS (2025-01-01)', xOf(si) + 4, 14);
    }
    ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 1.5; ctx.beginPath();
    curve.forEach((p, i) => { const x = xOf(i), y = yOf(p.e); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
    // zero / start line
    ctx.strokeStyle = '#2a2e39';
    ctx.beginPath(); ctx.moveTo(46, yOf(10000)); ctx.lineTo(w - 10, yOf(10000)); ctx.stroke();
    ctx.fillStyle = '#787b86'; ctx.font = '11px sans-serif';
    ctx.fillText('$' + fmt(hi, 0), 4, 14);
    ctx.fillText('$' + fmt(lo, 0), 4, h - 24);
    ctx.fillText(new Date(curve[0].t).toISOString().slice(0, 10), 46, h - 6);
    ctx.fillText(new Date(curve[curve.length - 1].t).toISOString().slice(0, 10), w - 90, h - 6);
  }

  // ---------- Samples / save / load ----------
  const SAMPLES = {
    r7: 'strategies/r7_wpr_ema34.pine',
    lux: 'strategies/samples/luxalgo-signals-overlays-clone.pine',
    hook: 'strategies/samples/wpr89-ema34-hook-arrows.pine',
    fractal: 'strategies/samples/fractal-wpr-v1.pine',
    trail: 'strategies/samples/gold-trend-trail.pine',
  };
  async function loadSample(key) {
    try {
      const res = await fetch(SAMPLES[key]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      $('editor').value = await res.text();
      setStatus(`Loaded sample: ${key}`);
      hideConsoleError();
    } catch (e) {
      showConsoleError('Could not load sample ' + key + ': ' + e.message);
    }
  }
  function saveScript() {
    try {
      localStorage.setItem('gold-pine-lab:script', $('editor').value);
      localStorage.setItem('gold-pine-lab:meta', JSON.stringify({ symbol: state.symbol, tf: state.tf, savedAt: Date.now() }));
      setStatus('Script saved to localStorage.');
    } catch (e) { showConsoleError('Save failed: ' + e.message); }
  }
  function loadSaved() {
    const s = localStorage.getItem('gold-pine-lab:script');
    if (s) { $('editor').value = s; setStatus('Loaded saved script from localStorage.'); }
    else setStatus('No saved script in localStorage.');
  }

  // ---------- Init ----------
  async function init() {
    chart = new GoldChart($('chartMain'), $('chartOsc'));
    chart.onHover = () => {};
    loadIndicators();
    // Indicators button: dropdown with the built-in library + active list.
    $('indBtn').onclick = (e) => {
      e.stopPropagation();
      const p = $('indPanel');
      const open = p.style.display !== 'block';
      if (open) {
        renderIndPanel();
        const r = $('indBtn').getBoundingClientRect();
        p.style.left = Math.max(8, r.left) + 'px';
        p.style.top = (r.bottom + 6) + 'px';
        p.style.display = 'block';
      } else {
        p.style.display = 'none';
      }
    };
    document.addEventListener('click', (e) => {
      const p = $('indPanel');
      if (p && p.style.display === 'block' && !$('indBtn').contains(e.target) && !p.contains(e.target)) p.style.display = 'none';
    });
    $('runBtn').onclick = () => runScript(false); // doubles as Cancel while running
    $('runFullBtn').onclick = () => runScript(true);
    $('saveBtn').onclick = saveScript;
    $('loadSavedBtn').onclick = loadSaved;
    $('resetViewBtn').onclick = () => chart.resetView();
    $('showAllBtn').onclick = () => chart.showAll();
    $('zoomInBtn').onclick = () => chart.zoomBy(0.8); // around the chart centre
    $('zoomOutBtn').onclick = () => chart.zoomBy(1.25);
    $('goLatestBtn').onclick = () => chart.goToLatest();
    $('sampleSel').onchange = (e) => { if (e.target.value) loadSample(e.target.value); e.target.value = ''; };
    $('copyBtn').onclick = () => {
      navigator.clipboard.writeText($('editor').value).then(() => setStatus('Script copied to clipboard.'));
    };
    document.querySelectorAll('[data-tf]').forEach((b) => {
      b.onclick = () => {
        state.tf = b.dataset.tf;
        document.querySelectorAll('[data-tf]').forEach((x) => x.classList.toggle('active', x === b));
        state.result = null;
        $('testerEmpty').style.display = 'block'; $('testerBody').style.display = 'none';
        refreshChart();
        setStatus(`Timeframe ${state.tf} · ${fmtInt(state.candles.n)} bars`);
      };
    });
    document.querySelectorAll('[data-ctype]').forEach((b) => {
      b.onclick = () => {
        state.chartType = b.dataset.ctype;
        chart.type = state.chartType;
        document.querySelectorAll('[data-ctype]').forEach((x) => x.classList.toggle('active', x === b));
        chart.draw();
      };
    });
    // Live = real XAUUSD 1m candles (Dukascopy spot via /api/live proxy,
    // Yahoo GC=F futures as fallback). ON by default and auto-refreshing
    // every 5s — the price runs by itself, no manual refresh. Keeps the
    // current Pine result — plots are time-matched, so new bars just extend
    // the chart. Spot XAU chip comes from gold-api.com.
    async function startLive() {
      if (state.liveOn) return;
      state.liveOn = true;
      $('liveBtn').textContent = '● Live ON';
      $('liveBtn').classList.add('live-on');
      await doLiveUpdate();
      state.liveTimer = setInterval(doLiveUpdate, 5000);
    }
    $('liveBtn').onclick = async () => { state.liveOn ? stopLive() : startLive(); };
    async function doLiveUpdate() {
      if (!state.m1) return;
      setStatus('Live: fetching XAU/USD candles…');
      const res = await GoldData.liveUpdate(state.m1, (m) => setStatus(m));
      if (res.ok) state.m1 = res.data;
      updateSpotChip(res);
      setDataStatus();
      refreshChart(true); // live must not snap the zoom/pan back to 300 bars
      // Pine plots only cover the bars of the last run — without this, the
      // Pine pane goes empty as soon as the view moves onto live bars.
      // Re-run the preview when: a result exists, the script is unchanged
      // since that run, nothing is already running, NEW bars arrived since
      // the last run (so the 5s refresh does not re-run Pine pointlessly),
      // and the user is looking at the live edge. Tester numbers are never
      // replaced (see the result handler's autoLiveRun branch).
      if (!state.running && !autoLiveRun && state.result && $('editor').value === lastRunCode
          && state.candles.n > lastRunN
          && chart && chart.endIdx >= state.candles.n - 5) {
        autoLiveRun = true;
        runScript(false);
      }
    }
    function stopLive() {
      state.liveOn = false;
      if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
      $('liveBtn').textContent = '● Live data';
      $('liveBtn').classList.remove('live-on');
      setStatus('Live off — showing bundled 2023–2025 data + last live bars.');
    }
    function updateSpotChip(res) {
      const el = $('spotChip');
      if (!el) return;
      const lastClose = state.m1 ? state.m1.close[state.m1.n - 1] : null;
      if (res && res.spot) el.textContent = `XAU $${res.spot.price.toFixed(2)} · live (${res.feed || '—'})`;
      else if (res && res.ok) el.textContent = `XAU $${lastClose.toFixed(2)} · live (${res.feed})`;
      else if (res && res.diag && res.diag.length) el.textContent = 'Live failed: ' + res.diag.map((d) => d.feed + ' ' + (d.ok ? 'ok' : d.error)).join(' · ');
      else el.textContent = 'Live unavailable';
      el.title = 'Live candles are real XAU/USD (Dukascopy spot; Yahoo GC=F gold futures when Dukascopy is down — futures trade a few dollars above spot). Spot price via gold-api.com.' + (res && res.basisNote ? ' ' + res.basisNote : '');
    }
    $('csvInput').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = GoldData.parseCSV(text);
        state.symbol = f.name.replace(/\.csv$/i, '').toUpperCase() || 'CSV';
        state.m1 = data;
        GoldData._meta = { source: 'CSV upload: ' + f.name, range: [data.times[0], data.times[data.n - 1]], bars: data.n, updatedAt: Date.now() };
        state.result = null;
        setDataStatus();
        refreshChart();
        setStatus(`CSV loaded: ${fmtInt(data.n)} bars (${state.symbol}).`);
      } catch (err) { showConsoleError('CSV error: ' + err.message); }
    };
    // bottom tabs
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
        document.querySelectorAll('.tab-pane').forEach((p) => {
          const active = p.id === 'tab-' + b.dataset.tab;
          p.style.display = active ? (b.dataset.tab === 'editor' ? 'flex' : 'block') : 'none';
        });
        // Opening Strategy Tester with only a preview result runs the full
        // history automatically (the 8 gates need full history). Cancel anytime.
        if (b.dataset.tab === 'tester' && state.result && state.result.preview && state.result.strategy && !state.running) {
          setStatus('Tester needs full history — running full 1M bars…');
          runScript(true);
        }
      };
    });
    window.addEventListener('resize', () => { if (chart) chart.draw(); });

    setStatus('Loading bundled data (XAUUSD M1 2023–2025)…');
    try {
      await GoldData.init();
      state.m1 = await GoldData.loadBundled((m) => setStatus(m));
      setDataStatus();
      refreshChart();
      setStatus(`Ready · ${fmtInt(state.m1.n)} bars loaded`);
      await loadSample('r7');
      startLive(); // live is ON by default — price runs realtime, no button press
    } catch (e) {
      showConsoleError('Data load failed: ' + e.message + ' — serve via http.server, not file://');
      setStatus('Data load failed');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
