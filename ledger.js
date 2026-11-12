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
// 往來：借出／代墊／收回／借入／還款。這些只是「錢在帳戶與對象之間移動」，不算收入或支出
const DEBT = { lend: '借出', advance: '代墊', collect: '收回', borrow: '借入', payback: '還款' };
const DEBT_OPT = { lend: '借錢給人', advance: '幫人代墊', collect: '對方還我', borrow: '向人借錢', payback: '我還款' };
const DEBT_HINT = { lend: '借出：錢從帳戶出去，對方欠你。不算支出。', advance: '代墊：幫對方先付，對方欠你。不算你的支出。', collect: '收回：對方還你錢。不算收入。', borrow: '借入：向人借錢，錢進帳戶，你欠對方。不算收入。', payback: '還款：你還對方錢。不算支出。' };
// 貸款（車貸／房貸／信貸）與分期付款
const LOAN_KINDS = { car: '車貸', house: '房貸', credit: '信貸', other: '其他貸款' };
const LOAN_METHODS = { equal: '本息平均（每期繳一樣）', principal: '本金平均（每期本金一樣）' };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const int = (v, lo, hi, d = lo) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const INFLOW = new Set(['income', 'collect', 'borrow']);   // 讓帳戶餘額增加的類型
const TYPES = ['expense', 'income', 'transfer', ...Object.keys(DEBT)];

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
  const people = (Array.isArray(s?.people) ? s.people : []).filter(p => p && p.id && p.name).map(p => ({ id: String(p.id), name: String(p.name).trim().slice(0, 20), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate || '') ? p.dueDate : '' }));
  const acc = id => (ids.has(id) ? id : accounts[0].id);
  const loans = (Array.isArray(s?.loans) ? s.loans : []).filter(l => l && l.id && l.name && Number(l.balance0) > 0).map(l => ({ id: String(l.id), name: String(l.name).trim().slice(0, 20), kind: LOAN_KINDS[l.kind] ? l.kind : 'other', balance0: round2(Number(l.balance0)), rate: Math.min(100, Math.max(0, Number(l.rate) || 0)), months: int(l.months, 1, 600, 1), grace: int(l.grace, 0, 600, 0), method: l.method === 'principal' ? 'principal' : 'equal', payDay: int(l.payDay, 1, 31, 1), startDate: isDate(l.startDate) ? l.startDate : today(), accountId: acc(l.accountId) }));
  const installs = (Array.isArray(s?.installs) ? s.installs : []).filter(p => p && p.id && p.name && Number(p.amount) > 0 && Number(p.periods) >= 1 && isDate(p.firstDate)).map(p => ({ id: String(p.id), name: String(p.name).trim().slice(0, 20), amount: round2(Number(p.amount)), periods: int(p.periods, 1, 360, 1), firstDate: p.firstDate, accountId: acc(p.accountId), category: String(p.category || '購物').slice(0, 12), paid0: int(p.paid0, 0, int(p.periods, 1, 360, 1), 0), since: isDate(p.since) ? p.since : p.firstDate }));
  return { transactions, budgets: s?.budgets || {}, accounts, people, loans, installs, categories: cleanCats(s?.categories, defaults) };
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

// ---------- 回饋：觸感＋「✓ 已記錄」提示 ----------
// iPhone 的 Safari 不支援 navigator.vibrate；但 iOS 18 起，切換一個 <input switch> 開關會有系統觸感，
// 所以建立一個看不見的開關點一下。Android 則直接用 vibrate。不支援的裝置什麼都不會發生。
function haptic() {
  try {
    if (typeof navigator.vibrate === 'function' && navigator.vibrate(10)) return;
    const label = document.createElement('label'), input = document.createElement('input');
    label.setAttribute('aria-hidden', 'true'); label.style.display = 'none';
    input.type = 'checkbox'; input.setAttribute('switch', '');
    label.append(input); document.head.append(label); label.click(); label.remove();
  } catch {}
}
let toastEl = null, toastTimer = 0;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'ledger-toast'; toastEl.setAttribute('role', 'status'); document.body.append(toastEl); }
  toastEl.textContent = '✓ ' + msg;
  toastEl.classList.remove('is-on'); void toastEl.offsetWidth; toastEl.classList.add('is-on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1500);
}
function feedback(msg, btn) {
  haptic();
  if (msg) toast(msg);
  if (btn) { btn.classList.remove('is-pop'); void btn.offsetWidth; btn.classList.add('is-pop'); }
}

