// analysis.js — 分析報表（零相依，全部用 SVG 繪製）
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round(n * 100) / 100;
const compact = n => {
  const a = Math.abs(n), s = a >= 1e8 ? (a / 1e8).toFixed(1) + '億' : a >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, '') + '萬' : String(Math.round(a));
  return (n < 0 ? '-' : '') + s;
};
// 甜甜圈的顏色跟著主題走（定義在 app.css 的 --c1～--c7）
const COLORS = [1, 2, 3, 4, 5, 6, 7].map(i => `var(--c${i})`);
const colorAt = i => COLORS[Math.min(i, 6)];
const BUCKETS = [['清晨', '05–09'], ['上午', '09–12'], ['中午', '12–14'], ['下午', '14–18'], ['晚上', '18–22'], ['深夜', '22–05']];
const bucketOf = h => h < 5 ? 5 : h < 9 ? 0 : h < 12 ? 1 : h < 14 ? 2 : h < 18 ? 3 : h < 22 ? 4 : 5;
const WD = '一二三四五六日';

export function mountAnalysis(el, getState, money, isHidden = () => false, getDebt = () => null) {
  // n：期間月數；sel：點選的月份（YYYY-MM）；cat：展開的分類
  const ui = { n: 6, sel: null, cat: null };
  const draw = () => {
    el.innerHTML = build(getState(), ui, money, isHidden(), getDebt());
    el.querySelectorAll('[data-pct]').forEach(e => { e.style.width = e.dataset.pct + '%'; });
    el.querySelectorAll('[data-c]').forEach(e => { e.style.background = e.dataset.c; });
  };
  el.addEventListener('click', e => {
    const r = e.target.closest('[data-range]'), m = e.target.closest('[data-mon]'), c = e.target.closest('[data-cat]');
    if (r) { ui.n = +r.dataset.range; ui.sel = null; ui.cat = null; }
    else if (m) ui.sel = m.dataset.mon;
    else if (c) ui.cat = ui.cat === c.dataset.cat ? null : c.dataset.cat;
    else return;
    draw();
  });
  return draw;
}

