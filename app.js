import { createLedger } from './ledger.js';
import { mountAnalysis } from './analysis.js';

const SCHEMA = 5;          // 備份檔／資料格式版本。改動資料結構時 +1，並在 migrations 補上升級函式
const REMIND_DAYS = 7;     // 超過幾天沒備份就提醒
// v1 → v2：新增帳戶、時間、轉帳。舊備份沒有帳戶，還原時會自動歸到「現金」帳戶
// v2 → v3：新增可自訂的分類清單。沒有 categories 的舊備份，還原時會用預設分類＋記錄裡出現過的分類
// v3 → v4：新增往來對象（代墊／借出／借入）。舊備份沒有 people，還原後就是空的
const migrations = { 1: d => ({ ...d, schemaVersion: 2 }), 2: d => ({ ...d, schemaVersion: 3 }), 3: d => ({ ...d, schemaVersion: 4 }), 4: d => ({ ...d, schemaVersion: 5 }) };
// v4 → v5：新增貸款與分期付款（loans／installs）。舊備份沒有這兩項，還原後就是空的
const TYPES = ['expense', 'income', 'transfer', 'lend', 'advance', 'collect', 'borrow', 'payback', 'loanprin'];
const $ = s => document.querySelector(s);

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('ledger-db', 1);   // 資料庫版本；新增 store 時 +1 並加在下方
  r.onupgradeneeded = e => {
    const db = r.result;
    if (e.oldVersion < 1) { db.createObjectStore('transactions', { keyPath: 'id' }); db.createObjectStore('meta'); }
    // if (e.oldVersion < 2) { ... }
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); });
const meta = {
  get: async k => req((await dbp).transaction('meta').objectStore('meta').get(k)),
  set: async (k, v) => { const t = (await dbp).transaction('meta', 'readwrite'); t.objectStore('meta').put(v, k); await done(t); },
};

let known = null;   // id → 已寫入的 JSON；只寫有變動的記錄。null 代表下次整批重寫
const legacy = () => { try { const s = JSON.parse(localStorage.getItem('ledger:v1')); return s?.transactions ? s : null; } catch { return null; } };
const storage = {
  async load() {
    const t = (await dbp).transaction(['transactions', 'meta']);
    const [transactions, budgets, accounts, categories, people, loans, installs] = await Promise.all([req(t.objectStore('transactions').getAll()), req(t.objectStore('meta').get('budgets')), req(t.objectStore('meta').get('accounts')), req(t.objectStore('meta').get('categories')), req(t.objectStore('meta').get('people')), req(t.objectStore('meta').get('loans')), req(t.objectStore('meta').get('installs'))]);
    if (!transactions.length && !budgets) {          // 第一次開啟：把舊版 localStorage 的資料搬進來
      const old = legacy();
      if (old) { await storage.save(old); return old; }
    }
    known = new Map(transactions.map(r => [r.id, JSON.stringify(r)]));
    return { transactions, budgets: budgets || {}, accounts: accounts || [], categories, people: people || [], loans: loans || [], installs: installs || [] };
  },
  async save(state) {
    const t = (await dbp).transaction(['transactions', 'meta'], 'readwrite'), s = t.objectStore('transactions');
    try {
      if (!known) { s.clear(); known = new Map(); }
      const ids = new Set();
      for (const r of state.transactions) {
        ids.add(r.id);
        const j = JSON.stringify(r);
        if (known.get(r.id) !== j) { s.put(r); known.set(r.id, j); }
      }
      for (const id of [...known.keys()]) if (!ids.has(id)) { s.delete(id); known.delete(id); }
      t.objectStore('meta').put(state.budgets, 'budgets');
      t.objectStore('meta').put(state.accounts, 'accounts');
      t.objectStore('meta').put(state.categories, 'categories');
      t.objectStore('meta').put(state.people || [], 'people');
      t.objectStore('meta').put(state.loans || [], 'loans');
      t.objectStore('meta').put(state.installs || [], 'installs');
      await done(t);
    } catch (e) { known = null; throw e; }
  },
};

// ---------- 畫面 ----------
// 隱私偏好（只是介面設定，存在 localStorage 才能在畫面出現前就套用）
const PREF_KEY = 'ledger:prefs', prefs = { hide: false, hideOnStart: false, hideOnLeave: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY))); } catch {}
let hidden = prefs.hideOnStart || prefs.hide;
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs, hide: hidden })); } catch {} };
const ledger = createLedger($('#app'), { storage, masked: hidden, onReady: refresh, onChange: refresh });
navigator.storage?.persist?.();   // 請瀏覽器把資料標為「不要自動清除」