const SKELETON = `
<section class="ledger" aria-label="記帳">
  <header class="ledger__head">
    <button class="ledger__nav" type="button" data-act="prev" aria-label="上個月">‹</button>
    <h2 data-r="month"></h2>
    <button class="ledger__nav" type="button" data-act="next" aria-label="下個月">›</button>
  </header>
  <dl class="ledger__sum" data-r="summary"></dl>
  <div class="ledger__alerts" data-r="alerts" role="status"></div>
  <section class="ledger__pending" data-r="pending"></section>
  <div class="ledger__grid">
    <div class="ledger__col">
      <form class="ledger__form" data-r="form" data-form="entry" novalidate>
        <fieldset class="ledger__type">
          <legend class="ledger__sr">類型</legend>
          <label><input type="radio" name="type" value="expense" checked><span>支出</span></label>
          <label><input type="radio" name="type" value="income"><span>收入</span></label>
          <label><input type="radio" name="type" value="transfer"><span>轉帳</span></label>
          <label><input type="radio" name="type" value="debt"><span>往來</span></label>
        </fieldset>
        <label class="ledger__field"><span>金額</span><input name="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="0"></label>
        <label class="ledger__field"><span data-r="accLabel">帳戶</span><select name="account"></select></label>
        <label class="ledger__field" data-r="toWrap" hidden><span>轉入帳戶</span><select name="toAccount"></select></label>
        <label class="ledger__field" data-r="debtWrap" hidden><span>往來類型</span><select name="debtKind">${Object.entries(DEBT_OPT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="ledger__field" data-r="personWrap" hidden><span>對象</span><select name="person"></select></label>
        <div class="ledger__catadd ledger__field--wide" data-r="personNew" hidden><input name="newperson" type="text" maxlength="20" placeholder="新對象名稱（家人、朋友…）" aria-label="新對象名稱" autocomplete="off"><button class="ledger__btn ledger__btn--primary" type="button" data-act="person-new-save">新增</button><button class="ledger__btn" type="button" data-act="person-new-cancel">取消</button></div>
        <p class="ledger__hint ledger__field--wide" data-r="debtHint" hidden></p>
        <label class="ledger__field" data-r="catWrap"><span>分類</span><select name="category"></select></label>
        <div class="ledger__catadd ledger__field--wide" data-r="catNew" hidden><input name="newcat" type="text" maxlength="12" placeholder="新分類名稱" aria-label="新分類名稱" autocomplete="off"><button class="ledger__btn ledger__btn--primary" type="button" data-act="cat-new-save">新增</button><button class="ledger__btn" type="button" data-act="cat-new-cancel">取消</button></div>
        <label class="ledger__field"><span>日期</span><input name="date" type="date"></label>
        <label class="ledger__field"><span>時間</span><input name="time" type="time"></label>
        <div class="ledger__chips" data-r="noteChips" role="group" aria-label="常用備註" hidden></div>
        <label class="ledger__field ledger__field--wide"><span>備註</span><input name="note" type="text" maxlength="60" placeholder="例如：午餐" autocomplete="off"></label>
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
  let type = 'expense', editing = false, ready = false, editId = null, accEdit = null, catMgr = false, lastCat = '', lastPerson = '', view = 'acc', personOpen = null, loanOpen = null, loanForm = null, payMode = null, instOpen = null, instForm = null, pplForm = null;

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
    if (t.accountId === a.id) b += INFLOW.has(t.type) ? t.amount : -t.amount;
    if (t.type === 'transfer' && t.toAccountId === a.id) b += t.amount;
    return b;
  }, a.opening || 0));
  // 對象餘額：正數＝對方欠我（應收），負數＝我欠對方（應付）
  const personBal = (id, upto) => round2(state.transactions.reduce((b, t) => (t.personId === id && DEBT[t.type] && !(upto && t.date > upto) ? b + (INFLOW.has(t.type) ? -t.amount : t.amount) : b), 0));
  // ---- 貸款：用「目前剩餘本金＋剩餘期數＋年利率」往後試算；實際金額以銀行帳單為準，繳款時可修改 ----
  const loanRem = (l, upto) => round2(l.balance0 - state.transactions.filter(t => t.type === 'loanprin' && t.loanId === l.id && !(upto && t.date > upto)).reduce((s, t) => s + t.amount, 0));
  const loanPaidN = l => new Set(state.transactions.filter(t => t.loanId === l.id && t.regular).map(t => t.payId)).size;
  const loanDue = (l, k) => { const s = new Date(l.startDate + 'T00:00:00'); let m = s.getMonth(); if (clampDay(s.getFullYear(), m, l.payDay) < s) m++; return clampDay(s.getFullYear(), m + k, l.payDay); };
  function loanStep(l, rem, k) {
    const left = Math.max(1, l.months - k), graceLeft = Math.max(0, (l.grace || 0) - k), na = Math.max(1, left - graceLeft), r = l.rate / 1200;
    const interest = round2(rem * r);
    let principal = 0;
    if (!graceLeft) principal = na <= 1 ? rem : l.method === 'principal' ? rem / na : r ? rem * r / (1 - Math.pow(1 + r, -na)) - rem * r : rem / na;
    principal = Math.min(rem, Math.max(0, round2(principal)));
    return { k, interest, principal, payment: round2(interest + principal), due: loanDue(l, k) };
  }
  function loanInfo(l) {
    const rem = loanRem(l), k = loanPaidN(l), plan = [];
    let r = rem;
    const cap = Math.max(1, l.months - k) + 1;
    while (r > 0.004 && plan.length < Math.min(cap, 600)) { const s = loanStep(l, r, k + plan.length); r = round2(r - s.principal); plan.push({ ...s, rem: r }); }
    return { rem, k, plan, next: plan[0] || null, totalInterest: round2(plan.reduce((s, x) => s + x.interest, 0)) };
  }
  // ---- 分期付款：每一期到期後等你按「確認」才記成一筆支出（App 不會在背景自動記帳）----
  const instDate = (p, i) => { const d = new Date(p.firstDate + 'T00:00:00'); return clampDay(d.getFullYear(), d.getMonth() + i, d.getDate()); };
  const instDone = p => { const s = new Set(); for (let i = 0; i < p.paid0; i++) s.add(i); state.transactions.forEach(t => { if (t.installId === p.id) s.add(t.idx); }); return s; };
  const instLeft = p => Math.max(0, p.periods - instDone(p).size);
  const pendingInst = () => {
    const t0 = midnight(), out = [];
    for (const p of state.installs) { const done = instDone(p); for (let i = 0; i < p.periods; i++) { const d = instDate(p, i); if (!done.has(i) && d <= t0) out.push({ p, i, date: d }); } }
    return out.sort((a, b) => a.date - b.date);
  };
  const loanName = id => state.loans.find(l => l.id === id)?.name || '（已刪除的貸款）';
  const personName = id => state.people.find(p => p.id === id)?.name || '?';

  // ---------- 常用備註（類似 MOZE）：依「分類」或「往來對象」記住打過的備註，常用、最近用的排前面 ----------
  // 直接從既有記錄算出來，不另外存資料；長按刪掉的備註只是「不再建議」，存在這支手機上
  const NOTE_HIDE_KEY = 'ledger:noteHide';
  let noteHide = new Set();
  try { noteHide = new Set(JSON.parse(localStorage.getItem(NOTE_HIDE_KEY)) || []); } catch {}
  const txNoteKey = t => (DEBT[t.type] ? 'p:' + t.personId : t.type === 'transfer' ? 'transfer' : t.type + ':' + t.category);
  function formNoteKey() {
    const f = $('form');
    if (type === 'debt') return f.person.value && f.person.value !== '__new__' ? 'p:' + f.person.value : '';
    if (type === 'transfer') return 'transfer';
    return f.category.value && f.category.value !== '__new__' ? type + ':' + f.category.value : '';
  }
  function noteSuggest(key) {
    const now = Date.now(), m = new Map();
    for (const t of state.transactions) {
      const n = String(t.note || '').trim();
      if (!n || t.installId || t.loanId || txNoteKey(t) !== key || noteHide.has(key + '\u0000' + n)) continue;
      const when = new Date(`${t.date}T${t.time || '12:00'}`).getTime() || 0, e = m.get(n) || { n, c: 0, last: 0 };
      e.c++; e.last = Math.max(e.last, when); m.set(n, e);
    }
    // 分數＝使用次數，越久沒用打越多折（每 30 天打一次折），所以常用又最近用的排最前面
    return [...m.values()].map(e => ({ ...e, s: e.c / (1 + Math.max(0, now - e.last) / 864e5 / 30) })).sort((a, b) => b.s - a.s || b.last - a.last);
  }
  function renderNoteChips() {
    const f = $('form'), box = $('noteChips'), key = formNoteKey(), cur = f.note.value.trim(), q = cur.toLowerCase();
    const list = key ? noteSuggest(key).filter(e => e.n !== cur && (!q || e.n.toLowerCase().includes(q))).slice(0, 12) : [];
    box.hidden = !list.length;
    box.innerHTML = list.map(e => `<button type="button" class="ledger__chip" data-act="note-pick" data-note="${esc(e.n)}">${esc(e.n)}</button>`).join('');
  }
  // 長按備註標籤 → 不再建議
  let pressTimer = 0, pressXY = null, skipClick = false;
  const pressEnd = () => { clearTimeout(pressTimer); pressTimer = 0; pressXY = null; };
  function onPressStart(e) {
    const b = e.target.closest('.ledger__chip');
    if (!b) return;
    pressEnd(); pressXY = [e.clientX, e.clientY];
    pressTimer = setTimeout(() => {
      pressEnd(); skipClick = true; haptic();
      const key = formNoteKey(), n = b.dataset.note;
      if (key && confirm(`不再建議「${n}」？\n已經記下的記錄不會改變。`)) {
        noteHide.add(key + '\u0000' + n);
        try { localStorage.setItem(NOTE_HIDE_KEY, JSON.stringify([...noteHide])); } catch {}
        renderNoteChips();
      }
      setTimeout(() => { skipClick = false; }, 400);
    }, 550);
  }
  const onPressMove = e => { if (pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 10) pressEnd(); };
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
  function clean({ type: ty, amount, accountId, toAccountId, personId, category, date, time = '', note = '' }) {
    amount = round2(Number(amount));
    if (!TYPES.includes(ty)) throw new Error('type 必須是 expense、income、transfer、lend、advance、collect、borrow 或 payback');
    if (!(amount > 0)) throw new Error('請輸入大於 0 的金額。');
    if (!state.accounts.some(a => a.id === accountId)) throw new Error('請選擇帳戶。');
    if (ty === 'transfer') {
      if (!state.accounts.some(a => a.id === toAccountId)) throw new Error('請選擇轉入帳戶。');
      if (toAccountId === accountId) throw new Error('轉出與轉入帳戶不能相同。');
      category = '轉帳';
    } else if (DEBT[ty]) {
      if (!state.people.some(p => p.id === personId)) throw new Error('請選擇往來對象。');
      toAccountId = undefined; category = DEBT[ty];
    } else { toAccountId = undefined; if (!category || category === '__new__') throw new Error('請選擇分類。'); }
    if (!DEBT[ty]) personId = undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('請選擇日期。');
    if (time && !/^\d{2}:\d{2}$/.test(time)) throw new Error('時間格式不正確。');
    const out = { type: ty, amount, accountId, toAccountId, category, date, time, note: String(note).trim().slice(0, 60) };
    if (personId) out.personId = personId;
    return out;
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
    if (!DEBT[r.type]) delete state.transactions[i].personId;
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
  // ---- 往來對象 ----
  function addPerson(name) {
    name = String(name ?? '').trim().slice(0, 20);
    if (!name) throw new Error('請輸入對象名稱。');
    if (state.people.some(p => p.name === name)) throw new Error('已經有同名的對象了。');
    const p = { id: uid(), name, dueDate: '' };
    state.people.push(p); update(); persist();
    return p.id;
  }
  function renamePerson(id, name) {
    name = String(name ?? '').trim().slice(0, 20);
    const p = state.people.find(x => x.id === id);
    if (!p) throw new Error('找不到這個對象。');
    if (!name) throw new Error('請輸入對象名稱。');
    if (state.people.some(x => x.id !== id && x.name === name)) throw new Error('已經有同名的對象了。');
    p.name = name; update(); persist();
  }
  function setPersonDue(id, date) {
    const p = state.people.find(x => x.id === id);
    if (!p) throw new Error('找不到這個對象。');
    p.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : '';
    update(); persist();
  }
  function removePerson(id) {
    if (state.transactions.some(t => t.personId === id)) throw new Error('這個對象已有往來記錄，無法刪除。');
    state.people = state.people.filter(p => p.id !== id);
    if (personOpen === id) personOpen = null;
    update(); persist();
  }
  // ---- 貸款 API ----
  function saveLoan(id, v) {
    const old = id && state.loans.find(l => l.id === id);
    const name = String(v.name || '').trim().slice(0, 20), rate = Number(v.rate);
    if (!name) throw new Error('請輸入貸款名稱。');
    if (!(rate >= 0 && rate <= 100)) throw new Error('年利率請輸入 0～100（例如 2.35）。');
    if (!state.accounts.some(a => a.id === v.accountId)) throw new Error('請選擇扣款帳戶。');
    const day = Math.round(Number(v.payDay));
    if (!(day >= 1 && day <= 31)) throw new Error('每月繳款日請輸入 1～31。');
    const f = { name, kind: LOAN_KINDS[v.kind] ? v.kind : 'other', rate, payDay: day, accountId: v.accountId, method: v.method === 'principal' ? 'principal' : 'equal' };
    let l;
    if (old) l = { ...old, ...f };
    else {
      const balance0 = round2(Number(v.balance0)), months = Math.round(Number(v.months));
      if (!(balance0 > 0)) throw new Error('請輸入目前剩餘本金。');
      if (!(months >= 1 && months <= 600)) throw new Error('剩餘期數請輸入 1～600（月）。');
      const grace = Math.max(0, Math.min(months - 1, Math.round(Number(v.grace)) || 0));
      l = { id: uid(), balance0, months, grace, startDate: isDate(v.startDate) ? v.startDate : today(), ...f };
    }
    const i = state.loans.findIndex(x => x.id === l.id);
    if (i < 0) state.loans.push(l); else state.loans[i] = l;
    loanForm = null; loanOpen = l.id; update(); persist();
    return l.id;
  }
  function removeLoan(id) {
    state.loans = state.loans.filter(l => l.id !== id);
    if (loanOpen === id) loanOpen = null;
    loanForm = null; payMode = null; update(); persist();   // 已記的繳款記錄會保留
  }
  // 繳款：利息記成一筆「支出」，本金只減少貸款餘額（不算支出）
  function payLoan(id, v) {
    const l = state.loans.find(x => x.id === id);
    if (!l) throw new Error('找不到這筆貸款。');
    if (!isDate(v.date)) throw new Error('請選擇日期。');
    if (!state.accounts.some(a => a.id === v.accountId)) throw new Error('請選擇扣款帳戶。');
    const interest = round2(Number(v.interest) || 0), principal = round2(Number(v.principal) || 0), extra = !!v.extra;
    if (interest < 0 || principal < 0 || interest + principal <= 0) throw new Error('請輸入利息或本金金額。');
    if (principal > loanRem(l) + 0.005) throw new Error('本金不能超過剩餘本金。');
    const payId = uid(), base = { accountId: v.accountId, date: v.date, time: '', note: l.name + (extra ? ' 提前還本' : ''), loanId: l.id, payId, regular: !extra, createdAt: Date.now() };
    if (interest > 0) state.transactions.push({ id: uid(), type: 'expense', amount: interest, category: '貸款利息', ...base });
    if (principal > 0) state.transactions.push({ id: uid(), type: 'loanprin', amount: principal, category: '貸款本金', extra, ...base, note: extra ? '提前還本' : '' });
    payMode = null; update(); persist();
  }
  // ---- 分期付款 API ----
  function saveInstall(id, v) {
    const old = id && state.installs.find(p => p.id === id);
    const name = String(v.name || '').trim().slice(0, 20), amount = round2(Number(v.amount)), periods = Math.round(Number(v.periods));
    if (!name) throw new Error('請輸入品項名稱。');
    if (!(amount > 0)) throw new Error('請輸入每期金額。');
    if (!(periods >= 1 && periods <= 360)) throw new Error('期數請輸入 1～360。');
    if (!isDate(v.firstDate)) throw new Error('請選擇第一期的日期。');
    if (!state.accounts.some(a => a.id === v.accountId)) throw new Error('請選擇扣款帳戶（信用卡也可以）。');
    const category = String(v.category || '').trim().slice(0, 12);
    if (!category || category === '__new__') throw new Error('請選擇分類。');
    const paid0 = Math.max(0, Math.min(periods, Math.round(Number(v.paid0)) || 0));
    const p = { id: old ? old.id : uid(), name, amount, periods, firstDate: v.firstDate, accountId: v.accountId, category, paid0, since: old ? old.since : (v.firstDate < today() ? v.firstDate : today()) };
    const i = state.installs.findIndex(x => x.id === p.id);
    if (i < 0) state.installs.push(p); else state.installs[i] = p;
    instForm = null; instOpen = p.id; update(); persist();
    return p.id;
  }
  function removeInstall(id) {
    state.installs = state.installs.filter(p => p.id !== id);
    if (instOpen === id) instOpen = null;
    instForm = null; update(); persist();   // 已確認的支出會保留
  }
  function confirmInstall(id, idx, quiet) {
    const p = state.installs.find(x => x.id === id);
    idx = Number(idx);
    if (!p || !Number.isInteger(idx) || idx < 0 || idx >= p.periods || instDone(p).has(idx)) return;
    state.transactions.push({ id: uid(), type: 'expense', amount: p.amount, accountId: p.accountId, category: p.category, date: ymd(instDate(p, idx)), time: '', note: `${p.name} 第 ${idx + 1}/${p.periods} 期`, installId: p.id, idx, createdAt: Date.now() });
    if (!quiet) { update(); persist(); }
  }
  function getDebt() {
    const loans = state.loans.map(l => { const i = loanInfo(l); return { id: l.id, name: l.name, kind: l.kind, rate: l.rate, remaining: i.rem, left: i.plan.length, payment: i.next?.payment || 0, interest: i.next?.interest || 0, principal: i.next?.principal || 0, due: i.next ? ymd(i.next.due) : '', totalInterest: i.totalInterest }; });
    const installs = state.installs.map(p => { const left = instLeft(p); return { id: p.id, name: p.name, amount: p.amount, left, remaining: round2(left * p.amount) }; });
    const monthly = round2(loans.reduce((s, x) => s + x.payment, 0) + installs.filter(x => x.left > 0).reduce((s, x) => s + x.amount, 0));
    return { loans, installs, monthly, remaining: round2(loans.reduce((s, x) => s + x.remaining, 0) + installs.reduce((s, x) => s + x.remaining, 0)) };
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
    if (masked) { accEdit = null; editing = false; loanForm = null; instForm = null; payMode = null; if (editId) endEdit(); }   // 關掉所有會露出金額的編輯畫面
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
    const ppl = [];
    for (const p of state.people) {
      const b = personBal(p.id);
      if (!b || !p.dueDate) continue;
      const d = new Date(p.dueDate + 'T00:00:00'), days = Math.round((d - midnight()) / 864e5), mine = b > 0;
      const who = mine ? `${esc(p.name)} 欠你 ${money(b)}` : `你欠 ${esc(p.name)} ${money(-b)}`;
      if (days < 0) ppl.push(`<p class="ledger__alert is-over"><b>${mine ? '逾期未收' : '逾期未還'}</b> ${who}，預計日是 ${mmdd(d)}</p>`);
      else if (days <= 3) ppl.push(`<p class="ledger__alert is-warn"><b>${mine ? '收款提醒' : '還款提醒'}</b> ${who}，${days === 0 ? '今天' : days + ' 天後'}（${mmdd(d)}）</p>`);
    }
    for (const l of state.loans) {
      const i = loanInfo(l);
      if (!i.next) continue;
      const days = Math.round((i.next.due - midnight()) / 864e5), txt = `${esc(l.name)} 本期應繳約 ${money(i.next.payment)}（${mmdd(i.next.due)}）`;
      if (days < 0) ppl.push(`<p class="ledger__alert is-over"><b>貸款逾期</b> ${txt}，還沒有記錄繳款</p>`);
      else if (days <= 3) ppl.push(`<p class="ledger__alert is-warn"><b>貸款繳款</b> ${txt}${days === 0 ? '，今天到期' : '，' + days + ' 天後到期'}</p>`);
    }
    $('alerts').innerHTML = [...cards, ...ppl, ...budget].join('');
  }

  function renderPending() {
    const list = pendingInst();
    $('pending').innerHTML = !list.length ? '' :
      `<div class="ledger__sec-head"><h3>待確認的分期付款</h3>${list.length > 1 ? '<button class="ledger__link" type="button" data-act="inst-confirm-all">全部確認</button>' : ''}</div><ul>` +
      list.map(x => `<li class="ledger__pend"><span>${esc(x.p.name)}<small class="ledger__muted">第 ${x.i + 1}/${x.p.periods} 期 · ${mmdd(x.date)} · ${esc(accName(x.p.accountId))}</small></span><span class="ledger__num">${money(x.p.amount)}</span><button class="ledger__pay" type="button" data-act="inst-confirm" data-id="${esc(x.p.id)}" data-idx="${x.i}">確認</button></li>`).join('') + '</ul>';
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
    const tx = (q ? state.transactions.filter(t => [t.category, t.note, t.loanId ? loanName(t.loanId) : '', accName(t.accountId), t.toAccountId ? accName(t.toAccountId) : '', t.personId ? personName(t.personId) : '', String(t.amount), t.time, t.date].join(' ').toLowerCase().includes(q)) : inMonth()).sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '') || (b.createdAt || 0) - (a.createdAt || 0));
    const dayExp = {}; let lastDay = '';
    tx.forEach(t => { if (t.type === 'expense') dayExp[t.date] = round2((dayExp[t.date] || 0) + t.amount); });
    $('list').innerHTML = `<div class="ledger__sec-head"><h3>${q ? '搜尋結果（全部月份）' : '本月記錄'}</h3><small class="ledger__muted">${tx.length} 筆</small></div>` +
      (tx.length
        ? `<ul>${tx.map(t => {
          let head = '';
          if (t.date !== lastDay) {
            lastDay = t.date;
            const d = new Date(t.date + 'T00:00:00'), spent = dayExp[t.date] || 0;
            head = `<li class="ledger__day"><span>${(q ? t.date.slice(2) : t.date.slice(5)).replaceAll('-', '/')} 週${'日一二三四五六'[d.getDay()]}</span>${spent ? `<span>支出 <b>${money(spent)}</b></span>` : ''}</li>`;
          }
          const sub = t.type === 'transfer' ? `${accName(t.accountId)} → ${accName(t.toAccountId)}` : DEBT[t.type] ? `${personName(t.personId)} · ${accName(t.accountId)}` : t.type === 'loanprin' ? `${loanName(t.loanId)} · ${accName(t.accountId)}` : accName(t.accountId);
          const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
          return head + `<li class="ledger__tx"><time datetime="${t.date}${t.time ? 'T' + t.time : ''}">${t.time || '–'}</time>` +
            `<button type="button" class="ledger__tx-main" data-act="edit" data-id="${esc(t.id)}" aria-label="編輯 ${esc(t.category)} ${money(t.amount)}"><span>${esc(t.category)}</span><small class="ledger__muted">${esc(sub)}${t.note ? ' · ' + esc(t.note) : ''}</small></button>` +
            `<span class="ledger__num is-${DEBT[t.type] || t.type === 'loanprin' ? 'transfer' : t.type}">${sign}${money(t.amount)}</span>` +
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
    const pb = state.people.map(p => personBal(p.id)), recv = round2(pb.filter(x => x > 0).reduce((s, x) => s + x, 0)), owe = round2(0 - pb.filter(x => x < 0).reduce((s, x) => s + x, 0));
    const loansRem = round2(state.loans.reduce((s, l) => s + loanRem(l), 0)), instsRem = round2(state.installs.reduce((s, p) => s + p.amount * instLeft(p), 0)), other = round2(owe + loansRem + instsRem);
    const net = round2(assets + recv - debt - other);
    const seg = `<div class="ledger__seg" role="group" aria-label="切換">` + [['acc', '帳戶'], ['ppl', '往來'], ['loan', '貸款']].map(([v, n]) => `<button type="button" data-act="view" data-v="${v}" aria-pressed="${view === v}">${n}</button>`).join('') + `</div>`;
    $('accounts').innerHTML = seg +
      `<dl class="ledger__sum"><div class="ledger__bal"><dt>淨資產</dt><dd class="${net < 0 ? 'is-neg' : ''}">${money(net)}</dd></div><div><dt>資產${recv ? '（含應收）' : ''}</dt><dd>${money(round2(assets + recv))}</dd></div><div><dt>負債${other ? '（含貸款・應付）' : ''}</dt><dd>${money(round2(debt + other))}</dd></div></dl>` +
      (view === 'ppl' ? renderPeople(recv, owe) : view === 'loan' ? renderLoans() : `<div class="ledger__sec-head"><h3>我的帳戶</h3>${f ? '' : '<button class="ledger__link" type="button" data-act="acc-new">新增帳戶</button>'}</div>${form}${groups}`);
    $('accounts').querySelectorAll('[data-pct]').forEach(el => { el.style.width = el.dataset.pct + '%'; });
  }

  // ---------- 貸款與分期 ----------
  const accOpts = sel => state.accounts.map(a => `<option value="${esc(a.id)}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  const dstr = d => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  function renderLoans() {
    if (loanForm) return loanFormHtml();
    if (instForm) return instFormHtml();
    const lo = state.loans.find(l => l.id === loanOpen); if (lo) return loanDetail(lo);
    const ip = state.installs.find(p => p.id === instOpen); if (ip) return instDetail(ip);
    const L = state.loans.map(l => ({ l, i: loanInfo(l) })), I = state.installs.map(p => ({ p, left: instLeft(p) }));
    const total = round2(L.reduce((s, x) => s + x.i.rem, 0) + I.reduce((s, x) => s + x.left * x.p.amount, 0)), monthly = getDebt().monthly;
    const lrows = L.length ? `<ul class="ledger__acclist">${L.map(({ l, i }) => `<li class="ledger__accrow"><button type="button" class="ledger__acc" data-act="loan-open" data-id="${esc(l.id)}"><span class="ledger__acc-name">${esc(l.name)}<small class="ledger__muted">${LOAN_KINDS[l.kind]} · ${i.next ? `下期 ${mmdd(i.next.due)} · 約 ${money(i.next.payment)}` : '已還清'}</small></span><span class="ledger__num">${money(i.rem)}</span></button></li>`).join('')}</ul>` : '<p class="ledger__empty">還沒有貸款。車貸、房貸、信貸都可以在這裡記。</p>';
    const irows = I.length ? `<ul class="ledger__acclist">${I.map(({ p, left }) => `<li class="ledger__accrow"><button type="button" class="ledger__acc" data-act="inst-open" data-id="${esc(p.id)}"><span class="ledger__acc-name">${esc(p.name)}<small class="ledger__muted">${left ? `還剩 ${left} 期 · 每期 ${money(p.amount)}` : '已繳清'}</small></span><span class="ledger__num">${money(round2(left * p.amount))}</span></button></li>`).join('')}</ul>` : '<p class="ledger__empty">還沒有分期付款。手機、家電、旅遊分期都可以在這裡記。</p>';
    return `<dl class="ledger__sum ledger__sum--two"><div><dt>貸款與分期餘額</dt><dd>${money(total)}</dd></div><div><dt>每月固定還款（估）</dt><dd>${money(monthly)}</dd></div></dl>` +
      `<div class="ledger__sec-head"><h3>貸款</h3><button class="ledger__link" type="button" data-act="loan-new">新增貸款</button></div>${lrows}` +
      `<div class="ledger__sec-head"><h3>分期付款</h3><button class="ledger__link" type="button" data-act="inst-new">新增分期</button></div>${irows}`;
  }
  function loanFormHtml() {
    const old = loanForm === 'new' ? null : state.loans.find(l => l.id === loanForm);
    const v = old || { kind: 'car', method: 'equal', accountId: (state.accounts.find(a => a.kind === 'bank') || state.accounts[0]).id };
    const fld = (label, name, val, attrs = '') => `<label class="ledger__field"><span>${label}</span><input name="${name}" value="${esc(val ?? '')}" ${attrs}></label>`;
    return `<div class="ledger__sec-head"><h3>${old ? '編輯貸款' : '新增貸款'}</h3></div><form class="ledger__acc-form" data-form="loan" data-id="${esc(old?.id || '')}" novalidate>` +
      fld('名稱', 'lname', old?.name, 'type="text" maxlength="20" placeholder="例如：Model Y 車貸"') +
      `<label class="ledger__field"><span>類型</span><select name="lkind">${Object.entries(LOAN_KINDS).map(([k, n]) => `<option value="${k}"${v.kind === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` +
      (old ? '' : fld('目前剩餘本金', 'lbal', '', 'type="number" min="0" step="any" inputmode="decimal" placeholder="還欠銀行多少"') + fld('剩餘期數（月）', 'lmonths', '', 'type="number" min="1" max="600" inputmode="numeric" placeholder="例如 60"')) +
      fld('年利率 %', 'lrate', old ? old.rate : '', 'type="number" min="0" max="100" step="any" inputmode="decimal" placeholder="例如 2.35"') +
      `<label class="ledger__field"><span>還款方式</span><select name="lmethod">${Object.entries(LOAN_METHODS).map(([k, n]) => `<option value="${k}"${v.method === k ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` +
      fld('每月繳款日', 'lday', old?.payDay, 'type="number" min="1" max="31" inputmode="numeric"') +
      `<label class="ledger__field"><span>扣款帳戶</span><select name="lacc">${accOpts(v.accountId)}</select></label>` +
      (old ? '' : fld('寬限期剩餘月數（只繳利息，沒有填 0）', 'lgrace', '', 'type="number" min="0" inputmode="numeric" placeholder="0"') + fld('從哪天開始記錄', 'lstart', today(), 'type="date"')) +
      `<p class="ledger__hint ledger__field--wide">「目前剩餘本金」看銀行最近一期帳單。系統依剩餘本金、期數與利率試算每期的利息與本金，實際以銀行帳單為準，記錄繳款時可以直接修改金額。${old ? '要改剩餘本金或期數，請刪除後重建。利率調整時直接改年利率即可。' : ''}</p>` +
      `<p class="ledger__error" data-acc-error role="alert"></p><div class="ledger__actions"><button class="ledger__btn ledger__btn--primary" type="submit">儲存</button><button class="ledger__btn" type="button" data-act="loan-formcancel">取消</button></div></form>`;
  }
  function loanDetail(l) {
    const i = loanInfo(l), pct = Math.min(100, Math.max(0, (l.balance0 - i.rem) / l.balance0 * 100));
    const tx = state.transactions.filter(t => t.loanId === l.id).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
    const nx = i.next, dueDays = nx ? Math.round((nx.due - midnight()) / 864e5) : 0;
    let pay = '';
    if (payMode && nx) {
      const ex = payMode === 'extra';
      pay = `<form class="ledger__acc-form" data-form="loanpay" data-id="${esc(l.id)}" data-mode="${payMode}" novalidate><label class="ledger__field"><span>日期</span><input name="pdate" type="date" value="${today()}"></label>` +
        `<label class="ledger__field"><span>扣款帳戶</span><select name="pacc">${accOpts(l.accountId)}</select></label>` +
        `<label class="ledger__field"><span>利息（算支出）</span><input name="pint" type="number" min="0" step="any" inputmode="decimal" value="${ex ? '' : nx.interest}" placeholder="0"></label>` +
        `<label class="ledger__field"><span>${ex ? '提前還的本金' : '本金（不算支出）'}</span><input name="ppri" type="number" min="0" step="any" inputmode="decimal" value="${ex ? '' : nx.principal}" placeholder="0"></label>` +
        `<p class="ledger__hint ledger__field--wide">${ex ? '提前還本會直接減少剩餘本金，之後每期的利息與應繳金額會重新試算。' : '預設是試算值。如果銀行帳單的金額不同，請直接改成帳單上的利息與本金。'}</p>` +
        `<p class="ledger__error" data-acc-error role="alert"></p><div class="ledger__actions"><button class="ledger__btn ledger__btn--primary" type="submit">${ex ? '記錄提前還本' : '記錄本期繳款'}</button><button class="ledger__btn" type="button" data-act="loan-paycancel">取消</button></div></form>`;
    }
    const plan = i.plan.slice(0, 12);
    return `<div class="ledger__sec-head"><button class="ledger__link" type="button" data-act="loan-back">‹ 貸款</button><span class="ledger__links"><button class="ledger__link" type="button" data-act="loan-edit" data-id="${esc(l.id)}">編輯</button><button class="ledger__link ledger__link--danger" type="button" data-act="loan-del" data-id="${esc(l.id)}">刪除</button></span></div>` +
      `<div class="ledger__person"><h3>${esc(l.name)}</h3><p class="ledger__status">${LOAN_KINDS[l.kind]} · 年利率 ${l.rate}% · ${LOAN_METHODS[l.method].split('（')[0]}<br>${i.rem > 0 ? `剩餘本金 <b>${money(i.rem)}</b>` : '<b>已還清</b>'}</p>` +
      `<div class="ledger__meter" aria-hidden="true"><i data-pct="${pct.toFixed(1)}"></i></div><small class="ledger__muted">已還 ${Math.round(pct)}%（${money(round2(l.balance0 - i.rem))} / ${money(l.balance0)}）</small>` +
      (nx ? `<dl class="ledger__cc-grid"><div><dt>下期應繳（估）</dt><dd>${money(nx.payment)} <small class="ledger__st ${dueDays < 0 ? 'is-over' : dueDays <= 3 ? 'is-warn' : ''}">${mmdd(nx.due)}${dueDays < 0 ? ` 逾期 ${-dueDays} 天` : dueDays === 0 ? ' 今天' : ` · ${dueDays} 天後`}</small></dd></div><div><dt>其中利息／本金</dt><dd>${money(nx.interest)} / ${money(nx.principal)}</dd></div><div><dt>剩餘期數</dt><dd>${i.plan.length} 期 <small class="ledger__st">約 ${dstr(i.plan[i.plan.length - 1].due)} 還清</small></dd></div><div><dt>預估剩餘利息</dt><dd>${money(i.totalInterest)}</dd></div></dl>` +
        `<div class="ledger__actions" style="margin-top:16px"><button class="ledger__btn ledger__btn--primary" type="button" data-act="loan-pay" data-mode="regular">記錄本期繳款</button><button class="ledger__btn" type="button" data-act="loan-pay" data-mode="extra">提前還本</button></div>` : '') + `</div>` + pay +
      (plan.length ? `<details class="ledger__cc-more"><summary>還款試算（接下來 ${plan.length} 期）</summary><ul class="ledger__cc-tx">${plan.map(x => `<li><time>${dstr(x.due).slice(2)}</time><span class="ledger__muted">利息 ${money(x.interest)} · 本金 ${money(x.principal)}</span><span class="ledger__num">${money(x.payment)}</span></li>`).join('')}</ul><p class="ledger__hint">利息以每月 年利率÷12 試算，銀行若按實際天數計息會有小差異。</p></details>` : '') +
      `<div class="ledger__sec-head"><h3>繳款記錄</h3><small class="ledger__muted">${tx.length} 筆</small></div>` +
      (tx.length ? `<ul>${tx.map(t => `<li class="ledger__tx"><time>${t.date.slice(2).replaceAll('-', '/')}</time><button type="button" class="ledger__tx-main" data-act="edit" data-id="${esc(t.id)}"><span>${t.type === 'loanprin' ? (t.extra ? '提前還本' : '本金') : '利息'}</span><small class="ledger__muted">${esc(accName(t.accountId))}</small></button><span class="ledger__num is-${t.type === 'expense' ? 'expense' : 'transfer'}">${t.type === 'expense' ? '−' : ''}${money(t.amount)}</span><button class="ledger__x" type="button" data-act="remove" data-id="${esc(t.id)}" aria-label="刪除">×</button></li>`).join('')}</ul><p class="ledger__hint">利息算在每月支出裡，本金只減少貸款餘額。</p>` : '<p class="ledger__empty">還沒有繳款記錄。</p>');
  }
  function instFormHtml() {
    const old = instForm === 'new' ? null : state.installs.find(p => p.id === instForm);
    const cats = [...state.categories.expense]; if (old && !cats.includes(old.category)) cats.push(old.category);
    const fld = (label, name, val, attrs = '') => `<label class="ledger__field"><span>${label}</span><input name="${name}" value="${esc(val ?? '')}" ${attrs}></label>`;
    return `<div class="ledger__sec-head"><h3>${old ? '編輯分期' : '新增分期'}</h3></div><form class="ledger__acc-form" data-form="inst" data-id="${esc(old?.id || '')}" novalidate>` +
      fld('品項', 'iname', old?.name, 'type="text" maxlength="20" placeholder="例如：iPhone 分期"') +
      fld('每期金額', 'iamt', old?.amount, 'type="number" min="0" step="any" inputmode="decimal"') +
      fld('期數', 'iper', old?.periods, 'type="number" min="1" max="360" inputmode="numeric" placeholder="例如 12"') +
      fld('第一期日期', 'istart', old?.firstDate || today(), 'type="date"') +
      `<label class="ledger__field"><span>扣款帳戶／信用卡</span><select name="iacc">${accOpts(old?.accountId || (state.accounts.find(a => a.kind === 'credit') || state.accounts[0]).id)}</select></label>` +
      `<label class="ledger__field"><span>分類</span><select name="icat">${cats.map(c => `<option value="${esc(c)}"${(old?.category || (cats.includes('購物') ? '購物' : cats[0])) === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>` +
      fld('已經繳了幾期（沒有填 0）', 'ipaid', old?.paid0 || '', 'type="number" min="0" inputmode="numeric" placeholder="0"') +
      `<p class="ledger__hint ledger__field--wide">每一期到期日，記帳頁會出現「待確認」，按一下才記成一筆支出（信用卡就記在那張卡上）。App 不會在背景自動記帳。</p>` +
      `<p class="ledger__error" data-acc-error role="alert"></p><div class="ledger__actions"><button class="ledger__btn ledger__btn--primary" type="submit">儲存</button><button class="ledger__btn" type="button" data-act="inst-formcancel">取消</button></div></form>`;
  }
  function instDetail(p) {
    const done = instDone(p), conf = new Set(state.transactions.filter(t => t.installId === p.id).map(t => t.idx)), t0 = midnight(), left = p.periods - done.size;
    const rows = Array.from({ length: p.periods }, (_, k) => {
      const d = instDate(p, k), isDone = done.has(k), due = !isDone && d <= t0;
      const st = isDone ? (conf.has(k) ? '已記帳' : '先前已繳') : due ? `<button class="ledger__pay" type="button" data-act="inst-confirm" data-id="${esc(p.id)}" data-idx="${k}">確認</button>` : '尚未到期';
      return `<li><time>${dstr(d).slice(2)}</time><span class="ledger__muted">第 ${k + 1}/${p.periods} 期 · ${st}</span><span class="ledger__num${isDone ? ' is-transfer' : ''}">${money(p.amount)}</span></li>`;
    }).join('');
    return `<div class="ledger__sec-head"><button class="ledger__link" type="button" data-act="inst-back">‹ 貸款</button><span class="ledger__links"><button class="ledger__link" type="button" data-act="inst-edit" data-id="${esc(p.id)}">編輯</button><button class="ledger__link ledger__link--danger" type="button" data-act="inst-del" data-id="${esc(p.id)}">刪除</button></span></div>` +
      `<div class="ledger__person"><h3>${esc(p.name)}</h3><p class="ledger__status">${left ? `還剩 <b>${left}</b> 期，共 <b>${money(round2(left * p.amount))}</b>` : '<b>已繳清</b>'}</p>` +
      `<dl class="ledger__cc-grid"><div><dt>每期金額</dt><dd>${money(p.amount)}</dd></div><div><dt>總金額</dt><dd>${money(round2(p.amount * p.periods))}</dd></div><div><dt>扣款帳戶</dt><dd>${esc(accName(p.accountId))}</dd></div><div><dt>分類</dt><dd>${esc(p.category)}</dd></div></dl></div>` +
      `<ul class="ledger__cc-tx ledger__instlist">${rows}</ul><p class="ledger__hint">每一期確認後會各記成一筆「${esc(p.category)}」支出。刪除這筆分期不會刪掉已記的支出。</p>`;
  }

  function renderPeople(recv, owe) {
    const o = personOpen && state.people.find(p => p.id === personOpen);
    if (o) return personDetail(o);
    const rows = state.people.map(p => ({ p, b: personBal(p.id) })).sort((x, y) => Math.abs(y.b) - Math.abs(x.b));
    const list = rows.length ? `<ul class="ledger__acclist">${rows.map(({ p, b }) =>
      `<li class="ledger__accrow"><button type="button" class="ledger__acc" data-act="ppl-open" data-id="${esc(p.id)}"><span class="ledger__acc-name">${esc(p.name)}<small class="ledger__muted">${b > 0 ? '對方欠我' : b < 0 ? '我欠對方' : '已結清'}${p.dueDate && b ? ' · 預計 ' + p.dueDate.slice(5).replace('-', '/') : ''}</small></span><span class="ledger__num${b > 0 ? ' is-income' : ''}">${money(Math.abs(b))}</span></button></li>`).join('')}</ul>`
      : '<p class="ledger__empty">還沒有往來對象。在「記帳」選「往來」記第一筆，或按右上角新增對象。</p>';
    return `<dl class="ledger__sum ledger__sum--two"><div><dt>應收（別人欠我）</dt><dd class="${recv ? 'is-pos' : ''}">${money(recv)}</dd></div><div><dt>應付（我欠別人）</dt><dd>${money(owe)}</dd></div></dl>` +
      `<div class="ledger__sec-head"><h3>往來對象</h3><button class="ledger__link" type="button" data-act="ppl-add">新增對象</button></div>${pplForm === 'new' ? pplFormHtml('', '') : ''}${list}`;
  }
  function pplFormHtml(id, name) {
    return `<form class="ledger__catadd" data-form="person" data-id="${esc(id)}" novalidate><input name="pname" type="text" maxlength="20" value="${esc(name)}" placeholder="對象名稱（家人、朋友、公司…）" aria-label="對象名稱" autocomplete="off"><button class="ledger__btn ledger__btn--primary" type="submit">${id ? '儲存' : '新增'}</button><button class="ledger__btn" type="button" data-act="ppl-formcancel">取消</button></form><p class="ledger__error" data-ppl-error role="alert"></p>`;
  }
  function personDetail(p) {
    const b = personBal(p.id), tx = state.transactions.filter(t => t.personId === p.id).sort((x, y) => y.date.localeCompare(x.date) || (y.time || '').localeCompare(x.time || '') || (y.createdAt || 0) - (x.createdAt || 0));
    const status = b > 0 ? `對方欠我 <b>${money(b)}</b>` : b < 0 ? `我欠對方 <b>${money(-b)}</b>` : '已結清';
    const btn = (kind, label, primary) => `<button type="button" class="ledger__btn${primary ? ' ledger__btn--primary' : ''}" data-act="ppl-act" data-kind="${kind}" data-id="${esc(p.id)}">${label}</button>`;
    return `<div class="ledger__sec-head"><button class="ledger__link" type="button" data-act="ppl-back">‹ 往來</button><span class="ledger__links"><button class="ledger__link" type="button" data-act="ppl-rename" data-id="${esc(p.id)}">改名</button>` +
      `<button class="ledger__link ledger__link--danger" type="button" data-act="ppl-del" data-id="${esc(p.id)}">刪除</button></span></div>` +
      `${pplForm === p.id ? pplFormHtml(p.id, p.name) : ''}<div class="ledger__person"><h3>${esc(p.name)}</h3><p class="ledger__status">${status}</p>` +
      `<div class="ledger__actions">${b > 0 ? btn('collect', '收回', true) : b < 0 ? btn('payback', '還款', true) : ''}${btn(b < 0 ? 'borrow' : 'lend', b < 0 ? '再借入' : '再借出', b === 0)}${btn('advance', '代墊')}</div>` +
      `<label class="ledger__field"><span>預計${b < 0 ? '還款' : '收回'}日（選填，到期前 3 天提醒）</span><input type="date" data-pdue="${esc(p.id)}" value="${esc(p.dueDate || '')}"></label></div>` +
      `<div class="ledger__sec-head"><h3>往來記錄</h3><small class="ledger__muted">${tx.length} 筆</small></div>` +
      (tx.length ? `<ul>${tx.map(t => `<li class="ledger__tx"><time>${t.date.slice(2).replaceAll('-', '/')}${t.time ? `<small>${t.time}</small>` : ''}</time>` +
        `<button type="button" class="ledger__tx-main" data-act="edit" data-id="${esc(t.id)}"><span>${DEBT[t.type]}</span><small class="ledger__muted">${esc(accName(t.accountId))}${t.note ? ' · ' + esc(t.note) : ''}</small></button>` +
        `<span class="ledger__num is-transfer">${money(t.amount)}</span><button class="ledger__x" type="button" data-act="remove" data-id="${esc(t.id)}" aria-label="刪除">×</button></li>`).join('')}</ul>` : '<p class="ledger__empty">還沒有記錄。</p>');
  }

  function update() {
    $('month').textContent = `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
    fillAccounts();
    if (type === 'expense' || type === 'income') fillCats();
    if (type === 'debt') fillPeople();
    renderSummary(); renderAlerts(); renderPending(); renderCats(); renderDaily(); renderList(); renderAccounts(); renderNoteChips();
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
    const f = $('form'), tr = type === 'transfer', db = type === 'debt', cat = type === 'expense' || type === 'income';
    $('catWrap').hidden = !cat; $('toWrap').hidden = !tr;
    $('debtWrap').hidden = !db; $('personWrap').hidden = !db; $('debtHint').hidden = !db;
    $('personNew').hidden = true; $('catNew').hidden = true;
    $('accLabel').textContent = tr ? '轉出帳戶' : db ? (INFLOW.has(f.debtKind.value) ? '入帳帳戶' : '付款帳戶') : '帳戶';
    if (db) { fillPeople(); $('debtHint').textContent = DEBT_HINT[f.debtKind.value]; }
    if (cat) fillCats();
    renderNoteChips();
  }
  function fillPeople(sel) {
    const f = $('form'), old = sel ?? (f.person.value === '__new__' ? lastPerson : f.person.value);
    // 沒有任何對象時，選單只剩「＋ 新增對象…」，選它不會觸發 change，所以加一個空白選項，並直接打開輸入欄
    const none = !state.people.length;
    f.person.innerHTML = (none ? '<option value="" disabled>請先新增對象</option>' : '') + state.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') + '<option value="__new__">＋ 新增對象…</option>';
    if (none) { f.person.value = ''; $('personNew').hidden = false; }
    else if (state.people.some(p => p.id === old)) f.person.value = old;
    lastPerson = f.person.value;
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
    editId = id; type = DEBT[t.type] ? 'debt' : t.type;
    f.querySelector(`input[name="type"][value="${type}"]`).checked = true;
    if (type === 'debt') f.debtKind.value = t.type;
    syncForm();
    if (type === 'debt') f.person.value = t.personId;
    if (type === 'expense' || type === 'income') {
      if (![...f.category.options].some(o => o.value === t.category)) f.category.add(new Option(t.category));
      f.category.value = t.category;
    }
    f.account.value = t.accountId; if (t.toAccountId) f.toAccount.value = t.toAccountId;
    f.amount.value = t.amount; f.date.value = t.date; f.time.value = t.time || ''; f.note.value = t.note || '';
    $('submit').textContent = '儲存修改'; $('cancel').hidden = false; f.classList.add('is-editing'); renderNoteChips();
    showError(''); f.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function endEdit() {
    const f = $('form');
    editId = null; f.amount.value = ''; f.note.value = ''; f.time.value = nowTime();
    $('submit').textContent = '新增記錄'; $('cancel').hidden = true; f.classList.remove('is-editing'); renderNoteChips();
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

  // 往來快捷：從對象頁帶入「收回／還款／再借出…」，收回與還款預設填入全部餘額
  function startDebt(personId, kind) {
    const f = $('form'), acc = state.accounts.find(a => a.kind === 'bank') || state.accounts.find(a => a.kind !== 'credit') || state.accounts[0];
    if (!state.people.some(p => p.id === personId) || !DEBT[kind]) return;
    if (editId) endEdit();
    type = 'debt'; f.querySelector('input[name="type"][value="debt"]').checked = true;
    f.debtKind.value = kind; syncForm(); fillPeople(personId); f.account.value = acc.id;
    const b = Math.abs(personBal(personId));
    f.amount.value = (kind === 'collect' || kind === 'payback') && b && !masked ? b : '';
    f.date.value = today(); f.time.value = nowTime(); f.note.value = ''; showError(''); renderNoteChips();
    root.dispatchEvent(new CustomEvent('ledger:goto', { detail: 'records' }));
    f.amount.focus();
  }

  // ---------- 事件 ----------
  const onClick = e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (masked && ['edit', 'acc-edit', 'budget-edit', 'ppl-rename', 'loan-new', 'loan-edit', 'loan-pay', 'inst-new', 'inst-edit'].includes(act)) return alert('金額已隱藏。請先點右上角的眼睛顯示金額，再編輯。');
    if (act === 'prev' || act === 'next') {
      const [y, m] = month.split('-').map(Number), d = new Date(y, m - 1 + (act === 'next' ? 1 : -1), 1);
      setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
    } else if (act === 'note-pick') {
      if (skipClick) return;
      $('form').note.value = b.dataset.note; haptic(); renderNoteChips();
    } else if (act === 'remove') {
      if (confirm('刪除這筆記錄？')) { removeTransaction(b.dataset.id); feedback('已刪除'); }
    } else if (act === 'budget-edit' || act === 'budget-cancel') {
      editing = act === 'budget-edit'; update();
    } else if (act === 'edit') { if (state.transactions.find(t => t.id === b.dataset.id)?.type === 'loanprin') return alert('貸款本金記錄無法修改。請刪除後，到「資產 › 貸款」重新記錄。'); startEdit(b.dataset.id); if (b.closest('[data-r="accounts"]')) root.dispatchEvent(new CustomEvent('ledger:goto', { detail: 'records' })); }
    else if (act === 'view') { view = b.dataset.v; pplForm = null; personOpen = loanOpen = instOpen = loanForm = instForm = payMode = null; renderAccounts(); }
    else if (act === 'loan-new') { loanForm = 'new'; renderAccounts(); }
    else if (act === 'loan-open') { loanOpen = b.dataset.id; payMode = null; renderAccounts(); scrollTo(0, 0); }
    else if (act === 'loan-back') { loanOpen = null; loanForm = null; payMode = null; renderAccounts(); }
    else if (act === 'loan-edit') { loanForm = b.dataset.id; payMode = null; renderAccounts(); }
    else if (act === 'loan-formcancel') { loanForm = null; renderAccounts(); }
    else if (act === 'loan-pay') { payMode = b.dataset.mode; renderAccounts(); }
    else if (act === 'loan-paycancel') { payMode = null; renderAccounts(); }
    else if (act === 'loan-del') { if (confirm('刪除這筆貸款？已經記下的繳款記錄會保留。')) { removeLoan(b.dataset.id); feedback('已刪除'); } }
    else if (act === 'inst-new') { instForm = 'new'; renderAccounts(); }
    else if (act === 'inst-open') { instOpen = b.dataset.id; renderAccounts(); scrollTo(0, 0); }
    else if (act === 'inst-back') { instOpen = null; instForm = null; renderAccounts(); }
    else if (act === 'inst-edit') { instForm = b.dataset.id; renderAccounts(); }
    else if (act === 'inst-formcancel') { instForm = null; renderAccounts(); }
    else if (act === 'inst-del') { if (confirm('刪除這筆分期？已經確認的支出會保留。')) { removeInstall(b.dataset.id); feedback('已刪除'); } }
    else if (act === 'inst-confirm') { confirmInstall(b.dataset.id, b.dataset.idx); feedback('已確認', b); }
    else if (act === 'inst-confirm-all') { pendingInst().forEach(x => confirmInstall(x.p.id, x.i, true)); update(); persist(); feedback('已全部確認'); }
    else if (act === 'ppl-open') { personOpen = b.dataset.id; pplForm = null; renderAccounts(); scrollTo(0, 0); }
    else if (act === 'ppl-back') { personOpen = null; pplForm = null; renderAccounts(); }
    else if (act === 'ppl-add') { pplForm = 'new'; renderAccounts(); focusIn('[data-form="person"] input'); }
    else if (act === 'ppl-formcancel') { pplForm = null; renderAccounts(); }
    else if (act === 'person-new-save') savePersonInline();
    else if (act === 'person-new-cancel') { $('personNew').hidden = true; fillPeople(); }
    else if (act === 'cat-new-save') saveCatInline();
    else if (act === 'cat-new-cancel') { $('catNew').hidden = true; fillCats(); }
    else if (act === 'ppl-act') startDebt(b.dataset.id, b.dataset.kind);
    else if (act === 'ppl-rename') { pplForm = b.dataset.id; renderAccounts(); focusIn('[data-form="person"] input'); }
    else if (act === 'ppl-del') {
      if (confirm('刪除這個對象？')) { try { removePerson(b.dataset.id); feedback('已刪除'); } catch (err) { alert(err.message); } }
    }
    else if (act === 'edit-cancel') endEdit();
    else if (act === 'catmgr-open') { catMgr = true; editing = false; update(); }
    else if (act === 'catmgr-close') { catMgr = false; update(); }
    else if (act === 'cat-rename') {
      const to = prompt(`把「${b.dataset.name}」改名為：`, b.dataset.name);
      if (to !== null) { try { renameCategory(b.dataset.type, b.dataset.name, to); } catch (err) { alert(err.message); } }
    } else if (act === 'cat-del') {
      if (confirm(`從選單移除「${b.dataset.name}」？\n既有的記錄不會被刪除。`)) { try { removeCategory(b.dataset.type, b.dataset.name); feedback('已移除'); } catch (err) { alert(err.message); } }
    }
    else if (act === 'acc-new') { accEdit = 'new'; renderAccounts(); }
    else if (act === 'acc-edit') { accEdit = b.dataset.id; renderAccounts(); }
    else if (act === 'acc-cancel') { accEdit = null; renderAccounts(); }
    else if (act === 'acc-pay') startPay(b.dataset.id);
    else if (act === 'acc-delete') {
      if (confirm('刪除這個帳戶？')) { try { removeAccount(b.dataset.id); feedback('已刪除'); } catch (err) { alert(err.message); } }
    }
  };
  function focusIn(sel) { const el = root.querySelector(sel); if (el) { el.focus(); el.select?.(); } }
  function savePersonInline() {
    const f = $('form'), n = f.newperson.value;
    if (!n.trim()) return f.newperson.focus();
    try { const id = addPerson(n); fillPeople(id); $('personNew').hidden = true; showError(''); renderNoteChips(); feedback('已新增對象'); } catch (err) { showError(err.message); }
  }
  function saveCatInline() {
    const f = $('form'), n = f.newcat.value;
    if (!n.trim()) return f.newcat.focus();
    try { const c = addCategory(type, n); fillCats(c); $('catNew').hidden = true; showError(''); renderNoteChips(); feedback('已新增分類'); } catch (err) { showError(err.message); }
  }
  // 「對方還我」或「我還款」超過目前欠款時先提醒，避免餘額被翻成相反方向（例如從舊 App 搬過來、漏記了代墊）
  function overpayOk(input) {
    const ty = input.type;
    if ((ty !== 'collect' && ty !== 'payback') || !state.people.some(p => p.id === input.personId)) return true;
    const bal = personBal(input.personId), owed = round2(ty === 'collect' ? bal : -bal), amt = round2(Number(input.amount));
    if (!(amt > 0) || amt <= owed) return true;
    const name = personName(input.personId);
    const head = ty === 'collect'
      ? (owed > 0 ? `${name} 目前只欠你 ${money(owed)}，這筆收回 ${money(amt)} 比較多。` : `${name} 目前沒有欠你錢。`)
      : (owed > 0 ? `你目前只欠 ${name} ${money(owed)}，這筆還款 ${money(amt)} 比較多。` : `你目前沒有欠 ${name} 錢。`);
    const tail = ty === 'collect' ? '多出來的部分會變成「你欠對方」。\n如果是之前的代墊或借出沒有記到，請先補記那一筆。' : '多出來的部分會變成「對方欠你」。\n如果是之前的借入沒有記到，請先補記那一筆。';
    return confirm(`${head}\n\n${tail}\n\n仍要記錄嗎？`);
  }
  const onSubmit = e => {
    const f = e.target;
    if (f.matches('[data-form="entry"]')) {
      e.preventDefault();
      if (document.activeElement === f.newperson) return savePersonInline();
      if (document.activeElement === f.newcat) return saveCatInline();
      if (!ready) return showError('資料載入中，請稍候。');
      try {
        const input = { type: type === 'debt' ? f.debtKind.value : type, personId: f.person.value, amount: f.amount.value, accountId: f.account.value, toAccountId: f.toAccount.value, category: f.category.value, date: f.date.value, time: f.time.value, note: f.note.value };
        if (!editId && !overpayOk(input)) return;
        const wasEdit = !!editId;
        if (editId) { updateTransaction(editId, input); endEdit(); } else addTransaction(input);
        f.amount.value = ''; f.note.value = ''; f.time.value = nowTime(); showError(''); renderNoteChips();
        feedback(wasEdit ? '已儲存修改' : '已記錄', $('submit'));
        f.amount.focus();
      } catch (err) { showError(err.message); }
    } else if (f.matches('[data-form="budget"]')) {
      e.preventDefault();
      f.querySelectorAll('input[data-cat]').forEach(i => putBudget(i.dataset.cat, i.value));
      editing = false; update(); persist(); feedback('預算已儲存');
    } else if (f.matches('[data-form="account"]')) {
      e.preventDefault();
      const credit = f.kind.value === 'credit', n = Number(f.opening.value) || 0;
      try {
        saveAccount(f.dataset.id || null, { name: f.accname.value, kind: f.kind.value, opening: credit ? -Math.abs(n) : n, statementDay: f.statementDay.value, dueDay: f.dueDay.value, limit: f.limit.value });
        feedback('帳戶已儲存');
      } catch (err) { f.querySelector('[data-acc-error]').textContent = err.message; }
    } else if (f.matches('[data-form="loan"]')) {
      e.preventDefault();
      try { saveLoan(f.dataset.id || null, { name: f.lname.value, kind: f.lkind.value, rate: f.lrate.value, method: f.lmethod.value, payDay: f.lday.value, accountId: f.lacc.value, balance0: f.lbal?.value, months: f.lmonths?.value, grace: f.lgrace?.value, startDate: f.lstart?.value }); feedback('貸款已儲存'); }
      catch (err) { f.querySelector('[data-acc-error]').textContent = err.message; }
    } else if (f.matches('[data-form="loanpay"]')) {
      e.preventDefault();
      try { payLoan(f.dataset.id, { date: f.pdate.value, accountId: f.pacc.value, interest: f.pint.value, principal: f.ppri.value, extra: f.dataset.mode === 'extra' }); feedback('已記錄繳款'); }
      catch (err) { f.querySelector('[data-acc-error]').textContent = err.message; }
    } else if (f.matches('[data-form="inst"]')) {
      e.preventDefault();
      try { saveInstall(f.dataset.id || null, { name: f.iname.value, amount: f.iamt.value, periods: f.iper.value, firstDate: f.istart.value, accountId: f.iacc.value, category: f.icat.value, paid0: f.ipaid.value }); feedback('分期已儲存'); }
      catch (err) { f.querySelector('[data-acc-error]').textContent = err.message; }
    } else if (f.matches('[data-form="person"]')) {
      e.preventDefault();
      const id = f.dataset.id, n = f.pname.value;
      try {
        if (id) { pplForm = null; renamePerson(id, n); feedback('已改名'); }
        else { const nid = addPerson(n); pplForm = null; personOpen = nid; renderAccounts(); scrollTo(0, 0); feedback('已新增對象'); }
      } catch (err) { f.parentNode.querySelector('[data-ppl-error]').textContent = err.message; if (id) pplForm = id; }
    } else if (f.matches('[data-form="catadd"]')) {
      e.preventDefault();
      try { addCategory(f.dataset.type, f.catname.value); feedback('已新增分類'); } catch (err) { alert(err.message); }
    }
  };
  const onType = e => {
    if (e.target.name === 'category' && e.target.value !== '__new__') lastCat = e.target.value;
    if (e.target.matches('[data-pdue]')) { try { setPersonDue(e.target.dataset.pdue, e.target.value); } catch (err) { alert(err.message); } return; }
    if (e.target.name === 'person' && e.target.value !== '__new__') lastPerson = e.target.value;
    if (e.target.name === 'type') { type = e.target.value; syncForm(); }
    else if (e.target.name === 'debtKind') syncForm();
    else if (e.target.name === 'person' && e.target.value === '__new__') {
      $('personNew').hidden = false; $('form').newperson.value = ''; $('form').newperson.focus();
    }
    else if (e.target.name === 'category' && e.target.value === '__new__') {
      $('catNew').hidden = false; $('form').newcat.value = ''; $('form').newcat.focus();
    }
    else if (e.target.name === 'kind') {
      const f = e.target.form, c = e.target.value === 'credit';
      f.querySelector('[data-credit]').hidden = !c;
      f.querySelector('[data-r="openLabel"]').textContent = c ? '目前欠款' : '初始餘額';
    }
    if (e.target.name === 'category' || e.target.name === 'person') renderNoteChips();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  const onInput = e => { if (e.target.matches('[data-r="search"]')) renderList(); else if (e.target === $('form').note) renderNoteChips(); };
  const onCtx = e => { if (e.target.closest('.ledger__chip')) e.preventDefault(); };
  root.addEventListener('pointerdown', onPressStart);
  root.addEventListener('pointermove', onPressMove);
  root.addEventListener('pointerup', pressEnd);
  root.addEventListener('pointercancel', pressEnd);
  root.addEventListener('contextmenu', onCtx);
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
    addTransaction, updateTransaction, removeTransaction, saveAccount, removeAccount, addPerson, renamePerson, setPersonDue, removePerson, saveLoan, removeLoan, payLoan, saveInstall, removeInstall, confirmInstall, getDebt, replaceState, setBudget, setMonth, setMasked, addCategory, renameCategory, removeCategory, openCategoryManager,
    destroy() {
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.removeEventListener('change', onType);
      root.removeEventListener('input', onInput);
      root.removeEventListener('pointerdown', onPressStart);
      root.removeEventListener('pointermove', onPressMove);
      root.removeEventListener('pointerup', pressEnd);
      root.removeEventListener('pointercancel', pressEnd);
      root.removeEventListener('contextmenu', onCtx);
      root.replaceChildren();
    },
  };
}
