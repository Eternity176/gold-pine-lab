// End-to-end worker test: run the REAL pine-worker.js (via vm + stubs) on
// real bundled candles + the luxalgo clone; verify the plot payload the
// chart receives carries per-point colors + plotshape metadata, and that
// boolean plots are filtered to true-only.
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
const N = 2000, s = d.n - N;
const msg = {
  type: 'run',
  code: fs.readFileSync('/home/hatch/workspace/tradingview/luxalgo-signals-overlays-clone.pine', 'utf8'),
  times: d.times.slice(s), open: d.open.slice(s), high: d.high.slice(s), low: d.low.slice(s), close: d.close.slice(s),
  symbol: 'XAUUSD', timeframe: '1m', initialCapital: 10000,
};

const posted = [];
const sandbox = {
  self: { postMessage: (m) => posted.push(m) },
  console, URL, Blob,
};
sandbox.self.Function = Function;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// importScripts stub: eval the file in the same context.
sandbox.importScripts = (...files) => {
  for (const f of files) vm.runInContext(fs.readFileSync(root + f, 'utf8'), sandbox, { filename: f });
};
vm.runInContext(fs.readFileSync(root + 'pine-worker.js', 'utf8'), sandbox, { filename: 'pine-worker.js' });

await sandbox.self.onmessage({ data: msg });
const result = posted.find((m) => m.type === 'result');
if (!result) { console.log('FAIL no result; posted:', posted.map((m) => m.type + ':' + (m.message || ''))); process.exit(1); }

let fail = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' ' + extra)); if (!cond) fail++; };

const bc = result.plots['Candle Coloring'];
ok('barcolor: all points true (bool filter kept them)', bc && bc.length > 0 && bc.every((p) => p.v === true), `n=${bc && bc.length}`);
ok('barcolor: per-point colors present (green/red/purple)', bc && bc.some((p) => p.c === '#00e676') && bc.some((p) => p.c === '#ff1744') && bc.some((p) => p.c === '#7e57c2'));
ok('barcolor: meta style is barcolor', result.plotMeta['Candle Coloring'].style === 'barcolor', `style=${result.plotMeta['Candle Coloring'].style}`);

const lg = result.plots['Long'];
ok('Long: only true points survive (no false spam)', lg && lg.length > 0 && lg.every((p) => p.v === true), `n=${lg && lg.length}`);
ok('Long: label metadata kept (text/shape/loc/color)', lg && lg.every((p) => p.text === '▲' && p.shape === 'shape_label_up' && p.loc === 'BelowBar' && p.c === '#089981'), JSON.stringify(lg && lg[0]));
const ls = result.plots['Long Strong'];
ok('Long Strong: ▲+ glyph kept', ls && ls.length > 0 && ls.every((p) => p.text === '▲+'), `n=${ls && ls.length}`);
const sh = result.plots['Short'];
ok('Short: ▼ glyph + AboveBar kept', sh && sh.length > 0 && sh.every((p) => p.text === '▼' && p.loc === 'AboveBar' && p.c === '#f23645'), `n=${sh && sh.length}`);
const ex = result.plots['Exit Long'];
ok('Exit Long: xcross shape kept', ex && ex.length > 0 && ex.every((p) => p.shape === 'shape_xcross'), `n=${ex && ex.length}`);

const st = result.plots['Smart Trail'];
const stColors = new Set(st.map((p) => p.c).filter(Boolean));
ok('Smart Trail: per-point colors change green<->red', stColors.has('#00e676') && stColors.has('#ff1744'), JSON.stringify([...stColors]));
ok('Smart Trail: numeric values present', st.some((p) => typeof p.v === 'number'));

console.log(fail === 0 ? 'ALL WORKER CLONE TESTS PASSED' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
