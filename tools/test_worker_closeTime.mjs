// Regression test for the barstate.isconfirmed fix (2026-11-10): the worker
// must pass closeTime = openTime + timeframe on every candle, so PineTS
// confirms closed bars. Without it the LuxAlgo clone (confirmOnClose=true)
// produced ZERO signals on any recent/live window. Run:
//   node tools/test_worker_closeTime.mjs
// Requires /tmp/live.json (fetched from the deployed /api/live) for the
// live-bars case; skips that case with a warning if it is absent.
import fs from 'node:fs';
import vm from 'node:vm';

const root = '/home/hatch/workspace/backtest-platform/';
function parseBin(path) {
  const buf = fs.readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(0, true);
  const times = new Uint32Array(buf.buffer, buf.byteOffset + 4, n);
  const off = 4 + 4 * n;
  const open = new Float32Array(buf.buffer, buf.byteOffset + off, n);
  const high = new Float32Array(buf.buffer, buf.byteOffset + off + 4 * n, n);
  const low = new Float32Array(buf.buffer, buf.byteOffset + off + 8 * n, n);
  const close = new Float32Array(buf.buffer, buf.byteOffset + off + 12 * n, n);
  return { n, times, open, high, low, close };
}
function loadWorker() {
  const posted = [];
  const sandbox = { self: { postMessage: (m) => posted.push(m) }, console, URL, Blob };
  sandbox.self.Function = Function;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(root + f, 'utf8'), sandbox, { filename: f });
  };
  vm.runInContext(fs.readFileSync(root + 'pine-worker.js', 'utf8'), sandbox, { filename: 'pine-worker.js' });
  return { sandbox, posted };
}
async function runWorker(times, open, high, low, close, timeframe) {
  const { sandbox, posted } = loadWorker();
  await sandbox.self.onmessage({ data: { type: 'run', code: fs.readFileSync('/home/hatch/workspace/tradingview/luxalgo-signals-overlays-clone.pine', 'utf8'), times, open, high, low, close, symbol: 'XAUUSD', timeframe, initialCapital: 10000 } });
  const result = posted.find((m) => m.type === 'result');
  if (!result) throw new Error('no result; posted: ' + posted.map((m) => m.type + ':' + (m.message || '')).join(', '));
  return result;
}
let fail = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' ' + extra)); if (!cond) fail++; };
const countIn = (plots, key, from) => {
  const p = plots[key]; if (!p) return -1;
  return p.filter((pt) => pt.v === true && pt.t >= from).length;
};

// Case 1 — live bars (recent window): the clone must produce signals.
if (fs.existsSync('/tmp/live.json')) {
  const live = JSON.parse(fs.readFileSync('/tmp/live.json', 'utf8')).bars;
  const n = live.length;
  const times = new Uint32Array(n), open = new Float32Array(n), high = new Float32Array(n), low = new Float32Array(n), close = new Float32Array(n);
  live.forEach((b, i) => { times[i] = b[0]; open[i] = b[1]; high[i] = b[2]; low[i] = b[3]; close[i] = b[4]; });
  const r = await runWorker(times, open, high, low, close, '1m');
  const fromMs = (live[n - 300][0]) * 60000;
  const longs = countIn(r.plots, 'Long', fromMs) + countIn(r.plots, 'Long Strong', fromMs);
  const shorts = countIn(r.plots, 'Short', fromMs) + countIn(r.plots, 'Short Strong', fromMs);
  ok('live window: Long signals in last 300 bars', longs > 0, `longs=${longs}`);
  ok('live window: Short signals in last 300 bars', shorts > 0, `shorts=${shorts}`);
  ok('live window: barcolor still present', (r.plots['Candle Coloring'] || []).length > 0);
} else {
  console.log('SKIP live-bars case: /tmp/live.json not found (fetch https://gold-pine-lab.vercel.app/api/live?limit=1000)');
}

// Case 2 — bundled bars: signal counts must be UNCHANGED by the fix
// (isconfirmed was already true there; pre-fix baseline: Long 52, Short 45).
const d = parseBin(root + 'data/2025.bin');
const N = 2000, s = d.n - N;
const r2 = await runWorker(d.times.slice(s), d.open.slice(s), d.high.slice(s), d.low.slice(s), d.close.slice(s), '1m');
ok('bundled: Long count unchanged (52)', (r2.plots['Long'] || []).filter((p) => p.v === true).length === 52, `got ${(r2.plots['Long'] || []).filter((p) => p.v === true).length}`);
ok('bundled: Short count unchanged (45)', (r2.plots['Short'] || []).filter((p) => p.v === true).length === 45, `got ${(r2.plots['Short'] || []).filter((p) => p.v === true).length}`);
ok('bundled: Smart Trail still numeric', (r2.plots['Smart Trail'] || []).some((p) => typeof p.v === 'number'));

console.log(fail === 0 ? 'ALL CLOSETIME TESTS PASSED' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