const nf = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const drawAnalysis = mountAnalysis($('#analysis'), () => ledger.getState(), n => (hidden ? '•••••' : nf.format(n)), () => hidden, () => ledger.getDebt());
const setTab = t => {
  document.body.dataset.tab = t;
  document.querySelectorAll('.tabbar button').forEach(x => x.setAttribute('aria-current', String(x.dataset.tab === t)));
  scrollTo(0, 0);
  if (t === 'analysis') drawAnalysis();
};
document.querySelector('.tabbar').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
$('#app').addEventListener('ledger:goto', e => setTab(e.detail));

const fmt = iso => new Date(iso).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
async function refresh() {
  const n = ledger.getState().transactions.length, last = await meta.get('lastBackup');
  const days = last ? (Date.now() - new Date(last)) / 864e5 : Infinity;
  $('#stat-count').textContent = `${n} 筆`;
  $('#stat-backup').textContent = last ? fmt(last) : '尚未備份';
  $('#banner').hidden = !(n > 0 && days >= REMIND_DAYS);
  $('#banner-text').textContent = last ? `已 ${Math.floor(days)} 天沒有備份` : '你還沒有備份過資料';
}

// ---------- 匯出 ----------
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
async function saveFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {      // iPhone：用分享表單存到「檔案」或傳給別人
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
async function exportJSON() {
  const s = ledger.getState();
  const data = { app: 'ledger', schemaVersion: SCHEMA, exportedAt: new Date().toISOString(), transactions: s.transactions, budgets: s.budgets, accounts: s.accounts, categories: s.categories, people: s.people, loans: s.loans, installs: s.installs };
  if (await saveFile(`ledger-backup-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json')) {
    await meta.set('lastBackup', data.exportedAt); refresh();
  }
}
const cell = v => {
  v = String(v);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;           // 避免 Excel 把備註當公式執行
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
function exportCSV() {
  const rows = ledger.getState().transactions.slice().sort((a, b) => a.date.localeCompare(b.date));
  const names = Object.fromEntries(ledger.getState().accounts.map(a => [a.id, a.name])), kind = { income: '收入', expense: '支出', transfer: '轉帳', lend: '借出', advance: '代墊', collect: '收回', borrow: '借入', payback: '還款', loanprin: '還本金' }, who = Object.fromEntries(ledger.getState().people.map(p => [p.id, p.name])), lname = Object.fromEntries(ledger.getState().loans.map(l => [l.id, l.name])), iname = Object.fromEntries(ledger.getState().installs.map(p => [p.id, p.name]));
  const csv = ['日期,時間,類型,帳戶,轉入帳戶,對象／項目,分類,金額,備註', ...rows.map(t => [t.date, t.time || '', kind[t.type], names[t.accountId] || '', names[t.toAccountId] || '', who[t.personId] || lname[t.loanId] || iname[t.installId] || '', t.category, t.amount, t.note].map(cell).join(','))].join('\r\n');
  saveFile(`ledger-${stamp()}.csv`, '\uFEFF' + csv, 'text/csv');   // BOM 讓 Excel 正確顯示中文
}

// ---------- 還原 ----------
function migrate(d) {
  if (!d || d.app !== 'ledger' || !Array.isArray(d.transactions)) throw new Error('這不是記帳 App 的備份檔。');
  let v = d.schemaVersion ?? 1;
  if (v > SCHEMA) throw new Error('這份備份來自較新版本的 App，請先更新 App 再還原。');
  while (v < SCHEMA) { d = migrations[v](d); v = d.schemaVersion; }
  return d;
}
async function restore(file) {
  let d;
  try { d = migrate(JSON.parse(await file.text())); } catch (e) { return alert(e instanceof SyntaxError ? '這不是有效的備份檔。' : e.message); }
  const valid = new Map();
  for (const t of d.transactions) {
    if (t && typeof t.id === 'string' && TYPES.includes(t.type) && Number(t.amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && typeof t.category === 'string')
      valid.set(t.id, { id: t.id, type: t.type, amount: Number(t.amount), accountId: t.accountId, toAccountId: t.toAccountId, ...(t.personId ? { personId: String(t.personId) } : {}), ...(t.loanId ? { loanId: String(t.loanId), payId: String(t.payId || ''), regular: !!t.regular, extra: !!t.extra } : {}), ...(t.installId ? { installId: String(t.installId), idx: Number(t.idx) } : {}), category: t.category, date: t.date, time: /^\d{2}:\d{2}$/.test(t.time) ? t.time : '', note: String(t.note || ''), createdAt: t.createdAt || 0 });
  }
  const skipped = d.transactions.length - valid.size, cur = ledger.getState();
  const ok = confirm(`要用備份取代目前的資料嗎？\n\n目前：${cur.transactions.length} 筆記錄\n備份：${valid.size} 筆記錄${d.exportedAt ? `（匯出於 ${fmt(d.exportedAt)}）` : ''}${skipped ? `\n略過 ${skipped} 筆格式不正確的記錄` : ''}\n\n還原後，目前的資料會被覆蓋且無法復原。建議先匯出目前的資料。`);
  if (!ok) return;
  const budgets = Object.fromEntries(Object.entries(d.budgets || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]));
  ledger.replaceState({ transactions: [...valid.values()], budgets, accounts: Array.isArray(d.accounts) ? d.accounts : [], people: Array.isArray(d.people) ? d.people : [], loans: Array.isArray(d.loans) ? d.loans : [], installs: Array.isArray(d.installs) ? d.installs : [], categories: d.categories && typeof d.categories === 'object' ? d.categories : undefined });
  alert(`已還原 ${valid.size} 筆記錄。`);
}

$('#btn-json').onclick = exportJSON;
$('#banner-btn').onclick = exportJSON;
$('#btn-csv').onclick = exportCSV;
$('#btn-cats').onclick = () => { setTab('stats'); ledger.openCategoryManager(); };
$('#file').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await restore(f); };

// ---------- 隱私模式 ----------
const eye = $('#eye');
function setHidden(v) {
  hidden = v; savePrefs(); ledger.setMasked(v);
  eye.setAttribute('aria-pressed', String(v)); eye.setAttribute('aria-label', v ? '顯示金額' : '隱藏金額');
  if (document.body.dataset.tab === 'analysis') drawAnalysis();
}
eye.onclick = () => setHidden(!hidden);
setHidden(hidden);
for (const [id, key] of [['#pv-start', 'hideOnStart'], ['#pv-leave', 'hideOnLeave']]) {
  $(id).checked = prefs[key];
  $(id).onchange = e => { prefs[key] = e.target.checked; savePrefs(); };
}
const onLeave = () => { if (prefs.hideOnLeave && !hidden) setHidden(true); };
document.addEventListener('visibilitychange', () => { if (document.hidden) onLeave(); });
addEventListener('pagehide', onLeave);

// ---------- 外觀主題 ----------
// 新增主題：在 app.css 加一段 [data-theme="id"]，再在這裡加一行 [id, 名稱, [背景, 卡片, 主色]]
const THEMES = [
  ['dark', '經典黑', ['#0a0a0a', '#232323', '#3e6ae1']],
  ['sakura', '櫻花粉', ['#fff4f7', '#fde3ec', '#e8508a']],
  ['peach', '蜜桃牛奶', ['#fff6f1', '#ffe6dc', '#f2788f']],
  ['night-sakura', '夜櫻', ['#170d12', '#33202a', '#ff7eaa']],
  ['lavender', '薰衣草', ['#f7f4ff', '#ebe4ff', '#8b6cf0']],
  ['mint', '薄荷', ['#f2fbf8', '#dcf3ec', '#22a785']],
];
const THEME_KEY = 'ledger:theme', look = { theme: 'dark', accent: '', hearts: false, stars: false, y2k: false };
try { Object.assign(look, JSON.parse(localStorage.getItem(THEME_KEY))); } catch {}
const root = document.documentElement;
function applyLook() {
  root.dataset.theme = look.theme;
  if (look.accent) root.style.setProperty('--blue', look.accent); else root.style.removeProperty('--blue');
  document.body.classList.toggle('is-hearts', look.hearts);
  document.body.classList.toggle('is-stars', look.stars);
  document.body.classList.toggle('is-y2k', look.y2k);
  root.style.setProperty('--mark', JSON.stringify(' ' + (look.hearts ? '♡' : '') + (look.stars ? '☆' : '') + (look.y2k ? '★' : '')));
  const cs = getComputedStyle(root);
  document.querySelector('meta[name="theme-color"]').content = cs.getPropertyValue('--bg').trim();
  $('#accent').value = look.accent || cs.getPropertyValue('--blue').trim();
  $('#themes').querySelectorAll('.theme').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === look.theme)));
  $('#hearts').checked = look.hearts;
  $('#stars').checked = look.stars;
  $('#y2k').checked = look.y2k;
  try { localStorage.setItem(THEME_KEY, JSON.stringify(look)); } catch {}
}
$('#themes').innerHTML = THEMES.map(([id, name, [a, b, c]]) =>
  `<button class="theme" type="button" data-theme="${id}"><i aria-hidden="true"><b style="background:${a}"></b><b style="background:${b}"></b><b style="background:${c}"></b></i>${name}</button>`).join('');
$('#themes').onclick = e => { const b = e.target.closest('.theme'); if (b) { look.theme = b.dataset.theme; look.accent = ''; applyLook(); } };
$('#accent').oninput = e => { look.accent = e.target.value; applyLook(); };
$('#accent-reset').onclick = () => { look.accent = ''; applyLook(); };
$('#hearts').onchange = e => { look.hearts = e.target.checked; applyLook(); };
$('#stars').onchange = e => { look.stars = e.target.checked; applyLook(); };
$('#y2k').onchange = e => { look.y2k = e.target.checked; applyLook(); };
applyLook();

// ---------- 離線 ----------
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js'));
