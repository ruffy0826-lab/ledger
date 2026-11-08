/*! ledger.js v2 — 記帳模組：收入／支出／轉帳、多帳戶（現金・銀行・電子支付・信用卡）、時間、分類統計、每日圖表、每月預算 */

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const round2 = n => Math.round(n * 100) / 100;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const localAdapter = key => ({
  load: () => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  save: s => localStorage.setItem(key, JSON.stringify(s)),
});

const KINDS = { cash: '現金', bank: '銀行', ewallet: '電子支付', credit: '信用卡' };
const TYPES = ['expense', 'income', 'transfer'];

// 分類清單：去空白、去重複、限制長度；「轉帳」是系統保留名稱；每種至少留一個
const cleanCats = (c, d) => {
  const one = k => {
    const src = Array.isArray(c?.[k]) ? c[k] : d[k], seen = new Set();
    const out = src.map(x => String(x).trim().slice(0, 12)).filter(x => x && x !== '轉帳' && !seen.has(x) && seen.add(x));
    return out.length ? out : ['其他'];
  };
  return { expense: one('expense'), income: one('income') };
};

// 舊資料（沒有帳戶）會自動歸到「現金」帳戶
const normalize = (s, defaults) => {
  let accounts = (Array.isArray(s?.accounts) ? s.accounts : []).filter(a => a && a.id && a.name && KINDS[a.kind]).map(a => ({ ...a, opening: Number(a.opening) || 0 }));
  if (!accounts.length) accounts = [{ id: 'acc-default', name: '現金', kind: 'cash', opening: 0 }];
  const ids = new Set(accounts.map(a => a.id));
  const transactions = (Array.isArray(s?.transactions) ? s.transactions : []).map(t => ({ ...t, accountId: ids.has(t.accountId) ? t.accountId : accounts[0].id, time: t.time || '' }));
  return { transactions, budgets: s?.budgets || {}, accounts, categories: cleanCats(s?.categories, defaults) };
};

// 下一個「每月 N 日」（遇到小月自動退到月底）
function nextDay(day) {
  const n = new Date(), t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  for (let k = 0; k < 2; k++) {
    const dim = new Date(t0.getFullYear(), t0.getMonth() + k + 1, 0).getDate();
    const d = new Date(t0.getFullYear(), t0.getMonth() + k, Math.min(day, dim));
    if (d >= t0) return { d, days: Math.round((d - t0) / 864e5) };
  }
}

const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mmdd = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const midnight = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const clampDay = (y, m, day) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));   // 遇到小月退到月底
const stmtOnOrBefore = (day, ref) => { const d = clampDay(ref.getFullYear(), ref.getMonth(), day); return d > ref ? clampDay(ref.getFullYear(), ref.getMonth() - 1, day) : d; };
const stmtBefore = (day, d) => clampDay(d.getFullYear(), d.getMonth() - 1, day);
const stmtAfter = (day, d) => clampDay(d.getFullYear(), d.getMonth() + 1, day);
const dueAfter = (dueDay, stmt) => { const d = clampDay(stmt.getFullYear(), stmt.getMonth(), dueDay); return d > stmt ? d : clampDay(stmt.getFullYear(), stmt.getMonth() + 1, dueDay); };

const SKELETON = `
<section class="ledger" aria-label="記帳">
  <header class="ledger__head">
    <button class="ledger__nav" type="button" data-act="prev" aria-label="上個月">‹</button>
    <h2 data-r="month"></h2>
    <button class="ledger__nav" type="button" data-act="next" aria-label="下個月">›</button>
  </header>
  <dl class="ledger__sum" data-r="summary"></dl>
  <div class="ledger__alerts" data-r="alerts" role="status"></div>
  <div class="ledger__grid">
    <div class="ledger__col">
      <form class="ledger__form" data-r="form" data-form="entry" novalidate>
        <fieldset class="ledger__type">
          <legend class="ledger__sr">類型</legend>
          <label><input type="radio" name="type" value="expense" checked><span>支出</span></label>
          <label><input type="radio" name="type" value="income"><span>收入</span></label>
          <label><input type="radio" name="type" value="transfer"><span>轉帳</span></label>
        </fieldset>
        <label class="ledger__field"><span>金額</span><input name="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="0"></label>
        <label class="ledger__field"><span data-r="accLabel">帳戶</span><select name="account"></select></label>
        <label class="ledger__field" data-r="toWrap" hidden><span>轉入帳戶</span><select name="toAccount"></select></label>
        <label class="ledger__field" data-r="catWrap"><span>分類</span><select name="category"></select></label>
        <label class="ledger__field"><span>日期</span><input name="date" type="date"></label>
        <label class="ledger__field"><span>時間</span><input name="time" type="time"></label>
        <label class="ledger__field ledger__field--wide"><span>備註</span><input name="note" type="text" maxlength="60" placeholder="例如：午餐"></label>
        <p class="ledger__error" data-r="error" role="alert"></p>
        <button class="ledger__btn ledger__btn--primary" type="submit" data-r="submit">新增記錄</button>
        <button class="ledger__btn" type="button" data-act="edit-cancel" data-r="cancel" hidden>取消修改</button>
      </form>
      <input class="ledger__search" type="search" data-r="search" placeholder="搜尋記錄（備註、分類、帳戶、金額）" aria-label="搜尋記錄" autocomplete="off">
      <section data-r="list"></section>
    </div>
    <div class="ledger__col">
      <section data-r="cats"></section>
      <section data-r="daily"></section>
    </div>
  </div>
  <section class="ledger__accounts" data-r="accounts"></section>
</section>`;