function build(state, ui, money, hid, debt) {
  const N = ui.n;
  const cp = v => (hid ? '••' : compact(v));
  const now = new Date();
  const months = Array.from({ length: N }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - (N - 1 - i), 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
  const mLabel = m => `${+m.slice(5)}月`;
  const head = `<h1 class="title">分析</h1><div class="an-seg" role="group" aria-label="期間">${[3, 6, 12].map(k => `<button type="button" data-range="${k}" aria-pressed="${k === N}">${k} 個月</button>`).join('')}</div>`;
  if (!state.transactions.length) return head + '<p class="an-empty">還沒有資料。先記幾筆帳，這裡就會出現趨勢與分析。</p>';

  const sumBy = (tx, ty) => r2(tx.filter(t => t.type === ty).reduce((s, t) => s + t.amount, 0));
  const per = months.map(m => { const tx = state.transactions.filter(t => t.date.startsWith(m)); return { m, inc: sumBy(tx, 'income'), exp: sumBy(tx, 'expense'), cnt: tx.filter(t => t.type === 'expense').length }; });
  const set = new Set(months), RE = state.transactions.filter(t => t.type === 'expense' && set.has(t.date.slice(0, 7)));
  const exp = r2(per.reduce((s, p) => s + p.exp, 0)), inc = r2(per.reduce((s, p) => s + p.inc, 0));
  const full = per.slice(0, -1), incF = r2(full.reduce((s, p) => s + p.inc, 0)), expF = r2(full.reduce((s, p) => s + p.exp, 0)), nF = full.length;   // 完整月份（不含本月）
  const rate = incF > 0 ? Math.round((incF - expF) / incF * 100) : null;
  const open = state.accounts.reduce((s, a) => s + (a.opening || 0), 0);
  // 淨資產＝帳戶初始餘額＋收入－支出，再扣掉貸款與分期的起算負債（分期每期確認的支出會把負債一起沖掉，所以加回）
  const nw = months.map(m => {
    const end = m + '-31'; let v = open;
    for (const t of state.transactions) if (t.date <= end) v += t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount + (t.installId ? t.amount : 0) : 0;
    for (const l of state.loans || []) if (l.startDate <= end) v -= l.balance0;
    for (const p of state.installs || []) if (p.since <= end) v -= p.amount * (p.periods - p.paid0);
    return r2(v);
  });
  const catTotals = list => { const o = {}; list.forEach(t => { o[t.category] = r2((o[t.category] || 0) + t.amount); }); return Object.entries(o).sort((a, b) => b[1] - a[1]); };
  const cats = catTotals(RE);
  const cur = per[N - 1], prev = per[N - 2];
  const daysIn = m => new Date(+m.slice(0, 4), +m.slice(5), 0).getDate();

  // 時段與星期
  const tb = Array(6).fill(0), tbn = Array(6).fill(0); let timed = 0;
  RE.forEach(t => { if (/^\d{2}:\d{2}$/.test(t.time || '')) { const b = bucketOf(+t.time.slice(0, 2)); tb[b] += t.amount; tbn[b]++; timed += t.amount; } });
  const wd = Array(7).fill(0), wdn = Array(7).fill(0);
  RE.forEach(t => { const i = (new Date(t.date + 'T00:00').getDay() + 6) % 7; wd[i] += t.amount; wdn[i]++; });

  // 本月還沒過完，所以和上月「同一天以前」比
  const upto = t => +t.date.slice(8, 10) <= now.getDate(), sp = m => state.transactions.filter(t => t.type === 'expense' && t.date.startsWith(m) && upto(t));
  const curTo = r2(sp(cur.m).reduce((s, t) => s + t.amount, 0)), prevTo = r2(sp(prev.m).reduce((s, t) => s + t.amount, 0));
  const mc = m => Object.fromEntries(catTotals(sp(m)));
  const c1 = mc(cur.m), c0 = mc(prev.m);

  // 重點觀察
  const ins = [];
  if (prevTo > 0) { const d = (curTo - prevTo) / prevTo * 100; ins.push(`本月至今的支出比上月同期${d >= 0 ? '多' : '少'} ${Math.abs(Math.round(d))}%（<b class="an-nb">${d >= 0 ? '+' : '−'}${money(Math.abs(r2(curTo - prevTo)))}</b>）。`); }
  const dim = daysIn(cur.m), today = now.getDate();
  if (cur.exp > 0 && today < dim) ins.push(`照目前每天平均 <b class="an-nb">${money(r2(cur.exp / today))}</b> 的速度，本月支出預估約 <b class="an-nb">${money(r2(cur.exp / today * dim))}</b>。`);
  const jump = Object.keys(c1).map(k => [k, r2(c1[k] - (c0[k] || 0))]).sort((a, b) => b[1] - a[1])[0];
  if (jump && jump[1] > 0 && prevTo > 0) ins.push(`跟上月同期比，增加最多的是「${esc(jump[0])}」，多了 <b class="an-nb">${money(jump[1])}</b>。`);
  if (cats.length) ins.push(`「${esc(cats[0][0])}」是近 ${N} 個月最大的支出，佔 ${Math.round(cats[0][1] / exp * 100)}%。`);
  if (rate !== null) ins.push(`前 ${nF} 個完整月的平均儲蓄率為 ${rate}%。`);
  if (timed > 0) { const i = tb.indexOf(Math.max(...tb)); ins.push(`消費最集中在${BUCKETS[i][0]}（${BUCKETS[i][1]} 時），佔有記錄時間之支出的 ${Math.round(tb[i] / timed * 100)}%。`); }

  const kpi = (k, v, cls = '') => `<div class="an-kpi"><small>${k}</small><b class="${cls}">${v}</b></div>`;
  const kpis = kpi('平均月收入', money(r2(incF / nF))) + kpi('平均月支出', money(r2(expF / nF))) + kpi('儲蓄率', rate === null ? '–' : rate + '%') + kpi('目前淨資產', money(nw[N - 1]));

  const card = (title, body, extra = '') => `<section class="an-card"><div class="ledger__sec-head"><h3>${title}</h3>${extra}</div>${body}</section>`;
  const hbars = (items) => { const mx = Math.max(...items.map(i => i.v)); return items.map(i => `<div class="an-row${mx > 0 && i.v === mx ? ' is-max' : ''}"><span>${i.l}${i.s ? `<small>${i.s}</small>` : ''}</span><div class="an-track"><i data-pct="${mx ? (i.v / mx * 100).toFixed(1) : 0}"></i></div><span class="an-amt">${money(r2(i.v))}</span></div>`).join(''); };

  // ---------- 收支趨勢（可點選月份） ----------
  const si = Math.max(0, months.indexOf(ui.sel) >= 0 ? months.indexOf(ui.sel) : N - 1), S = per[si];
  const W = 320, H = 160, base = H - 20, maxV = Math.max(1, ...per.flatMap(p => [p.inc, p.exp])), gw = W / N, bw = Math.min(14, gw / 2 - 2);
  const hgt = v => Math.max((v / maxV) * (base - 14), v ? 1.5 : 0);
  const midY = base - (base - 14) / 2;
  const bars = per.map((p, i) => {
    const cx = gw * i + gw / 2, dim2 = i === si ? '' : ' is-dim';
    return `<rect class="an-inc${dim2}" x="${(cx - bw - 1).toFixed(1)}" y="${(base - hgt(p.inc)).toFixed(1)}" width="${bw}" height="${hgt(p.inc).toFixed(1)}" rx="2"/>` +
      `<rect class="an-exp${dim2}" x="${(cx + 1).toFixed(1)}" y="${(base - hgt(p.exp)).toFixed(1)}" width="${bw}" height="${hgt(p.exp).toFixed(1)}" rx="2"/>` +
      `<text class="${i === si ? 'is-sel' : ''}" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${N > 6 ? +p.m.slice(5) : mLabel(p.m)}</text>` +
      `<rect class="an-hit" data-mon="${p.m}" x="${(gw * i).toFixed(1)}" y="0" width="${gw.toFixed(1)}" height="${H}"><title>${mLabel(p.m)}</title></rect>`;
  }).join('');
  const trend = `<svg class="an-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="近 ${N} 個月收入與支出長條圖，點選月份看明細">` +
    `<line class="an-grid" x1="0" x2="${W}" y1="14" y2="14"/><line class="an-grid" x1="0" x2="${W}" y1="${midY}" y2="${midY}"/>${bars}<line x1="0" x2="${W}" y1="${base}" y2="${base}"/>` +
    `<text x="0" y="10">${cp(maxV)}</text><text x="0" y="${midY - 3}">${cp(maxV / 2)}</text></svg>`;

  // 選取月份的明細
  const isCur = si === N - 1, sDays = isCur ? today : daysIn(S.m), sBal = r2(S.inc - S.exp);
  const sTx = state.transactions.filter(t => t.type === 'expense' && t.date.startsWith(S.m));
  const sTop = catTotals(sTx).slice(0, 3);
  const sRate = S.inc > 0 ? Math.round(sBal / S.inc * 100) + '%' : '–';
  const detail = `<div class="an-detail"><div class="an-detail-head"><b>${S.m.slice(0, 4)} 年 ${mLabel(S.m)}${isCur ? '（至今）' : ''}</b><small>點長條圖或下方表格切換月份</small></div>` +
    `<dl class="an-dl"><div><dt>收入</dt><dd class="an-pos">${money(S.inc)}</dd></div><div><dt>支出</dt><dd>${money(S.exp)}</dd></div>` +
    `<div><dt>結餘</dt><dd class="${sBal < 0 ? 'is-up' : 'an-pos'}">${sBal < 0 ? '−' : ''}${money(Math.abs(sBal))}</dd></div><div><dt>儲蓄率</dt><dd>${sRate}</dd></div>` +
    `<div><dt>支出筆數</dt><dd>${S.cnt} 筆</dd></div><div><dt>每日平均支出</dt><dd>${money(r2(S.exp / sDays))}</dd></div></dl>` +
    (sTop.length ? `<p class="an-sub">這個月花最多的分類</p><ol class="an-top">${sTop.map(([nm, v]) => `<li><span>${esc(nm)}</span><span class="an-amt">${money(v)}・${Math.round(v / S.exp * 100)}%</span></li>`).join('')}</ol>` : '<p class="an-empty">這個月沒有支出。</p>') + '</div>';

  // ---------- 每月一覽（表格） ----------
  const fmtBal = v => `<span class="${v < 0 ? 'is-up' : 'an-pos'}">${v < 0 ? '−' : ''}${money(Math.abs(v))}</span>`;
  const rows = per.map((p, i) => `<tr data-mon="${p.m}" class="${i === si ? 'is-sel' : ''}"><th scope="row">${N > 6 || +p.m.slice(5) === 1 ? p.m.slice(2, 4) + '/' : ''}${+p.m.slice(5)}月${i === N - 1 ? '<small>至今</small>' : ''}</th><td>${money(p.inc)}</td><td>${money(p.exp)}</td><td>${fmtBal(r2(p.inc - p.exp))}</td></tr>`).reverse().join('');
  const table = `<div class="an-tblwrap"><table class="an-tbl"><thead><tr><th scope="col">月份</th><th scope="col">收入</th><th scope="col">支出</th><th scope="col">結餘</th></tr></thead><tbody>${rows}</tbody>` +
    `<tfoot><tr><th scope="row">合計</th><td>${money(inc)}</td><td>${money(exp)}</td><td>${fmtBal(r2(inc - exp))}</td></tr>` +
    (nF ? `<tr><th scope="row">月平均<small>不含本月</small></th><td>${money(r2(incF / nF))}</td><td>${money(r2(expF / nF))}</td><td>${fmtBal(r2((incF - expF) / nF))}</td></tr>` : '') + '</tfoot></table></div>';

  // ---------- 淨資產走勢 ----------
  const lo = Math.min(...nw), hi = Math.max(...nw), span = hi - lo || 1, NH = 130, px = 14;
  const y = v => 22 + (hi - v) / span * (NH - 50);
  const pts = nw.map((v, i) => [px + i * (W - 2 * px) / (N - 1), y(v)]);
  const line = pts.map(p => p.map(c => c.toFixed(1)).join(',')).join(' ');
  const zero = lo < 0 && hi > 0 ? `<line class="an-zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : '';
  const nwLabels = months.map((m, i) => (N <= 6 || i % 2 === (N - 1) % 2) ? `<text x="${pts[i][0].toFixed(1)}" y="${NH - 4}" text-anchor="middle">${+m.slice(5)}月</text>` : '').join('');
  const sp0 = pts[si], anchor = si === 0 ? 'start' : si === N - 1 ? 'end' : 'middle';
  const nwChange = r2(nw[N - 1] - nw[0]);
  const networth = `<svg class="an-svg" viewBox="0 0 ${W} ${NH}" role="img" aria-label="近 ${N} 個月淨資產走勢">${zero}<polygon class="an-area" points="${pts[0][0].toFixed(1)},${NH - 20} ${line} ${pts[N - 1][0].toFixed(1)},${NH - 20}"/>` +
    `<polyline class="an-line" points="${line}"/>${pts.map((p, i) => `<circle class="an-dot${i === si ? '' : ' is-dim'}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === si ? 4 : 2.5}"/>`).join('')}` +
    `<text class="an-val" x="${sp0[0].toFixed(1)}" y="${(sp0[1] - 9).toFixed(1)}" text-anchor="${anchor}">${cp(nw[si])}</text>${nwLabels}` +
    pts.map((p, i) => `<rect class="an-hit" data-mon="${months[i]}" x="${(p[0] - (W - 2 * px) / (N - 1) / 2).toFixed(1)}" y="0" width="${((W - 2 * px) / (N - 1)).toFixed(1)}" height="${NH}"/>`).join('') + '</svg>' +
    `<p class="an-note">近 ${N} 個月${nwChange >= 0 ? '增加' : '減少'} <b class="an-nb">${money(Math.abs(nwChange))}</b>（${mLabel(months[0])}底 ${money(nw[0])} → 目前 ${money(nw[N - 1])}）。</p>`;

  // ---------- 支出分類（可展開） ----------
  let donut = '<p class="an-empty">這段期間沒有支出。</p>';
  if (exp > 0) {
    const top = cats.slice(0, 6), rest = r2(cats.slice(6).reduce((s, c) => s + c[1], 0)), slices = rest > 0 ? [...top, ['其他', rest]] : top;
    let off = 0;
    const arcs = slices.map(([, v], i) => { const p = v / exp * 100, c = `<circle r="15.9155" cx="21" cy="21" fill="none" style="stroke:${COLORS[i]}" stroke-width="6" stroke-dasharray="${p.toFixed(2)} ${(100 - p).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 21 21)"/>`; off += p; return c; }).join('');
    const catDetail = nm => {
      const tx = RE.filter(t => t.category === nm), tot = r2(tx.reduce((s, t) => s + t.amount, 0));
      const byM = months.map(m => ({ l: mLabel(m), v: r2(tx.filter(t => t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)) }));
      const fullAvg = nF ? r2(byM.slice(0, -1).reduce((s, x) => s + x.v, 0) / nF) : null;
      const notes = {}; tx.forEach(t => { const k = String(t.note || '').trim() || '（沒有備註）'; (notes[k] ||= { v: 0, n: 0 }); notes[k].v += t.amount; notes[k].n++; });
      const topN = Object.entries(notes).sort((a, b) => b[1].v - a[1].v).slice(0, 5);
      const bud = state.budgets?.[nm];
      const curV = byM[N - 1].v;
      return `<div class="an-catdetail"><dl class="an-dl"><div><dt>近 ${N} 個月合計</dt><dd>${money(tot)}</dd></div><div><dt>月平均（完整月）</dt><dd>${fullAvg === null ? '–' : money(fullAvg)}</dd></div>` +
        `<div><dt>筆數</dt><dd>${tx.length} 筆</dd></div><div><dt>平均每筆</dt><dd>${money(r2(tot / (tx.length || 1)))}</dd></div></dl>` +
        (bud ? `<p class="an-note">本月預算 ${money(bud)}，已用 ${money(curV)}（${Math.round(curV / bud * 100)}%）${curV > bud ? `，<span class="is-up">超出 ${money(r2(curV - bud))}</span>` : `，還剩 ${money(r2(bud - curV))}`}。</p>` : '') +
        `<p class="an-sub">每月金額</p>${hbars(byM)}` +
        `<p class="an-sub">花在哪些項目（依備註）</p><ul class="an-list an-cmp">${topN.map(([k, o]) => `<li><span>${esc(k)}</span><span class="an-amt">${o.n} 次</span><span class="an-d">${money(r2(o.v))}</span></li>`).join('')}</ul></div>`;
    };
    donut = `<svg class="an-donut" viewBox="0 0 42 42" role="img" aria-label="支出分類佔比">${arcs}<text class="an-dn" x="21" y="22.2" text-anchor="middle">${cp(exp)}</text><text class="an-dn-sub" x="21" y="26.5" text-anchor="middle">總支出</text></svg>` +
      `<p class="an-note an-center">點分類可以看每月金額和花在哪些項目</p>` +
      `<ul class="an-list an-cats">${cats.map(([nm, v], i) => `<li class="${ui.cat === nm ? 'is-open' : ''}"><button type="button" data-cat="${esc(nm)}" aria-expanded="${ui.cat === nm}"><i data-c="${colorAt(i)}"></i><span>${esc(nm)}</span><b>${Math.round(v / exp * 100)}%</b><span class="an-amt">${money(v)}</span><svg class="an-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>${ui.cat === nm ? catDetail(nm) : ''}</li>`).join('')}</ul>`;
  }

  // ---------- 本月 vs 上月（分類） ----------
  const names = [...new Set([...Object.keys(c1), ...Object.keys(c0)])].sort((a, b) => (c1[b] || 0) - (c1[a] || 0)).slice(0, 8);
  const cmp = names.length ? `<div class="an-cmphead"><span>分類</span><span>${mLabel(cur.m)}</span><span>${mLabel(prev.m)}</span><span>變化</span></div><ul class="an-list an-cmp4">${names.map(nm => {
    const a = c1[nm] || 0, b = c0[nm] || 0, d = b ? Math.round((a - b) / b * 100) : null;
    const [txt, cls] = d === null ? ['新增', 'is-up'] : !a ? ['沒花', 'is-down'] : d === 0 ? ['持平', ''] : [`${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`, d > 0 ? 'is-up' : 'is-down'];
    return `<li><span>${esc(nm)}</span><span class="an-amt">${money(a)}</span><span class="an-amt">${money(b)}</span><span class="an-d ${cls}">${txt}</span></li>`;
  }).join('')}</ul><p class="an-note">兩個月都只算到 ${today} 號，比較才公平。合計：${money(curTo)} vs ${money(prevTo)}。</p>` : '<p class="an-empty">本月與上月都沒有支出。</p>';

  // ---------- 最大幾筆支出 ----------
  const big = [...RE].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const bigCard = big.length ? card('最大的 5 筆支出', `<ul class="an-list an-big">${big.map(t => `<li><span class="an-big-l"><span>${esc(String(t.note || '').trim() || t.category)}</span><small>${+t.date.slice(5, 7)}/${+t.date.slice(8)}・${esc(t.category)}</small></span><span class="an-d">${money(t.amount)}</span></li>`).join('')}</ul>` +
    `<p class="an-note">這 5 筆合計佔近 ${N} 個月支出的 ${Math.round(big.reduce((s, t) => s + t.amount, 0) / exp * 100)}%。</p>`) : '';

  // ---------- 用哪個帳戶付 ----------
  const accN = id => state.accounts.find(a => a.id === id)?.name || '其他';
  const byAcc = {}; RE.forEach(t => { byAcc[t.accountId] = (byAcc[t.accountId] || 0) + t.amount; });
  const accItems = Object.entries(byAcc).sort((a, b) => b[1] - a[1]).map(([id, v]) => ({ l: esc(accN(id)), s: `${Math.round(v / exp * 100)}%`, v }));
  const accCard = accItems.length > 1 ? card('用哪個帳戶付', `<div class="an-rows-wide">${hbars(accItems)}</div>`) : '';

  // ---------- 負債概況 ----------
  let debtCard = '';
  if (debt && (debt.loans.length || debt.installs.length)) {
    const avgInc = nF ? r2(incF / nF) : 0, ratio = avgInc > 0 ? Math.round(debt.monthly / avgInc * 100) : null;
    const lvl = ratio === null ? '' : ratio >= 50 ? 'is-up' : ratio >= 35 ? 'is-warn' : 'is-down';
    const items = [...debt.loans.map(l => `<li><span>${esc(l.name)}</span><span class="an-amt">${money(l.remaining)}</span><span class="an-d">${l.payment ? '月付 ' + money(l.payment) : '已還清'}</span></li>`),
      ...debt.installs.filter(p => p.left > 0).map(p => `<li><span>${esc(p.name)}<small>剩 ${p.left} 期</small></span><span class="an-amt">${money(p.remaining)}</span><span class="an-d">月付 ${money(p.amount)}</span></li>`)].join('');
    const interest = r2(debt.loans.reduce((s, l) => s + l.totalInterest, 0));
    debtCard = card('負債概況', `<div class="an-kpis">${kpi('負債總額', money(debt.remaining))}${kpi('每月固定還款（估）', money(debt.monthly))}` +
      `${kpi('月還款佔月收入', ratio === null ? '–' : ratio + '%', lvl)}${kpi('貸款預估剩餘利息', money(interest))}</div>` +
      (items ? `<ul class="an-list an-cmp">${items}</ul>` : '') + `<p class="an-note">${ratio === null ? '還沒有完整月份的收入記錄，暫時無法計算占比。' : `月收入以前 ${nF} 個完整月的平均計算。一般建議月還款不要超過月收入的 35%。`}</p>`);
  }

  const wdTop = wd.indexOf(Math.max(...wd));
  return head + `<div class="an-kpis">${kpis}</div><p class="an-note an-kpi-note">平均值與儲蓄率以完整月份計算（不含本月）。</p>` +
    (ins.length ? card('重點觀察', `<ul class="an-ins">${ins.map(s => `<li>${s}</li>`).join('')}</ul>`) : '') +
    card('收支趨勢', trend + detail, '<span class="an-legend"><i class="d-inc"></i>收入<i class="d-exp"></i>支出</span>') +
    card('每月一覽', table) +
    card('淨資產走勢', networth) + debtCard +
    card('支出分類佔比', donut) +
    card(`${mLabel(cur.m)} vs ${mLabel(prev.m)}（同期）`, cmp) +
    bigCard + accCard +
    card('消費時段', timed > 0 ? hbars(BUCKETS.map((b, i) => ({ l: b[0], s: tbn[i] ? `${tbn[i]} 筆` : '', v: tb[i] }))) + '<p class="an-note">只計算有記錄時間的支出。</p>' : '<p class="an-empty">還沒有帶時間的支出記錄。</p>') +
    card('每週消費', hbars(wd.map((v, i) => ({ l: '週' + WD[i], s: wdn[i] ? `${wdn[i]} 筆` : '', v }))) + (exp > 0 ? `<p class="an-note">週${WD[wdTop]}花最多，佔 ${Math.round(wd[wdTop] / exp * 100)}%。</p>` : ''));
}
