// analysis.js — 分析報表（零相依，全部用 SVG 繪製）
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round(n * 100) / 100;
const compact = n => {
  const a = Math.abs(n), s = a >= 1e8 ? (a / 1e8).toFixed(1) + '億' : a >= 1e4 ? (a / 1e4).toFixed(1).replace(/\.0$/, '') + '萬' : String(Math.round(a));
  return (n < 0 ? '-' : '') + s;
};
const COLORS = ['#3e6ae1', '#4fd1a1', '#f5a524', '#ff5a5f', '#a78bfa', '#22d3ee', '#8a8d91'];
const BUCKETS = [['清晨', '05–09'], ['上午', '09–12'], ['中午', '12–14'], ['下午', '14–18'], ['晚上', '18–22'], ['深夜', '22–05']];
const bucketOf = h => h < 5 ? 5 : h < 9 ? 0 : h < 12 ? 1 : h < 14 ? 2 : h < 18 ? 3 : h < 22 ? 4 : 5;

export function mountAnalysis(el, getState, money, isHidden = () => false, getDebt = () => null) {
  let n = 6;
  const draw = () => {
    el.innerHTML = build(getState(), n, money, isHidden(), getDebt());
    el.querySelectorAll('[data-pct]').forEach(e => { e.style.width = e.dataset.pct + '%'; });
    el.querySelectorAll('[data-c]').forEach(e => { e.style.background = e.dataset.c; });
  };
  el.addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (b) { n = +b.dataset.range; draw(); } });
  return draw;
}

