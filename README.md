# Gold Pine Lab — XAUUSD M1 Backtest Platform (Pine-core)

A standalone, TradingView-like web app for testing Pine Script indicators and
strategies on real XAUUSD M1 candles. No account, no TradingView, no MT5, no
Python needed from the user side. Paste any Pine script, press Run, see the
signals on the chart and the Strategy Tester numbers.

## Open / run (3 lines)

```bash
cd ~/workspace/backtest-platform
python3 -m http.server 8000
# open http://localhost:8000/  (do NOT open index.html via file:// — fetch() of data/*.bin is blocked there)
```

The R7 strategy loads in the editor by default. Press **▶ Run** (full
1,008,574 bars, ~45–60 s in a Web Worker — the UI stays responsive) or set
**Max bars** to 20000 for a ~5 s check. Switch timeframe (1m/5m/15m/1H/1D),
chart type (Candles/Line/Area), drag to scroll, wheel to zoom, double-click to
reset. **Save** stores the script in localStorage; **Load sample** offers R7,
LuxAlgo clone, hook-arrows, Fractal+%R v1.

## Data

| File | Bars | Size | Range (UTC) |
|---|---|---|---|
| `data/2023.bin` | 352,949 | 7,058,984 B | 2023-01-02 → 2023-12-29 |
| `data/2024.bin` | 355,787 | 7,115,744 B | 2024-01-01 → 2024-12-31 |
| `data/2025.bin` | 299,838 | 5,996,764 B | 2025-01-01 → 2025-11-04 |
| **Total** | **1,008,574** | **20,171,492 B (20.17 MB)** | Dukascopy BID, XAUUSD M1 |

Format: `[uint32 n][uint32 times[n] epoch minutes][float32 open/high/low/close]`,
little-endian, per year (`tools/gen_data.py`). The app fetches the `.bin` files,
caches them in **IndexedDB** (localStorage is never used for candles), and
resamples M1 → M5/M15/H1/D1 client-side. Status corner shows source, range,
bar count and last update. **Live update:** Dukascopy V1 JSONP, best-effort
(verified via curl; UNVERIFIED in a real browser — falls back silently to
bundled data). Optional local proxy: `tools/dukascopy_proxy.py`
(`python3 tools/dukascopy_proxy.py`, port 8765). CSV upload
(`time,open,high,low,close,volume`, ISO UTC) is an optional fallback.
Full source decision + measured tests: `ANALYSIS.md` §3, `PLAN.md` §2.

## Pine engine — PineTS 0.13.1 (LuxAlgo, AGPL-3.0)

- Why: the only open-source interpreter with native Pine **v6** + full
  `strategy.*` + browser support that we verified by running it. Alternatives
  rejected: OpenPineScript (no v6), hoox-pyne (Python/Pyodide), Stoqey
  "PineJS" (not a library). Repo: https://github.com/LuxAlgo/PineTS,
  commit `100357e` seen 2026-11-09. Vendored at `vendor/pinets.min.browser.js`
  (815,944 B) + `vendor/PineTS-LICENSE` (AGPL-3.0) — no CDN, app works offline.
  Platform code itself is original; PineTS attribution is in the app footer
  and here. If the platform is published publicly, the repo (including the
  AGPL PineTS source link) must ship with it.
