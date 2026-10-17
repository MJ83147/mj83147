    /* Poker HoF front end. Talks to the Worker API under /poker-hof/api.
       The Torn key is held only in this page: it pages the poker log here in
       the browser, and is sent to the server only to prove identity. */
    var API = '/poker-hof/api';
    function el(id) { return document.getElementById(id); }

    var METRICS = [
      { key: 'net', label: 'Net $', short: 'Net $', column: 'Net $' },
      { key: 'sessions', label: 'Sittings', short: 'Sittings', column: 'Sittings' },
      { key: 'avg', label: 'Avg per sitting', short: 'Avg', column: 'Avg $' },
      { key: 'time', label: 'Time at table', short: 'Time', column: 'Time' }
    ];
    var VISIBILITY = [
      { key: 'public', label: 'Public', desc: 'Others see your position, name and value.' },
      { key: 'hide$', label: 'Hide $', desc: 'Others see your position and name, never your money.' },
      { key: 'hidename', label: 'Hide name', desc: 'Others see your position and value, never your name.' },
      { key: 'hidden', label: 'Fully hidden', desc: 'Others see only that a position is taken.' }
    ];
    var VIS_LABEL = { 'public': 'Public', 'hide$': 'Hide $', 'hidename': 'Hide name', 'hidden': 'Fully hidden' };

    // Session state, restored from the last sign-in on this device.
    var state = {
      token: localStorage.getItem('phof_token') || null,
      key: sessionStorage.getItem('phof_key') || null,   // kept only for this tab session
      me: JSON.parse(localStorage.getItem('phof_me') || 'null'),
      hidden: JSON.parse(localStorage.getItem('phof_hidden') || '[]'),
      board: null,
      globalMetric: 'net',
      boardState: {}
    };
    var signupStart = 'all', signupVisibility = 'public';

    /* ---------------- formatting ---------------- */
    function money(n) {
      var sign = n < 0 ? '-' : '', a = Math.abs(n);
      if (a >= 1e9) return sign + '$' + round(a / 1e9) + 'b';
      if (a >= 1e6) return sign + '$' + round(a / 1e6) + 'm';
      if (a >= 1e3) return sign + '$' + round(a / 1e3) + 'k';
      return sign + '$' + a;
    }
    function round(x) { return String(Math.round(x * 100) / 100); }
    function hoursMins(min) {
      var h = Math.floor(min / 60), m = min % 60;
      if (h >= 24) { var d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h'; }
      return h + 'h ' + m + 'm';
    }
    function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }
    function hue(pid) { return (Number(pid) * 47) % 360; }
    function avatarHtml(p, cls) {
      cls = cls || '';
      if (p.name && p.image) return '<span class="avatar ' + cls + (p.you ? ' avatar-me' : '') + '"><img src="' + p.image + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover"></span>';
      if (p.name) return '<span class="avatar ' + cls + (p.you ? ' avatar-me' : '') + '" style="background:hsl(' + hue(p.pid) + ' 55% 55%)">' + initials(p.name) + '</span>';
      return '<span class="avatar ' + cls + ' avatar-ghost">?</span>';
    }
    function metricValue(p, metric) {
      var v = metric === 'net' ? p.net : metric === 'sessions' ? p.sessions : metric === 'avg' ? p.avg : p.minutes;
      if (v === null || v === undefined) return '<span class="muted">—</span>';
      if (metric === 'net' || metric === 'avg') return '<span class="' + (v >= 0 ? 'pos' : 'neg') + '">' + money(v) + '</span>';
      if (metric === 'time') return hoursMins(v);
      return v;
    }

    function summaryStrip(summary) {
      var net = summary.net, sessions = summary.sessions, minutes = summary.minutes;
      return '<div class="summary">' +
        '<div class="summary-main"><span class="summary-amount ' + (net >= 0 ? 'pos' : 'neg') + '">' + money(net) + '</span>' +
        '<span class="summary-label">total net P&amp;L</span></div>' +
        '<div class="summary-meta"><span>' + summary.players + ' players</span>' +
        '<span>' + sessions + ' sittings</span><span>' + Math.round(minutes / 60) + 'h played</span></div>' +
        '</div>';
    }

    /* ---------------- fetch board ---------------- */
    function loadBoard() {
      var headers = {};
      if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
      return fetch(API + '/board', { headers: headers })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          state.board = data;
          data.tables.forEach(function (t) {
            if (!state.boardState[t.table]) state.boardState[t.table] = { metric: 'net', expanded: false };
          });
          renderGlobalTabs(); renderGlobalBoard(); renderBoards();
        })
        .catch(function () {
          el('global-rows').innerHTML = '<tr><td colspan="4" class="muted">Could not load the board.</td></tr>';
        });
    }

    /* ---------------- global board ---------------- */
    function renderGlobalTabs() {
      el('global-tabs').innerHTML = METRICS.map(function (m) {
        return '<span class="metric-tab' + (m.key === state.globalMetric ? ' active' : '') +
          '" onclick="setGlobalMetric(\'' + m.key + '\')">' + m.label + '</span>';
      }).join('');
    }
    function renderGlobalBoard() {
      if (!state.board) return;
      var g = state.board.global, metric = state.globalMetric;
      var mdef = METRICS.find(function (m) { return m.key === metric; });
      var head = '<tr><th class="rank-cell">#</th><th>Player</th><th class="num">' + mdef.column + '</th>';
      if (metric === 'avg') head += '<th class="num sm-hide">Sittings</th>';
      el('global-head').innerHTML = head + '</tr>';
      el('global-summary').innerHTML = summaryStrip(g.summary);

      if (!g.players.length) { el('global-rows').innerHTML = '<tr><td colspan="4" class="muted">No sittings yet. Be the first to sign up.</td></tr>'; return; }

      el('global-rows').innerHTML = g.order[metric].map(function (idx, i) {
        var p = g.players[idx], rank = i + 1;
        var name = p.name
          ? '<span class="player-name">' + p.name + '</span>' + (p.you ? ' <span class="you-tag">You</span>' : '')
          : '<span class="muted">Hidden player</span>';
        var sessionsCell = metric === 'avg'
          ? '<td class="num sm-hide muted">' + (p.sessions === null ? '—' : p.sessions) + '</td>' : '';
        return '<tr class="' + (rank <= 3 ? 'top-rank' : '') + (p.you ? ' is-you' : '') + '">' +
          '<td class="rank-cell">' + rank + '</td>' +
          '<td><span class="player-cell">' + avatarHtml(p, '') + name + '</span></td>' +
          '<td class="num">' + metricValue(p, metric) + '</td>' + sessionsCell + '</tr>';
      }).join('');
    }
    function setGlobalMetric(key) { state.globalMetric = key; renderGlobalTabs(); renderGlobalBoard(); }

    /* ---------------- per-table boards ---------------- */
    function renderBoards() {
      if (!state.board) return;
      el('board-grid').innerHTML = state.board.tables.map(function (t) {
        var table = t.table, b = t.board;
        var st = state.boardState[table] || { metric: 'net', expanded: false };
        var isAvg = st.metric === 'avg';
        var sessionsClass = isAvg ? ' has-sessions' : '';

        var tabs = METRICS.map(function (m) {
          return '<span class="board-tab' + (m.key === st.metric ? ' active' : '') +
            '" onclick="setBoardMetric(\'' + cssq(table) + '\',\'' + m.key + '\')">' + m.short + '</span>';
        }).join('');

        var columnLabel = METRICS.find(function (m) { return m.key === st.metric; }).column;
        var header = '<div class="board-columns' + sessionsClass + '">' +
          '<span class="col-rank">#</span><span>Player</span>' +
          (isAvg ? '<span class="col-sessions">Sittings</span>' : '') +
          '<span class="col-value">' + columnLabel + '</span></div>';

        var ord = b.order[st.metric];
        var rows = ord.map(function (idx, i) {
          var p = b.players[idx], rank = i + 1;
          var name = p.name
            ? '<span class="player-name">' + p.name + (p.you ? ' · you' : '') + '</span>'
            : '<span class="player-name muted">Hidden player</span>';
          var sessionsCell = isAvg
            ? '<span class="row-sessions">' + (p.sessions === null ? '—' : p.sessions) + '</span>' : '';
          var raw = st.metric === 'net' ? p.net : st.metric === 'avg' ? p.avg : null;
          var valueClass = (st.metric === 'net' || st.metric === 'avg') && raw !== null
            ? (raw >= 0 ? ' pos' : ' neg') : '';
          return '<div class="board-row' + sessionsClass + (rank <= 3 ? ' top-rank' : '') +
            (i >= 3 ? ' extra' : '') + (p.you ? ' is-you' : '') + '">' +
            '<span class="row-rank">' + rank + '</span>' +
            '<span class="row-player">' + avatarHtml(p, 'avatar-small') + name + '</span>' +
            sessionsCell +
            '<span class="row-value' + valueClass + '">' + metricValue(p, st.metric) + '</span></div>';
        }).join('');

        var moreBtn = b.players.length > 3
          ? '<button class="show-more" onclick="toggleBoard(\'' + cssq(table) + '\')">' +
          (st.expanded ? 'Show top 3 ▴' : 'Show all ' + b.players.length + ' ▾') + '</button>'
          : '';

        return '<div class="board ' + (st.expanded ? 'expanded' : 'collapsed') + '">' +
          '<div class="board-name">' + table + '</div>' +
          summaryStrip(b.summary) +
          '<div class="board-tabs">' + tabs + '</div>' + header +
          '<div class="board-rows">' + rows + '</div>' + moreBtn + '</div>';
      }).join('') || '<p class="muted">No table boards yet.</p>';
    }
    function cssq(s) { return s.replace(/'/g, "\\'"); }
    function setBoardMetric(table, key) { state.boardState[table].metric = key; renderBoards(); }
    function toggleBoard(table) { state.boardState[table].expanded = !state.boardState[table].expanded; renderBoards(); }

    /* ---------------- visibility previews ---------------- */
    function renderVisOptions(containerId, name, handler, current) {
      el(containerId).innerHTML = VISIBILITY.map(function (v) {
        var on = v.key === current;
        return '<label class="choice' + (on ? ' on' : '') + '" data-vis="' + v.key + '">' +
          '<input type="radio" name="' + name + '" value="' + v.key + '"' + (on ? ' checked' : '') +
          ' onchange="' + handler + '(\'' + v.key + '\')">' +
          '<span><span class="choice-title">' + v.label + '</span>' +
          '<span class="choice-desc">' + v.desc + '</span></span></label>';
      }).join('');
    }
    function highlightChoice(containerId, key) {
      el(containerId).querySelectorAll('.choice').forEach(function (c) { c.classList.toggle('on', c.dataset.vis === key); });
    }
    function renderPreview(targetId, mode) {
      var me = state.me || { name: 'You', pid: 1 };
      var rank = '<span class="row-rank">4</span>';
      var realAvatar = avatarHtml({ name: me.name, image: me.image, pid: me.torn_id || 1, you: true }, 'avatar-small');
      var ghost = '<span class="avatar avatar-small avatar-ghost">?</span>';
      var value = '<span class="row-value pos">$3.35m</span>';
      var hiddenValue = '<span class="row-value muted">—</span>';
      var player;
      if (mode === 'public' || mode === 'hide$') player = realAvatar + '<span class="player-name">' + (me.name || 'You') + '</span>';
      else if (mode === 'hidename') player = ghost + '<span class="player-name muted">Name hidden</span>';
      else player = ghost + '<span class="player-name muted">Position taken</span>';
      var val = (mode === 'public' || mode === 'hidename') ? value : hiddenValue;
      el(targetId).innerHTML = '<div class="board-row">' + rank + '<span class="row-player">' + player + '</span>' + val + '</div>';
    }
    function pickSignupVis(key) { highlightChoice('signup-vis-options', key); renderPreview('signup-vis-preview', key); signupVisibility = key; }
    function pickProfileVis(key) { highlightChoice('profile-vis-options', key); renderPreview('profile-vis-preview', key); }

    /* ---------------- account / navigation ---------------- */
    function renderAccount() {
      if (state.me) {
        var me = state.me;
        el('nav-account').innerHTML =
          '<a class="nav-profile" id="nav-profile" onclick="showView(\'profile\')">' +
          avatarHtml({ name: me.name, image: me.image, pid: me.torn_id, you: true }, 'avatar-small') + me.name + '</a>' +
          '<button class="btn btn-secondary" onclick="resync()">Sync</button>' +
          '<button class="btn btn-secondary" onclick="logout()">Log out</button>';
      } else {
        el('nav-account').innerHTML = '<button class="btn" onclick="showView(\'signup\')">Sign up</button>';
      }
    }
    function logout() {
      state.me = null; state.token = null; state.key = null;
      localStorage.removeItem('phof_me'); localStorage.removeItem('phof_token');
      localStorage.removeItem('phof_hidden'); sessionStorage.removeItem('phof_key');
      renderAccount(); loadBoard(); showView('boards');
    }
    function showView(view) {
      el('view-boards').classList.toggle('hidden', view !== 'boards');
      el('view-signup').classList.toggle('hidden', view !== 'signup');
      el('view-profile').classList.toggle('hidden', view !== 'profile');
      el('nav-boards').classList.toggle('active', view === 'boards');
      var pl = el('nav-profile'); if (pl) pl.classList.toggle('active', view === 'profile');
      if (view === 'profile') fillProfile();
      window.scrollTo(0, 0);
    }
    function saved(btn) {
      var label = btn.textContent;
      btn.textContent = 'Saved ✓'; btn.disabled = true;
      setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 1400);
    }

    /* ---------------- sign-up wizard ---------------- */
    var step = 1;
    function renderSteps() {
      var names = ['Key', 'Start date', 'How you appear', 'First sync'];
      el('steps').innerHTML = names.map(function (name, i) {
        var n = i + 1, cls = n === step ? ' active' : (n < step ? ' done' : '');
        return '<div class="step' + cls + '"><span class="step-num">' + (n < step ? '✓' : n) + '</span>' + name + '</div>';
      }).join('');
    }
    function goStep(n) {
      step = n;
      document.querySelectorAll('.wizard-step').forEach(function (s) { s.classList.toggle('hidden', Number(s.dataset.step) !== n); });
      renderSteps();
    }
    function checkKey() { el('step1-next').disabled = el('key-input').value.trim().length < 10; }
    function pickStart(value) {
      signupStart = value;
      el('start-all').classList.toggle('on', value === 'all');
      el('start-date').classList.toggle('on', value === 'date');
      el('start-date-input').classList.toggle('hidden', value !== 'date');
      el('start-hint').classList.toggle('hidden', value !== 'all');
    }

    /* ---------------- Torn log sync (runs in the browser) ---------------- */
    var TORN = 'https://api.torn.com/v2';
    var JOIN = 8410, LEAVE = 8411;

    // Page one log type back to a cutoff, within the 100-call/min limit.
    function fetchLog(key, logType, fromTs, onBatch) {
      var to = null, all = [];
      function page() {
        var u = TORN + '/user/log?log=' + logType + '&limit=100&sort=desc' + (to ? '&to=' + to : '') + '&key=' + encodeURIComponent(key);
        return fetch(u).then(function (r) { return r.json(); }).then(function (d) {
          if (d.error) throw new Error(d.error.error || 'Torn error');
          var batch = d.log || [];
          batch.forEach(function (e) { if (!fromTs || e.timestamp >= fromTs) all.push(e); });
          if (onBatch) onBatch(all.length);
          var oldest = batch.length ? batch[batch.length - 1].timestamp : null;
          var more = batch.length === 100 && (!fromTs || oldest >= fromTs);
          if (more) { to = oldest - 1; return new Promise(function (res) { setTimeout(function () { res(page()); }, 650); }); }
          return all;
        });
      }
      return page();
    }

    // Pair each leave with the most recent unpaired join on the same table.
    function buildSittings(joins, leaves) {
      var events = joins.map(function (e) { return { t: e.timestamp, type: 'join', id: e.id, table: e.data.table, value: e.data.value }; })
        .concat(leaves.map(function (e) { return { t: e.timestamp, type: 'leave', id: e.id, table: e.data.table, value: e.data.value }; }))
        .sort(function (a, b) { return a.t - b.t; });
      var open = {}, sittings = [];
      events.forEach(function (ev) {
        if (ev.type === 'join') { open[ev.table] = ev; }
        else {
          var j = open[ev.table];
          if (j) {
            sittings.push({ id: j.id, table_id: ev.table, buy_in: j.value, cash_out: ev.value, join_time: j.t, leave_time: ev.t });
            open[ev.table] = null;
          }
        }
      });
      return sittings;
    }

    function startSync() {
      var key = state.key;
      el('syncing').classList.remove('hidden'); el('sync-done').classList.add('hidden');
      var pct = 5; el('progress-bar').style.width = pct + '%'; el('progress-percent').textContent = pct + '%';
      function bump(to, msg) { pct = Math.max(pct, to); el('progress-bar').style.width = pct + '%'; el('progress-percent').textContent = pct + '%'; if (msg) el('sync-message').textContent = msg; }

      var fromTs = signupStart === 'date' ? Math.floor(new Date(el('start-date-input').value).getTime() / 1000) : null;
      el('sync-message').textContent = 'Reading your poker log…';

      Promise.all([
        fetchLog(key, LEAVE, fromTs, function (n) { bump(Math.min(45, 10 + n / 20), 'Paging leaves… ' + n); }),
        fetchLog(key, JOIN, fromTs, function (n) { bump(Math.min(70, 45 + n / 20), 'Paging joins… ' + n); })
      ]).then(function (res) {
        bump(80, 'Pairing joins with leaves…');
        var sittings = buildSittings(res[1], res[0]);
        bump(88, 'Submitting ' + sittings.length + ' sittings…');
        return submit(sittings);
      }).then(function (r) {
        bump(100, 'Done');
        var from = signupStart === 'all' ? 'all-time' : el('start-date-input').value;
        el('done-message').textContent = 'Stored ' + r.stored + ' sittings. Your profile shows "Data from ' + from +
          '". You appear as ' + VIS_LABEL[signupVisibility] + '; change that any time on your profile.';
        el('syncing').classList.add('hidden'); el('sync-done').classList.remove('hidden');
        return saveVisInitial().then(loadBoard);
      }).catch(function (e) {
        el('sync-message').textContent = 'Sync failed: ' + e.message;
      });

      function submit(sittings) {
        return fetch(API + '/sittings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key, sittings: sittings, start_mode: signupStart, start_date: fromTs })
        }).then(function (r) { return r.json(); }).then(function (r) { if (r.error) throw new Error(r.error); return r; });
      }
      function saveVisInitial() {
        return fetch(API + '/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: key, visibility: signupVisibility })
        }).then(function (r) { return r.json(); }).then(function (r) { if (r.player) { state.me = r.player; persistMe(); renderAccount(); } });
      }
    }

    // Step 1 -> authenticate the pasted key, then advance.
    function authAndContinue() {
      var key = el('key-input').value.trim();
      var btn = el('step1-next'); btn.disabled = true; btn.textContent = 'Checking…';
      fetch(API + '/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key })
      }).then(function (r) { return r.json(); }).then(function (r) {
        btn.textContent = 'Continue';
        if (r.error) { el('key-error').textContent = r.error; btn.disabled = false; return; }
        state.me = r.player; state.token = r.token; state.key = key;
        sessionStorage.setItem('phof_key', key); persistMe();
        renderAccount(); goStep(2);
      }).catch(function () { btn.textContent = 'Continue'; btn.disabled = false; el('key-error').textContent = 'Network error, try again.'; });
    }

    function persistMe() {
      localStorage.setItem('phof_me', JSON.stringify(state.me));
      if (state.token) localStorage.setItem('phof_token', state.token);
    }

    // Re-sync from the nav/profile button: needs the key for this tab session.
    function resync() {
      if (!state.key) { alert('Paste your key again to sync (it is not stored between visits).'); showView('signup'); return; }
      signupStart = state.me && state.me.start_mode || 'all';
      showView('signup'); goStep(4); startSync();
    }

    /* ---------------- profile ---------------- */
    function fillProfile() {
      if (!state.me) { showView('boards'); return; }
      var me = state.me;
      el('account-avatar').outerHTML = avatarHtml({ name: me.name, image: me.image, pid: me.torn_id, you: true }, 'avatar-large').replace('class="avatar ', 'id="account-avatar" class="avatar ');
      document.querySelector('.account-name').textContent = me.name;
      var from = me.start_mode === 'date' && me.start_date ? new Date(me.start_date * 1000).toISOString().slice(0, 10) : 'all-time';
      var syncedTxt = me.last_sync ? timeAgo(me.last_sync) : 'never';
      document.querySelector('.account-meta').textContent = 'Data from ' + from + ' · synced ' + syncedTxt;
      el('current-visibility').textContent = VIS_LABEL[me.visibility] || 'Public';
      renderVisOptions('profile-vis-options', 'profile-vis', 'pickProfileVis', me.visibility);
      renderPreview('profile-vis-preview', me.visibility);
      if (me.start_mode === 'date' && me.start_date) el('profile-date').value = new Date(me.start_date * 1000).toISOString().slice(0, 10);
      renderHiddenTables();
    }
    function timeAgo(ts) {
      var s = Math.floor(Date.now() / 1000) - ts;
      if (s < 90) return 'moments ago';
      if (s < 3600) return Math.round(s / 60) + ' minutes ago';
      if (s < 86400) return Math.round(s / 3600) + ' hours ago';
      return Math.round(s / 86400) + ' days ago';
    }
    function renderHiddenTables() {
      var groups = (state.board && state.board.tables.map(function (t) { return t.table; })) || [];
      // show every group that exists plus any already hidden
      var all = {}; groups.forEach(function (g) { all[g] = 1; }); state.hidden.forEach(function (g) { all[g] = 1; });
      var list = Object.keys(all);
      if (!list.length) { el('hidden-tables').innerHTML = '<p class="muted">No tables yet.</p>'; return; }
      el('hidden-tables').innerHTML = list.map(function (t) {
        var on = state.hidden.indexOf(t) >= 0;
        return '<label class="hidden-row"><span>' + t + '</span><input type="checkbox" value="' + t.replace(/"/g, '&quot;') + '"' + (on ? ' checked' : '') + '></label>';
      }).join('');
    }
    function saveVisibility(btn) {
      var chosen = el('profile-vis-options').querySelector('input:checked').value;
      postSettings({ visibility: chosen }, btn, function () { el('current-visibility').textContent = VIS_LABEL[chosen]; });
    }
    function saveStartDate(btn) {
      var v = el('profile-date').value;
      postSettings({ start_mode: 'date', start_date: Math.floor(new Date(v).getTime() / 1000) }, btn);
    }
    function saveHidden(btn) {
      var checked = [].slice.call(el('hidden-tables').querySelectorAll('input:checked')).map(function (c) { return c.value; });
      state.hidden = checked; localStorage.setItem('phof_hidden', JSON.stringify(checked));
      postSettings({ hidden_tables: checked }, btn, loadBoard);
    }
    function postSettings(payload, btn, after) {
      if (!state.key) { alert('Paste your key again to change settings (it is not stored between visits).'); showView('signup'); return; }
      payload.key = state.key;
      if (btn) { btn.disabled = true; }
      fetch(API + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json(); }).then(function (r) {
          if (r.error) { alert(r.error); if (btn) btn.disabled = false; return; }
          if (r.player) { state.me = r.player; persistMe(); }
          if (btn) saved(btn);
          if (after) after();
        }).catch(function () { if (btn) btn.disabled = false; });
    }
    function deleteMyData(btn) {
      if (!state.key) { alert('Paste your key again to delete your data.'); showView('signup'); return; }
      if (!confirm('Delete every sitting and setting for you? This cannot be undone.')) return;
      fetch(API + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: state.key }) })
        .then(function (r) { return r.json(); }).then(function () { logout(); });
    }

    /* ---------------- boot ---------------- */
    renderSteps();
    renderVisOptions('signup-vis-options', 'signup-vis', 'pickSignupVis', 'public');
    renderPreview('signup-vis-preview', 'public');
    renderAccount();
    loadBoard();
