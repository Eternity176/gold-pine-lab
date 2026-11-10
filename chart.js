// chart.js — custom canvas chart (TradingView-like, dark theme).
// Main pane: candles + overlay plots + plotshape markers + labels/lines/boxes
// + trade markers. Oscillator pane: overlay=false plots. Price axis right,
// time axis bottom, crosshair, OHLC legend, drag pan + wheel zoom.
(function () {
  'use strict';
  const UP = '#089981', DOWN = '#f23645';
  const GRID = '#2a2e39', AXIS_TXT = '#787b86', TXT = '#d1d4dc';
  const PALETTE = ['#2962ff', '#ff9800', '#9c27b0', '#00bcd4', '#ffeb3b', '#e91e63', '#4caf50', '#ffffff'];

  function cssColor(c, fallback) {
    if (!c || typeof c !== 'string') return fallback;
    // PineTS colors are '#RRGGBBAA' — canvas accepts 8-digit hex in modern browsers.
    return c;
  }

  class Chart {
    constructor(mainCanvas, oscCanvas) {
      this.main = mainCanvas; this.osc = oscCanvas;
      this.mctx = mainCanvas.getContext('2d');
      this.octx = oscCanvas ? oscCanvas.getContext('2d') : null;
      this.candles = null; this.plots = {}; this.plotMeta = {};
      this.labels = []; this.lines = []; this.boxes = []; this.trades = [];
      this.ind = []; // built-in indicator series: [{key,label,overlay,pane,color,style,values,levels}]
      this.endIdx = 0; this.barW = 0; this.viewBars = 300;
      this.barOffset = 0; // index in the full candle series where the last
      // run's window starts (0 = full history). PineTS reports label /
      // line / box positions and trade entry_bar_index as bar indices
      // RELATIVE to the run window (a 20k preview's bar 0 is the full
      // series' bar n-20000); without this offset they all pile up at the
      // left edge of the chart. Set by app.js via setData opts.
      this.mouse = null; this.onHover = null; this.type = 'candles';
      // Right offset (bars of empty space after the last candle, like
      // TradingView): the last candle never sits jammed against the price
      // axis. It is the DEFAULT gap (used by setData/resetView/goToLatest);
      // the wheel anchor is protected by the much more generous _maxEnd()
      // cap below, so zooming out at the right edge never breaks the anchor
      // — with a fixed 10-bar clamp, repeated zoom-outs clamped endIdx to
      // n-1 and the bar under the cursor walked into the past on every tick.
      this.rightOffset = 10;
      this._bind();
    }
    // Furthest the view's right edge may go: the last bar plus the larger
    // of the default offset and the whole visible window. For a real-bar
    // anchor this cap can never engage during a wheel zoom (the unclamped
    // endIdx exceeds n-1 by at most viewBars), so the anchor holds exactly
    // for any zoom-out sequence; it only stops the user dragging the chart
    // into endless empty space.
    _maxEnd() {
      return this.candles.n - 1 + Math.max(this.rightOffset, this.viewBars);
    }
    // Zoom around a screen fraction (frac 0 = left edge, 1 = right edge).
    // factor < 1 zooms in, > 1 zooms out. Used by the wheel handler and by
    // the + / − buttons (which zoom around the chart centre, frac 0.5).
    zoomBy(factor, frac = 0.5) {
      if (!this.candles) return;
      frac = Math.min(1, Math.max(0, frac));
      const plotW = this.main.clientWidth - 64;
      const mx = 4 + frac * Math.max(1, plotW);
      const anchorIdx = this._idxAtX(mx);
      this.viewBars = Math.max(10, Math.min(20000, Math.round(this.viewBars * factor)));
      this.endIdx = Math.round(anchorIdx + this.viewBars * (1 - frac) - 0.5);
      this.endIdx = Math.min(this._maxEnd(), Math.max(this.viewBars - 1, this.endIdx));
      this.draw();
    }
    // Jump to the newest bar, keeping the current zoom level.
    goToLatest() {
      if (!this.candles) return;
      this.endIdx = this.candles.n - 1 + this.rightOffset;
      this.draw();
    }
    // Built-in indicators (bar-indexed Float64Array values, NaN = no value).
    // Unlike Pine plots (time-keyed points + binary search per point), these
    // draw by visible bar index only — cheap even on 1M bars.
    setIndicators(list) {
      this.ind = list || [];
      this.draw();
    }
    _bind() {
      const el = this.main;
      let drag = null;
      // Wheel = zoom to cursor. Fixed per-event factors (0.85/1.18) were the
      // chaos: a trackpad gesture fires dozens of tiny wheel events, each one
      // multiplying the zoom — one flick went 300 -> 20 or 20000 bars. Now the
      // factor scales with the actual scroll amount: a mouse notch (~100px)
      // zooms ~15%, a trackpad tick (~5px) zooms <1%. deltaMode is honoured
      // (Firefox line mode) and the anchor uses CSS pixels — the old code
      // used canvas device pixels (this.main.width, dpr-scaled), so on retina
      // screens the anchor drifted left on every tick.
      const onWheel = (e) => {
        e.preventDefault();
        if (!this.candles) return;
        const el2 = e.currentTarget;
        const rect = el2.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 33; // lines -> px
        else if (e.deltaMode === 2) dy *= rect.height; // pages -> px
        // Scroll up (dy<0) zooms in, scroll down zooms out — same direction
        // as TradingView and the old code, but the factor now scales with
        // the actual scroll amount.
        const factor = Math.min(2, Math.max(0.5, Math.exp(dy * 0.0016)));
        // Keep the bar under the cursor at the same screen x after zoom.
        // xOf(i) = 4 + (i - start)*barW + barW/2, barW = plotW/viewBars,
        // start = endIdx - viewBars + 1  =>  endIdx = anchorIdx + viewBars*(1-frac) - 0.5
        // (frac in CSS px: clientWidth, NOT canvas device width).
        const plotW = this.main.clientWidth - 64;
        const frac = Math.min(1, Math.max(0, (mx - 4) / Math.max(1, plotW)));
        this.zoomBy(factor, frac);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      if (this.osc) this.osc.addEventListener('wheel', onWheel, { passive: false });
      el.addEventListener('mousedown', (e) => { drag = { x: e.clientX, end: this.endIdx }; });
      window.addEventListener('mousemove', (e) => {
        if (drag && this.candles) {
          const dx = e.clientX - drag.x;
          // Same fix as _idxAtX: no Math.max(2, barW) — when zoomed out
          // (barW < 1px) the old clamp made dragging feel stuck (100px
          // moved 50 bars instead of ~1500). barW || 1 guards pre-draw only.
          const bars = Math.round(dx / (this.barW || 1));
          this.endIdx = Math.min(this._maxEnd(), Math.max(this.viewBars - 1, drag.end - bars));
          this.draw();
        }
      });
      window.addEventListener('mouseup', () => { drag = null; });
      el.addEventListener('mousemove', (e) => {
        const rect = el.getBoundingClientRect();
        this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        this.draw();
        if (this.onHover && this.candles) {
          const i = this._idxAtX(this.mouse.x);
          if (i >= 0 && i < this.candles.n) this.onHover(i);
        }
      });
      el.addEventListener('mouseleave', () => { this.mouse = null; this.draw(); });
      el.addEventListener('dblclick', () => { this.resetView(); });
    }
    _plotW() { return this.main.width - 64; }
    _idxAtX(x) {
      const start = this.endIdx - this.viewBars + 1;
      // NOTE: no Math.max(1, barW) here — when zoomed out past ~936 bars,
      // barW < 1px and clamping the divisor to 1 made _idxAtX return a bar
      // hundreds of bars left of the cursor; the wheel handler then fed
      // that wrong anchor into the next zoom and the chart walked into the
      // past on every tick (the "lăn lùi kéo chart ra tít đằng trước" bug).
      // barW || 1 only guards the pre-first-draw state (barW = 0).
      const bw = this.barW || 1;
      return start + Math.floor((x - 4) / bw);
    }
    _xAtIdx(i) {
      const start = this.endIdx - this.viewBars + 1;
      return 4 + (i - start) * this.barW + this.barW / 2;
    }
    setData(candles, plots, plotMeta, drawings, trades, opts) {
      const keep = opts && opts.preserveView && this.candles;
      const oldEnd = this.endIdx, oldN = this.candles ? this.candles.n : 0;
      this.candles = candles; this.plots = plots || {}; this.plotMeta = plotMeta || {};
      this.barOffset = (opts && opts.barOffset) || 0;
      this.labels = (drawings && drawings.labels) || [];
      this.lines = (drawings && drawings.lines) || [];
      this.boxes = (drawings && drawings.boxes) || [];
      this.trades = trades || [];
      // Convert numeric Pine plots to bar-indexed arrays ONCE (linear merge —
      // both points and candles are time-sorted). Drawing then iterates only
      // the visible window instead of binary-searching 1M points on every
      // wheel tick / mouse move (that was a big part of the "chaotic" feel).
      this._plotVals = {};
      for (const key of Object.keys(this.plots)) {
        const pts = this.plots[key];
        if (pts.some((p) => p.v === true || p.v === false)) continue; // plotshape: keep points
        this._plotVals[key] = this._indexPlot(pts);
      }
      // Per-bar colors for line plots whose color is a series (Smart Trail
      // green/red) — the worker keeps each point's own color in `c`.
      this._plotCols = {};
      for (const key of Object.keys(this.plots)) {
        const pts = this.plots[key];
        if (!pts.some((p) => typeof p.c === 'string')) continue;
        if (pts.some((p) => p.v === true || p.v === false)) continue; // barcolor handled below
        this._plotCols[key] = this._indexColors(pts);
      }
      // barcolor: PineTS gives values all `true` with the color per point.
      // Merge every barcolor plot into one per-bar color array (last plot
      // wins, like TradingView) and use it to tint the candles. This must
      // live apart from plotshape: the old code saw `v === true` on every
      // bar and drew a green triangle under every candle.
      this._barColor = null;
      for (const key of Object.keys(this.plots)) {
        const m = this.plotMeta[key];
        if (!m || m.style !== 'barcolor') continue;
        if (!this._barColor) this._barColor = new Array(candles.n).fill(null);
        const cols = this._indexColors(this.plots[key]);
        for (let i = 0; i < candles.n; i++) if (cols[i]) this._barColor[i] = cols[i];
      }
      if (keep) {
        // Live updates must not snap the view back to the last 300 bars:
        // stay at the right edge if we were there (keeping the user's
        // right-offset distance from the last bar), else keep the position.
        const atRight = oldEnd >= oldN - 1;
        this.endIdx = atRight
          ? candles.n - 1 + Math.max(0, oldEnd - (oldN - 1))
          : Math.min(oldEnd, this._maxEnd());
      } else {
        this.endIdx = candles.n - 1 + this.rightOffset;
        this.viewBars = Math.min(300, candles.n);
      }
      this.draw();
    }
    _indexPlot(pts) {
      const n = this.candles.n, times = this.candles.times;
      const arr = new Float32Array(n).fill(NaN);
      let j = 0;
      for (const p of pts) {
        if (typeof p.v !== 'number' || Number.isNaN(p.v)) continue;
        const target = Math.floor(p.t / 60000);
        while (j < n && times[j] < target) j++;
        if (j < n && times[j] === target) arr[j] = p.v;
      }
      return arr;
    }
    // Same linear merge as _indexPlot, but for per-point colors (`c`):
    // returns an Array of color strings (or null) per bar index.
    _indexColors(pts) {
      const n = this.candles.n, times = this.candles.times;
      const arr = new Array(n).fill(null);
      let j = 0;
      for (const p of pts) {
        if (typeof p.c !== 'string') continue;
        const target = Math.floor(p.t / 60000);
        while (j < n && times[j] < target) j++;
        if (j < n && times[j] === target) arr[j] = p.c;
      }
      return arr;
    }
    resetView() {
      if (!this.candles) return;
      this.endIdx = this.candles.n - 1 + this.rightOffset;
      this.viewBars = Math.min(300, this.candles.n);
      this.draw();
    }
    showAll() {
      if (!this.candles) return;
      this.viewBars = this.candles.n; this.endIdx = this.candles.n - 1; this.draw();
    }
    _fitCanvas(cv) {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    }
    draw() {
      if (!this.candles) return;
      const { ctx, w, h } = this._fitCanvas(this.main);
      const plotW = w - 64, plotH = h - 22;
      const start = Math.max(0, this.endIdx - this.viewBars + 1);
      const end = this.endIdx; // view end — may run past the last bar by rightOffset
      const c = this.candles;
      const dataEnd = Math.min(end, c.n - 1); // last bar that has data
      this.barW = plotW / Math.max(1, end - start + 1);
      // price range from visible candles + overlay plots (bar-indexed, so
      // this loop only touches the visible window, never all 1M points)
      let lo = Infinity, hi = -Infinity;
      for (let i = start; i <= dataEnd; i++) { lo = Math.min(lo, c.low[i]); hi = Math.max(hi, c.high[i]); }
      const clo = lo, chi = hi, crange = (chi - clo) || 1;
      // An overlay plot whose values live far from price (e.g. an
      // oscillator plotted by an overlay=true script) must not stretch
      // the price axis and squash the candles: include a plot in the
      // range only if at least one visible value sits within one full
      // price range of the candle range. The plot is still drawn, just
      // off-screen — like TradingView. (Without this, an overlay=true
      // strategy plotting an oscillator, e.g. R7's EMA(%R) at -100..0
      // against $4100 gold, would flatten the candles to a line.)
      const includeInRange = (getV) => {
        let anyNear = false;
        for (let i = start; i <= dataEnd; i++) {
          const v = getV(i);
          if (typeof v === 'number' && !Number.isNaN(v) && v >= clo - crange && v <= chi + crange) { anyNear = true; break; }
        }
        if (!anyNear) return;
        for (let i = start; i <= dataEnd; i++) {
          const v = getV(i);
          if (typeof v === 'number' && !Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        }
      };
      for (const key of Object.keys(this._plotVals || {})) {
        const m = this.plotMeta[key];
        if (m && m.overlay === false) continue;
        const vals = this._plotVals[key];
        includeInRange((i) => vals[i]);
      }
      // built-in indicator overlays (bar-indexed, visible window only)
      for (const s of this.ind) {
        if (s.overlay === false) continue;
        const v = s.values;
        includeInRange((i) => v[i]);
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const pad = (hi - lo) * 0.06 || 1;
      lo -= pad; hi += pad;
      const yOf = (v) => 4 + (hi - v) / (hi - lo) * (plotH - 8);
      const xOf = (i) => this._xAtIdx(i);
      // bg + grid
      ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.fillStyle = AXIS_TXT;
      ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif'; ctx.textAlign = 'left';
      const steps = 6;
      for (let g = 0; g <= steps; g++) {
        const v = lo + (hi - lo) * g / steps;
        const y = yOf(v);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
        ctx.fillText(v.toFixed(2), plotW + 6, y + 4);
      }
      // time grid ( ~8 labels) — grid lines span the whole view, but labels
      // only exist for bars with data (never past the last candle).
      const nLab = 8;
      for (let g = 0; g <= nLab; g++) {
        const i = Math.round(start + (end - start) * g / nLab);
        const x = xOf(i);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
        if (i > dataEnd) continue;
        const d = new Date(c.times[i] * 60000);
        ctx.fillText(fmtTime(d), x - 24, h - 6);
      }
      // candles (or line / area)
      if (this.type === 'line' || this.type === 'area') {
        ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 1.5; ctx.beginPath();
        let started = false;
        for (let i = start; i <= dataEnd; i++) {
          const x = xOf(i), y = yOf(c.close[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (this.type === 'area') {
          ctx.lineTo(xOf(dataEnd), yOf(lo)); ctx.lineTo(xOf(start), yOf(lo)); ctx.closePath();
          ctx.fillStyle = 'rgba(41,98,255,0.12)'; ctx.fill();
        }
      } else {
      const bw = Math.max(1, Math.min(14, this.barW * 0.7));
      for (let i = start; i <= dataEnd; i++) {
        const x = xOf(i), up = c.close[i] >= c.open[i];
        // barcolor() tints the candle body (last barcolor plot wins);
        // without it, candles are green/red by close vs open.
        const bc = this._barColor && this._barColor[i];
        ctx.strokeStyle = ctx.fillStyle = bc || (up ? UP : DOWN);
        ctx.beginPath(); ctx.moveTo(x, yOf(c.high[i])); ctx.lineTo(x, yOf(c.low[i])); ctx.stroke();
        const yo = yOf(c.open[i]), yc = yOf(c.close[i]);
        ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      }
      }
      // overlay plots
      let pi = 0;
      for (const key of Object.keys(this.plots)) {
        const m = this.plotMeta[key];
        if (m && m.overlay === false) continue;
        if (m && m.style === 'barcolor') continue; // tints candles (see _barColor), never drawn as a plot
        const pts = this.plots[key];
        const color = cssColor(m && m.color, PALETTE[pi++ % PALETTE.length]);
        const isBool = pts.some((p) => p.v === true || p.v === false);
        if (isBool) {
          // plotshape: one marker per `true` point. The point's own metadata
          // (shape/location/text/color, kept by the worker) decides how it
          // looks — a labelup/labeldown draws the small colored box with its
          // glyph (▲/▼/▲+/▼+, like LuxAlgo), an xcross draws an X, anything
          // else falls back to a plain triangle.
          for (const p of pts) {
            if (p.v !== true) continue;
            const bi = this._barIndexOfTime(p.t);
            if (bi === null || bi < start || bi > dataEnd) continue;
            const x = xOf(bi);
            const shape = (p.shape || '').toLowerCase();
            const loc = (p.loc || '').toLowerCase();
            const col = (typeof p.c === 'string' && p.c) || color;
            const below = /below/i.test(loc) || (!loc && !/short|sell|red/i.test(key));
            const yBase = below ? yOf(c.low[bi]) + 11 : yOf(c.high[bi]) - 11;
            if (shape.includes('xcross')) {
              ctx.strokeStyle = col; ctx.lineWidth = 1.6;
              ctx.beginPath();
              ctx.moveTo(x - 5, yBase - 5); ctx.lineTo(x + 5, yBase + 5);
              ctx.moveTo(x + 5, yBase - 5); ctx.lineTo(x - 5, yBase + 5);
              ctx.stroke();
              continue;
            }
            if (shape.includes('label')) {
              const text = p.text || (below ? '▲' : '▼');
              ctx.font = 'bold 10px -apple-system, "Segoe UI", Roboto, sans-serif';
              const tw = ctx.measureText(text).width;
              const bw2 = Math.max(13, tw + 6), bh = 13;
              ctx.fillStyle = col;
              ctx.beginPath();
              if (ctx.roundRect) ctx.roundRect(x - bw2 / 2, yBase - bh / 2, bw2, bh, 3);
              else ctx.rect(x - bw2 / 2, yBase - bh / 2, bw2, bh);
              ctx.fill();
              ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
              ctx.fillText(text, x, yBase + 3.5);
              ctx.textAlign = 'left';
              continue;
            }
            const down = /short|sell|red/i.test(key);
            const y = down ? yOf(c.high[bi]) - 10 : yOf(c.low[bi]) + 10;
            ctx.fillStyle = col;
            ctx.beginPath();
            if (down) { ctx.moveTo(x, y + 5); ctx.lineTo(x - 5, y - 4); ctx.lineTo(x + 5, y - 4); }
            else { ctx.moveTo(x, y - 5); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); }
            ctx.closePath(); ctx.fill();
          }
          continue;
        }
        // Numeric line plot. Its color can be a series (Smart Trail green
        // when up, red when down) — the worker keeps each point's color in
        // _plotCols, so the line is drawn segment by segment, changing
        // color where the series does, instead of one flat color.
        ctx.lineWidth = 1.2;
        const vals = this._plotVals[key];
        const cols = this._plotCols[key];
        if (vals) {
          let cur = null, started = false, px = 0, py = 0, havePrev = false;
          const flush = () => { if (started) ctx.stroke(); started = false; };
          for (let i = start; i <= dataEnd; i++) {
            const v = vals[i];
            if (typeof v !== 'number' || Number.isNaN(v)) { flush(); cur = null; havePrev = false; continue; }
            const col = (cols && cols[i]) || color;
            const x = xOf(i), y = yOf(v);
            if (col !== cur) {
              flush();
              cur = col; ctx.strokeStyle = col; ctx.beginPath();
              // New segment starts at the previous point so it connects;
              // mark it started so the next lineTo (not moveTo) is used.
              if (havePrev) { ctx.moveTo(px, py); started = true; }
            }
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            px = x; py = y; havePrev = true;
          }
          flush();
        } else {
          ctx.strokeStyle = color; ctx.beginPath();
          let started = false;
          for (const p of pts) {
            if (typeof p.v !== 'number' || Number.isNaN(p.v)) { started = false; continue; }
            const bi = this._barIndexOfTime(p.t);
            if (bi === null || bi < start || bi > dataEnd) { started = false; continue; }
            const x = xOf(bi), y = yOf(p.v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      // built-in indicator overlays (bar-indexed lines)
      for (const s of this.ind) {
        if (s.overlay === false) continue;
        ctx.strokeStyle = s.color || '#2962ff'; ctx.lineWidth = 1.5; ctx.beginPath();
        let started = false;
        for (let i = start; i <= dataEnd; i++) {
          const val = s.values[i];
          if (typeof val !== 'number' || Number.isNaN(val)) { started = false; continue; }
          const x = xOf(i), y = yOf(val);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // lines / boxes / labels (final active set only)
      for (const ln of this.lines) {
        if (ln._deleted) continue;
        const x1 = this._drawX(ln.x1, ln.xloc), x2 = this._drawX(ln.x2, ln.xloc);
        if (x1 === null || x2 === null) continue;
        ctx.strokeStyle = cssColor(ln.color, '#787b86'); ctx.lineWidth = ln.width || 1;
        ctx.setLineDash(ln.style === 'dashed' ? [5, 4] : []);
        ctx.beginPath(); ctx.moveTo(x1, yOf(ln.y1)); ctx.lineTo(x2, yOf(ln.y2)); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const bx of this.boxes) {
        if (bx._deleted) continue;
        const x1 = this._drawX(bx.left, bx.xloc), x2 = this._drawX(bx.right, bx.xloc);
        if (x1 === null || x2 === null) continue;
        const y1 = yOf(bx.top), y2 = yOf(bx.bottom);
        if (bx.bgcolor) { ctx.fillStyle = cssColor(bx.bgcolor, 'rgba(120,123,134,0.15)'); ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }
        if (bx.border_color) { ctx.strokeStyle = cssColor(bx.border_color, '#787b86'); ctx.lineWidth = bx.border_width || 1; ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); }
      }
      for (const lb of this.labels) {
        if (lb._deleted) continue;
        const x = this._drawX(lb.x, lb.xloc);
        if (x === null) continue;
        const y = yOf(lb.y);
        ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
        const tw = ctx.measureText(lb.text || '').width + 10;
        ctx.fillStyle = cssColor(lb.color, '#363c4e');
        ctx.fillRect(x - tw / 2, y - 9, tw, 16);
        ctx.fillStyle = cssColor(lb.textcolor, '#ffffff');
        ctx.textAlign = 'center';
        ctx.fillText(lb.text || '', x, y + 3);
        ctx.textAlign = 'left';
      }
      // trade markers
      for (const tr of this.trades) {
        const bi = tr.entry_bar_index + this.barOffset;
        if (bi < start || bi > end) continue;
        const x = xOf(bi);
        const long = tr.dir > 0;
        ctx.fillStyle = long ? '#2962ff' : '#f23645';
        ctx.beginPath();
        if (long) { ctx.moveTo(x, yOf(c.low[bi]) + 14); ctx.lineTo(x - 5, yOf(c.low[bi]) + 22); ctx.lineTo(x + 5, yOf(c.low[bi]) + 22); }
        else { ctx.moveTo(x, yOf(c.high[bi]) - 14); ctx.lineTo(x - 5, yOf(c.high[bi]) - 22); ctx.lineTo(x + 5, yOf(c.high[bi]) - 22); }
        ctx.closePath(); ctx.fill();
      }
      // crosshair
      if (this.mouse) {
        const mx = this.mouse.x, my = this.mouse.y;
        ctx.strokeStyle = 'rgba(180,183,190,0.5)'; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, plotH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(plotW, my); ctx.stroke();
        ctx.setLineDash([]);
        const i = this._idxAtX(mx);
        if (i >= 0 && i < c.n) {
          const d = new Date(c.times[i] * 60000);
          ctx.fillStyle = '#363c4e';
          ctx.fillRect(Math.max(0, mx - 42), h - 18, 84, 16);
          ctx.fillStyle = TXT; ctx.textAlign = 'center';
          ctx.fillText(fmtTime(d), Math.max(42, mx), h - 6);
          ctx.textAlign = 'left';
          const pv = hi - (my - 4) / Math.max(1, plotH - 8) * (hi - lo);
          ctx.fillStyle = '#363c4e'; ctx.fillRect(plotW, my - 8, 64, 16);
          ctx.fillStyle = TXT; ctx.fillText(pv.toFixed(2), plotW + 6, my + 4);
        }
      }
      // OHLC legend — hovering the empty right-offset region shows the last
      // real bar (there is no candle under the cursor there).
      const li = Math.min(dataEnd, Math.max(start, this.mouse ? this._idxAtX(this.mouse.x) : dataEnd));
      if (li >= 0 && li < c.n) {
        ctx.fillStyle = TXT; ctx.font = '12px -apple-system, "Segoe UI", Roboto, sans-serif';
        const d = new Date(c.times[li] * 60000);
        const up = c.close[li] >= c.open[li];
        ctx.fillStyle = up ? UP : DOWN;
        ctx.fillText(`O ${c.open[li].toFixed(2)}  H ${c.high[li].toFixed(2)}  L ${c.low[li].toFixed(2)}  C ${c.close[li].toFixed(2)}   ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`, 8, 16);
      }
      this._drawOsc(start, dataEnd);
    }
    _barIndexOfTime(tMs) {
      // plots carry time in ms; candles carry epoch minutes. Binary search.
      if (!this.candles) return null;
      const target = Math.floor(tMs / 60000);
      const times = this.candles.times;
      let lo = 0, hi = times.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] === target) return mid;
        if (times[mid] < target) lo = mid + 1; else hi = mid - 1;
      }
      return null;
    }
    _drawX(x, xloc) {
      if (x === null || x === undefined || Number.isNaN(x)) return null;
      if (xloc === 'bar_time') {
        const bi = this._barIndexOfTime(x);
        return bi === null ? null : this._xAtIdx(bi);
      }
      return this._xAtIdx(x + this.barOffset); // bar_index (window-relative — see barOffset)
    }
    _drawOsc(start, end) {
      if (!this.osc) return;
      // Panes: Pine overlay=false plots share one pane ("Pine"); each
      // built-in pane indicator gets its own pane (its own scale — RSI 0-100
      // must not squash MACD). The wrap grows 110px per pane (max 330px)
      // and hides when there is nothing to show.
      const groups = [];
      const pineKeys = Object.keys(this.plots).filter((k) => this.plotMeta[k] && this.plotMeta[k].overlay === false);
      if (pineKeys.length) groups.push({ name: 'Pine', series: pineKeys.map((k) => ({ key: k, color: this.plotMeta[k].color, style: 'line', pine: true })) });
      for (const s of this.ind) {
        if (s.overlay !== false) continue;
        let g = groups.find((x) => x.name === s.pane);
        if (!g) { g = { name: s.pane, series: [] }; groups.push(g); }
        g.series.push(s);
      }
      const wrap = this.osc.parentElement;
      const nPanes = groups.length;
      if (this._oscPanes !== nPanes && wrap) {
        this._oscPanes = nPanes;
        wrap.style.display = nPanes ? '' : 'none';
        wrap.style.height = nPanes ? (Math.min(nPanes, 3) * 110) + 'px' : '0px';
      }
      if (!nPanes) return;
      const { ctx, w, h } = this._fitCanvas(this.osc);
      if (h <= 0 || w <= 0) return;
      ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, w, h);
      const plotW = w - 64;
      const paneH = h / nPanes;
      groups.forEach((g, gi) => {
        const top = gi * paneH, bot = top + paneH;
        const ph = paneH - 22; // leave room for the time/legend strip
        let lo = Infinity, hi = -Infinity;
        // scale from visible values
        for (const s of g.series) {
          if (s.pine) {
            const vals = this._plotVals[s.key];
            if (vals) {
              for (let i = start; i <= end; i++) {
                const v = vals[i];
                if (typeof v === 'number' && !Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
              }
            } else {
              for (const p of this.plots[s.key]) {
                if (typeof p.v !== 'number' || Number.isNaN(p.v)) continue;
                const bi = this._barIndexOfTime(p.t);
                if (bi === null || bi < start || bi > end) continue;
                lo = Math.min(lo, p.v); hi = Math.max(hi, p.v);
              }
            }
          } else {
            for (let i = start; i <= end; i++) {
              const val = s.values[i];
              if (typeof val === 'number' && !Number.isNaN(val)) { lo = Math.min(lo, val); hi = Math.max(hi, val); }
            }
          }
        }
        // histogram series include the zero line in their scale
        if (g.series.some((s) => s.style === 'histogram')) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        if (!isFinite(lo)) { lo = -100; hi = 0; }
        const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
        const yOf = (v) => top + 4 + (hi - v) / (hi - lo) * (ph - 8);
        // grid
        ctx.strokeStyle = GRID; ctx.fillStyle = AXIS_TXT; ctx.font = '11px sans-serif';
        for (let gg = 0; gg <= 4; gg++) {
          const v = lo + (hi - lo) * gg / 4, y = yOf(v);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
          ctx.fillText(v.toFixed(1), plotW + 6, y + 4);
        }
        // levels (RSI 70/30, Stoch 80/20)
        for (const s of g.series) {
          for (const lv of (s.levels || [])) {
            ctx.strokeStyle = lv.color || '#787b86'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(0, yOf(lv.v)); ctx.lineTo(plotW, yOf(lv.v)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = lv.color || '#787b86';
            ctx.fillText(String(lv.v), plotW + 6, yOf(lv.v) - 3);
          }
        }
        // zero line for histograms
        if (g.series.some((s) => s.style === 'histogram')) {
          ctx.strokeStyle = '#363c4e';
          ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(plotW, yOf(0)); ctx.stroke();
        }
        // series
        let pi = 0;
        for (const s of g.series) {
          const color = cssColor(s.color, PALETTE[pi++ % PALETTE.length]);
          if (s.style === 'histogram') {
            const bw = Math.max(1, Math.min(8, this.barW * 0.6));
            ctx.fillStyle = color;
            for (let i = start; i <= end; i++) {
              const val = s.values[i];
              if (typeof val !== 'number' || Number.isNaN(val)) continue;
              const x = this._xAtIdx(i), y = yOf(val), y0 = yOf(0);
              ctx.fillRect(x - bw / 2, Math.min(y, y0), bw, Math.max(1, Math.abs(y - y0)));
            }
            continue;
          }
          ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
          let started = false;
          const drawPoint = (bi, v) => {
            const x = this._xAtIdx(bi), y = yOf(v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          };
          if (s.pine) {
            const vals = this._plotVals[s.key];
            const cols = this._plotCols[s.key];
            if (vals) {
              // Series colors change mid-line (same as the main pane).
              let cur = null, havePrev = false;
              const flush = () => { if (started) ctx.stroke(); started = false; };
              for (let i = start; i <= end; i++) {
                const v = vals[i];
                if (typeof v !== 'number' || Number.isNaN(v)) { flush(); cur = null; havePrev = false; continue; }
                const col = (cols && cols[i]) || color;
                if (col !== cur) {
                  flush();
                  cur = col; ctx.strokeStyle = col; ctx.beginPath();
                  if (havePrev) { const x = this._xAtIdx(i - 1), y = yOf(vals[i - 1]); ctx.moveTo(x, y); started = true; }
                }
                drawPoint(i, v);
                havePrev = true;
              }
              flush();
            } else {
              for (const p of this.plots[s.key]) {
                if (typeof p.v !== 'number' || Number.isNaN(p.v)) { started = false; continue; }
                const bi = this._barIndexOfTime(p.t);
                if (bi === null || bi < start || bi > end) { started = false; continue; }
                drawPoint(bi, p.v);
              }
              ctx.stroke();
            }
          } else {
            for (let i = start; i <= end; i++) {
              const val = s.values[i];
              if (typeof val !== 'number' || Number.isNaN(val)) { started = false; continue; }
              drawPoint(i, val);
            }
            ctx.stroke();
          }
        }
        // pane separator + legend
        if (gi > 0) {
          ctx.strokeStyle = '#363c4e';
          ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(w, top); ctx.stroke();
        }
        ctx.fillStyle = TXT; ctx.font = '11px sans-serif';
        let legend = g.name + '  ·  ' + g.series.map((s) => s.label || s.key).join('  ·  ');
        while (legend.length > 4 && ctx.measureText(legend).width > plotW - 16) legend = legend.slice(0, -4) + '…';
        ctx.fillText(legend, 8, top + 14);
      });
    }
  }

  function fmtTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  globalThis.GoldChart = Chart;
})();
