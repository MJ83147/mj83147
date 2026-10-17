// Cloudflare Pages Function: the poker-hof data API.
// Serves /poker-hof/api/* for the static page at /poker-hof.
// The static page and app.js are served by Pages' CDN, not by this code.

const TORN = 'https://api.torn.com/v2';

/* ---- table id -> name, from Torn API v2 /torn/pokertables (Jul 2026). ---- */
const ID_TO_NAME = {
  2: 'Newbie Corner', 47: 'Newbie Corner II', 48: 'Newbie Corner III', 49: 'Newbie Corner IV',
  3: 'Hobo Holdem', 50: 'Hobo Holdem II', 51: 'Hobo Holdem III', 52: 'Hobo Holdem IV',
  26: 'Broke Jokes', 119: 'Broke Jokes II', 120: 'Broke Jokes III', 121: 'Broke Jokes IV',
  4: '8-bit', 53: '8-bit II', 54: '8-bit III', 55: '8-bit IV',
  5: 'Sprinkles', 56: 'Sprinkles II', 57: 'Sprinkles III', 58: 'Sprinkles IV',
  24: 'E-asy Street', 113: 'E-asy Street II', 114: 'E-asy Street III', 115: 'E-asy Street IV',
  6: 'Gatling Gun', 59: 'Gatling Gun II', 60: 'Gatling Gun III', 61: 'Gatling Gun IV',
  7: 'Quickdraw', 62: 'Quickdraw II', 63: 'Quickdraw III', 64: 'Quickdraw IV',
  8: 'Tight Knit', 65: 'Tight Knit II', 66: 'Tight Knit III', 67: 'Tight Knit IV',
  27: 'Six of the Best', 122: 'Six of the Best II', 123: 'Six of the Best III', 124: 'Six of the Best IV',
  9: 'Ballsy', 68: 'Ballsy II', 69: 'Ballsy III', 70: 'Ballsy IV',
  20: 'Boom or Bust', 101: 'Boom or Bust II', 102: 'Boom or Bust III', 103: 'Boom or Bust IV',
  18: 'Duel at Dawn', 95: 'Duel at Dawn II', 96: 'Duel at Dawn III', 97: 'Duel at Dawn IV',
  17: 'Fourplay', 92: 'Fourplay II', 93: 'Fourplay III', 94: 'Fourplay IV',
  11: "Old 'n Slow", 74: "Old 'n Slow II", 75: "Old 'n Slow III", 76: "Old 'n Slow IV",
  23: 'Periodic', 110: 'Periodic II', 111: 'Periodic III', 112: 'Periodic IV',
  10: 'Pound It', 71: 'Pound It II', 72: 'Pound It III', 73: 'Pound It IV',
  21: 'Old Folks Home', 104: 'Old Folks Home II', 105: 'Old Folks Home III', 106: 'Old Folks Home IV',
  12: 'Tripod', 77: 'Tripod II', 78: 'Tripod III', 79: 'Tripod IV',
  22: 'Comatose Cove', 107: 'Comatose Cove II', 108: 'Comatose Cove III', 109: 'Comatose Cove IV',
  28: 'River Wizard', 125: 'River Wizard II', 126: 'River Wizard III', 127: 'River Wizard IV',
  25: "Cat's Chance", 116: "Cat's Chance II", 117: "Cat's Chance III", 118: "Cat's Chance IV",
  13: 'Slow Cooker', 80: 'Slow Cooker II', 81: 'Slow Cooker III', 82: 'Slow Cooker IV',
  19: 'Juan on Juan', 98: 'Juan on Juan II', 99: 'Juan on Juan III', 100: 'Juan on Juan IV',
  15: 'High Rollers', 86: 'High Rollers II', 87: 'High Rollers III', 88: 'High Rollers IV',
  14: 'Fire Pit', 83: 'Fire Pit II', 84: 'Fire Pit III', 85: 'Fire Pit IV',
  16: 'Oligarch', 89: 'Oligarch II', 90: 'Oligarch III', 91: 'Oligarch IV'
};
function tableGroup(id) {
  const name = ID_TO_NAME[id];
  return name ? name.replace(/ (II|III|IV)$/, '') : null;
}
const GROUP_ORDER = (function () {
  const seen = {}, order = [];
  for (const id in ID_TO_NAME) {
    const g = ID_TO_NAME[id].replace(/ (II|III|IV)$/, '');
    if (!seen[g]) { seen[g] = 1; order.push(g); }
  }
  return order;
})();

/* ============================ entry ============================ */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^.*\/poker-hof\/api/, '') || '/';
  try {
    if (route === '/auth' && request.method === 'POST') return auth(request, env);
    if (route === '/board' && request.method === 'GET') return board(request, env, url);
    if (route === '/sittings' && request.method === 'POST') return submitSittings(request, env);
    if (route === '/settings' && request.method === 'POST') return saveSettings(request, env);
    if (route === '/delete' && request.method === 'POST') return deleteData(request, env);
    return json({ error: 'not found' }, 404);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
}

