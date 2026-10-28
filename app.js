// 完美的一天打卡 — 纯前端，数据只存在本机 localStorage。
// 设计要点（用户定稿）：计时跑满自动打勾，不设手动“完成”按钮；
// 断链不惩罚，只显示一句中性提示；每天的完成度用进度条直观展示。
(function () {
  'use strict';

  var STORAGE_KEY = 'perfect-day-v1';
  var DEFAULT_ITEMS = [
    { id: 'dev', name: '开发', minutes: 5 },
    { id: 'maintain', name: '维护', minutes: 5 },
    { id: 'english', name: '英语', minutes: 5 },
    { id: 'exercise', name: '锻炼', minutes: 5 },
    { id: 'side', name: '副业', minutes: 5 }
  ];

  // ---------- 日期工具（本地时区，不用 toISOString，避免 UTC 偏移） ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function keyToDate(key) {
    var p = key.split('-');
    return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  }
  function addDays(key, n) {
    var d = keyToDate(key);
    d.setDate(d.getDate() + n);
    return localKey(d);
  }
  function todayKey() { return localKey(new Date()); }

  // ---------- 核心统计（纯函数，可单测） ----------
  // 某天是否完美：今日按当前项目数算，过去按当天记录的总项目数算（项目增删不翻旧账）。
  function dayTotal(days, items, key, today) {
    var rec = days[key];
    if (key === today) return items.length;
    if (rec && rec.total) return rec.total;
    return items.length;
  }
  function dayIsPerfect(days, items, key, today) {
    var rec = days[key];
    if (!rec || !rec.done) return false;
    var total = dayTotal(days, items, key, today);
    if (total <= 0) return false;
    var done = rec.done.filter(function (id) {
      return items.some(function (it) { return it.id === id; });
    });
    // 过去的日子按当时记录为准（已删项目仍算数，历史不翻账）
    if (key !== today) done = rec.done;
    return done.length >= total;
  }
  function computeStats(days, items, today) {
    var total = 0, month = 0, longest = 0, run = 0, streak = 0;
    var monthPrefix = today.slice(0, 7);
    var keys = Object.keys(days).sort();
    // 最长连续：按日历逐日走，避免只看有记录的日子造成“假连续”
    var start = keys.length ? keys[0] : today;
    if (start > today) start = today;
    var cursor = start;
    var prevPerfect = false;
    while (cursor <= today) {
      var p = dayIsPerfect(days, items, cursor, today);
      if (p) {
        total++;
        if (cursor.slice(0, 7) === monthPrefix) month++;
        run = prevPerfect ? run + 1 : 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
      prevPerfect = p;
      cursor = addDays(cursor, 1);
    }
    // 当前连续：今天没满则从昨天算起
    var c = dayIsPerfect(days, items, today, today) ? today : addDays(today, -1);
    while (dayIsPerfect(days, items, c, today)) {
      streak++;
      c = addDays(c, -1);
    }
    return { streak: streak, total: total, longest: longest, month: month };
  }

  // ---------- 状态 ----------
  var state = null;
  var activeTimer = null; // { itemId, remaining, intervalId }
  var editingNoteId = null;
  var selectedDay = null;

  function defaultState() {
    return { items: JSON.parse(JSON.stringify(DEFAULT_ITEMS)), days: {} };
  }
  function load() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.items) || !s.days) return defaultState();
      return s;
    } catch (e) { return defaultState(); }
  }
  function save() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function ensureDay(key) {
    if (!state.days[key]) {
      state.days[key] = { done: [], notes: {}, total: state.items.length };
    }
    var rec = state.days[key];
    if (!Array.isArray(rec.done)) rec.done = [];
    if (!rec.notes) rec.notes = {};
    return rec;
  }
  function todayDoneIds() {
    var rec = state.days[todayKey()];
    if (!rec) return [];
    return rec.done.filter(function (id) {
      return state.items.some(function (it) { return it.id === id; });
    });
  }
  function setDone(key, itemId, done) {
    var rec = ensureDay(key);
    var i = rec.done.indexOf(itemId);
    if (done && i === -1) rec.done.push(itemId);
    if (!done && i !== -1) rec.done.splice(i, 1);
    save();
  }

  // ---------- 计时 ----------
  function startFocus(itemId) {
    if (activeTimer) stopTimer(false);
    var item = state.items.filter(function (it) { return it.id === itemId; })[0];
    if (!item) return;
    activeTimer = { itemId: itemId, remaining: item.minutes * 60, intervalId: null };
    activeTimer.intervalId = setInterval(function () {
      activeTimer.remaining--;
      var el = document.getElementById('timer-' + itemId);
      if (el) el.textContent = fmtTime(activeTimer.remaining);
      if (activeTimer.remaining <= 0) {
        stopTimer(false);
        setDone(todayKey(), itemId, true); // 计时跑满，自动打勾
        activeTimer = null;
        renderAll();
      }
    }, 1000);
    renderAll();
  }
  function stopTimer(rerender) {
    if (activeTimer && activeTimer.intervalId) clearInterval(activeTimer.intervalId);
    activeTimer = null;
    if (rerender) renderAll();
  }
  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = sec % 60;
    return pad(m) + ':' + pad(s);
  }

  // ---------- 渲染 ----------
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderHero() {
    var st = computeStats(state.days, state.items, todayKey());
    el('streakNum').textContent = st.streak;
    el('statTotal').textContent = st.total;
    el('statLongest').textContent = st.longest;
    el('statMonth').textContent = st.month;
    var todayPerfect = dayIsPerfect(state.days, state.items, todayKey(), todayKey());
    el('freshStartLine').hidden = !(st.streak === 0 && !todayPerfect);
    return st;
  }

  function renderToday() {
    var today = todayKey();
    var done = todayDoneIds();
    var total = state.items.length;
    var pct = total ? Math.round(done.length / total * 100) : 0;
    var complete = total > 0 && done.length >= total;
    el('doneCount').textContent = done.length;
    el('todayTotal').textContent = total;
    el('todayPct').textContent = pct + '%';
    var fill = el('progressFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('complete', complete);
    var bar = fill.parentElement;
    bar.setAttribute('aria-valuenow', pct);
    el('perfectBanner').hidden = !complete;

    var list = el('itemList');
    list.innerHTML = '';
    state.items.forEach(function (item) {
      var isDone = done.indexOf(item.id) !== -1;
      var isTiming = activeTimer && activeTimer.itemId === item.id;
      var li = document.createElement('li');
      li.className = 'item';
      var rec = state.days[today];
      var note = rec && rec.notes ? (rec.notes[item.id] || '') : '';

      var top = document.createElement('div');
      top.className = 'item-top';
      var name = document.createElement('span');
      name.className = 'item-name' + (isDone ? ' done' : '');
      name.textContent = item.name;
      var target = document.createElement('span');
      target.className = 'item-target';
      target.textContent = '目标 ' + item.minutes + ' 分钟';
      top.appendChild(name);
      top.appendChild(target);
      li.appendChild(top);

      var actions = document.createElement('div');
      actions.className = 'item-actions';
      if (isDone) {
        var mark = document.createElement('span');
        mark.className = 'done-mark';
        mark.textContent = '✓ 已打卡';
        actions.appendChild(mark);
        var undo = document.createElement('button');
        undo.type = 'button'; undo.className = 'ghost'; undo.textContent = '撤销';
        undo.onclick = function () { setDone(today, item.id, false); renderAll(); };
        actions.appendChild(undo);
      } else if (isTiming) {
        var timer = document.createElement('span');
        timer.className = 'timer'; timer.id = 'timer-' + item.id;
        timer.textContent = fmtTime(activeTimer.remaining);
        actions.appendChild(timer);
        var cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消计时';
        cancel.onclick = function () { stopTimer(true); };
        actions.appendChild(cancel);
      } else {
        var start = document.createElement('button');
        start.type = 'button'; start.textContent = '开始专注';
        start.disabled = !!activeTimer;
        start.onclick = function () { startFocus(item.id); };
        actions.appendChild(start);
        var direct = document.createElement('button');
        direct.type = 'button'; direct.className = 'secondary'; direct.textContent = '直接打卡';
        direct.onclick = function () { setDone(today, item.id, true); renderAll(); };
        actions.appendChild(direct);
      }
      var noteBtn = document.createElement('button');
      noteBtn.type = 'button'; noteBtn.className = 'ghost';
      noteBtn.textContent = note ? '改一笔' : '记一笔';
      noteBtn.onclick = function () {
        editingNoteId = (editingNoteId === item.id) ? null : item.id;
        renderToday();
      };
      actions.appendChild(noteBtn);
      li.appendChild(actions);

      if (editingNoteId === item.id) {
        var area = document.createElement('div');
        area.className = 'note-area';
        var ta = document.createElement('textarea');
        ta.rows = 2; ta.placeholder = '写一笔，比如副业想到的点子……';
        ta.value = note;
        ta.onchange = function () {
          var r = ensureDay(today);
          if (ta.value.trim()) r.notes[item.id] = ta.value;
          else delete r.notes[item.id];
          save();
          editingNoteId = null;
          renderToday();
        };
        area.appendChild(ta);
        li.appendChild(area);
      } else if (note) {
        var nt = document.createElement('div');
        nt.className = 'note-area';
        var p = document.createElement('div');
        p.className = 'note-text';
        p.textContent = note;
        nt.appendChild(p);
        li.appendChild(nt);
      }
      list.appendChild(li);
    });

    var hint = el('focusHint');
    if (activeTimer) {
      var cur = state.items.filter(function (it) { return it.id === activeTimer.itemId; })[0];
      hint.textContent = cur ? ('正在专注：' + cur.name) : '';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  function renderHistory() {
    var today = todayKey();
    var grid = el('historyGrid');
    grid.innerHTML = '';
    for (var i = 83; i >= 0; i--) {
      (function (key) {
        var rec = state.days[key];
        var doneCount = rec ? rec.done.length : 0;
        var perfect = dayIsPerfect(state.days, state.items, key, today);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day-cell' + (perfect ? ' perfect' : (doneCount > 0 ? ' partial' : '')) + (selectedDay === key ? ' selected' : '');
        btn.textContent = parseInt(key.slice(8, 10), 10);
        btn.setAttribute('aria-label', key + (perfect ? '，完美的一天' : (doneCount > 0 ? '，完成 ' + doneCount + ' 项' : '，未打卡')));
        btn.onclick = function () {
          selectedDay = (selectedDay === key) ? null : key;
          renderHistory();
        };
        grid.appendChild(btn);
      })(addDays(today, -i));
    }
    renderDayDetail();
  }

  function renderDayDetail() {
    var box = el('dayDetail');
    if (!selectedDay) { box.hidden = true; box.innerHTML = ''; return; }
    var today = todayKey();
    var key = selectedDay;
    var rec = state.days[key] || { done: [], notes: {} };
    var perfect = dayIsPerfect(state.days, state.items, key, today);
    var d = keyToDate(key);
    var label = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) +
      (key === today ? '（今天）' : '') + (perfect ? ' · 完美的一天' : '');
    box.hidden = false;
    box.innerHTML = '';
    var h = document.createElement('h3');
    h.textContent = label;
    box.appendChild(h);
    state.items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'day-detail-row';
      var nm = document.createElement('span');
      nm.textContent = item.name + (rec.done.indexOf(item.id) !== -1 ? ' ✓' : '');
      row.appendChild(nm);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = rec.done.indexOf(item.id) !== -1 ? 'ghost' : 'secondary';
      b.textContent = rec.done.indexOf(item.id) !== -1 ? '撤销' : '补打卡';
      b.onclick = function () {
        setDone(key, item.id, rec.done.indexOf(item.id) === -1);
        renderAll();
      };
      row.appendChild(b);
      box.appendChild(row);
    });
    var close = document.createElement('button');
    close.type = 'button'; close.className = 'ghost'; close.textContent = '收起';
    close.onclick = function () { selectedDay = null; renderHistory(); };
    box.appendChild(close);
  }

  function renderManage() {
    var list = el('manageList');
    list.innerHTML = '';
    state.items.forEach(function (item, idx) {
      var li = document.createElement('li');
      li.className = 'manage-row';
      var nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.value = item.name; nameInput.maxLength = 12;
      nameInput.setAttribute('aria-label', '项目名字');
      nameInput.onchange = function () {
        var v = nameInput.value.trim();
        if (v) { item.name = v; save(); renderAll(); } else { nameInput.value = item.name; }
      };
      var minInput = document.createElement('input');
      minInput.type = 'number'; minInput.min = 1; minInput.max = 120; minInput.value = item.minutes;
      minInput.setAttribute('aria-label', '目标分钟数');
      minInput.onchange = function () {
        var v = parseInt(minInput.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        if (v > 120) v = 120;
        item.minutes = v; minInput.value = v;
        save(); renderAll();
      };
      var up = document.createElement('button');
      up.type = 'button'; up.className = 'secondary'; up.textContent = '↑';
      up.disabled = idx === 0;
      up.onclick = function () {
        var tmp = state.items[idx - 1];
        state.items[idx - 1] = state.items[idx];
        state.items[idx] = tmp;
        save(); renderAll();
      };
      var down = document.createElement('button');
      down.type = 'button'; down.className = 'secondary'; down.textContent = '↓';
      down.disabled = idx === state.items.length - 1;
      down.onclick = function () {
        var tmp = state.items[idx + 1];
        state.items[idx + 1] = state.items[idx];
        state.items[idx] = tmp;
        save(); renderAll();
      };
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'danger'; del.textContent = '删除';
      del.onclick = function () {
        if (!window.confirm('确定删除“' + item.name + '”吗？今天的打卡记录会同步去掉它，过去的日子不受影响。')) return;
        state.items.splice(idx, 1);
        // 仅清理今天的记录，历史原样保留
        var t = state.days[todayKey()];
        if (t) {
          var i = t.done.indexOf(item.id);
          if (i !== -1) t.done.splice(i, 1);
          if (t.notes) delete t.notes[item.id];
        }
        if (activeTimer && activeTimer.itemId === item.id) stopTimer(false);
        save(); renderAll();
      };
      li.appendChild(nameInput);
      li.appendChild(minInput);
      var ml = document.createElement('span');
      ml.className = 'min-label'; ml.textContent = '分钟';
      li.appendChild(ml);
      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function renderAll() {
    renderHero();
    renderToday();
    renderHistory();
    renderManage();
  }

  function init() {
    state = load();
    var label = el('todayLabel');
    label.textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
    el('addBtn').onclick = function () {
      var name = el('newName').value.trim();
      var mins = parseInt(el('newMinutes').value, 10);
      if (!name) { el('newName').focus(); return; }
      if (isNaN(mins) || mins < 1) mins = 1;
      if (mins > 120) mins = 120;
      state.items.push({ id: 'it' + Date.now(), name: name, minutes: mins });
      el('newName').value = '';
      el('newMinutes').value = '5';
      save(); renderAll();
    };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
    renderAll();
  }

  // 浏览器内启动；Node 单测时只导出纯函数，不触 DOM。
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { localKey: localKey, addDays: addDays, dayTotal: dayTotal, dayIsPerfect: dayIsPerfect, computeStats: computeStats };
  }
})();