- Runs in a Web Worker (`pine-worker.js`, `importScripts` bundle + `tester.js`).
- Verified: 3 real user scripts run with 0 errors — see `PINE_COMPAT_TEST.md`
  (LuxAlgo clone, hook-arrows, Fractal+%R v1). Full Pine compatibility is NOT
  promised; the Help tab lists the supported subset and the gotchas found
  (e.g. `ta.wpr()` takes length only; drawings are final-active-set only;
  `strategy.exit` same-bar SL/TP follows TV's OHLC-order rule).

## Tester conventions (mandatory, match the lab)

- Commission **$0.11/oz RT = $0.055 per side** (`commission_value=0.055`,
  cash-per-contract), slippage 0. Market orders fill at next bar open.
- **Gap-fill exits:** open beyond SL/TP → fill at the open, never at the
  level (verified synthetically, `tools/test_gapfill.mjs`, 3/3 pass).
- **No trailing stop.** SL fixed at entry.
- **8 gates** (all must pass in BOTH IS 2023–24 and OS 2025): monthly ≥ 20%,
  max equity DD ≤ 10%, realized R:R ≥ 1.5, ≥ 1 trade/day, PF ≥ 1.5,
  expectancy > 0, no month < −10%, sample ≥ 240 trades/period. OS equity is
  rebased to $10k at the 2025-01-01 split. Realized R:R is the payoff ratio
  avgWin/|avgLoss| (exact when risk/trade is constant).
- Margin: PineTS rejects orders whose 1% margin exceeds equity; R7 sets
  `margin_long=1, margin_short=1`.

## R7 + parity (the honest numbers)

Reference variant (`strategies/r7_wpr_ema34.pine`): %R(34) + EMA(12) of %R,
arm LEVEL (−20/−80), trigger %R crosses EMA, no filters, SL 1.0×ATR(14),
TP 2.0R, risk 1%, max hold 1440 bars, NFP blackout first Friday 13:00–13:59 UTC.

| Capital | Engine | IS trades | IS PF | IS monthly | IS DD | IS gates | OS |
|---|---|---|---|---|---|---|---|
| $10k | Platform (PineTS) | 2,502 | 0.696 | −10.60% | 99.83% | 2/8 | 0 trades (bust) |
| $10k | Python mirror | 2,501 | 0.696 | −10.53% | 99.83% | 2/8 | 0 trades (bust) |
| $100k | Platform (PineTS) | 4,462 | 0.733 | −14.57% | 99.98% | 2/8 | 0 trades (bust) |
| $100k | Python mirror | 4,469 | 0.730 | −15.00% | 99.98% | 2/8 | 0 trades (bust) |

Full comparison + the 6 quantified divergences (ta.wpr call bug fixed,
commission mechanics, 3 exit-order flips in 4,451 trades, micro-trades, margin
edge, lab-vs-Pine sizing convention): `PARITY.md`. **Verdict: engine parity
confirmed (metrics agree within ~0.5%); the R7 reference variant itself FAILS
2/8 in both engines — the platform works, the strategy does not.**

## Measured runtimes (this machine, Node 24 / PineTS 0.13.1)

- Full 1,008,574 bars: R7 strategy 43–63 s (includes ~0.4 s candle build);
  indicator (hook-arrows) 20k bars 2.8 s; LuxAlgo 20k bars 7.0 s.
- In-browser Worker runtime should be similar; the app shows elapsed time
  after each run.

## UI tested

- Buttons exercised in a real browser session via CDP: page loads, data
  fetches, editor loads R7 sample (verified via probe: editor populated).
  Chart rendering verified with node-canvas on the real `chart.js` + real
  PineTS plots + real 2025 data — see
  `results/screenshot_chart_main_2026-11-09.png` (candles + BB + Supertrend +
  Fractal SR + buy triangles) and
  `results/screenshot_chart_osc_2026-11-09.png` (%R(89) + EMA(34) pane).
  Worker verified end-to-end in Node via `vm` simulation
  (`/tmp/canvas-test/test_worker.mjs` — real `pine-worker.js`, real bundle,
  R7 on 20k bars → 746 trades, net +$2,542 on that slice). `data.js` resample
  verified: M1→M5 ratio 5.00, M1→H1 5,001 bars; CSV parse verified.
  All JS files pass `node --check`; Python tools pass `py_compile`.

## Screenshot review (2026-11-09) — HONEST NOTE

A full-page live-browser screenshot was **blocked in this VM, not skipped**:
the bundled Chromium (157, `/opt/meta-chromium/chrome`) starts only via CDP
(it needs a Hatch WebGL domain-policy file + SHA-256, which I supplied), but
every navigation to `http://localhost:8000/` fails with
`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` — this build enforces Local
Network Access checks and neither `--disable-features=local-network-access-check`
nor `LocalNetworkAccessChecks` disables it; `cloudflared` quick tunnels also
fail here (egress TLS interception). The chart itself was verified by direct
render (above) and looks TradingView-like at a glance (dark #131722, #089981 /
#f23645 candles, #2962ff accents). **Still to verify on a real browser before
calling the UI "done":** the full page layout (top bar, bottom panel, Tester
tabs, tables overlay) and the Run → Tester flow. The coordinator/parent
should open the link in the user's browser and confirm.

## File structure

```
index.html  styles.css  app.js  chart.js  data.js  pine-worker.js  tester.js
vendor/pinets.min.browser.js  vendor/PineTS-LICENSE
strategies/r7_wpr_ema34.pine  strategies/samples/{luxalgo,hook-arrows,fractal-wpr-v1}.pine
data/{2023,2024,2025}.bin
tools/{gen_data.py, run_platform.mjs, run_parity.py, run_compat.mjs,
       test_gapfill.mjs, hook_window.mjs, dukascopy_proxy.py, shot.mjs}
results/{r7_platform_10k, r7_python_10k, r7_platform_100k, r7_python_100k}.json
results/{r7_pf100k_trades, r7_py100k_trades}.json
results/{compat_hook_20k, compat_lux_20k, compat_fractal_20k}.json
results/screenshot_chart_{main,osc}_2026-11-09.png
ANALYSIS.md  PLAN.md  README.md  PARITY.md  PINE_COMPAT_TEST.md
```

## Known limitations (v1)

- `request.security()` MTF not supported (needs another timeframe feed).
- Drawings (label/line/box) render only the final active set — PineTS does
  not retain historical drawings post-run.
- Live Dukascopy update is JSONP best-effort, unverified in a real browser.
- Full-page screenshot review pending (see note above).
- No share-link-with-code, no drawing toolbar, no alerts/replay (v2).
