// 完美的一天打卡 — 纯前端，数据只存在本机 localStorage。
// 设计要点（用户定稿）：计时跑满自动打勾，不设手动“完成”按钮；
// 跑满后自动转正计时（继续显示总专注时长，点“结束”才停）；
// 顶部的“今日一句话”按日期存，每天一张白纸；
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
  var activeTimer = null; // { itemId, target, elapsed, overtime, intervalId }
  var editingNoteId = null;
  var selectedDay = null;

  function defaultState() {
    return { items: JSON.parse(JSON.stringify(DEFAULT_ITEMS)), days: {}, encouragement: {} };
  }
  function load() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.items) || !s.days) return defaultState();
      if (!s.encouragement) s.encouragement = {};
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
    if (!rec.sessions) rec.sessions = [];
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
  // 倒计时跑满：自动打勾（规则不变），然后转正计时，显示总专注时长，
  // 点“结束”才停；正计时只在界面显示，不存档。
  // 熄屏修复（2026-10-29 bug）：不再靠 setInterval 每秒 +1 累加——iOS 熄屏/切后台
  // 会冻结 JS 计时，导致 5 分钟永远跑不满。改按开始时刻的墙钟算 elapsed，
  // 熄屏多久都照算；进行中的专注同时存进 localStorage，页面被系统回收重进也能恢复。
  function timerElapsed() {
    if (!activeTimer) return 0;
    return Math.max(0, Math.floor((Date.now() - activeTimer.startedAt) / 1000));
  }
  function persistFocus() {
    if (!state) return;
    if (activeTimer) {
      state.activeFocus = {
        itemId: activeTimer.itemId,
        startedAt: activeTimer.startedAt,
        target: activeTimer.target,
        overtime: activeTimer.overtime,
        sessionIndex: activeTimer.sessionIndex != null ? activeTimer.sessionIndex : null,
        sessionDay: activeTimer.sessionDay || null
      };
    } else {
      delete state.activeFocus;
    }
    save();
  }
  function completeFocus() {
    var itemId = activeTimer.itemId;
    activeTimer.overtime = true;
    setDone(todayKey(), itemId, true); // 计时跑满，自动打勾
    // 跑满即记一次专注；之后正计时结束时再把时长补成总时长。
    // at 用跑满的那一刻（开始时刻 + 目标时长），不是亮屏恢复的那一刻。
    var rec = ensureDay(todayKey());
    if (!rec.sessions) rec.sessions = [];
    rec.sessions.push({ itemId: itemId, seconds: activeTimer.target, at: activeTimer.startedAt + activeTimer.target * 1000 });
    activeTimer.sessionIndex = rec.sessions.length - 1;
    activeTimer.sessionDay = todayKey(); // 结束/撤销时按这天找记录，避免跨午夜写到别人头上
    persistFocus();
    renderAll(); // 切到已打卡行，开始正计时
  }
  function tick() {
    if (!activeTimer) return;
    var elapsed = timerElapsed();
    if (!activeTimer.overtime && elapsed >= activeTimer.target) {
      completeFocus();
      elapsed = timerElapsed();
    }
    var el = document.getElementById('timer-' + activeTimer.itemId);
    if (el) {
      el.textContent = activeTimer.overtime
        ? '已专注 ' + fmtTime(elapsed)
        : fmtTime(Math.max(0, activeTimer.target - elapsed));
    }
  }
  function startFocus(itemId) {
    if (activeTimer) stopTimer(false);
    var item = state.items.filter(function (it) { return it.id === itemId; })[0];
    if (!item) return;
    activeTimer = { itemId: itemId, startedAt: Date.now(), target: item.minutes * 60, overtime: false, sessionIndex: null, intervalId: null };
    persistFocus();
    activeTimer.intervalId = setInterval(tick, 1000);
    renderAll();
  }
  function stopTimer(rerender) {
    if (activeTimer && activeTimer.intervalId) clearInterval(activeTimer.intervalId);
    activeTimer = null;
    if (state) { delete state.activeFocus; save(); }
    if (rerender) renderAll();
  }
  // 正计时结束：把本次总时长写进该条专注记录，然后停表。
  // 按 sessionDay 找记录并核对 itemId，避免跨午夜写到另一条记录头上。
  function endFocus() {
    if (activeTimer && activeTimer.overtime && activeTimer.sessionIndex != null) {
      var rec = state.days[activeTimer.sessionDay || todayKey()];
      if (rec && rec.sessions && rec.sessions[activeTimer.sessionIndex] &&
          rec.sessions[activeTimer.sessionIndex].itemId === activeTimer.itemId) {
        rec.sessions[activeTimer.sessionIndex].seconds = timerElapsed();
        save();
      }
    }
    stopTimer(true);
  }
  // 恢复进行中的专注（重进页面时）：只恢复今天的；隔夜残留直接丢弃，不自动补记。
  function restoreFocus() {
    var f = state.activeFocus;
    if (!f) return;
    var item = state.items.filter(function (it) { return it.id === f.itemId; })[0];
    if (!item || localKey(new Date(f.startedAt)) !== todayKey() || f.startedAt > Date.now()) {
      delete state.activeFocus; save(); return;
    }
    activeTimer = { itemId: f.itemId, startedAt: f.startedAt, target: f.target, overtime: !!f.overtime, sessionIndex: f.sessionIndex != null ? f.sessionIndex : null, sessionDay: f.sessionDay || null, intervalId: null };
    // 熄屏期间已跑满：恢复瞬间即结算，不用再等一轮
    if (!activeTimer.overtime && timerElapsed() >= activeTimer.target) {
      completeFocus();
    }
    if (activeTimer) activeTimer.intervalId = setInterval(tick, 1000);
  }
  // 撤销时若该项正在正计时，丢弃本次未结束的记录（同样按 sessionDay + itemId 核对）
  function discardActiveSession(itemId) {
    if (activeTimer && activeTimer.itemId === itemId && activeTimer.sessionIndex != null) {
      var rec = state.days[activeTimer.sessionDay || todayKey()];
      if (rec && rec.sessions && rec.sessions[activeTimer.sessionIndex] &&
          rec.sessions[activeTimer.sessionIndex].itemId === itemId) {
        rec.sessions.splice(activeTimer.sessionIndex, 1);
        save();
      }
    }
    stopTimer(false);
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
      if (isTiming && !activeTimer.overtime) {
        var timer = document.createElement('span');
        timer.className = 'timer'; timer.id = 'timer-' + item.id;
        timer.textContent = fmtTime(Math.max(0, activeTimer.target - timerElapsed()));
        actions.appendChild(timer);
        var cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = '取消计时';
        cancel.onclick = function () { stopTimer(true); };
        actions.appendChild(cancel);
      } else if (isDone) {
        var mark = document.createElement('span');
        mark.className = 'done-mark';
        mark.textContent = '✓ 已打卡';
        actions.appendChild(mark);
        if (activeTimer && activeTimer.overtime && activeTimer.itemId === item.id) {
          var over = document.createElement('span');
          over.className = 'timer'; over.id = 'timer-' + item.id;
          over.textContent = '已专注 ' + fmtTime(timerElapsed());
          actions.appendChild(over);
          var end = document.createElement('button');
          end.type = 'button'; end.textContent = '结束';
          end.onclick = function () { endFocus(); };
          actions.appendChild(end);
        } else {
          var again = document.createElement('button');
          again.type = 'button'; again.className = 'secondary'; again.textContent = '再专注一次';
          again.disabled = !!activeTimer;
          again.onclick = function () { startFocus(item.id); };
          actions.appendChild(again);
        }
        var undo = document.createElement('button');
        undo.type = 'button'; undo.className = 'ghost'; undo.textContent = '撤销';
        undo.onclick = function () {
          if (activeTimer && activeTimer.itemId === item.id) discardActiveSession(item.id);
          setDone(today, item.id, false); renderAll();
        };
        actions.appendChild(undo);
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

      // 今日专注统计：跑满的次数 + 合计分钟（只算跑满的，取消的不算）
      var todaySessions = (rec && rec.sessions ? rec.sessions : []).filter(function (s) { return s.itemId === item.id; });
      if (todaySessions.length) {
        var totalSec = todaySessions.reduce(function (a, s) { return a + (s.seconds || 0); }, 0);
        var sum = document.createElement('div');
        sum.className = 'focus-sum';
        sum.textContent = '今日专注 ' + todaySessions.length + ' 次 · 合计 ' + Math.round(totalSec / 60) + ' 分钟';
        li.appendChild(sum);
      }

      if (editingNoteId === item.id) {
        var area = document.createElement('div');
        area.className = 'note-area';
        var ta = document.createElement('textarea');
        ta.rows = 2; ta.placeholder = '写一笔，比如副业想到的点子……';
        ta.value = note;
        // 同款熄屏丢数据问题：每敲一个字就存；change 只负责收起编辑框。
        ta.oninput = function () {
          var r = ensureDay(today);
          if (ta.value.trim()) r.notes[item.id] = ta.value;
          else delete r.notes[item.id];
          save();
        };
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
      hint.textContent = cur ? ((activeTimer.overtime ? '已达标，继续专注：' : '正在专注：') + cur.name) : '';
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
      // 同款熄屏丢数据问题：改名只靠 change 保存，改一半熄屏就丢。
      // oninput 只存不重绘（重绘会把正在打字的输入框换掉、丢焦点）。
      nameInput.oninput = function () {
        var v = nameInput.value.trim();
        if (v) { item.name = v; save(); }
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
      minInput.oninput = function () {
        var v = parseInt(minInput.value, 10);
        if (isNaN(v)) return;
        if (v < 1) v = 1;
        if (v > 120) v = 120;
        item.minutes = v; save();
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
        // 仅清理今天的记录，历史原样保留；同时同步今天的总项目数，
        // 否则明天这天会因 total 滞后（旧 5 项 vs 新 4 项）丢掉完美、断掉连续。
        var t = state.days[todayKey()];
        if (t) {
          var i = t.done.indexOf(item.id);
          if (i !== -1) t.done.splice(i, 1);
          if (t.notes) delete t.notes[item.id];
          t.total = state.items.length;
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

  // ---------- 今日一句话（按日期存，每天一张白纸） ----------
  function renderEncourage() {
    var input = el('encourageInput');
    if (!input) return;
    if (!state.encouragement) state.encouragement = {};
    input.value = state.encouragement[todayKey()] || '';
  }

  // ---------- 专注数据导出（复制成文字，发给小X分析） ----------
  function fmtClock(ts) {
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function buildFocusExport() {
    var lines = ['完美的一天 · 专注记录（发给小X分析）'];
    var keys = Object.keys(state.days).sort();
    var any = false;
    keys.forEach(function (key) {
      var rec = state.days[key];
      if (!rec || !rec.sessions || !rec.sessions.length) return;
      var byItem = {};
      rec.sessions.forEach(function (s) {
        if (!state.items.some(function (it) { return it.id === s.itemId; })) return;
        if (!byItem[s.itemId]) byItem[s.itemId] = [];
        byItem[s.itemId].push(s);
      });
      var itemLines = [];
      state.items.forEach(function (item) {
        var ss = byItem[item.id];
        if (!ss || !ss.length) return;
        var total = ss.reduce(function (a, s) { return a + (s.seconds || 0); }, 0);
        var detail = ss.map(function (s) { return fmtClock(s.at) + ' ' + Math.round((s.seconds || 0) / 60) + '分钟'; }).join('；');
        itemLines.push('  ' + item.name + '：' + ss.length + '次，合计' + Math.round(total / 60) + '分钟（' + detail + '）');
      });
      if (!itemLines.length) return;
      any = true;
      lines.push(key + '：');
      lines = lines.concat(itemLines);
    });
    if (!any) return '';
    return lines.join('\n');
  }
  function copyFocusData() {
    var text = buildFocusExport();
    var hint = el('copyFocusHint');
    function show(msg) {
      if (!hint) return;
      hint.textContent = msg;
      hint.hidden = false;
      setTimeout(function () { hint.hidden = true; }, 2500);
    }
    if (!text) { show('还没有专注记录，先专注一次吧'); return; }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      show('✓ 已复制，发给小X就能分析');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        show('✓ 已复制，发给小X就能分析');
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  // ---------- 全部数据备份：导出 JSON 文件 / 从文件导入 ----------
  // 导出的是全部数据（打卡、专注记录、鼓励句、项目设置）；换手机时导入就回来了。
  // 备份文件由用户自己保管（文件 App / 微信），不经过任何服务器。
  function buildBackupJSON() {
    return JSON.stringify({ app: 'perfect-day', version: 1, exportedAt: new Date().toISOString(), state: state }, null, 2);
  }
  function backupHint(msg) {
    var hint = el('backupHint');
    if (!hint) return;
    hint.textContent = msg;
    hint.hidden = false;
    setTimeout(function () { hint.hidden = true; }, 3000);
  }
  function downloadBackup() {
    try {
      var blob = new Blob([buildBackupJSON()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'perfect-day-backup-' + todayKey() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      backupHint('✓ 备份已生成，存到文件 App 或微信里');
    } catch (e) {
      backupHint('导出失败，换个浏览器再试一次');
    }
  }
  function importBackupFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var json = JSON.parse(reader.result);
        var s = (json && json.state) ? json.state : json;
        if (!s || !Array.isArray(s.items) || !s.days) { backupHint('这个文件不是有效的备份'); return; }
        if (!window.confirm('导入会覆盖当前这台手机上的全部数据，确定继续吗？')) return;
        if (activeTimer) stopTimer(false);
        state = s;
        if (!state.encouragement) state.encouragement = {};
        delete state.activeFocus; // 不把别人手机上的进行中专注带到这台手机
        save();
        renderEncourage();
        renderAll();
        backupHint('✓ 已导入，数据回来了');
      } catch (e) {
        backupHint('这个文件不是有效的备份');
      }
    };
    reader.onerror = function () { backupHint('读取文件失败，再试一次'); };
    reader.readAsText(file);
  }

  function renderAll() {
    renderHero();
    renderToday();
    renderHistory();
    renderManage();
  }

  function init() {
    state = load();
    restoreFocus(); // 熄屏/被系统回收后重进，正在进行的专注按墙钟恢复
    if (typeof document !== 'undefined' && document.addEventListener) {
      // 亮屏/切回前台瞬间立即按墙钟结算一次，不等下一秒的 interval
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) tick();
      });
    }
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
      try { window.localStorage.removeItem('perfect-day-draft'); } catch (e) {}
      save(); renderAll();
    };
    // 新增输入框的草稿也即时存：填一半熄屏/重进，草稿还在。
    (function () {
      var dn = el('newName'), dm = el('newMinutes');
      if (!dn || !dm) return;
      try {
        var draft = JSON.parse(window.localStorage.getItem('perfect-day-draft') || 'null');
        if (draft) {
          if (draft.name) dn.value = draft.name;
          if (draft.minutes) dm.value = draft.minutes;
        }
      } catch (e) {}
      var saveDraft = function () {
        try { window.localStorage.setItem('perfect-day-draft', JSON.stringify({ name: dn.value, minutes: dm.value })); } catch (e) {}
      };
      dn.oninput = saveDraft;
      dm.oninput = saveDraft;
    })();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
    renderEncourage();
    var encInput = el('encourageInput');
    var encSaved = el('encourageSaved');
    var encTimer = null;
    if (encInput) {
      // 熄屏同款问题：只靠 change（失焦/回车）保存，输入一半就熄屏会丢。
      // 改成每敲一个字就存，change 只作兜底。
      var saveEnc = function () {
        if (!state.encouragement) state.encouragement = {};
        var v = encInput.value.trim();
        if (v) state.encouragement[todayKey()] = v;
        else delete state.encouragement[todayKey()];
        save();
      };
      encInput.oninput = function () {
        saveEnc();
        if (encSaved) {
          encSaved.hidden = false;
          if (encTimer) clearTimeout(encTimer);
          encTimer = setTimeout(function () { encSaved.hidden = true; }, 1500);
        }
      };
      encInput.onchange = saveEnc;
    }
    var copyBtn = el('copyFocusBtn');
    if (copyBtn) copyBtn.onclick = copyFocusData;
    var exportBtn = el('exportBackupBtn');
    if (exportBtn) exportBtn.onclick = downloadBackup;
    var importBtn = el('importBackupBtn');
    var importFile = el('importBackupFile');
    if (importBtn && importFile) {
      importBtn.onclick = function () { importFile.click(); };
      importFile.onchange = function () {
        if (importFile.files && importFile.files[0]) importBackupFile(importFile.files[0]);
        importFile.value = '';
      };
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