function build(state, N, money, hid, debt) {
  const cp = v => (hid ? '••' : compact(v));
  const now = new Date();
  const months = Array.from({ length: N }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - (N - 1 - i), 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
  const head = `<h1 class="title">分析</h1><div class="an-seg" role="group" aria-label="期間">${[3, 6, 12].map(k => `<button type="button" data-range="${k}" aria-pressed="${k === N}">${k} 個月</button>`).join('')}</div>`;
  if (!state.transactions.length) return head + '<p class="an-empty">還沒有資料。先記幾筆帳，這裡就會出現趨勢與分析。</p>';

  const sumBy = (tx, ty) => r2(tx.filter(t => t.type === ty).reduce((s, t) => s + t.amount, 0));
  const per = months.map(m => { const tx = state.transactions.filter(t => t.date.startsWith(m)); return { m, inc: sumBy(tx, 'income'), exp: sumBy(tx, 'expense') }; });
  const set = new Set(months), RE = state.transactions.filter(t => t.type === 'expense' && set.has(t.date.slice(0, 7)));
  const exp = r2(per.reduce((s, p) => s + p.exp, 0));
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

  // 時段與星期
  const tb = Array(6).fill(0); let timed = 0;
  RE.forEach(t => { if (/^\d{2}:\d{2}$/.test(t.time || '')) { tb[bucketOf(+t.time.slice(0, 2))] += t.amount; timed += t.amount; } });
  const wd = Array(7).fill(0);
  RE.forEach(t => { wd[(new Date(t.date + 'T00:00').getDay() + 6) % 7] += t.amount; });

  // 重點觀察
  const ins = [];
  // 本月還沒過完，所以和上月「同一天以前」比
  const upto = t => +t.date.slice(8, 10) <= now.getDate(), sp = m => state.transactions.filter(t => t.type === 'expense' && t.date.startsWith(m) && upto(t));
  const curTo = r2(sp(cur.m).reduce((s, t) => s + t.amount, 0)), prevTo = r2(sp(prev.m).reduce((s, t) => s + t.amount, 0));
  if (prevTo > 0) { const d = (curTo - prevTo) / prevTo * 100; ins.push(`本月至今的支出比上月同期${d >= 0 ? '多' : '少'} ${Math.abs(Math.round(d))}%（<b class="an-nb">${d >= 0 ? '+' : '−'}${money(Math.abs(r2(curTo - prevTo)))}</b>）。`); }
  if (cats.length) ins.push(`「${esc(cats[0][0])}」是近 ${N} 個月最大的支出，佔 ${Math.round(cats[0][1] / exp * 100)}%。`);
  if (rate !== null) ins.push(`前 ${nF} 個完整月的平均儲蓄率為 ${rate}%。`);
  if (timed > 0) { const i = tb.indexOf(Math.max(...tb)); ins.push(`消費最集中在${BUCKETS[i][0]}（${BUCKETS[i][1]} 時），佔有記錄時間之支出的 ${Math.round(tb[i] / timed * 100)}%。`); }

  const kpis = [['平均月收入', money(r2(incF / nF))], ['平均月支出', money(r2(expF / nF))], ['儲蓄率', rate === null ? '–' : rate + '%'], ['目前淨資產', money(nw[N - 1])]]
    .map(([k, v]) => `<div class="an-kpi"><small>${k}</small><b>${v}</b></div>`).join('');

  // 收支趨勢（群組長條）
  const W = 320, H = 150, base = H - 20, maxV = Math.max(1, ...per.flatMap(p => [p.inc, p.exp])), gw = W / N, bw = Math.min(14, gw / 2 - 2);
  const hgt = v => Math.max((v / maxV) * (base - 14), v ? 1.5 : 0);
  const bars = per.map((p, i) => {
    const cx = gw * i + gw / 2, mm = +p.m.slice(5);
    return `<rect class="an-inc" x="${(cx - bw - 1).toFixed(1)}" y="${(base - hgt(p.inc)).toFixed(1)}" width="${bw}" height="${hgt(p.inc).toFixed(1)}" rx="2"><title>${mm} 月收入 ${money(p.inc)}</title></rect>` +
      `<rect class="an-exp" x="${(cx + 1).toFixed(1)}" y="${(base - hgt(p.exp)).toFixed(1)}" width="${bw}" height="${hgt(p.exp).toFixed(1)}" rx="2"><title>${mm} 月支出 ${money(p.exp)}</title></rect>` +
      `<text x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${mm}月</text>`;
  }).join('');
  const trend = `<svg class="an-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="近 ${N} 個月收入與支出長條圖">${bars}<line x1="0" x2="${W}" y1="${base}" y2="${base}"/><text x="0" y="9">${cp(maxV)}</text></svg>`;

  // 淨資產走勢
  const lo = Math.min(...nw), hi = Math.max(...nw), span = hi - lo || 1, NH = 120, px = 12;
  const y = v => 14 + (hi - v) / span * (NH - 40);
  const pts = nw.map((v, i) => [px + i * (W - 2 * px) / (N - 1), y(v)]);
  const line = pts.map(p => p.map(c => c.toFixed(1)).join(',')).join(' ');
  const zero = lo < 0 && hi > 0 ? `<line class="an-zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : '';
  const nwLabels = months.map((m, i) => (N <= 6 || i % 2 === 0) ? `<text x="${pts[i][0].toFixed(1)}" y="${NH - 4}" text-anchor="middle">${+m.slice(5)}月</text>` : '').join('');
  const networth = `<svg class="an-svg" viewBox="0 0 ${W} ${NH}" role="img" aria-label="近 ${N} 個月淨資產走勢">${zero}<polygon class="an-area" points="${pts[0][0].toFixed(1)},${NH - 20} ${line} ${pts[N - 1][0].toFixed(1)},${NH - 20}"/>` +
    `<polyline class="an-line" points="${line}"/><circle class="an-dot" cx="${pts[N - 1][0].toFixed(1)}" cy="${pts[N - 1][1].toFixed(1)}" r="3.5"/>` +
    `<text x="0" y="9">${cp(hi)}</text><text x="0" y="${NH - 22}">${cp(lo)}</text>${nwLabels}</svg>`;

  // 分類甜甜圈
  let donut = '<p class="an-empty">這段期間沒有支出。</p>';
  if (exp > 0) {
    const top = cats.slice(0, 6), rest = r2(cats.slice(6).reduce((s, c) => s + c[1], 0)), slices = rest > 0 ? [...top, ['其他', rest]] : top;
    let off = 0;
    const arcs = slices.map(([, v], i) => { const p = v / exp * 100, c = `<circle r="15.9155" cx="21" cy="21" fill="none" stroke="${COLORS[i]}" stroke-width="6" stroke-dasharray="${p.toFixed(2)} ${(100 - p).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 21 21)"/>`; off += p; return c; }).join('');
    donut = `<svg class="an-donut" viewBox="0 0 42 42" role="img" aria-label="支出分類佔比">${arcs}<text class="an-dn" x="21" y="22.2" text-anchor="middle">${cp(exp)}</text><text class="an-dn-sub" x="21" y="26.5" text-anchor="middle">總支出</text></svg>` +
      `<ul class="an-list">${slices.map(([nm, v], i) => `<li><i data-c="${COLORS[i]}"></i><span>${esc(nm)}</span><b>${Math.round(v / exp * 100)}%</b><span class="an-amt">${money(v)}</span></li>`).join('')}</ul>`;
  }

  // 本月 vs 上月（分類）
  const mc = m => Object.fromEntries(catTotals(sp(m)));
  const c1 = mc(cur.m), c0 = mc(prev.m);
  const names = [...new Set([...Object.keys(c1), ...Object.keys(c0)])].sort((a, b) => (c1[b] || 0) - (c1[a] || 0)).slice(0, 6);
  const cmp = names.length ? `<ul class="an-list an-cmp">${names.map(nm => {
    const a = c1[nm] || 0, b = c0[nm] || 0, d = b ? Math.round((a - b) / b * 100) : null;
    const [txt, cls] = d === null ? ['新增', 'is-up'] : d === 0 ? ['持平', ''] : [`${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%`, d > 0 ? 'is-up' : 'is-down'];
    return `<li><span>${esc(nm)}</span><span class="an-amt">${money(a)}</span><span class="an-d ${cls}">${txt}</span></li>`;
  }).join('')}</ul>` : '<p class="an-empty">本月與上月都沒有支出。</p>';

  const hbars = (items) => { const mx = Math.max(...items.map(i => i.v)); return items.map(i => `<div class="an-row${mx > 0 && i.v === mx ? ' is-max' : ''}"><span>${i.l}</span><div class="an-track"><i data-pct="${mx ? (i.v / mx * 100).toFixed(1) : 0}"></i></div><span class="an-amt">${money(r2(i.v))}</span></div>`).join(''); };
  const card = (title, body, extra = '') => `<section class="an-card"><div class="ledger__sec-head"><h3>${title}</h3>${extra}</div>${body}</section>`;

  // 負債概況
  let debtCard = '';
  if (debt && (debt.loans.length || debt.installs.length)) {
    const avgInc = nF ? r2(incF / nF) : 0, ratio = avgInc > 0 ? Math.round(debt.monthly / avgInc * 100) : null;
    const lvl = ratio === null ? '' : ratio >= 50 ? 'is-up' : ratio >= 35 ? 'is-warn' : 'is-down';
    const items = [...debt.loans.map(l => `<li><span>${esc(l.name)}</span><span class="an-amt">${money(l.remaining)}</span><span class="an-d">${l.payment ? '月付 ' + money(l.payment) : '已還清'}</span></li>`),
      ...debt.installs.filter(p => p.left > 0).map(p => `<li><span>${esc(p.name)}</span><span class="an-amt">${money(p.remaining)}</span><span class="an-d">月付 ${money(p.amount)}</span></li>`)].join('');
    const interest = r2(debt.loans.reduce((s, l) => s + l.totalInterest, 0));
    debtCard = card('負債概況', `<div class="an-kpis"><div class="an-kpi"><small>負債總額</small><b>${money(debt.remaining)}</b></div><div class="an-kpi"><small>每月固定還款（估）</small><b>${money(debt.monthly)}</b></div>` +
      `<div class="an-kpi"><small>月還款佔月收入</small><b class="${lvl}">${ratio === null ? '–' : ratio + '%'}</b></div><div class="an-kpi"><small>貸款預估剩餘利息</small><b>${money(interest)}</b></div></div>` +
      (items ? `<ul class="an-list an-cmp">${items}</ul>` : '') + `<p class="an-note">${ratio === null ? '還沒有完整月份的收入記錄，暫時無法計算占比。' : `月收入以前 ${nF} 個完整月的平均計算。一般建議月還款不要超過月收入的 35%。`}</p>`);
  }

  return head + `<div class="an-kpis">${kpis}</div><p class="an-note an-kpi-note">平均值與儲蓄率以完整月份計算（不含本月）。</p>` +
    (ins.length ? card('重點觀察', `<ul class="an-ins">${ins.map(s => `<li>${s}</li>`).join('')}</ul>`) : '') +
    card('收支趨勢', trend, '<span class="an-legend"><i class="d-inc"></i>收入<i class="d-exp"></i>支出</span>') +
    card('淨資產走勢', networth) + debtCard +
    card('支出分類佔比', donut) +
    card(`${+cur.m.slice(5)} 月 vs ${+prev.m.slice(5)} 月（同期）`, cmp) +
    card('消費時段', timed > 0 ? hbars(BUCKETS.map((b, i) => ({ l: b[0], v: tb[i] }))) + '<p class="an-note">只計算有記錄時間的支出。</p>' : '<p class="an-empty">還沒有帶時間的支出記錄。</p>') +
    card('每週消費', hbars(wd.map((v, i) => ({ l: '週' + '一二三四五六日'[i], v }))));
}