/* ============================ identity ============================ */
// Resolve a key to its owner via Torn. The id/name/image come from Torn's
// response to this key, so a caller can never claim to be someone else.
// The key is used for this one call and never stored.
async function identify(key) {
  if (!key || !/^[A-Za-z0-9]{10,24}$/.test(String(key).trim())) {
    return { error: 'That does not look like a Torn API key.' };
  }
  let res;
  try {
    res = await fetch(`${TORN}/user/profile?key=${encodeURIComponent(String(key).trim())}`,
      { headers: { 'Accept': 'application/json' } });
  } catch (e) {
    return { error: 'Could not reach Torn. Try again.' };
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) return { error: 'Torn rejected the key: ' + (data.error.error || data.error.code) };
  const p = data.profile || data;
  if (!p || (!p.player_id && !p.id)) return { error: 'Torn did not return a profile for this key.' };
  return { id: Number(p.player_id || p.id), name: String(p.name || 'Player'), image: p.image || p.profile_image || null };
}

async function auth(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO players (torn_id, name, image, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(torn_id) DO UPDATE SET name = ?2, image = ?3`
  ).bind(who.id, who.name, who.image, now).run();

  const row = await env.DB.prepare(
    `SELECT torn_id, name, image, visibility, start_mode, start_date, last_sync FROM players WHERE torn_id = ?1`
  ).bind(who.id).first();
  const token = await signToken(env, who.id);
  return json({ player: row, token });
}

/* ============================ submit sittings ============================ */
async function submitSittings(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);

  const sittings = Array.isArray(body.sittings) ? body.sittings : [];
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO sittings
       (id, player_id, table_id, table_group, buy_in, cash_out, net, join_time, leave_time)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  );
  const batch = [];
  let skipped = 0;
  for (const s of sittings) {
    const tableId = Number(s.table_id);
    const group = tableGroup(tableId);
    if (!group) { skipped++; continue; }
    const buyIn = Math.round(Number(s.buy_in) || 0);
    const cashOut = Math.round(Number(s.cash_out) || 0);
    const join = Math.floor(Number(s.join_time) || 0);
    const leave = Math.floor(Number(s.leave_time) || 0);
    if (!s.id || !join || !leave) { skipped++; continue; }
    batch.push(stmt.bind(String(s.id), who.id, tableId, group, buyIn, cashOut, cashOut - buyIn, join, leave));
  }
  let stored = 0;
  if (batch.length) {
    const results = await env.DB.batch(batch);
    stored = results.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
    skipped += batch.length - stored;
  }

  if (body.start_mode === 'all' || body.start_mode === 'date') {
    await env.DB.prepare(`UPDATE players SET start_mode = ?2, start_date = ?3, last_sync = ?4 WHERE torn_id = ?1`)
      .bind(who.id, body.start_mode, body.start_mode === 'date' ? Math.floor(Number(body.start_date) || 0) : null, now).run();
  } else {
    await env.DB.prepare(`UPDATE players SET last_sync = ?2 WHERE torn_id = ?1`).bind(who.id, now).run();
  }
  return json({ stored, skipped, last_sync: now });
}

/* ============================ settings ============================ */
async function saveSettings(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);

  if (['public', 'hide$', 'hidename', 'hidden'].includes(body.visibility)) {
    await env.DB.prepare(`UPDATE players SET visibility = ?2 WHERE torn_id = ?1`).bind(who.id, body.visibility).run();
  }
  if (body.start_mode === 'all' || body.start_mode === 'date') {
    const newDate = body.start_mode === 'date' ? Math.floor(Number(body.start_date) || 0) : null;
    await env.DB.prepare(`UPDATE players SET start_mode = ?2, start_date = ?3 WHERE torn_id = ?1`)
      .bind(who.id, body.start_mode, newDate).run();
    if (newDate) {
      await env.DB.prepare(`DELETE FROM sittings WHERE player_id = ?1 AND join_time < ?2`).bind(who.id, newDate).run();
    }
  }
  if (Array.isArray(body.hidden_tables)) {
    await env.DB.prepare(`DELETE FROM hidden_tables WHERE player_id = ?1`).bind(who.id).run();
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO hidden_tables (player_id, table_group) VALUES (?1, ?2)`);
    const batch = body.hidden_tables.filter(g => GROUP_ORDER.includes(g)).map(g => stmt.bind(who.id, g));
    if (batch.length) await env.DB.batch(batch);
  }

  const row = await env.DB.prepare(
    `SELECT torn_id, name, image, visibility, start_mode, start_date, last_sync FROM players WHERE torn_id = ?1`
  ).bind(who.id).first();
  const hidden = await env.DB.prepare(`SELECT table_group FROM hidden_tables WHERE player_id = ?1`).bind(who.id).all();
  return json({ player: row, hidden_tables: hidden.results.map(r => r.table_group) });
}

