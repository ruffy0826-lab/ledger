// 抓台股（上市＋上櫃）、美股（含 ETF）、加密貨幣價格，全部換成台幣，寫到 prices.json
// 由 .github/workflows/prices.yml 每小時執行，結果推到 prices 分支，App 從 raw.githubusercontent.com 讀
import { writeFileSync } from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Accept: 'application/json, text/plain, */*' };
const num = v => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const r4 = n => Math.round(n * 10000) / 10000;
async function getText(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}
const getJSON = async (url, tries) => JSON.parse(await getText(url, tries));
// 簡易 CSV（支援雙引號欄位）
const csv = t => t.split(/\r?\n/).filter(l => l.trim()).map(l => { const r = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { r.push(cur); cur = ''; } else cur += ch; } r.push(cur); return r.map(x => x.trim().replace(/^=/, '')); });
// 在任意 JSON 裡找出「代號＋價格」的列
function collect(node, out, codeKeys, priceKeys) {
  if (Array.isArray(node)) { for (const x of node) collect(x, out, codeKeys, priceKeys); return; }
  if (!node || typeof node !== 'object') return;
  const ck = codeKeys.find(k => typeof node[k] === 'string'), pk = priceKeys.find(k => k in node);
  if (ck && pk) { const p = num(node[pk]); if (p) out[node[ck].trim().toUpperCase()] = p; return; }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collect(v, out, codeKeys, priceKeys);
}

const out = { updated: new Date().toISOString(), currency: 'TWD', fx: {}, tw: {}, us: {}, crypto: {}, errors: [] };
const step = async (name, fn) => { try { await fn(); } catch (e) { out.errors.push(`${name}: ${e.message}`); console.error(name, e.message); } };

// 匯率
await step('fx', async () => {
  const j = await getJSON('https://open.er-api.com/v6/latest/USD');
  const twd = num(j?.rates?.TWD); if (!twd) throw new Error('no TWD rate');
  out.fx.USD = twd;
});

// 台股上市：證交所網站的資料收盤後就更新（openapi 常慢一天，只當備援）
await step('twse', async () => {
  let n = 0;
  try {
    const t = await getText('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json');
    let f, rows;
    try { const j = JSON.parse(t); f = j.fields || []; rows = j.data || []; out.twDate = j.date || ''; }
    catch { const all = csv(t), hi = all.findIndex(r => r.includes('證券代號')); f = all[hi] || []; rows = all.slice(hi + 1); }
    const ci = f.indexOf('證券代號'), pi = f.indexOf('收盤價'), di = f.indexOf('日期');
    if (ci < 0 || pi < 0) throw new Error('欄位不對：' + f.join(','));
    for (const row of rows) { const p = num(row[pi]); if (p && row[ci]) { out.tw[String(row[ci]).trim().toUpperCase()] = p; n++; if (di >= 0 && !out.twDate) out.twDate = row[di]; } }
  } catch (e) { out.errors.push('twse-www: ' + e.message); }
  if (n < 500) collect(await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'), out.tw, ['Code'], ['ClosingPrice']);
});
// 台股上櫃
await step('tpex', async () => {
  collect(await getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'), out.tw, ['SecuritiesCompanyCode'], ['Close']);
});

// 美股：Nasdaq 篩選器（NYSE、Nasdaq、AMEX 全部個股＋ETF），價格是美元
const usd = {};
await step('us-stocks', async () => collect(await getJSON('https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true'), usd, ['symbol'], ['lastsale', 'lastSalePrice']));
// Nasdaq 的 ETF 篩選器從 GitHub 抓不到，改成逐檔查常見美股 ETF（要加別的代號就加在這裡）
const US_ETF = `VOO VTI SPY IVV QQQ QQQM VT VEA VWO VXUS BND BNDX AGG TLT IEF SHY SGOV BIL VGT XLK SMH SOXX SCHD VIG VYM DGRO JEPI JEPQ
DIA IWM IJH IJR MDY VB VO VTV VUG IWF IWD SPLG SPYG SPYV SCHG SCHB SCHX SCHF RSP MTUM QUAL USMV XLF XLE XLV XLY XLP XLI XLU XLB XLRE XLC
VNQ ARKK TQQQ SQQQ SOXL UPRO SSO QLD GLD IAU SLV GDX USO EFA EEM IEFA IEMG EWJ EWT EWY FXI MCHI INDA KWEB VGK VPL IBIT FBTC ETHA GBTC BITO
LQD HYG JNK EMB MUB TIP VCIT VCSH VGIT VGSH VGLT BSV BIV BLV IGSB IGIB USHY SPHY SPTL SPTS EDV ZROO VXF VV MGK VOOG VOOV VBR VBK ESGU
DGRW NOBL SDY HDV SPHD DVY FDVV COWZ AVUV AVDV DFAC DFUS DFAI IXUS ACWI URTH BOTZ ROBO ICLN TAN LIT HACK CIBR SKYY CLOU IGV FDN XBI IBB`.split(/\s+/).filter(Boolean);
await step('us-etf', async () => {
  let todo = US_ETF.filter(s => !(s in usd)); const n0 = todo.length;
  // 1) Nasdaq 個別報價
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async sym => {
      try {
        const j = await getJSON(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=etf`, 1);
        const p = num(j?.data?.primaryData?.lastSalePrice); if (p) usd[sym] = p;
      } catch {}
    }));
  }
  todo = todo.filter(s => !(s in usd)); const viaNasdaq = n0 - todo.length;
  // 2) Stooq 批次 CSV 補漏
  for (let i = 0; i < todo.length; i += 40) {
    try {
      const rows = csv(await getText(`https://stooq.com/q/l/?s=${todo.slice(i, i + 40).map(x => x.toLowerCase() + '.us').join(',')}&f=sc&h&e=csv`, 2));
      for (const [sym, close] of rows.slice(1)) { const p = num(close); if (p) usd[sym.replace(/\.US$/i, '').toUpperCase()] = p; }
    } catch (e) { console.log('stooq', e.message); }
  }
  const left = US_ETF.filter(s => !(s in usd));
  console.log('etf nasdaq', viaNasdaq, 'stooq', n0 - viaNasdaq - left.length, '查不到', left.join(' '));
  if (n0 && left.length === n0) throw new Error('ETF 全部查不到');
});
for (const [k, v] of Object.entries(usd)) if (out.fx.USD) out.us[k.replace('/', '.')] = r4(v * out.fx.USD);

// 加密貨幣：CoinGecko 市值前 500 名，直接用台幣報價；同代號取市值較大的
await step('crypto', async () => {
  for (const page of [1, 2]) {
    const list = await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=twd&order=market_cap_desc&per_page=250&page=${page}`);
    for (const c of list) { const s = String(c.symbol || '').toUpperCase(), p = num(c.current_price); if (s && p && !(s in out.crypto)) out.crypto[s] = p; }
  }
});

const n = { tw: Object.keys(out.tw).length, us: Object.keys(out.us).length, crypto: Object.keys(out.crypto).length };
console.log('twDate', out.twDate, 'counts', n, 'fx', out.fx, 'samples', { '0050': out.tw['0050'], '2330': out.tw['2330'], VOO: out.us.VOO, AAPL: out.us.AAPL, BTC: out.crypto.BTC, ETH: out.crypto.ETH });
if (!n.tw && !n.us && !n.crypto) { console.error('全部失敗', out.errors); process.exit(1); }
writeFileSync(process.argv[2] || 'prices.json', JSON.stringify(out));
