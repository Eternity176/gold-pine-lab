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
      this.endIdx = 0; this.barW = 0; this.viewBars = 300;
      this.mouse = null; this.onHover = null; this.type = 'candles';
      this._bind();
    }
    _bind() {
      const el = this.main;
      let drag = null;
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!this.candles) return;
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const anchorIdx = this._idxAtX(mx);
        const factor = e.deltaY < 0 ? 0.85 : 1.18;
        this.viewBars = Math.max(20, Math.min(20000, Math.round(this.viewBars * factor)));
        // keep anchor bar under cursor
        const plotW = this._plotW();
        const frac = (mx - 4) / Math.max(1, plotW);
        this.endIdx = Math.round(anchorIdx + (this.viewBars - 1) * (1 - frac) + frac * 0);
        this.endIdx = Math.min(this.candles.n - 1, Math.max(this.viewBars - 1, this.endIdx));
        this.draw();
      }, { passive: false });
      el.addEventListener('mousedown', (e) => { drag = { x: e.clientX, end: this.endIdx }; });
      window.addEventListener('mousemove', (e) => {
        if (drag && this.candles) {
          const dx = e.clientX - drag.x;
          const bars = Math.round(dx / Math.max(2, this.barW));
          this.endIdx = Math.min(this.candles.n - 1, Math.max(this.viewBars - 1, drag.end - bars));
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
      return start + Math.floor((x - 4) / Math.max(1, this.barW));
    }
    _xAtIdx(i) {
      const start = this.endIdx - this.viewBars + 1;
      return 4 + (i - start) * this.barW + this.barW / 2;
    }
    setData(candles, plots, plotMeta, drawings, trades) {
      this.candles = candles; this.plots = plots || {}; this.plotMeta = plotMeta || {};
      this.labels = (drawings && drawings.labels) || [];
      this.lines = (drawings && drawings.lines) || [];
      this.boxes = (drawings && drawings.boxes) || [];
      this.trades = trades || [];
      this.endIdx = candles.n - 1;
      this.viewBars = Math.min(300, candles.n);
      this.draw();
    }
    resetView() {
      if (!this.candles) return;
      this.endIdx = this.candles.n - 1;
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
      const end = this.endIdx;
      this.barW = plotW / Math.max(1, end - start + 1);
      const c = this.candles;
      // price range from visible candles + overlay plots
      let lo = Infinity, hi = -Infinity;
      for (let i = start; i <= end; i++) { lo = Math.min(lo, c.low[i]); hi = Math.max(hi, c.high[i]); }
      for (const key of Object.keys(this.plots)) {
        const m = this.plotMeta[key];
        if (m && m.overlay === false) continue;
        const pts = this.plots[key];
        for (const p of pts) {
          if (typeof p.v !== 'number' || Number.isNaN(p.v)) continue;
          const bi = this._barIndexOfTime(p.t);
          if (bi === null || bi < start || bi > end) continue;
          lo = Math.min(lo, p.v); hi = Math.max(hi, p.v);
        }
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
      // time grid ( ~8 labels)
      const nLab = 8;
      for (let g = 0; g <= nLab; g++) {
        const i = Math.round(start + (end - start) * g / nLab);
        const x = xOf(i);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
        const d = new Date(c.times[i] * 60000);
        ctx.fillText(fmtTime(d), x - 24, h - 6);
      }
      // candles (or line / area)
      if (this.type === 'line' || this.type === 'area') {
        ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 1.5; ctx.beginPath();
        let started = false;
        for (let i = start; i <= end; i++) {
          const x = xOf(i), y = yOf(c.close[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (this.type === 'area') {
          ctx.lineTo(xOf(end), yOf(lo)); ctx.lineTo(xOf(start), yOf(lo)); ctx.closePath();
          ctx.fillStyle = 'rgba(41,98,255,0.12)'; ctx.fill();
        }
      } else {
      const bw = Math.max(1, Math.min(14, this.barW * 0.7));
      for (let i = start; i <= end; i++) {
        const x = xOf(i), up = c.close[i] >= c.open[i];
        ctx.strokeStyle = ctx.fillStyle = up ? UP : DOWN;
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
        const pts = this.plots[key];
        const color = cssColor(m && m.color, PALETTE[pi++ % PALETTE.length]);
        const isBool = pts.some((p) => p.v === true || p.v === false);
        if (isBool) {
          // plotshape: triangle above high (red-ish) or below low (green-ish)
          for (const p of pts) {
            if (p.v !== true) continue;
            const bi = this._barIndexOfTime(p.t);
            if (bi === null || bi < start || bi > end) continue;
            const x = xOf(bi);
            const down = /short|sell|red/i.test(key);
            const y = down ? yOf(c.high[bi]) - 10 : yOf(c.low[bi]) + 10;
            ctx.fillStyle = down ? '#ff1744' : '#00e676';
            ctx.beginPath();
            if (down) { ctx.moveTo(x, y + 5); ctx.lineTo(x - 5, y - 4); ctx.lineTo(x + 5, y - 4); }
            else { ctx.moveTo(x, y - 5); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); }
            ctx.closePath(); ctx.fill();
          }
          continue;
        }
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
        let started = false;
        for (const p of pts) {
          if (typeof p.v !== 'number' || Number.isNaN(p.v)) { started = false; continue; }
          const bi = this._barIndexOfTime(p.t);
          if (bi === null || bi < start || bi > end) { started = false; continue; }
          const x = xOf(bi), y = yOf(p.v);
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
        const bi = tr.entry_bar_index;
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
      // OHLC legend
      const li = Math.min(end, Math.max(start, this.mouse ? this._idxAtX(this.mouse.x) : end));
      if (li >= 0 && li < c.n) {
        ctx.fillStyle = TXT; ctx.font = '12px -apple-system, "Segoe UI", Roboto, sans-serif';
        const d = new Date(c.times[li] * 60000);
        const up = c.close[li] >= c.open[li];
        ctx.fillStyle = up ? UP : DOWN;
        ctx.fillText(`O ${c.open[li].toFixed(2)}  H ${c.high[li].toFixed(2)}  L ${c.low[li].toFixed(2)}  C ${c.close[li].toFixed(2)}   ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`, 8, 16);
      }
      this._drawOsc(start, end);
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
      return this._xAtIdx(x); // bar_index
    }
    _drawOsc(start, end) {
      if (!this.osc) return;
      const { ctx, w, h } = this._fitCanvas(this.osc);
      ctx.fillStyle = '#131722'; ctx.fillRect(0, 0, w, h);
      const keys = Object.keys(this.plots).filter((k) => this.plotMeta[k] && this.plotMeta[k].overlay === false);
      if (!keys.length) {
        ctx.fillStyle = AXIS_TXT; ctx.font = '11px sans-serif';
        ctx.fillText('Oscillator pane — no overlay=false plots from this script', 8, 16);
        return;
      }
      let lo = Infinity, hi = -Infinity;
      for (const key of keys) {
        for (const p of this.plots[key]) {
          if (typeof p.v !== 'number' || Number.isNaN(p.v)) continue;
          const bi = this._barIndexOfTime(p.t);
          if (bi === null || bi < start || bi > end) continue;
          lo = Math.min(lo, p.v); hi = Math.max(hi, p.v);
        }
      }
      if (!isFinite(lo)) { lo = -100; hi = 0; }
      const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
      const yOf = (v) => 4 + (hi - v) / (hi - lo) * (h - 22);
      const plotW = w - 64;
      ctx.strokeStyle = GRID;
      for (let g = 0; g <= 4; g++) {
        const v = lo + (hi - lo) * g / 4, y = yOf(v);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
        ctx.fillStyle = AXIS_TXT; ctx.font = '11px sans-serif';
        ctx.fillText(v.toFixed(1), plotW + 6, y + 4);
      }
      let pi = 0;
      for (const key of keys) {
        ctx.strokeStyle = cssColor(this.plotMeta[key].color, PALETTE[pi++ % PALETTE.length]);
        ctx.lineWidth = 1.2; ctx.beginPath();
        let started = false;
        for (const p of this.plots[key]) {
          if (typeof p.v !== 'number' || Number.isNaN(p.v)) { started = false; continue; }
          const bi = this._barIndexOfTime(p.t);
          if (bi === null || bi < start || bi > end) { started = false; continue; }
          const x = this._xAtIdx(bi), y = yOf(p.v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // legend (bottom-left, clear of the top hline)
      ctx.fillStyle = TXT; ctx.font = '11px sans-serif';
      let legend = keys.join('  ·  ');
      while (legend.length > 4 && ctx.measureText(legend).width > plotW - 16) legend = legend.slice(0, -4) + '…';
      ctx.fillText(legend, 8, h - 8);
    }
  }

  function fmtTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  globalThis.GoldChart = Chart;
})();