export function createLedger(root, options = {}) {
  if (!(root instanceof Element)) throw new Error('createLedger：請傳入一個 DOM 元素');

  const opt = {
    locale: 'zh-TW',
    currency: 'TWD',
    storageKey: 'ledger:v1',
    warnAt: 0.8,
    storage: null,        // { load(), save(state) }，可回傳 Promise
    masked: false,        // true＝所有金額顯示為 •••••（隱私模式）
    onReady: null,        // () => void，資料載入完成後呼叫
    onChange: null,       // (state) => void，每次存檔後呼叫
    onBudgetAlert: null,  // 新增支出讓預算變成 warn / over 時呼叫
    ...options,
    categories: {
      expense: ['餐飲', '交通', '購物', '居住', '娛樂', '醫療', '其他'],
      income: ['薪資', '獎金', '投資', '其他'],
      ...options.categories,
    },
  };
  const storage = opt.storage || localAdapter(opt.storageKey);
  const nf = new Intl.NumberFormat(opt.locale, { style: 'currency', currency: opt.currency, minimumFractionDigits: 0, maximumFractionDigits: 2 });
  let masked = !!opt.masked;
  const money = n => (masked ? '•••••' : nf.format(n));

  let state = normalize(null, opt.categories);
  let month = today().slice(0, 7);
  let type = 'expense', editing = false, ready = false, editId = null, accEdit = null, catMgr = false, lastCat = '';

  root.innerHTML = SKELETON;
  const $ = k => root.querySelector(`[data-r="${k}"]`);
  const showError = msg => { $('error').textContent = msg; };

  // ---------- 計算 ----------
  const inMonth = (m = month) => state.transactions.filter(t => t.date.startsWith(m));
  const sum = list => round2(list.reduce((a, t) => a + t.amount, 0));
  const accName = id => state.accounts.find(a => a.id === id)?.name || '?';
  // 帳戶餘額＝初始餘額＋收入－支出－轉出＋轉入（信用卡餘額為負數＝欠款）
  const balanceOf = (a, upto) => round2(state.transactions.reduce((b, t) => {
    if (upto && t.date > upto) return b;
    if (t.accountId === a.id) b += t.type === 'income' ? t.amount : -t.amount;
    if (t.type === 'transfer' && t.toAccountId === a.id) b += t.amount;
    return b;
  }, a.opening || 0));
  const rank = { none: 0, ok: 0, warn: 1, over: 2 };
  const budgetState = (cat, m) => {
    const spent = sum(inMonth(m).filter(t => t.type === 'expense' && t.category === cat));
    const budget = state.budgets[cat] || 0, ratio = budget ? spent / budget : 0;
    const level = !budget ? 'none' : ratio > 1 ? 'over' : ratio >= opt.warnAt ? 'warn' : 'ok';
    return { cat, month: m, spent, budget, ratio, level };
  };

  const persist = async () => {
    if (!ready) return;
    try { await storage.save(state); opt.onChange?.(structuredClone(state)); }
    catch { showError('儲存失敗，請稍後再試。'); }
  };

  // ---------- 對外 API ----------
  function clean({ type: ty, amount, accountId, toAccountId, category, date, time = '', note = '' }) {
    amount = round2(Number(amount));
    if (!TYPES.includes(ty)) throw new Error('type 必須是 expense、income 或 transfer');
    if (!(amount > 0)) throw new Error('請輸入大於 0 的金額。');
    if (!state.accounts.some(a => a.id === accountId)) throw new Error('請選擇帳戶。');
    if (ty === 'transfer') {
      if (!state.accounts.some(a => a.id === toAccountId)) throw new Error('請選擇轉入帳戶。');
      if (toAccountId === accountId) throw new Error('轉出與轉入帳戶不能相同。');
      category = '轉帳';
    } else { toAccountId = undefined; if (!category || category === '__new__') throw new Error('請選擇分類。'); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('請選擇日期。');
    if (time && !/^\d{2}:\d{2}$/.test(time)) throw new Error('時間格式不正確。');
    return { type: ty, amount, accountId, toAccountId, category, date, time, note: String(note).trim().slice(0, 60) };
  }
  function addTransaction(input) {
    const r = clean(input), { type: ty, category, date } = r;
    const m = date.slice(0, 7), before = budgetState(category, m);
    state.transactions.push({ id: uid(), ...r, createdAt: Date.now() });
    const after = budgetState(category, m);
    if (ty === 'expense' && after.level !== 'ok' && rank[after.level] > rank[before.level]) opt.onBudgetAlert?.(after);
    month = m;
    update(); persist();
  }
  function updateTransaction(id, input) {
    const i = state.transactions.findIndex(t => t.id === id);
    if (i < 0) throw new Error('找不到這筆記錄。');
    const r = clean(input);
    state.transactions[i] = { ...state.transactions[i], ...r };
    if (r.type !== 'transfer') delete state.transactions[i].toAccountId;
    month = r.date.slice(0, 7);
    update(); persist();
  }
  function removeTransaction(id) {
    if (id === editId) endEdit();
    state.transactions = state.transactions.filter(t => t.id !== id);
    update(); persist();
  }
  function saveAccount(id, v) {
    const name = String(v.name || '').trim().slice(0, 20);
    if (!name) throw new Error('請輸入帳戶名稱。');
    if (!KINDS[v.kind]) throw new Error('請選擇帳戶類型。');
    const day = x => { x = Math.round(Number(x)); return x >= 1 && x <= 31 ? x : 0; };
    const credit = v.kind === 'credit';
    const a = { id: id || uid(), name, kind: v.kind, opening: round2(Number(v.opening) || 0), statementDay: credit ? day(v.statementDay) : 0, dueDay: credit ? day(v.dueDay) : 0, limit: credit ? Math.max(0, round2(Number(v.limit) || 0)) : 0 };
    const i = state.accounts.findIndex(x => x.id === a.id);
    if (i < 0) state.accounts.push(a); else state.accounts[i] = a;
    accEdit = null; update(); persist();
  }
  function removeAccount(id) {
    if (state.accounts.length <= 1) throw new Error('至少要保留一個帳戶。');
    if (state.transactions.some(t => t.accountId === id || t.toAccountId === id)) throw new Error('這個帳戶已有記錄，無法刪除。可以改名或把它留著。');
    state.accounts = state.accounts.filter(a => a.id !== id);
    accEdit = null; update(); persist();
  }
  function replaceState(s) {
    let cats = s.categories;
    if (!cats) {
      cats = { expense: [...opt.categories.expense], income: [...opt.categories.income] };
      for (const t of s.transactions || []) if (t.type !== 'transfer' && cats[t.type] && t.category && !cats[t.type].includes(t.category)) cats[t.type].push(t.category);
    }
    state = normalize({ ...s, categories: cats }, opt.categories);
    update(); persist();
  }

  // ---- 分類管理：新增／改名／移除 ----
  const catName = v => {
    const n = String(v ?? '').trim().slice(0, 12);
    if (!n) throw new Error('請輸入分類名稱。');
    if (n === '轉帳') throw new Error('「轉帳」是系統保留的名稱，請換一個。');
    return n;
  };
  const catType = ty => { if (ty !== 'expense' && ty !== 'income') throw new Error('type 必須是 expense 或 income'); return ty; };
  function addCategory(ty, name) {
    catType(ty); name = catName(name);
    if (state.categories[ty].includes(name)) throw new Error('已經有同名的分類了。');
    state.categories[ty].push(name);
    update(); persist();
    return name;
  }
  function renameCategory(ty, from, to) {
    catType(ty); to = catName(to);
    if (to === from) return;
    const i = state.categories[ty].indexOf(from);
    if (i < 0) throw new Error('找不到這個分類。');
    if (state.categories[ty].includes(to)) throw new Error('已經有同名的分類了。');
    state.categories[ty][i] = to;
    state.transactions.forEach(t => { if (t.type === ty && t.category === from) t.category = to; });   // 舊記錄跟著改名
    if (ty === 'expense' && state.budgets[from] != null) {
      if (state.budgets[to] == null) state.budgets[to] = state.budgets[from];
      delete state.budgets[from];
    }
    update(); persist();
  }
  function removeCategory(ty, name) {
    catType(ty);
    if (state.categories[ty].length <= 1) throw new Error('至少要保留一個分類。');
    state.categories[ty] = state.categories[ty].filter(c => c !== name);
    update(); persist();   // 只從選單移除；既有記錄與預算不動
  }
  function openCategoryManager() { catMgr = true; editing = false; update(); }
  const putBudget = (cat, amount) => {
    amount = round2(Number(amount));
    if (amount > 0) state.budgets[cat] = amount; else delete state.budgets[cat];
  };
  function setBudget(cat, amount) { putBudget(cat, amount); update(); persist(); }
  function setMasked(v) {
    masked = !!v;
    if (masked) { accEdit = null; editing = false; if (editId) endEdit(); }   // 關掉所有會露出金額的編輯畫面
    update();
  }
  function setMonth(m) { if (/^\d{4}-\d{2}$/.test(m)) { month = m; update(); } }

  // ---------- 畫面 ----------
  function renderSummary() {
    const tx = inMonth(), income = sum(tx.filter(t => t.type === 'income')), expense = sum(tx.filter(t => t.type === 'expense'));
    const bal = round2(income - expense);
    $('summary').innerHTML =
      `<div class="ledger__bal"><dt>本月結餘</dt><dd class="${bal < 0 ? 'is-neg' : ''}">${money(bal)}</dd></div>` +
      `<div><dt>收入</dt><dd>${money(income)}</dd></div><div><dt>支出</dt><dd>${money(expense)}</dd></div>`;
  }

  function renderAlerts() {
    const budget = Object.keys(state.budgets).map(c => budgetState(c, month)).filter(b => b.level === 'over' || b.level === 'warn')
      .map(b => b.level === 'over'
        ? `<p class="ledger__alert is-over"><b>超支</b> ${esc(b.cat)} 已超出預算 ${money(b.spent - b.budget)}（${money(b.spent)} / ${money(b.budget)}）</p>`
        : `<p class="ledger__alert is-warn"><b>快用完</b> ${esc(b.cat)} 已用 ${Math.round(b.ratio * 100)}% 預算（${money(b.spent)} / ${money(b.budget)}）</p>`);
    const cards = [];
    for (const a of state.accounts.filter(x => x.kind === 'credit')) {
      const c = cardInfo(a);
      if (a.statementDay && a.dueDay) {
        if (c.status === 'overdue') cards.push(`<p class="ledger__alert is-over"><b>逾期未繳</b> ${esc(a.name)} 帳單尚有 ${money(c.remaining)} 未繳，截止日是 ${mmdd(c.due)}</p>`);
        else if (c.status === 'due' && c.days <= 3) cards.push(`<p class="ledger__alert is-warn"><b>繳款提醒</b> ${esc(a.name)} ${c.days === 0 ? '今天' : c.days + ' 天後'}（${mmdd(c.due)}）截止，尚有 ${money(c.remaining)} 未繳</p>`);
      } else if (a.dueDay && c.owed > 0) {
        const n = nextDay(a.dueDay);
        if (n.days <= 3) cards.push(`<p class="ledger__alert is-warn"><b>繳款提醒</b> ${esc(a.name)} ${n.days === 0 ? '今天' : n.days + ' 天後'}（${mmdd(n.d)}）要繳款，目前欠款 ${money(c.owed)}</p>`);
      }
      if (c.limit && c.ratio >= opt.warnAt) cards.push(`<p class="ledger__alert ${c.ratio > 1 ? 'is-over' : 'is-warn'}"><b>額度</b> ${esc(a.name)} 已使用 ${Math.round(c.ratio * 100)}%，可用 ${money(c.avail)}</p>`);
    }
    $('alerts').innerHTML = [...cards, ...budget].join('');
  }

  function renderCatMgr() {
    const group = (ty, title) =>
      `<h4 class="ledger__gt">${title}</h4><ul class="ledger__catlist">${state.categories[ty].map(c =>
        `<li><span>${esc(c)}</span><button type="button" class="ledger__link" data-act="cat-rename" data-type="${ty}" data-name="${esc(c)}">改名</button>` +
        `<button type="button" class="ledger__link ledger__link--danger" data-act="cat-del" data-type="${ty}" data-name="${esc(c)}">移除</button></li>`).join('')}</ul>` +
      `<form class="ledger__catadd" data-form="catadd" data-type="${ty}" novalidate><input name="catname" type="text" maxlength="12" placeholder="新增${title}分類" aria-label="新增${title}分類" autocomplete="off"><button class="ledger__btn" type="submit">新增</button></form>`;
    $('cats').innerHTML = `<div class="ledger__sec-head"><h3>管理分類</h3><button class="ledger__link" type="button" data-act="catmgr-close">完成</button></div>` +
      `<p class="ledger__hint">改名會連同舊記錄一起更新。移除只是從選單拿掉，既有記錄不會被刪除。</p>` + group('expense', '支出') + group('income', '收入');
  }

  function renderCats() {
    if (catMgr) return renderCatMgr();
    const spent = {};
    inMonth().filter(t => t.type === 'expense').forEach(t => { spent[t.category] = round2((spent[t.category] || 0) + t.amount); });
    const total = round2(Object.values(spent).reduce((a, b) => a + b, 0));
    const names = [...new Set([...state.categories.expense, ...Object.keys(spent), ...Object.keys(state.budgets)])]
      .filter(c => editing || spent[c] || state.budgets[c])
      .sort((a, b) => (spent[b] || 0) - (spent[a] || 0));
    let body;
    if (editing) {
      body = `<form class="ledger__budget" data-form="budget"><p class="ledger__hint">每月預算，留空代表不設定。</p>` +
        names.map(c => `<label class="ledger__budget-row"><span>${esc(c)}</span><input type="number" min="0" step="any" inputmode="decimal" data-cat="${esc(c)}" value="${state.budgets[c] || ''}"></label>`).join('') +
        `<div class="ledger__actions"><button class="ledger__btn ledger__btn--primary" type="submit">儲存預算</button><button class="ledger__btn" type="button" data-act="budget-cancel">取消</button></div></form>`;
    } else if (!names.length) {
      body = '<p class="ledger__empty">本月還沒有支出。</p>';
    } else {
      body = `<ul>${names.map(c => {
        const b = budgetState(c, month), s = spent[c] || 0;
        const pct = b.budget ? Math.min(b.ratio, 1) * 100 : total ? s / total * 100 : 0;
        const note = b.budget ? `已用 ${Math.round(b.ratio * 100)}% 預算` : `佔支出 ${Math.round(pct)}%`;
        return `<li class="ledger__cat is-${b.level}"><div class="ledger__cat-top"><span>${esc(c)}</span><span class="ledger__num">${money(s)}${b.budget ? ` <small>/ ${money(b.budget)}</small>` : ''}</span></div>` +
          `<div class="ledger__meter" aria-hidden="true"><i data-pct="${pct.toFixed(1)}"></i></div><small class="ledger__muted">${note}</small></li>`;
      }).join('')}</ul>`;
    }
    $('cats').innerHTML = `<div class="ledger__sec-head"><h3>支出分類</h3>${editing ? '' : '<span class="ledger__links"><button class="ledger__link" type="button" data-act="catmgr-open">管理分類</button><button class="ledger__link" type="button" data-act="budget-edit">設定預算</button></span>'}</div>${body}`;
  }

  function renderDaily() {
    const [y, m] = month.split('-').map(Number), days = new Date(y, m, 0).getDate();
    const v = Array(days).fill(0);
    inMonth().filter(t => t.type === 'expense').forEach(t => { v[+t.date.slice(8, 10) - 1] += t.amount; });
    const max = Math.max(...v);
    let body = '<p class="ledger__empty">本月還沒有支出。</p>';
    if (max > 0) {
      const W = 320, H = 120, base = H - 16, step = W / days, peak = v.indexOf(max);
      const bars = v.map((x, i) => {
        const h = Math.max(x / max * (base - 6), 1.5);
        return `<rect class="ledger__bar${i === peak ? ' is-peak' : ''}" x="${(i * step + 1).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${m}/${i + 1}：${money(round2(x))}</title></rect>`;
      }).join('');
      const labels = v.map((_, i) => (i === 0 || (i + 1) % 5 === 0) ? `<text x="${(i * step + step / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle">${i + 1}</text>` : '').join('');
      body = `<svg class="ledger__daily" viewBox="0 0 ${W} ${H}" role="img" aria-label="每日支出長條圖，單日最高 ${m}/${peak + 1}，${money(round2(max))}">${bars}<line x1="0" x2="${W}" y1="${base}" y2="${base}"/>${labels}</svg>`;
    }
    $('daily').innerHTML = `<div class="ledger__sec-head"><h3>每日支出</h3></div>${body}`;
  }

  function renderList() {
    const q = $('search').value.trim().toLowerCase();
    const tx = (q ? state.transactions.filter(t => [t.category, t.note, accName(t.accountId), t.toAccountId ? accName(t.toAccountId) : '', String(t.amount), t.time, t.date].join(' ').toLowerCase().includes(q)) : inMonth()).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '') || (b.createdAt || 0) - (a.createdAt || 0));
    $('list').innerHTML = `<div class="ledger__sec-head"><h3>${q ? '搜尋結果（全部月份）' : '本月記錄'}</h3><small class="ledger__muted">${tx.length} 筆</small></div>` +
      (tx.length
        ? `<ul>${tx.map(t => {
          const sub = t.type === 'transfer' ? `${accName(t.accountId)} → ${accName(t.toAccountId)}` : accName(t.accountId);
          const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
          return `<li class="ledger__tx"><time datetime="${t.date}${t.time ? 'T' + t.time : ''}">${(q ? t.date.slice(2) : t.date.slice(5)).replaceAll('-', '/')}${t.time ? `<small>${t.time}</small>` : ''}</time>` +
            `<button type="button" class="ledger__tx-main" data-act="edit" data-id="${esc(t.id)}" aria-label="編輯 ${esc(t.category)} ${money(t.amount)}"><span>${esc(t.category)}</span><small class="ledger__muted">${esc(sub)}${t.note ? ' · ' + esc(t.note) : ''}</small></button>` +
            `<span class="ledger__num is-${t.type}">${sign}${money(t.amount)}</span>` +
            `<button class="ledger__x" type="button" data-act="remove" data-id="${esc(t.id)}" aria-label="刪除 ${esc(t.category)} ${money(t.amount)}">×</button></li>`;
        }).join('')}</ul>`
        : `<p class="ledger__empty">${q ? '找不到符合的記錄。' : '這個月還沒有記錄。在上方新增第一筆。'}</p>`);
  }

  // 結帳週期 (from, to]：回傳期間內的記錄、已繳金額、消費總額（to 空白＝到目前）
  function cycle(a, from, to) {
    const items = state.transactions.filter(t => (t.accountId === a.id || t.toAccountId === a.id) && t.date > from && (!to || t.date <= to))
      .sort((x, y) => x.date.localeCompare(y.date) || (x.time || '').localeCompare(y.time || ''));
    const paid = round2(items.filter(t => t.type === 'transfer' && t.toAccountId === a.id).reduce((s, t) => s + t.amount, 0));
    const charges = round2((0 - balanceOf(a, to)) - (0 - balanceOf(a, from)) + paid);
    return { items, paid, charges };
  }
  function cardInfo(a) {
    const owed = round2(0 - balanceOf(a)), limit = a.limit || 0, used = Math.max(0, owed);
    const info = { owed, limit, used, avail: limit ? round2(limit - used) : 0, ratio: limit ? used / limit : 0 };
    if (!a.statementDay) return info;
    const t0 = midnight(), last = stmtOnOrBefore(a.statementDay, t0), prev = stmtBefore(a.statementDay, last), L = ymd(last);
    const stmt = Math.max(0, round2(0 - balanceOf(a, L)));          // 上期帳單金額＝結帳日當天的欠款
    const cur = cycle(a, L);                                          // 結帳日之後：本期消費與已繳款
    const remaining = Math.max(0, round2(stmt - cur.paid));
    const due = a.dueDay ? dueAfter(a.dueDay, last) : null, days = due ? Math.round((due - t0) / 864e5) : null;
    const status = !stmt || remaining <= 0 ? 'paid' : days !== null && days < 0 ? 'overdue' : 'due';
    return { ...info, last, prev, next: stmtAfter(a.statementDay, last), stmt, remaining, due, days, status, cur, prevCycle: cycle(a, ymd(prev), L) };
  }
  function history(a, k = 6) {
    const out = []; let end = stmtOnOrBefore(a.statementDay, midnight());
    for (let i = 0; i < k; i++) { const start = stmtBefore(a.statementDay, end); out.push({ start, end, ...cycle(a, ymd(start), ymd(end)) }); end = start; }
    return out;
  }
  const txRow = (t, a) => {
    const pay = t.type === 'transfer' && t.toAccountId === a.id, neg = pay || t.type === 'income';
    const label = pay ? `繳款（${esc(accName(t.accountId))}）` : t.type === 'transfer' ? `轉出 → ${esc(accName(t.toAccountId))}` : esc(t.category);
    return `<li><time>${t.date.slice(5).replace('-', '/')}${t.time ? ' ' + t.time : ''}</time><span>${label}${t.note ? `<small class="ledger__muted"> · ${esc(t.note)}</small>` : ''}</span><span class="ledger__num${neg ? ' is-income' : ''}">${neg ? '−' : ''}${money(t.amount)}</span></li>`;
  };
  function cardBlock(a) {
    const c = cardInfo(a), pct = c.limit ? Math.min(c.ratio, 1) * 100 : 0;
    const lvl = !c.limit ? 'none' : c.ratio > 1 ? 'over' : c.ratio >= opt.warnAt ? 'warn' : 'ok';
    const bits = [a.statementDay && `結帳 ${a.statementDay} 日`, a.dueDay && `繳款 ${a.dueDay} 日`].filter(Boolean);
    let html = `<div class="ledger__accrow"><button type="button" class="ledger__acc" data-act="acc-edit" data-id="${esc(a.id)}"><span class="ledger__acc-name">${esc(a.name)}<small class="ledger__muted">${bits.join(' · ') || '信用卡'}</small></span><span class="ledger__num">${money(c.owed)}</span></button>` +
      `<button type="button" class="ledger__pay" data-act="acc-pay" data-id="${esc(a.id)}" aria-label="繳款 ${esc(a.name)}">繳款</button></div>`;
    if (c.limit) html += `<div class="ledger__cc-limit is-${lvl}"><div class="ledger__meter" aria-hidden="true"><i data-pct="${pct.toFixed(1)}"></i></div><small class="ledger__muted">已用 ${Math.round(c.ratio * 100)}% · 可用 ${money(c.avail)} / ${money(c.limit)}</small></div>`;
    if (a.statementDay) {
      const st = c.status === 'paid' ? ['已繳清', 'is-ok'] : c.status === 'overdue' ? [`已逾期 ${-c.days} 天`, 'is-over'] : c.due ? [c.days === 0 ? '今天截止' : `還有 ${c.days} 天`, c.days <= 3 ? 'is-warn' : ''] : ['', ''];
      const list = items => items.length ? `<ul class="ledger__cc-tx">${items.map(t => txRow(t, a)).join('')}</ul>` : '<p class="ledger__empty">沒有記錄。</p>';
      const hist = history(a).filter(h => h.items.length), from = new Date(c.last.getFullYear(), c.last.getMonth(), c.last.getDate() + 1);
      html += `<dl class="ledger__cc-grid"><div><dt>上期帳單</dt><dd>${money(c.stmt)} <small class="ledger__st">${mmdd(c.last)} 結帳</small></dd></div><div><dt>尚未繳款</dt><dd>${money(c.remaining)}</dd></div>` +
        `<div><dt>繳款截止</dt><dd>${c.due ? mmdd(c.due) : '–'} <small class="ledger__st ${st[1]}">${st[0]}</small></dd></div><div><dt>本期消費</dt><dd>${money(c.cur.charges)} <small class="ledger__st">${mmdd(c.next)} 結帳</small></dd></div></dl>` +
        `<details class="ledger__cc-more"><summary>帳單明細</summary><h4>本期（${mmdd(from)} 起）・消費 ${money(c.cur.charges)}</h4>${list(c.cur.items)}` +
        `<h4>上期（${mmdd(c.prev)} – ${mmdd(c.last)}）・消費 ${money(c.prevCycle.charges)}</h4>${list(c.prevCycle.items)}` +
        (hist.length ? `<h4>歷史帳單</h4><ul class="ledger__cc-tx">${hist.map(h => `<li><time>${mmdd(h.end)} 結帳</time><span class="ledger__muted">${mmdd(h.start)} – ${mmdd(h.end)} · ${h.items.length} 筆</span><span class="ledger__num">${money(h.charges)}</span></li>`).join('')}</ul>` : '') + `</details>`;
    }
    return `<li class="ledger__cc">${html}</li>`;
  }

  function renderAccounts() {
    const bal = state.accounts.map(a => ({ a, b: balanceOf(a) }));
    const assets = round2(bal.filter(x => x.a.kind !== 'credit').reduce((s, x) => s + x.b, 0));
    const debt = round2(0 - bal.filter(x => x.a.kind === 'credit').reduce((s, x) => s + x.b, 0));
    const f = accEdit === 'new' ? { kind: 'bank' } : state.accounts.find(a => a.id === accEdit);
    const credit = f?.kind === 'credit';
    const form = !f ? '' :
      `<form class="ledger__acc-form" data-form="account" data-id="${esc(f.id || '')}" novalidate>` +
      `<label class="ledger__field"><span>名稱</span><input name="accname" type="text" maxlength="20" value="${esc(f.name || '')}" placeholder="例如：國泰世華"></label>` +
      `<label class="ledger__field"><span>類型</span><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${f.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>` +
      `<label class="ledger__field"><span data-r="openLabel">${credit ? '目前欠款' : '初始餘額'}</span><input name="opening" type="number" step="any" inputmode="decimal" value="${f.opening ? (credit ? -f.opening : f.opening) : ''}" placeholder="0"></label>` +
      `<div class="ledger__acc-credit" data-credit${credit ? '' : ' hidden'}>` +
      `<label class="ledger__field ledger__field--wide"><span>信用額度</span><input name="limit" type="number" min="0" step="any" inputmode="decimal" value="${f.limit || ''}" placeholder="例如 100000"></label>` +
      `<label class="ledger__field"><span>結帳日（每月）</span><input name="statementDay" type="number" min="1" max="31" inputmode="numeric" value="${f.statementDay || ''}"></label>` +
      `<label class="ledger__field"><span>繳款日（每月）</span><input name="dueDay" type="number" min="1" max="31" inputmode="numeric" value="${f.dueDay || ''}"></label></div>` +
      `<p class="ledger__error" data-acc-error role="alert"></p>` +
      `<div class="ledger__actions"><button class="ledger__btn ledger__btn--primary" type="submit">儲存</button><button class="ledger__btn" type="button" data-act="acc-cancel">取消</button>` +
      `${f.id ? `<button class="ledger__btn ledger__btn--danger" type="button" data-act="acc-delete" data-id="${esc(f.id)}">刪除</button>` : ''}</div></form>`;
    const groups = ['cash', 'bank', 'ewallet', 'credit'].map(k => {
      const items = bal.filter(x => x.a.kind === k);
      if (!items.length) return '';
      return `<h3 class="ledger__gt">${KINDS[k]}</h3><ul class="ledger__acclist">${items.map(({ a, b }) => k === 'credit' ? cardBlock(a) :
        `<li class="ledger__accrow"><button type="button" class="ledger__acc" data-act="acc-edit" data-id="${esc(a.id)}"><span class="ledger__acc-name">${esc(a.name)}</span><span class="ledger__num">${money(b)}</span></button></li>`).join('')}</ul>`;
    }).join('');
    const net = round2(assets - debt);
    $('accounts').innerHTML =
      `<dl class="ledger__sum"><div class="ledger__bal"><dt>淨資產</dt><dd class="${net < 0 ? 'is-neg' : ''}">${money(net)}</dd></div><div><dt>資產</dt><dd>${money(assets)}</dd></div><div><dt>負債</dt><dd>${money(debt)}</dd></div></dl>` +
      `<div class="ledger__sec-head"><h3>我的帳戶</h3>${f ? '' : '<button class="ledger__link" type="button" data-act="acc-new">新增帳戶</button>'}</div>${form}${groups}`;
  }

  function update() {
    $('month').textContent = `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
    fillAccounts();
    if (type !== 'transfer') fillCats();
    renderSummary(); renderAlerts(); renderCats(); renderDaily(); renderList(); renderAccounts();
    root.querySelectorAll('[data-pct]').forEach(el => { el.style.width = el.dataset.pct + '%'; });
  }

  // ---------- 表單 ----------
  function fillAccounts() {
    const f = $('form'), opts = state.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    for (const k of ['account', 'toAccount']) {
      const old = f[k].value;
      f[k].innerHTML = opts;
      if (state.accounts.some(a => a.id === old)) f[k].value = old;
    }
    if (f.toAccount.value === f.account.value && state.accounts.length > 1) f.toAccount.value = state.accounts.find(a => a.id !== f.account.value).id;
  }
  function syncForm() {
    const f = $('form'), tr = type === 'transfer';
    $('catWrap').hidden = tr; $('toWrap').hidden = !tr;
    $('accLabel').textContent = tr ? '轉出帳戶' : '帳戶';
    if (!tr) fillCats();
  }
  function fillCats(sel) {
    const f = $('form'), cur = f.category.value, old = sel ?? (cur === '__new__' ? lastCat : cur);
    const list = [...state.categories[type]];
    if (editId && old && old !== '__new__' && !list.includes(old)) list.push(old);   // 編輯舊記錄時，保留已被移除的分類
    f.category.innerHTML = list.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') + '<option value="__new__">＋ 新增分類…</option>';
    if (list.includes(old)) f.category.value = old;
    lastCat = f.category.value;
  }
  function startEdit(id) {
    const t = state.transactions.find(x => x.id === id), f = $('form');
    if (!t) return;
    editId = id; type = t.type;
    f.querySelector(`input[name="type"][value="${type}"]`).checked = true;
    syncForm();
    if (type !== 'transfer') {
      if (![...f.category.options].some(o => o.value === t.category)) f.category.add(new Option(t.category));
      f.category.value = t.category;
    }
    f.account.value = t.accountId; if (t.toAccountId) f.toAccount.value = t.toAccountId;
    f.amount.value = t.amount; f.date.value = t.date; f.time.value = t.time || ''; f.note.value = t.note || '';
    $('submit').textContent = '儲存修改'; $('cancel').hidden = false; f.classList.add('is-editing');
    showError(''); f.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function endEdit() {
    const f = $('form');
    editId = null; f.amount.value = ''; f.note.value = ''; f.time.value = nowTime();
    $('submit').textContent = '新增記錄'; $('cancel').hidden = true; f.classList.remove('is-editing');
  }

  // 信用卡繳款：自動帶入「從銀行轉帳到這張卡」，金額預設為目前欠款
  function startPay(id) {
    const card = state.accounts.find(a => a.id === id), f = $('form');
    const from = state.accounts.find(a => a.kind === 'bank') || state.accounts.find(a => a.kind !== 'credit');
    if (!card) return;
    if (!from) return alert('請先建立一個銀行或現金帳戶，才能從那裡繳款。');
    if (editId) endEdit();
    type = 'transfer'; f.querySelector('input[name="type"][value="transfer"]').checked = true; syncForm();
    f.account.value = from.id; f.toAccount.value = card.id;
    const c = cardInfo(card), amt = c.remaining > 0 ? c.remaining : c.owed;   // 有帳單就預設繳上期帳單，否則繳全部欠款
    f.amount.value = amt > 0 && !masked ? amt : ''; f.date.value = today(); f.time.value = nowTime(); f.note.value = '信用卡繳款'; showError('');
    root.dispatchEvent(new CustomEvent('ledger:goto', { detail: 'records' }));   // 請外層切到「記帳」分頁
    f.amount.focus();
  }

  // ---------- 事件 ----------
  const onClick = e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (masked && ['edit', 'acc-edit', 'budget-edit'].includes(act)) return alert('金額已隱藏。請先點右上角的眼睛顯示金額，再編輯。');
    if (act === 'prev' || act === 'next') {
      const [y, m] = month.split('-').map(Number), d = new Date(y, m - 1 + (act === 'next' ? 1 : -1), 1);
      setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    } else if (act === 'remove') {
      if (confirm('刪除這筆記錄？')) removeTransaction(b.dataset.id);
    } else if (act === 'budget-edit' || act === 'budget-cancel') {
      editing = act === 'budget-edit'; update();
    } else if (act === 'edit') startEdit(b.dataset.id);
    else if (act === 'edit-cancel') endEdit();
    else if (act === 'catmgr-open') { catMgr = true; editing = false; update(); }
    else if (act === 'catmgr-close') { catMgr = false; update(); }
    else if (act === 'cat-rename') {
      const to = prompt(`把「${b.dataset.name}」改名為：`, b.dataset.name);
      if (to !== null) { try { renameCategory(b.dataset.type, b.dataset.name, to); } catch (err) { alert(err.message); } }
    } else if (act === 'cat-del') {
      if (confirm(`從選單移除「${b.dataset.name}」？\n既有的記錄不會被刪除。`)) { try { removeCategory(b.dataset.type, b.dataset.name); } catch (err) { alert(err.message); } }
    }
    else if (act === 'acc-new') { accEdit = 'new'; renderAccounts(); }
    else if (act === 'acc-edit') { accEdit = b.dataset.id; renderAccounts(); }
    else if (act === 'acc-cancel') { accEdit = null; renderAccounts(); }
    else if (act === 'acc-pay') startPay(b.dataset.id);
    else if (act === 'acc-delete') {
      if (confirm('刪除這個帳戶？')) { try { removeAccount(b.dataset.id); } catch (err) { alert(err.message); } }
    }
  };
  const onSubmit = e => {
    const f = e.target;
    if (f.matches('[data-form="entry"]')) {
      e.preventDefault();
      if (!ready) return showError('資料載入中，請稍候。');
      try {
        const input = { type, amount: f.amount.value, accountId: f.account.value, toAccountId: f.toAccount.value, category: f.category.value, date: f.date.value, time: f.time.value, note: f.note.value };
        if (editId) { updateTransaction(editId, input); endEdit(); } else addTransaction(input);
        f.amount.value = ''; f.note.value = ''; f.time.value = nowTime(); showError(''); f.amount.focus();
      } catch (err) { showError(err.message); }
    } else if (f.matches('[data-form="budget"]')) {
      e.preventDefault();
      f.querySelectorAll('input[data-cat]').forEach(i => putBudget(i.dataset.cat, i.value));
      editing = false; update(); persist();
    } else if (f.matches('[data-form="account"]')) {
      e.preventDefault();
      const credit = f.kind.value === 'credit', n = Number(f.opening.value) || 0;
      try {
        saveAccount(f.dataset.id || null, { name: f.accname.value, kind: f.kind.value, opening: credit ? -Math.abs(n) : n, statementDay: f.statementDay.value, dueDay: f.dueDay.value, limit: f.limit.value });
      } catch (err) { f.querySelector('[data-acc-error]').textContent = err.message; }
    } else if (f.matches('[data-form="catadd"]')) {
      e.preventDefault();
      try { addCategory(f.dataset.type, f.catname.value); } catch (err) { alert(err.message); }
    }
  };
  const onType = e => {
    if (e.target.name === 'category' && e.target.value !== '__new__') lastCat = e.target.value;
    if (e.target.name === 'type') { type = e.target.value; syncForm(); }
    else if (e.target.name === 'category' && e.target.value === '__new__') {
      const name = prompt(`新增${type === 'income' ? '收入' : '支出'}分類（最多 12 字）：`);
      if (name === null || !name.trim()) return fillCats();
      try { fillCats(addCategory(type, name)); } catch (err) { alert(err.message); fillCats(); }
    }
    else if (e.target.name === 'kind') {
      const f = e.target.form, c = e.target.value === 'credit';
      f.querySelector('[data-credit]').hidden = !c;
      f.querySelector('[data-r="openLabel"]').textContent = c ? '目前欠款' : '初始餘額';
    }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  const onInput = e => { if (e.target.matches('[data-r="search"]')) renderList(); };
  root.addEventListener('change', onType);
  root.addEventListener('input', onInput);

  // ---------- 啟動 ----------
  $('form').date.value = today();
  $('form').time.value = nowTime();
  syncForm();
  update();
  Promise.resolve().then(() => storage.load()).then(s => {
    if (s && Array.isArray(s.transactions)) state = normalize(s, opt.categories);
    ready = true; update(); opt.onReady?.();
  }).catch(() => showError('無法讀取記帳資料，請重新整理頁面。'));

  return {
    getState: () => structuredClone(state),
    addTransaction, updateTransaction, removeTransaction, saveAccount, removeAccount, replaceState, setBudget, setMonth, setMasked, addCategory, renameCategory, removeCategory, openCategoryManager,
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('change', onType);
      root.removeEventListener('input', onInput);
      root.replaceChildren();
    },
  };
}
