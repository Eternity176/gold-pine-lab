// Verify the Gold Trail fixes through the REAL worker:
//  1. Gold Trail: plots overlay=true, trades>0, labels>0, dashboard real.
//     2nd run (compile cache) must give the same.
//  2. R7 (20k preview): trades>0, EMA(%R) plot overlay=false (pane).
//  3. LuxAlgo clone: labels in live window, overlay=true (unchanged).
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
const d = parseBin(root + 'data/2025.bin');
const live = JSON.parse(fs.readFileSync('/tmp/live.json', 'utf8')).bars;
const NB = 19000;
const times = [], open = [], high = [], low = [], close = [];
for (let i = d.n - NB; i < d.n; i++) { times.push(d.times[i]); open.push(d.open[i]); high.push(d.high[i]); low.push(d.low[i]); close.push(d.close[i]); }
for (const b of live) { times.push(b[0]); open.push(b[1]); high.push(b[2]); low.push(b[3]); close.push(b[4]); }
const series = { times: new Uint32Array(times), open: new Float32Array(open), high: new Float32Array(high), low: new Float32Array(low), close: new Float32Array(close) };
const posted = [];
const sandbox = { self: { postMessage: (m) => posted.push(m) }, console, URL, Blob };
sandbox.self.Function = Function;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
sandbox.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(root + f, 'utf8'), sandbox, { filename: f }); };
vm.runInContext(fs.readFileSync(root + 'pine-worker.js', 'utf8'), sandbox, { filename: 'pine-worker.js' });
async function run(code) {
  posted.length = 0;
  await sandbox.self.onmessage({ data: { type: 'run', code, times: series.times, open: series.open, high: series.high, low: series.low, close: series.close, symbol: 'XAUUSD', timeframe: '1m', initialCapital: 10000 } });
  const r = posted.find((m) => m.type === 'result');
  const e = posted.find((m) => m.type === 'error');
  if (e) throw new Error('worker error: ' + e.message);
  if (!r) throw new Error('no result');
  return r;
}
let fails = 0;
const check = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); if (!cond) fails++; };

// 1. Gold Trail, fresh run
const trailCode = fs.readFileSync('/home/hatch/workspace/tradingview/gold-trend-trail.pine', 'utf8');
const t1 = await run(trailCode);
check('Trail: Glow/Trail overlay=true (main chart)', t1.plotMeta['Glow'].overlay === true && t1.plotMeta['Trail'].overlay === true, `Glow=${t1.plotMeta['Glow'].overlay} Trail=${t1.plotMeta['Trail'].overlay}`);
check('Trail: Stop/TP1/TP2 overlay=true', t1.plotMeta['Stop'].overlay === true && t1.plotMeta['TP1'].overlay === true && t1.plotMeta['TP2'].overlay === true);
check('Trail: closed trades > 0', t1.strategy.closedtrades > 0, `${t1.strategy.closedtrades} trades`);
check('Trail: netprofit is a real number', typeof t1.strategy.netprofit === 'number' && t1.strategy.netprofit !== 0, `net=${t1.strategy.netprofit}`);
check('Trail: labels (BUY/SELL) > 0', (t1.labels || []).length > 0, `${(t1.labels || []).length} labels`);
// 1b. Gold Trail, cached 2nd run (compile cache path)
const t2 = await run(trailCode);
check('Trail cached run: same trade count', t2.strategy.closedtrades === t1.strategy.closedtrades, `${t2.strategy.closedtrades} vs ${t1.strategy.closedtrades}`);
check('Trail cached run: overlay still true', t2.plotMeta['Trail'].overlay === true);

// 2. R7 preview
const r7 = await run(fs.readFileSync(root + 'strategies/r7_wpr_ema34.pine', 'utf8'));
check('R7: trades > 0 (engine unchanged)', r7.strategy.closedtrades > 0, `${r7.strategy.closedtrades} trades`);
check('R7: EMA(%R) overlay=false (stays in pane)', r7.plotMeta['EMA(%R)'].overlay === false, `overlay=${r7.plotMeta['EMA(%R)'].overlay}`);

// 3. LuxAlgo clone
const lux = await run(fs.readFileSync(root + 'strategies/samples/luxalgo-signals-overlays-clone.pine', 'utf8'));
let luxLive = 0;
for (const k of ['Long', 'Long Strong', 'Short', 'Short Strong']) luxLive += (lux.plots[k] || []).filter((p) => p.v === true && p.t >= series.times[series.times.length - 300] * 60000).length;
check('Clone: live-window signals > 0', luxLive > 0, `${luxLive} in last 300 bars`);
check('Clone: Smart Trail overlay=true', lux.plotMeta['Smart Trail'].overlay === true);
console.log(fails === 0 ? 'ALL TRAILFIX TESTS PASSED' : `${fails} FAILURES`);
process.exit(fails ? 1 : 0);
