// ---------- 自訂日期選擇器（月曆底部面板） ----------
// 點任何 <input type="date"> 所在的欄位，就從下方滑出月曆，取代 iOS 的滾輪。
// 選好後寫回原本的 input 並觸發 input / change 事件，所以其他程式完全不用改。
const WEEK = '日一二三四五六';
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T00:00:00') : null);

let sheet, grid, title, clearBtn, target = null, view = null, sel = '';

function build() {
  sheet = document.createElement('div');
  sheet.className = 'dp';
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="dp__backdrop" data-dp="close"></div>
    <div class="dp__panel" role="dialog" aria-modal="true" aria-label="選擇日期">
      <div class="dp__grab" data-dp="close"></div>
      <header class="dp__head">
        <button type="button" class="dp__round" data-dp="prev" aria-label="上個月">‹</button>
        <button type="button" class="dp__title" data-dp="today" aria-label="回到今天"></button>
        <button type="button" class="dp__round" data-dp="next" aria-label="下個月">›</button>
      </header>
      <div class="dp__week">${[...WEEK].map((w, i) => `<span class="${i === 0 ? 'is-sun' : i === 6 ? 'is-sat' : ''}">週${w}</span>`).join('')}</div>
      <div class="dp__grid" role="grid"></div>
      <footer class="dp__foot">
        <button type="button" class="dp__btn" data-dp="clear">清除</button>
        <button type="button" class="dp__btn" data-dp="pick-today">今天</button>
      </footer>
    </div>`;
  document.body.append(sheet);
  grid = sheet.querySelector('.dp__grid');
  title = sheet.querySelector('.dp__title');
  clearBtn = sheet.querySelector('[data-dp="clear"]');

  sheet.addEventListener('click', e => {
    const day = e.target.closest('[data-day]');
    if (day) return choose(day.dataset.day);
    const act = e.target.closest('[data-dp]')?.dataset.dp;
    if (act === 'close') close();
    else if (act === 'prev') shift(-1);
    else if (act === 'next') shift(1);
    else if (act === 'today') { const t = new Date(); view = new Date(t.getFullYear(), t.getMonth(), 1); render(); }
    else if (act === 'pick-today') choose(iso(new Date()));
    else if (act === 'clear') choose('');
  });

  // 左右滑動換月，往下滑關閉
  let sx = 0, sy = 0;
  const panel = sheet.querySelector('.dp__panel');
  panel.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  panel.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1);
    else if (dy > 80 && dy > Math.abs(dx) * 1.5) close();
  }, { passive: true });

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) close(); });
}

function shift(n) {
  view = new Date(view.getFullYear(), view.getMonth() + n, 1);
  render(n);
}

function render(dir = 0) {
  // 標題：選到的日期在這個月就顯示完整日期，否則顯示正在看的年月
  const s = parse(sel), ym = `${view.getFullYear()}/${pad(view.getMonth() + 1)}`;
  title.textContent = s && iso(s).startsWith(iso(view).slice(0, 7)) ? `${ym}/${pad(s.getDate())}` : ym;

  const todayIso = iso(new Date());
  const start = new Date(view.getFullYear(), view.getMonth(), 1 - view.getDay());
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), k = iso(d), w = d.getDay();
    const cls = ['dp__day'];
    if (d.getMonth() !== view.getMonth()) cls.push('is-out');
    if (w === 0) cls.push('is-sun'); else if (w === 6) cls.push('is-sat');
    if (k === todayIso) cls.push('is-today');
    if (k === sel) cls.push('is-sel');
    const label = d.getDate() === 1 ? `<small>${d.getMonth() + 1}月</small>` : pad(d.getDate());
    html += `<button type="button" role="gridcell" class="${cls.join(' ')}" data-day="${k}" aria-label="${d.getMonth() + 1}月${d.getDate()}日 週${WEEK[w]}"${k === sel ? ' aria-selected="true"' : ''}><span>${label}</span></button>`;
  }
  grid.innerHTML = html;
  if (dir) { grid.classList.remove('is-l', 'is-r'); void grid.offsetWidth; grid.classList.add(dir > 0 ? 'is-l' : 'is-r'); }
}

function open(input) {
  if (!sheet) build();
  target = input;
  sel = input.value;
  const d = parse(sel) || new Date();
  view = new Date(d.getFullYear(), d.getMonth(), 1);
  // 主表單的日期一定要有值，就不顯示「清除」
  clearBtn.hidden = input.required || input.name === 'date' || input.name === 'pdate';
  render();
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('is-on'));
  document.documentElement.classList.add('dp-lock');
}

function close() {
  if (!sheet || sheet.hidden) return;
  sheet.classList.remove('is-on');
  document.documentElement.classList.remove('dp-lock');
  setTimeout(() => { sheet.hidden = true; }, 220);
  target = null;
}

function choose(value) {
  const input = target;
  sel = value;
  if (input) {
    render();
    if (input.value !== value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  setTimeout(close, 120);
}

export function initDatePicker() {
  // 攔截點擊：點到日期欄位（或包著它的 label）就打開月曆，不讓 iOS 原生滾輪跳出來
  document.addEventListener('click', e => {
    const input = e.target.closest('input[type=date]') || e.target.closest('label')?.querySelector('input[type=date]');
    if (!input || input.disabled || input.readOnly) return;
    e.preventDefault();
    input.blur();
    open(input);
  }, true);
}