async function deleteData(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sittings WHERE player_id = ?1`).bind(who.id),
    env.DB.prepare(`DELETE FROM hidden_tables WHERE player_id = ?1`).bind(who.id),
    env.DB.prepare(`DELETE FROM players WHERE torn_id = ?1`).bind(who.id)
  ]);
  return json({ deleted: true });
}

/* ============================ board ============================ */
async function board(request, env, url) {
  const viewer = await viewerFrom(request, env, url);

  const players = await env.DB.prepare(`SELECT torn_id, name, image, visibility FROM players`).all();
  const pmap = {};
  players.results.forEach(p => { pmap[p.torn_id] = p; });

  const agg = await env.DB.prepare(
    `SELECT s.player_id AS pid, s.table_group AS grp,
            SUM(s.net) AS net, COUNT(*) AS sessions, SUM(s.leave_time - s.join_time) AS seconds
     FROM sittings s
     WHERE NOT EXISTS (SELECT 1 FROM hidden_tables h WHERE h.player_id = s.player_id AND h.table_group = s.table_group)
     GROUP BY s.player_id, s.table_group`
  ).all();

  const scopes = { global: {} };
  for (const r of agg.results) {
    if (!pmap[r.pid]) continue;
    addTo(scopes.global, r.pid, r);
    if (!scopes[r.grp]) scopes[r.grp] = {};
    addTo(scopes[r.grp], r.pid, r);
  }

  const out = { viewer: viewer ? { id: viewer.id } : null, global: buildScope(scopes.global, pmap, viewer), tables: [] };
  for (const grp of GROUP_ORDER) {
    if (scopes[grp]) {
      const b = buildScope(scopes[grp], pmap, viewer);
      if (b.players.length) out.tables.push({ table: grp, board: b });
    }
  }
  return json(out);
}

function addTo(scope, pid, r) {
  if (!scope[pid]) scope[pid] = { net: 0, sessions: 0, minutes: 0 };
  scope[pid].net += Number(r.net) || 0;
  scope[pid].sessions += Number(r.sessions) || 0;
  scope[pid].minutes += Math.round((Number(r.seconds) || 0) / 60);
}

function buildScope(scope, pmap, viewer) {
  const recv = canReceive(viewer ? viewer.visibility : 'visitor');
  const rows = Object.keys(scope).map(pid => {
    const p = pmap[pid], t = scope[pid];
    const you = viewer && Number(pid) === viewer.id;
    const exp = exposes(p.visibility);
    const seeName = you || (exp.name && recv.name);
    const seeVal = you || (exp.value && recv.value);
    const avg = t.sessions ? Math.round(t.net / t.sessions) : 0;
    return {
      pid: Number(pid), you: !!you,
      _net: t.net, _sessions: t.sessions, _minutes: t.minutes, _avg: avg,
      name: seeName ? p.name : null,
      image: seeName ? (p.image || null) : null,
      net: seeVal ? t.net : null, sessions: seeVal ? t.sessions : null,
      minutes: seeVal ? t.minutes : null, avg: seeVal ? avg : null
    };
  });

  const order = {};
  [['net', '_net'], ['sessions', '_sessions'], ['avg', '_avg'], ['time', '_minutes']].forEach(([k, f]) => {
    order[k] = rows.map((r, i) => i).sort((a, b) => rows[b][f] - rows[a][f]);
  });

  let net = 0, sessions = 0, minutes = 0;
  rows.forEach(r => { net += r._net; sessions += r._sessions; minutes += r._minutes; });

  const out = rows.map(r => ({
    pid: r.pid, you: r.you, name: r.name, image: r.image,
    net: r.net, sessions: r.sessions, minutes: r.minutes, avg: r.avg
  }));
  return { summary: { net, sessions, minutes, players: out.length }, players: out, order };
}

function exposes(v) {
  return { name: v === 'public' || v === 'hide$', value: v === 'public' || v === 'hidename' };
}
function canReceive(mode) {
  if (!mode || mode === 'visitor') return { name: false, value: false };
  return { name: mode === 'public' || mode === 'hide$', value: mode === 'public' || mode === 'hidename' };
}

async function viewerFrom(request, env, url) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : url.searchParams.get('token');
  if (!token) return null;
  const id = await verifyToken(env, token);
  if (!id) return null;
  const row = await env.DB.prepare(`SELECT torn_id AS id, visibility FROM players WHERE torn_id = ?1`).bind(id).first();
  return row || { id, visibility: 'public' };
}

/* ============================ tokens ============================ */
async function hmacKey(env) {
  const secret = env.SESSION_SECRET || 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(env, id) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
  const body = `${id}.${exp}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body));
  return `${body}.${hex(sig)}`;
}
async function verifyToken(env, token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromHex(sig), new TextEncoder().encode(`${id}.${exp}`));
  return ok ? Number(id) : null;
}
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

/* ============================ responses ============================ */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
