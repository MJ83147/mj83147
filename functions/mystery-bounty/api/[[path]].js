// Cloudflare Pages Function: the Mystery Bounty tournament API.
// Serves /mystery-bounty/api/* for the static pages at /mystery-bounty.
//
// Auth model (public Torn-key identity, no passwords):
//   - Anyone proves who they are by passing their Torn API key; we call Torn
//     /v2/user/profile so the identity is authoritative and unspoofable. The
//     key is used for that one call and never stored.
//   - Admins = a torn_id in the `admins` allowlist (seeded in schema.sql).
//   - Stewards = a torn_id in the `stewards` allowlist (managed by admins).
//   - On auth we issue an HMAC session token carrying id + role; every write
//     re-verifies the token and its role. Signed with env.SESSION_SECRET.
//
// Money is INTEGER Torn dollars. The bounty POOL is always computed from
// participant counts x the configured bounty portions; it is never settable.

const TORN = 'https://api.torn.com/v2';

/* ============================ entry / router ============================ */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^.*\/mystery-bounty\/api/, '') || '/';
  const method = request.method;
  try {
    // public reads
    if (route === '/state' && method === 'GET') return getState(env, url);
    if (route === '/table' && method === 'GET') return getTable(env, url);
    if (route === '/availability' && method === 'GET') {
      const v = await requireRole(request, env, url, 'admin');
      if (!v) return json({ error: 'admin only' }, 403);
      return getAvailability(env, url);
    }
    if (route === '/stage/seating' && method === 'GET') return getSeating(request, env, url);

    // auth
    if (route === '/auth' && method === 'POST') return auth(request, env);

    // public writes
    if (route === '/availability/mine' && (method === 'GET' || method === 'POST')) return myAvailability(request, env, url);
    if (route === '/availability/submit' && method === 'POST') return submitAvailability(request, env);
    if (route === '/seat/claim' && method === 'POST') return claimSeat(request, env);

    // steward or admin writes
    if (route === '/result' && method === 'POST') return reportResult(request, env);
    if (route === '/knockout' && method === 'POST') return reportKnockout(request, env);
    if (route === '/table/finish' && method === 'POST') return finishTable(request, env);
    if (route === '/steward/availability' && method === 'POST') return setStewardAvailability(request, env);
    if (route === '/steward/assign' && method === 'POST') return assignSteward(request, env);

    // admin writes
    if (route === '/players/add' && method === 'POST') return playersAdd(request, env);
    if (route === '/players/remove' && method === 'POST') return playersRemove(request, env);
    if (route === '/donations/add' && method === 'POST') return donationsAdd(request, env);
    if (route === '/donations/remove' && method === 'POST') return donationsRemove(request, env);
    if (route === '/settings' && method === 'POST') return saveSettings(request, env);
    if (route === '/status' && method === 'POST') return setStatus(request, env);
    if (route === '/stage/generate' && method === 'POST') return stageGenerate(request, env);
    if (route === '/stage/commit' && method === 'POST') return stageCommit(request, env);
    if (route === '/stage/clear' && method === 'POST') return stageClear(request, env);
    if (route === '/stage/fill-availability' && method === 'POST') return fillAvailability(request, env);
    if (route === '/stage/seat-manual' && method === 'POST') return seatManual(request, env);
    if (route === '/stage/method' && method === 'POST') return stageSetMethod(request, env);
    if (route === '/rebuy/confirm' && method === 'POST') return rebuyConfirm(request, env);
    if (route === '/envelopes/generate' && method === 'POST') return envelopesGenerate(request, env);
    if (route === '/stewards/add' && method === 'POST') return stewardsAdd(request, env);
    if (route === '/stewards/remove' && method === 'POST') return stewardsRemove(request, env);
    if (route === '/table/meta' && method === 'POST') return tableMeta(request, env);
    if (route === '/reset' && method === 'POST') return resetEvent(request, env);

    return json({ error: 'not found' }, 404);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 500);
  }
}

/* ============================ identity + auth ============================ */
async function identify(key) {
  if (!key || !/^[A-Za-z0-9]{10,24}$/.test(String(key).trim())) {
    return { error: 'That does not look like a Torn API key.' };
  }
  let res;
  try {
    res = await fetch(`${TORN}/user/profile?key=${encodeURIComponent(String(key).trim())}`,
      { headers: { Accept: 'application/json' } });
  } catch (e) {
    return { error: 'Could not reach Torn. Try again.' };
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) return { error: 'Torn rejected the key: ' + (data.error.error || data.error.code) };
  const p = data.profile || data;
  if (!p || (!p.player_id && !p.id)) return { error: 'Torn did not return a profile for this key.' };
  return { id: Number(p.player_id || p.id), name: String(p.name || 'Player') };
}

// Resolve the caller's role from their torn_id against the allowlists.
async function roleOf(env, id) {
  const a = await env.MB.prepare(`SELECT 1 FROM admins WHERE torn_id = ?1`).bind(id).first();
  if (a) return 'admin';
  const s = await env.MB.prepare(`SELECT 1 FROM stewards WHERE torn_id = ?1 AND active = 1`).bind(id).first();
  if (s) return 'steward';
  return 'player';
}

async function auth(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);
  const role = await roleOf(env, who.id);
  const token = await signToken(env, who.id, role);
  // note: we return the Torn name for the session greeting only; it is never stored.
  return json({ id: who.id, name: who.name, role, token });
}

// Verify a Bearer token (or ?token=) and require at least the given role.
// Returns { id, role } or throws a Response via requireFail.
async function requireRole(request, env, url, min) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7)
    : (url ? url.searchParams.get('token') : null);
  const v = await verifyToken(env, token);
  if (!v) return null;
  // re-resolve the role from the DB on every request, so a steward/admin who was
  // removed loses access immediately instead of riding their token's baked-in
  // role until it expires (tokens are signed for 30 days).
  const role = await roleOf(env, v.id);
  const rank = { player: 0, steward: 1, admin: 2 };
  if (rank[role] < rank[min]) return null;
  return { id: v.id, role };
}

/* ============================ settings / pool ============================ */
async function readSettings(env) {
  const rows = await env.MB.prepare(`SELECT key, value FROM settings`).all();
  const s = {};
  rows.results.forEach(r => { s[r.key] = r.value; });
  return s;
}
function num(s, k, d) { const v = Number(s[k]); return isFinite(v) ? v : d; }

// Compute pools from counts x configured portions. Never settable by admins.
async function computePool(env, s) {
  const pc = await env.MB.prepare(`SELECT COUNT(*) n FROM players`).first();
  const rc = await env.MB.prepare(`SELECT COUNT(*) n FROM players WHERE rebuy_paid = 1`).first();
  const dc = await env.MB.prepare(`SELECT COALESCE(SUM(amount),0) t FROM donations`).first();
  const entries = Number(pc.n) || 0, rebuys = Number(rc.n) || 0, donated = Number(dc.t) || 0;
  // split each fee into main vs bounty by the configured percentages (a ratio,
  // so they don't have to sum to exactly 100)
  const mainPct = num(s, 'main_pct', 60), bountyPct = num(s, 'bounty_pct', 40);
  const denom = (mainPct + bountyPct) || 100;
  const entryTotal = num(s, 'entry_total', 50000000), rebuyTotal = num(s, 'rebuy_total', 75000000);
  const entryBounty = Math.round(entryTotal * bountyPct / denom);
  const rebuyBounty = Math.round(rebuyTotal * bountyPct / denom);
  const entryMain = entryTotal - entryBounty;
  const rebuyMain = rebuyTotal - rebuyBounty;
  const mainFromEntries = entries * entryMain;
  const mainFromRebuys = rebuys * rebuyMain;
  // donations are split between main and bounty the same way as a buy-in
  const donatedBounty = Math.round(donated * bountyPct / denom);
  const donatedMain = donated - donatedBounty;
  const bountyTotal = entries * entryBounty + rebuys * rebuyBounty + donatedBounty;
  // the bounty pool is split between the three bounty stages (Day 1, Day 2,
  // Final) by the configured shares (a ratio, like main/bounty). The Rebuy and
  // Money tables have no bounties. Day 2 takes the rounding remainder.
  const sh = bountyShares(s);
  const day1EnvPool = Math.round(bountyTotal * sh.day1 / sh.sum);
  const finalEnvPool = Math.round(bountyTotal * sh.final / sh.sum);
  const day2EnvPool = bountyTotal - day1EnvPool - finalEnvPool;
  return {
    entries, rebuys, donated, donatedMain, donatedBounty,
    mainFromEntries, mainFromRebuys,
    mainTotal: mainFromEntries + mainFromRebuys + donatedMain,
    bountyTotal, day1EnvPool, day2EnvPool, finalEnvPool
  };
}
// Envelope split between the bounty stages, from settings (defaults 10/55/35).
// A database from before Day 1 had bounties only has final_share_pct (the old
// Day 2 / Final split); until the new split is saved, the defaults apply.
function bountyShares(s) {
  if (s.day1_share_pct == null && s.day2_share_pct == null) return { day1: 10, day2: 55, final: 35, sum: 100 };
  const day1 = Math.max(0, num(s, 'day1_share_pct', 10));
  const day2 = Math.max(0, num(s, 'day2_share_pct', 55));
  const final = Math.max(0, num(s, 'final_share_pct', 35));
  return { day1, day2, final, sum: (day1 + day2 + final) || 100 };
}
// Stages whose tables play for bounty envelopes.
function isBountyStage(stage) { return stage === 'day1' || stage === 'day2' || stage === 'final'; }
// Total already given to the envelope pools of these stages' tables.
async function assignedEnvelopes(env, stages) {
  const ph = stages.map((_, i) => '?' + (i + 1)).join(',');
  const r = await env.MB.prepare(`SELECT COALESCE(SUM(envelope_total),0) t FROM tables WHERE stage IN (${ph})`).bind(...stages).first();
  return Number(r.t) || 0;
}

/* ============================ public: /state ============================ */
// The current stage is derived from the per-stage start times (stored as epoch
// seconds in settings as day1_at..complete_at), so nobody has to flip a status
// by hand. Before day1_at it is 'setup'; the roster locks once day1 starts.
function computeStatus(s) {
  const now = Math.floor(Date.now() / 1000);
  const seq = [['day1', 'day1_at'], ['rebuy', 'rebuy_at'], ['day2', 'day2_at'],
  ['final', 'final_at'], ['money', 'money_at']];
  let cur = 'setup';
  for (const [stage, key] of seq) { const v = Number(s[key]); if (v && now >= v) cur = stage; }
  return cur;
}
// The roster is never locked: admins manage players by hand at any point in the
// event, so there is no sign-up cutoff gating adds/removes.
function rosterLocked(s) {
  return false;
}

// Derived per-stage lifecycle. A stage goes LIVE in one of two ways:
//   1. its own scheduled date has arrived, or
//   2. the previous stage is complete AND this stage has had its tables generated
//      (so it opens when the admin actually sets it up, not the instant the
//      previous stage ends).
// A stage is complete only if it has tables and every one is 'complete' (tables
// close only when a result is filed). Exactly ONE stage is "current" (the
// earliest started stage that isn't finished), so two stages can never read live
// at the same time and a finished stage stops being live.
function computeStages(s, tablesRows) {
  const now = Math.floor(Date.now() / 1000);
  const ORDER = ['day1', 'rebuy', 'day2', 'final', 'money'];
  const byStage = {}; ORDER.forEach(k => { byStage[k] = []; });
  tablesRows.forEach(t => { if (byStage[t.stage]) byStage[t.stage].push(t); });
  const dateOpen = k => { const v = Number(s[k + '_at']); return !!(v && now >= v); };
  const hasTables = k => byStage[k].length > 0;
  const allComplete = k => hasTables(k) && byStage[k].every(t => t.status === 'complete');
  // optional stages are skipped entirely when not in play
  const enabled = k => {
    if (k === 'money') return s.money_table_enabled !== '0';
    if (k === 'rebuy') return hasTables('rebuy') || !!Number(s.rebuy_at);
    return true; // day1, day2, final are always part of the run
  };
  const order = ORDER.filter(enabled);
  const started = {}, complete = {};
  order.forEach((k, i) => {
    complete[k] = allComplete(k);
    const prev = i > 0 ? order[i - 1] : null;
    started[k] = dateOpen(k) || (!!prev && complete[prev] && hasTables(k));
  });
  // the single live stage: the earliest started stage that isn't finished yet
  let current = 'setup';
  for (const k of order) { if (started[k] && !complete[k]) { current = k; break; } }
  // no stage live but everything that opened is done -> whole event complete
  if (current === 'setup') { const last = order[order.length - 1]; if (last && complete[last]) current = 'complete'; }
  const state = {};
  order.forEach(k => { state[k] = { started: !!started[k], complete: !!complete[k], hasTables: hasTables(k), live: k === current }; });
  return { order, state, current };
}

async function getState(env, url) {
  const s = await readSettings(env);
  // overlay the date-derived status + roster lock so the board and gates follow the schedule
  s.tournament_status = computeStatus(s);
  s.roster_locked = rosterLocked(s) ? '1' : '0';
  const pool = await computePool(env, s);

  const players = (await env.MB.prepare(
    `SELECT torn_id AS tornId, name, status, current_loc AS loc, rebuy_paid AS rebuyPaid, stage_out AS stageOut
     FROM players ORDER BY name COLLATE NOCASE`).all()).results;
  const donations = (await env.MB.prepare(
    `SELECT donor_name AS donorName, amount FROM donations ORDER BY id`).all()).results;
  const tablesRows = (await env.MB.prepare(
    `SELECT id, stage, label, status, seat_size AS seatSize, seating_mode AS seatingMode,
            bounties_live AS bountiesLive, timeslot, steward_id AS stewardId,
            envelope_total AS envelopeTotal, sort_no AS sortNo
     FROM tables ORDER BY sort_no, id`).all()).results;
  const seats = (await env.MB.prepare(
    `SELECT table_id AS tableId, torn_id AS tornId, seat_no AS seatNo, claimed FROM table_seats`).all()).results;
  const placings = (await env.MB.prepare(
    `SELECT table_id AS tableId, place, torn_id AS tornId, advanced_to AS advancedTo FROM placings`).all()).results;
  const finalPlaces = (await env.MB.prepare(
    `SELECT place, torn_id AS tornId, prize FROM final_places ORDER BY place`).all()).results;
  const stewards = (await env.MB.prepare(
    `SELECT torn_id AS tornId, name, active FROM stewards WHERE active = 1 ORDER BY name COLLATE NOCASE`).all()).results;
  const stewardAvailability = (await env.MB.prepare(
    `SELECT steward_id AS stewardId, slot_id AS slotId FROM steward_availability`).all()).results;

  // bounty leaderboard (revealed cash is fine to show as an aggregate)
  const bounties = (await env.MB.prepare(
    `SELECT k.eliminator_id AS tornId, p.name, COUNT(*) AS kos, COALESCE(SUM(k.amount),0) AS cash
     FROM knockouts k LEFT JOIN players p ON p.torn_id = k.eliminator_id
     GROUP BY k.eliminator_id ORDER BY cash DESC`).all()).results;

  // envelope progress per table (count + opened) WITHOUT leaking sealed amounts
  const envAgg = (await env.MB.prepare(
    `SELECT table_id AS tableId, COUNT(*) AS count, SUM(opened) AS opened FROM envelopes GROUP BY table_id`
  ).all()).results;
  const envByTable = {}; envAgg.forEach(e => { envByTable[e.tableId] = e; });

  // derived per-stage lifecycle (which stage is live, which are done)
  const stages = computeStages(s, tablesRows);

  // attach seats + placings + envelope progress to each table
  const seatsByTable = {}, placingsByTable = {};
  seats.forEach(r => { (seatsByTable[r.tableId] = seatsByTable[r.tableId] || []).push(r); });
  placings.forEach(r => { (placingsByTable[r.tableId] = placingsByTable[r.tableId] || []).push(r); });
  const tables = tablesRows.map(t => {
    const e = envByTable[t.id];
    // a table reads live only while its stage is the current one; otherwise it is
    // 'complete' (result filed) or 'pending' (its stage hasn't gone live yet)
    const displayStatus = t.status === 'complete' ? 'complete'
      : (t.stage === stages.current ? 'live' : 'pending');
    return {
      ...t,
      bountiesLive: !!t.bountiesLive,
      displayStatus,
      seats: (seatsByTable[t.id] || []).sort((a, b) => (a.seatNo || 0) - (b.seatNo || 0)),
      places: (placingsByTable[t.id] || []).sort((a, b) => a.place - b.place),
      envelope: e ? { count: e.count, opened: e.opened || 0, total: t.envelopeTotal } : null
    };
  });

  // stats
  const active = players.filter(p => (p.status || 'active') !== 'eliminated' && p.status !== 'champion').length;
  const champions = players.filter(p => p.status === 'champion').length;
  const eliminated = players.filter(p => p.status === 'eliminated').length;
  const games = tablesRows.filter(t => t.status === 'complete').length;
  const stats = {
    registered: players.length, active: active + champions, eliminated,
    games, rebuys: pool.rebuys, donors: donations.length, donated: pool.donated
  };

  return json({ settings: s, pool, stats, players, donations, tables, finalPlaces, stewards, stewardAvailability, bounties, currentStage: stages.current, stageState: stages.state });
}

// Player availability rows (admin), for the availability-admin demand view.
async function getAvailability(env, url) {
  const phase = url.searchParams.get('phase');
  const sql = `SELECT a.torn_id AS tornId, p.name, a.phase, a.slot_id AS slotId, a.fingerprint, a.submitted_at AS submittedAt
               FROM availability a LEFT JOIN players p ON p.torn_id = a.torn_id` +
    (phase ? ` WHERE a.phase = ?1` : ``);
  const q = env.MB.prepare(sql);
  const rows = (await (phase ? q.bind(phase) : q).all()).results;
  return json({ rows });
}

// Full detail for one table incl. the ordered knockouts WITH revealed amounts
// (only once the table is complete) so the public replay can animate it.
async function getTable(env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'missing id' }, 400);
  const t = await env.MB.prepare(
    `SELECT id, stage, label, status, seat_size AS seatSize, bounties_live AS bountiesLive, envelope_total AS envelopeTotal
     FROM tables WHERE id = ?1`).bind(id).first();
  if (!t) return json({ error: 'no such table' }, 404);
  const seats = (await env.MB.prepare(
    `SELECT ts.torn_id AS tornId, ts.seat_no AS seatNo, p.name
     FROM table_seats ts LEFT JOIN players p ON p.torn_id = ts.torn_id
     WHERE ts.table_id = ?1 ORDER BY ts.seat_no`).bind(id).all()).results;
  const places = (await env.MB.prepare(
    `SELECT place, torn_id AS tornId FROM placings WHERE table_id = ?1 ORDER BY place`).bind(id).all()).results;
  // reveal amounts only once the table is complete
  const complete = t.status === 'complete';
  const rows = (await env.MB.prepare(
    `SELECT seq, eliminated_id AS out, eliminator_id AS by, ${complete ? 'amount' : '0 AS amount'}
     FROM knockouts WHERE table_id = ?1 ORDER BY seq`).bind(id).all()).results;
  // one event per busted player; a split knockout (equal hands) has several
  // rows for the same victim, merged here into `shares` (by + amount each)
  const knockouts = [], byOut = {};
  rows.forEach(k => {
    let ev = byOut[k.out];
    if (!ev) { ev = byOut[k.out] = { seq: k.seq, out: k.out, by: k.by, amount: 0, shares: [] }; knockouts.push(ev); }
    ev.amount += Number(k.amount) || 0;
    ev.shares.push({ by: k.by, amount: Number(k.amount) || 0 });
  });
  return json({ table: { ...t, bountiesLive: !!t.bountiesLive }, seats, places, knockouts, complete });
}

/* ============================ admin: players ============================ */
async function playersAdd(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const s = await readSettings(env);
  if (rosterLocked(s)) return json({ error: 'Roster is locked (sign-ups have closed).' }, 400);
  const id = Number(body.tornId), name = String(body.name || '').trim();
  if (!id || !name) return json({ error: 'name and tornId required' }, 400);
  await env.MB.prepare(
    `INSERT INTO players (torn_id, name, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(torn_id) DO UPDATE SET name = ?2`
  ).bind(id, name, now()).run();
  return json({ ok: true });
}
async function playersRemove(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const s = await readSettings(env);
  if (rosterLocked(s)) return json({ error: 'Roster is locked (sign-ups have closed).' }, 400);
  await env.MB.prepare(`DELETE FROM players WHERE torn_id = ?1`).bind(Number(body.tornId)).run();
  return json({ ok: true });
}

/* ============================ admin: donations ============================ */
async function donationsAdd(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const name = String(body.donorName || '').trim();
  const amount = Math.round(Number(body.amount) || 0);
  if (!name || !amount) return json({ error: 'donorName and amount required' }, 400);
  await env.MB.prepare(`INSERT INTO donations (donor_name, amount, note, created_at) VALUES (?1,?2,?3,?4)`)
    .bind(name, amount, String(body.note || ''), now()).run();
  return json({ ok: true });
}
async function donationsRemove(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  await env.MB.prepare(`DELETE FROM donations WHERE id = ?1`).bind(Number(body.id)).run();
  return json({ ok: true });
}

/* ============================ admin: settings / status ============================ */
const EDITABLE = new Set([
  'event_name', 'roster_locked', 'entry_total', 'rebuy_total', 'main_pct', 'bounty_pct',
  'day1_table_min', 'day1_table_max', 'rebuy_table_min', 'rebuy_table_max',
  'day2_table_min', 'day2_table_max', 'day2_table_count', 'day2_advance', 'day2_to_money', 'final_table_size',
  'day1_share_pct', 'day2_share_pct', 'final_share_pct', 'money_table_enabled', 'payout_structure', 'pay_to',
  'signup_at', 'day1_at', 'rebuy_at', 'day2_at', 'final_at', 'money_at', 'complete_at',
  'day1_method', 'rebuy_method', 'day2_method',
  'day1_select_at', 'rebuy_select_at', 'day2_select_at',
  'final_time', 'money_time', 'avail_phase'
]);
const STAGE_KEYS = ['day1', 'rebuy', 'day2', 'final'];
async function saveSettings(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const entries = Object.entries(body || {}).filter(([k]) => EDITABLE.has(k));
  if (!entries.length) return json({ error: 'nothing to save' }, 400);
  // the Day 1 / Day 2 / Final envelope shares must add up to 100
  if (entries.some(([k]) => /^(day1|day2|final)_share_pct$/.test(k))) {
    const cur = await readSettings(env);
    entries.forEach(([k, val]) => { cur[k] = val; });
    const sh = bountyShares(cur);
    if ([sh.day1, sh.day2, sh.final].some(x => !isFinite(x)) || Math.abs(sh.day1 + sh.day2 + sh.final - 100) > 0.001)
      return json({ error: 'The Day 1, Day 2 and Final envelope shares must add up to 100.' }, 400);
  }
  const stmt = env.MB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3`);
  await env.MB.batch(entries.map(([k, val]) => stmt.bind(k, String(val), now())));
  return json({ ok: true, settings: await readSettings(env) });
}
async function setStatus(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const allowed = ['setup', 'day1', 'rebuy', 'day2', 'final', 'money', 'complete'];
  if (!allowed.includes(body.status)) return json({ error: 'bad status' }, 400);
  await setSetting(env, 'tournament_status', body.status);
  // starting the tournament locks the roster
  if (body.status !== 'setup') await setSetting(env, 'roster_locked', '1');
  return json({ ok: true });
}

/* ============================ admin: stage generation ============================ */
// Build a seating plan for a stage from the right pool of players, without
// writing it yet (the admin reviews/edits then commits). Ports the shootout /
// bounty-test table-splitting maths.
async function stageGenerate(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stage = body.stage;
  // can't build a later stage until Day 1 has finished
  if (stage === 'rebuy' || stage === 'day2') {
    const d1 = await env.MB.prepare(`SELECT COUNT(*) n, SUM(status='complete') c FROM tables WHERE stage='day1'`).first();
    if (!Number(d1.n) || Number(d1.c) !== Number(d1.n)) return json({ error: 'Finish Day 1 first.' }, 400);
  }
  const s = await readSettings(env);
  const pool = await stagePool(env, stage, s);
  const method = s[stage + '_method'] || 'availability';
  const plan = planTables(stage, pool, s);
  return json({ stage, plan, method, poolCount: pool.length });
}

// Who is eligible to be seated for each stage.
async function stagePool(env, stage, s) {
  if (stage === 'day1') {
    return (await env.MB.prepare(
      `SELECT torn_id AS id, name FROM players ORDER BY name COLLATE NOCASE`).all()).results;
  }
  if (stage === 'rebuy') {
    return (await env.MB.prepare(
      `SELECT torn_id AS id, name FROM players WHERE rebuy_paid = 1
         AND torn_id NOT IN (SELECT torn_id FROM table_seats ts JOIN tables t ON t.id = ts.table_id WHERE t.stage = 'rebuy')
       ORDER BY name COLLATE NOCASE`).all()).results;
  }
  if (stage === 'day2') {
    // winners of day1 + rebuy tables (place 1)
    return (await env.MB.prepare(
      `SELECT p.torn_id AS id, p.name FROM placings pl
         JOIN tables t ON t.id = pl.table_id
         JOIN players p ON p.torn_id = pl.torn_id
       WHERE pl.place = 1 AND t.stage IN ('day1','rebuy')
       ORDER BY p.name COLLATE NOCASE`).all()).results;
  }
  if (stage === 'final') {
    return (await env.MB.prepare(
      `SELECT p.torn_id AS id, p.name FROM placings pl
         JOIN tables t ON t.id = pl.table_id
         JOIN players p ON p.torn_id = pl.torn_id
       WHERE t.stage = 'day2' AND pl.advanced_to = 'final'
       ORDER BY p.name COLLATE NOCASE`).all()).results;
  }
  if (stage === 'money') {
    return (await env.MB.prepare(
      `SELECT p.torn_id AS id, p.name FROM placings pl
         JOIN tables t ON t.id = pl.table_id
         JOIN players p ON p.torn_id = pl.torn_id
       WHERE t.stage = 'day2' AND pl.advanced_to = 'money'
       ORDER BY p.name COLLATE NOCASE`).all()).results;
  }
  return [];
}

// How many tables to make so each lands within [min, max] players. `desired`
// is the preferred count (e.g. Day 2's table count), clamped to that range.
function tableCount(pool, min, max, desired) {
  if (pool <= 0) return 0;
  min = Math.min(Math.max(1, min || 1), max);           // guard against min > max misconfig
  const lo = Math.ceil(pool / max);                     // at least this many (none over max)
  const hi = Math.max(1, Math.floor(pool / min));       // at most this many (none under min)
  let c = desired || lo;
  c = Math.min(Math.max(c, lo), Math.max(lo, hi));      // keep within [lo, hi]; lo wins if lo>hi
  return Math.max(1, c);
}
// Even table split (ceil to table count, balance remainder), mirrors bounty-test.
function splitTables(p, size) {
  if (p <= 0) return [];
  const t = Math.max(1, Math.ceil(p / size)), base = Math.floor(p / t), extra = p % t, out = [];
  for (let i = 0; i < t; i++) out.push(i < extra ? base + 1 : base);
  return out;
}
function planTables(stage, pool, s) {
  const prefix = { day1: 'day1-t', rebuy: 'rebuy-t', day2: 'day2-t' }[stage] || (stage + '-t');
  // Final and Money are single tables seated directly from whoever advanced.
  if (stage === 'final') return [{ tableId: 'final', stage, size: num(s, 'final_table_size', 9), players: pool }];
  if (stage === 'money') return [{ tableId: 'money', stage, size: pool.length || num(s, 'day2_advance', 3), players: pool }];
  // Day 1 / Rebuy / Day 2: empty, time-slotted tables. Players arrive either by
  // availability (admin fills from the poll) or first-come (players claim).
  // Table count honours BOTH the min and max per table so we never make tables
  // below the minimum (e.g. 4 players with a min of 6 → one table, not three).
  let seat, min, desired = null;
  if (stage === 'day1') { seat = num(s, 'day1_table_max', 6); min = num(s, 'day1_table_min', 2); }
  else if (stage === 'rebuy') { seat = num(s, 'rebuy_table_max', 3); min = num(s, 'rebuy_table_min', 2); }
  else if (stage === 'day2') { seat = num(s, 'day2_table_max', 9); min = num(s, 'day2_table_min', 2); desired = num(s, 'day2_table_count', 3); }
  else { seat = 9; min = 2; }
  const count = tableCount(pool.length, min, seat, desired);
  if (count === 0) return [];
  const tables = [];
  for (let i = 0; i < count; i++) tables.push({ tableId: prefix + (i + 1), stage, size: seat, players: [] });
  return tables;
}

// Write a reviewed plan: create tables + seats. Expects { stage, plan, mode }.
async function stageCommit(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stage = body.stage;
  // same prerequisite as stageGenerate — can't seat a later stage before Day 1 is done
  if (stage === 'rebuy' || stage === 'day2') {
    const d1 = await env.MB.prepare(`SELECT COUNT(*) n, SUM(status='complete') c FROM tables WHERE stage='day1'`).first();
    if (!Number(d1.n) || Number(d1.c) !== Number(d1.n)) return json({ error: 'Finish Day 1 first.' }, 400);
  }
  const plan = Array.isArray(body.plan) ? body.plan : [];
  const mode = body.mode === 'claim' ? 'claim' : 'assigned';
  const bountiesLive = isBountyStage(stage) ? 1 : 0;
  const s = await readSettings(env);
  const stmts = [];
  plan.forEach((t, ti) => {
    stmts.push(env.MB.prepare(
      `INSERT INTO tables (id, stage, label, status, seat_size, seating_mode, bounties_live, sort_no, created_at)
       VALUES (?1,?2,?3,'live',?4,?5,?6,?7,?8)
       ON CONFLICT(id) DO UPDATE SET stage=?2, label=?3, seat_size=?4, seating_mode=?5, bounties_live=?6, sort_no=?7`
    ).bind(t.tableId, stage, t.label || tableLabel(stage, ti + 1), t.size || (t.players || []).length,
      mode, bountiesLive, stageSort(stage) * 100 + ti, now()));
    stmts.push(env.MB.prepare(`DELETE FROM table_seats WHERE table_id = ?1`).bind(t.tableId));
    // In claim mode we create empty seats players claim; in assigned mode we seat them now.
    if (mode === 'assigned') {
      (t.players || []).forEach((p, si) => {
        stmts.push(env.MB.prepare(
          `INSERT OR IGNORE INTO table_seats (table_id, torn_id, seat_no, claimed) VALUES (?1,?2,?3,0)`
        ).bind(t.tableId, Number(p.id || p), si + 1));
      });
    }
    // mark where these players now are
    (t.players || []).forEach(p => {
      stmts.push(env.MB.prepare(`UPDATE players SET current_loc = ?2, status = 'active' WHERE torn_id = ?1`)
        .bind(Number(p.id || p), stage));
    });
  });
  if (stmts.length) await env.MB.batch(stmts);

  // Day 1 / Day 2 / final tables get their envelope pools set to equal totals.
  if (bountiesLive) await buildEnvelopesForStage(env, stage, plan, s);
  return json({ ok: true, tables: plan.length });
}

async function stageClear(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stage = body.stage;
  const ids = (await env.MB.prepare(`SELECT id FROM tables WHERE stage = ?1`).bind(stage).all()).results.map(r => r.id);
  const stmts = [env.MB.prepare(`DELETE FROM tables WHERE stage = ?1`).bind(stage)];
  ids.forEach(id => {
    stmts.push(env.MB.prepare(`DELETE FROM table_seats WHERE table_id = ?1`).bind(id));
    stmts.push(env.MB.prepare(`DELETE FROM placings WHERE table_id = ?1`).bind(id));
    stmts.push(env.MB.prepare(`DELETE FROM envelopes WHERE table_id = ?1`).bind(id));
    stmts.push(env.MB.prepare(`DELETE FROM knockouts WHERE table_id = ?1`).bind(id));
  });
  await env.MB.batch(stmts);
  return json({ ok: true, cleared: ids.length });
}

// Seat players into a stage's already-committed, time-slotted tables using the
// availability poll. Each player is assigned to the table whose TCT hour is
// CLOSEST to a time they picked (exact match first, then nearest hour), the most
// constrained players are placed first, and ties break toward the emptiest table
// so the field stays balanced. Players who picked nothing go wherever there's room.
async function fillAvailability(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stage = body.stage;
  const tables = (await env.MB.prepare(
    `SELECT id, seat_size AS size, timeslot FROM tables WHERE stage = ?1 ORDER BY id`).bind(stage).all()).results;
  if (!tables.length) return json({ error: 'Create and time the tables first.' }, 400);
  // availability seating matches players to each table's TCT hour, so every table
  // must have a time set before it can run
  const untimed = tables.filter(t => !t.timeslot).length;
  if (untimed) return json({ error: `Set a time on every table first — ${untimed} still missing.` }, 400);
  const s = await readSettings(env);
  const pool = await stagePool(env, stage, s);
  const av = (await env.MB.prepare(`SELECT torn_id AS id, slot_id AS slot FROM availability WHERE phase = ?1`).bind(stage).all()).results;
  const slotsByPlayer = {};
  av.forEach(r => { (slotsByPlayer[r.id] = slotsByPlayer[r.id] || new Set()).add(r.slot); });
  // each table's TCT hour slot id, parsed from its datetime-local timeslot
  const tHour = t => { const m = /(\d{1,2}):/.exec(t.timeslot || ''); return m ? Number(m[1]) : null; };
  const slotHour = sl => { const m = /t(\d+)/.exec(sl || ''); return m ? Number(m[1]) : null; };
  const seats = tables.map(t => ({ id: t.id, cap: Number(t.size) || 9, hour: tHour(t), players: [] }));
  // the TCT hours a player picked in the poll (empty set = available anytime)
  const hoursOf = pid => {
    const set = slotsByPlayer[pid];
    return set ? Array.from(set).map(slotHour).filter(h => h != null) : [];
  };
  // distance from a table's hour to the player's NEAREST picked hour (wraps at 24h);
  // 99 when the player picked nothing (no preference) or the table has no time set
  const dist = (pid, x) => {
    const hrs = hoursOf(pid);
    if (x.hour == null || !hrs.length) return 99;
    let best = 99;
    hrs.forEach(h => { let d = Math.abs(h - x.hour); d = Math.min(d, 24 - d); best = Math.min(best, d); });
    return best;
  };
  // seat the most constrained players first (fewest tables at a time they actually picked)
  const order = pool.slice().sort((a, b) =>
    seats.filter(x => dist(a.id, x) === 0).length - seats.filter(x => dist(b.id, x) === 0).length);
  // each player goes to the open table CLOSEST to a time they picked, ties broken
  // toward the emptiest table so the field stays balanced
  const place = pid => {
    const open = seats.filter(x => x.players.length < x.cap);
    if (!open.length) return false;
    open.sort((a, b) => dist(pid, a) - dist(pid, b) || (b.cap - b.players.length) - (a.cap - a.players.length));
    open[0].players.push(pid); return true;
  };
  order.forEach(p => place(p.id));
  const stmts = [];
  seats.forEach(x => {
    stmts.push(env.MB.prepare(`DELETE FROM table_seats WHERE table_id = ?1`).bind(x.id));
    x.players.forEach((pid, i) => {
      stmts.push(env.MB.prepare(`INSERT OR IGNORE INTO table_seats (table_id, torn_id, seat_no, claimed) VALUES (?1,?2,?3,0)`).bind(x.id, pid, i + 1));
      stmts.push(env.MB.prepare(`UPDATE players SET current_loc = ?2, status='active' WHERE torn_id = ?1`).bind(pid, stage));
    });
  });
  await env.MB.batch(stmts);
  return json({ ok: true, seated: seats.reduce((n, x) => n + x.players.length, 0) });
}

// Switch a stage's seating method BEFORE it goes live. The method is part of the
// table structure (availability -> assigned tables, first-come -> claim tables),
// so this also re-modes the stage's existing tables to match. Refused once the
// stage is live, because structure is locked from that point on.
async function stageSetMethod(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stage = body.stage;
  if (!stage) return json({ error: 'stage required' }, 400);
  const method = body.method === 'fcfs' ? 'fcfs' : 'availability';
  const s = await readSettings(env);
  const rows = (await env.MB.prepare(`SELECT id, stage, status FROM tables`).all()).results;
  const stages = computeStages(s, rows);
  if (stages.state[stage] && stages.state[stage].live) {
    return json({ error: 'That stage is already live; its seating can no longer be changed.' }, 400);
  }
  const mode = method === 'fcfs' ? 'claim' : 'assigned';
  await setSetting(env, stage + '_method', method);
  await env.MB.prepare(`UPDATE tables SET seating_mode = ?2 WHERE stage = ?1`).bind(stage, mode).run();
  return json({ ok: true, method });
}

/* ============================ admin: rebuy ============================ */
async function rebuyConfirm(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  await env.MB.prepare(`UPDATE players SET rebuy_paid = 1, status = 'active' WHERE torn_id = ?1`)
    .bind(Number(body.tornId)).run();
  return json({ ok: true });
}

/* ============================ admin: envelopes ============================ */
// Record each bounty table's TOTAL bounty pool. The individual sealed envelopes
// are NOT created up front: they are generated when the table is finished, one
// per actual knockout, by randomly splitting this total. That way there are
// never any leftover unopened envelopes. Each Day 1 table gets an equal slice of
// day1EnvPool. Rebuys and donations can still grow the bounty pool after Day 1
// is seated, so later stages are worked out from what is not yet given out:
// Day 2 shares (pool - final share - what Day 1 got) equally, and the final
// table gets everything Day 1 and Day 2 did not. That way the whole bounty
// pool is always paid out, and with no late money it is exactly the set split.
async function buildEnvelopesForStage(env, stage, plan, s) {
  const pool = await computePool(env, s);
  const stmts = [];
  if (stage === 'day1' || stage === 'day2') {
    const stagePool = stage === 'day1' ? pool.day1EnvPool
      : Math.max(0, pool.bountyTotal - pool.finalEnvPool - await assignedEnvelopes(env, ['day1']));
    const perTable = plan.length ? Math.floor(stagePool / plan.length) : 0;
    plan.forEach(t => {
      stmts.push(env.MB.prepare(`UPDATE tables SET envelope_total = ?2 WHERE id = ?1`).bind(t.tableId, perTable));
      stmts.push(env.MB.prepare(`DELETE FROM envelopes WHERE table_id = ?1`).bind(t.tableId));
    });
  } else if (stage === 'final') {
    const t = plan[0]; if (!t) return;
    const finalPool = Math.max(0, pool.bountyTotal - await assignedEnvelopes(env, ['day1', 'day2']));
    stmts.push(env.MB.prepare(`UPDATE tables SET envelope_total = ?2 WHERE id = ?1`).bind(t.tableId, finalPool));
    stmts.push(env.MB.prepare(`DELETE FROM envelopes WHERE table_id = ?1`).bind(t.tableId));
  }
  if (stmts.length) await env.MB.batch(stmts);
}

// Regenerate a single table's sealed spread (admin "reshuffle"). Total is fixed.
async function envelopesGenerate(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const t = await env.MB.prepare(`SELECT id, envelope_total AS total FROM tables WHERE id = ?1`).bind(body.tableId).first();
  if (!t) return json({ error: 'no such table' }, 404);
  const count = Number(body.count) ||
    (await env.MB.prepare(`SELECT COUNT(*) n FROM envelopes WHERE table_id = ?1`).bind(t.id).first()).n || 0;
  const amounts = spread(Number(t.total) || 0, count);
  const stmts = [env.MB.prepare(`DELETE FROM envelopes WHERE table_id = ?1`).bind(t.id)];
  amounts.forEach((amt, i) =>
    stmts.push(env.MB.prepare(`INSERT INTO envelopes (table_id, seq, amount) VALUES (?1,?2,?3)`).bind(t.id, i + 1, amt)));
  await env.MB.batch(stmts);
  return json({ ok: true, count: amounts.length });
}

// Split one envelope equally between `n` players in whole dollars. Any
// leftover dollars (amount not divisible by n) go one each to the first takers.
function splitEqual(amount, n) {
  amount = Math.max(0, Math.round(Number(amount) || 0));
  if (n <= 1) return [amount];
  const base = Math.floor(amount / n);
  let rem = amount - base * n;
  const out = [];
  for (let i = 0; i < n; i++) { out.push(base + (rem > 0 ? 1 : 0)); if (rem > 0) rem--; }
  return out;
}

// Split `total` into `count` varied envelopes that sum EXACTLY to total.
// Uses largest-remainder apportionment over random weights (one jackpot), in
// 1M buckets when the pool is big enough, otherwise exact dollars.
function spread(total, count) {
  if (count <= 0) return [];
  total = Math.max(0, Math.round(Number(total) || 0));
  if (count === 1) return [total];
  const unit = total >= count * 1000000 ? 1000000 : 1;
  const U = Math.floor(total / unit);
  const w = [];
  for (let i = 0; i < count; i++) w.push(0.6 + Math.random());
  w[Math.floor(Math.random() * count)] += count * 0.8; // jackpot
  const wsum = w.reduce((a, b) => a + b, 0);
  const raw = w.map(x => U * x / wsum);
  const base = raw.map(Math.floor);
  let rem = U - base.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => i).sort((a, b) => (raw[b] - base[b]) - (raw[a] - base[a]));
  for (let i = 0; i < rem; i++) base[order[i % count]]++;
  const amounts = base.map(u => u * unit);
  const diff = total - amounts.reduce((a, b) => a + b, 0); // sub-unit remainder
  if (diff) amounts[0] += diff;
  for (let j = amounts.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [amounts[j], amounts[k]] = [amounts[k], amounts[j]]; }
  return amounts;
}

/* ============================ admin: stewards + table meta ============================ */
async function stewardsAdd(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const id = Number(body.tornId), name = String(body.name || '').trim();
  if (!id || !name) return json({ error: 'name and tornId required' }, 400);
  await env.MB.prepare(
    `INSERT INTO stewards (torn_id, name, active, created_at) VALUES (?1,?2,1,?3)
     ON CONFLICT(torn_id) DO UPDATE SET name = ?2, active = 1`).bind(id, name, now()).run();
  return json({ ok: true });
}
async function stewardsRemove(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  await env.MB.prepare(`UPDATE stewards SET active = 0 WHERE torn_id = ?1`).bind(Number(body.tornId)).run();
  return json({ ok: true });
}
async function tableMeta(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  await env.MB.prepare(`UPDATE tables SET timeslot = COALESCE(?2, timeslot), seating_mode = COALESCE(?3, seating_mode) WHERE id = ?1`)
    .bind(body.tableId, body.timeslot != null ? String(body.timeslot) : null, body.mode || null).run();
  return json({ ok: true });
}

/* ============================ admin: reset ============================ */
// Wipe all tournament progress and registrations back to a clean setup state.
// Keeps the admin + steward allowlists and the config numbers; clears the
// schedule so the board returns to 'setup'. Optional { keepPlayers:true }.
async function resetEvent(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stmts = [
    env.MB.prepare(`DELETE FROM tables`),
    env.MB.prepare(`DELETE FROM table_seats`),
    env.MB.prepare(`DELETE FROM placings`),
    env.MB.prepare(`DELETE FROM final_places`),
    env.MB.prepare(`DELETE FROM envelopes`),
    env.MB.prepare(`DELETE FROM knockouts`),
    env.MB.prepare(`DELETE FROM availability`),
    env.MB.prepare(`DELETE FROM donations`),
    // clear the schedule so computeStatus() falls back to 'setup', unlocking the roster
    env.MB.prepare(`DELETE FROM settings WHERE key IN ('day1_at','rebuy_at','day2_at','final_at','money_at','complete_at')`),
    env.MB.prepare(`UPDATE settings SET value = '0' WHERE key = 'roster_locked'`),
    env.MB.prepare(`UPDATE settings SET value = 'setup' WHERE key = 'tournament_status'`)
  ];
  if (!body.keepPlayers) stmts.push(env.MB.prepare(`DELETE FROM players`));
  else stmts.push(env.MB.prepare(`UPDATE players SET status='active', current_loc=NULL, rebuy_paid=0, stage_out=NULL`));
  await env.MB.batch(stmts);
  return json({ ok: true });
}

/* ============================ steward: assignment + availability ============================ */
async function assignSteward(request, env) {
  const v = await requireRole(request, env, null, 'steward');
  if (!v) return json({ error: 'steward only' }, 403);
  const body = await request.json().catch(() => ({}));
  const sid = body.stewardId ? Number(body.stewardId) : null;
  await env.MB.prepare(`UPDATE tables SET steward_id = ?2 WHERE id = ?1`).bind(body.tableId, sid).run();
  return json({ ok: true });
}
async function setStewardAvailability(request, env) {
  const v = await requireRole(request, env, null, 'steward');
  if (!v) return json({ error: 'steward only' }, 403);
  const body = await request.json().catch(() => ({}));
  const sid = Number(body.stewardId) || v.id;
  const slots = Array.isArray(body.slotIds) ? body.slotIds.map(String) : [];
  const stmts = [env.MB.prepare(`DELETE FROM steward_availability WHERE steward_id = ?1`).bind(sid)];
  slots.forEach(sl => stmts.push(env.MB.prepare(
    `INSERT OR IGNORE INTO steward_availability (steward_id, slot_id) VALUES (?1,?2)`).bind(sid, sl)));
  await env.MB.batch(stmts);
  return json({ ok: true });
}

/* ============================ steward: results ============================ */
// Record a table's finishing order. For day1/rebuy only the winner matters
// (advances). For day2 the top `advance` go to the final, the next
// `day2_to_money` finishers drop to the money table; others are out. For
// final/money we write the overall finishing places + main-pool prizes.
async function reportResult(request, env) {
  const v = await requireRole(request, env, null, 'steward');
  if (!v) return json({ error: 'steward only' }, 403);
  const body = await request.json().catch(() => ({}));
  const t = await env.MB.prepare(`SELECT id, stage, seat_size AS size FROM tables WHERE id = ?1`).bind(body.tableId).first();
  if (!t) return json({ error: 'no such table' }, 404);
  const places = (Array.isArray(body.places) ? body.places : []).map(Number).filter(Boolean);
  if (!places.length) return json({ error: 'places required' }, 400);
  const s = await readSettings(env);
  // all seated players, so losers the steward didn't list still get eliminated
  const seated = (await env.MB.prepare(`SELECT torn_id AS id FROM table_seats WHERE table_id = ?1`).bind(t.id).all()).results.map(r => Number(r.id));

  const stmts = [env.MB.prepare(`DELETE FROM placings WHERE table_id = ?1`).bind(t.id)];
  const advance = num(s, 'day2_advance', 3);
  const toMoney = num(s, 'day2_to_money', 2);  // places below the advance cutoff that drop to the money table
  const advancing = {};  // tornId -> loc for those who move on
  places.forEach((pid, i) => {
    const place = i + 1;
    let advancedTo = null;
    if (t.stage === 'day1' || t.stage === 'rebuy') advancedTo = place === 1 ? 'day2' : null;
    else if (t.stage === 'day2') advancedTo = place <= advance ? 'final' : (place <= advance + toMoney ? 'money' : null);
    stmts.push(env.MB.prepare(
      `INSERT INTO placings (table_id, place, torn_id, advanced_to, recorded_at) VALUES (?1,?2,?3,?4,?5)`
    ).bind(t.id, place, pid, advancedTo, now()));
    if (advancedTo) advancing[pid] = advancedTo;
  });
  // apply status to EVERY seated player: advancers move on, everyone else is out
  var everyone = {};
  seated.forEach(id => { everyone[id] = true; });
  places.forEach(id => { everyone[id] = true; });
  Object.keys(everyone).forEach(idStr => {
    const id = Number(idStr);
    if (advancing[id]) stmts.push(env.MB.prepare(`UPDATE players SET current_loc = ?2, status = 'active', stage_out = NULL WHERE torn_id = ?1`).bind(id, advancing[id]));
    else if (t.stage !== 'final' && t.stage !== 'money') stmts.push(env.MB.prepare(`UPDATE players SET status = 'eliminated', stage_out = ?2 WHERE torn_id = ?1`).bind(id, t.stage));
  });
  stmts.push(env.MB.prepare(`UPDATE tables SET status = 'complete' WHERE id = ?1`).bind(t.id));

  // final / money -> overall finishing places + prizes
  if (t.stage === 'final' || t.stage === 'money') {
    const pool = await computePool(env, s);
    const pay = parsePayout(s);
    const finalSeats = num(s, 'final_table_size', 9);  // money places follow the final table
    places.forEach((pid, i) => {
      const overall = t.stage === 'final' ? i + 1 : finalSeats + (i + 1);
      const pct = pay[overall - 1] || 0;
      const prize = Math.round(pool.mainTotal * pct / 100);
      stmts.push(env.MB.prepare(
        `INSERT INTO final_places (place, torn_id, prize, recorded_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(place) DO UPDATE SET torn_id=?2, prize=?3, recorded_at=?4`).bind(overall, pid, prize, now()));
    });
    if (t.stage === 'final') stmts.push(env.MB.prepare(`UPDATE players SET status = 'champion' WHERE torn_id = ?1`).bind(places[0]));
  }
  await env.MB.batch(stmts);
  // Day 2 results route the advancers; (re)seat the Final and Money tables for them automatically.
  if (t.stage === 'day2') await ensureAdvancerTables(env, s);
  return json({ ok: true });
}

// Finish a whole bounty table (Day 2 / Final) from one grid submit: each seated
// player has a finishing `position` and, if eliminated, a `by` (who busted them).
// This records every knockout AND the finishing order in one atomic write. The
// envelope amounts are assigned in bust order (worst finisher first) but stay
// sealed until the replay animation reveals them. Idempotent: re-submitting
// rebuilds the table's placings, knockouts and envelope-open flags from scratch.
async function finishTable(request, env) {
  const v = await requireRole(request, env, null, 'steward');
  if (!v) return json({ error: 'steward only' }, 403);
  const body = await request.json().catch(() => ({}));
  const t = await env.MB.prepare(`SELECT id, stage, seat_size AS size, envelope_total AS envTotal FROM tables WHERE id = ?1`).bind(body.tableId).first();
  if (!t) return json({ error: 'no such table' }, 404);
  const s = await readSettings(env);
  const seatedRows = (await env.MB.prepare(`SELECT torn_id AS id, seat_no AS seatNo FROM table_seats WHERE table_id = ?1`).bind(t.id).all()).results;
  const seatOrder = {}; seatedRows.forEach(r => { seatOrder[Number(r.id)] = Number(r.seatNo) || 0; });
  // `by` is a tornId for a knockout, or null for the winner OR a "did not play"
  // no-show (both are non-knockouts; their place still comes from `position`)
  const norm = (Array.isArray(body.entries) ? body.entries : [])
    .map(e => {
      const by = Number(e.by);
      const realBy = (Number.isFinite(by) && by > 0) ? by : null;
      // `splitWith`: other players who knocked this player out with an equal hand.
      // The envelope is then split equally between `by` and each of them.
      const raw = Array.isArray(e.splitWith) ? e.splitWith : (e.splitWith != null && e.splitWith !== '' ? [e.splitWith] : []);
      const split = realBy ? [...new Set(raw.map(Number).filter(x => Number.isFinite(x) && x > 0 && x !== realBy))] : [];
      return { id: Number(e.tornId), by: realBy, split, position: Number(e.position) || 0 };
    })
    .filter(e => e.id && seatOrder[e.id] != null);
  if (!norm.length) return json({ error: 'entries required' }, 400);
  for (const e of norm) {
    if (e.by && e.by === e.id) return json({ error: 'a player cannot knock themselves out' }, 400);
    if (e.split.indexOf(e.id) >= 0) return json({ error: 'a player cannot split their own knockout' }, 400);
    if (e.by && seatOrder[e.by] == null) return json({ error: 'the eliminator must be seated at this table' }, 400);
    for (const x of e.split) if (seatOrder[x] == null) return json({ error: 'split players must be seated at this table' }, 400);
  }
  // finishing order: by position, ties broken by seat order (duplicate positions
  // are allowed on input and just resolve to adjacent places)
  norm.sort((a, b) => (a.position - b.position) || (seatOrder[a.id] - seatOrder[b.id]));
  const places = norm.map(e => e.id);
  // the eliminated, in BUST order (worst finisher busted first) for envelope/replay order
  const busts = norm.filter(e => e.by).slice().sort((a, b) => (b.position - a.position) || (seatOrder[b.id] - seatOrder[a.id]));
  // ONE envelope per actual knockout: randomly split this table's whole bounty pool
  // into exactly that many envelopes, so there are never any left-over unopened ones
  const amounts = spread(Number(t.envTotal) || 0, busts.length);

  const stmts = [
    env.MB.prepare(`DELETE FROM placings WHERE table_id = ?1`).bind(t.id),
    env.MB.prepare(`DELETE FROM knockouts WHERE table_id = ?1`).bind(t.id),
    env.MB.prepare(`DELETE FROM envelopes WHERE table_id = ?1`).bind(t.id)
  ];
  // A split knockout (equal hands) writes one knockout row per eliminator, each
  // with an equal share of the same envelope. Knockout seq is its own running
  // count; the shared envelope_id ties the rows of one split together.
  let koSeq = 0;
  busts.forEach((e, i) => {
    const seq = i + 1, amt = amounts[i] || 0;
    stmts.push(env.MB.prepare(`INSERT INTO envelopes (table_id, seq, amount, opened) VALUES (?1,?2,?3,1)`).bind(t.id, seq, amt));
    const takers = [e.by].concat(e.split);
    const shares = splitEqual(amt, takers.length);
    takers.forEach((by, j) => {
      koSeq++;
      stmts.push(env.MB.prepare(
        `INSERT INTO knockouts (table_id, seq, eliminated_id, eliminator_id, envelope_id, amount, recorded_at, reported_by)
         VALUES (?1,?2,?3,?4,(SELECT id FROM envelopes WHERE table_id = ?1 AND seq = ?8),?5,?6,?7)`)
        .bind(t.id, koSeq, e.id, by, shares[j], now(), v.id, seq));
    });
  });
  const advance = num(s, 'day2_advance', 3);
  const toMoney = num(s, 'day2_to_money', 2);  // places below the advance cutoff that drop to the money table
  const advancing = {};
  places.forEach((pid, i) => {
    const place = i + 1;
    let advancedTo = null;
    if (t.stage === 'day1' || t.stage === 'rebuy') advancedTo = place === 1 ? 'day2' : null;
    else if (t.stage === 'day2') advancedTo = place <= advance ? 'final' : (place <= advance + toMoney ? 'money' : null);
    stmts.push(env.MB.prepare(`INSERT INTO placings (table_id, place, torn_id, advanced_to, recorded_at) VALUES (?1,?2,?3,?4,?5)`).bind(t.id, place, pid, advancedTo, now()));
    if (advancedTo) advancing[pid] = advancedTo;
  });
  const everyone = {}; seatedRows.forEach(r => { everyone[Number(r.id)] = true; }); places.forEach(id => { everyone[id] = true; });
  Object.keys(everyone).forEach(idStr => {
    const id = Number(idStr);
    if (advancing[id]) stmts.push(env.MB.prepare(`UPDATE players SET current_loc = ?2, status = 'active', stage_out = NULL WHERE torn_id = ?1`).bind(id, advancing[id]));
    else if (t.stage !== 'final' && t.stage !== 'money') stmts.push(env.MB.prepare(`UPDATE players SET status = 'eliminated', stage_out = ?2 WHERE torn_id = ?1`).bind(id, t.stage));
  });
  stmts.push(env.MB.prepare(`UPDATE tables SET status = 'complete' WHERE id = ?1`).bind(t.id));
  if (t.stage === 'final' || t.stage === 'money') {
    const pool = await computePool(env, s);
    const pay = parsePayout(s);
    const finalSeats = num(s, 'final_table_size', 9);
    places.forEach((pid, i) => {
      const overall = t.stage === 'final' ? i + 1 : finalSeats + (i + 1);
      const pct = pay[overall - 1] || 0;
      const prize = Math.round(pool.mainTotal * pct / 100);
      stmts.push(env.MB.prepare(`INSERT INTO final_places (place, torn_id, prize, recorded_at) VALUES (?1,?2,?3,?4) ON CONFLICT(place) DO UPDATE SET torn_id=?2, prize=?3, recorded_at=?4`).bind(overall, pid, prize, now()));
    });
    if (t.stage === 'final') stmts.push(env.MB.prepare(`UPDATE players SET status = 'champion' WHERE torn_id = ?1`).bind(places[0]));
  }
  await env.MB.batch(stmts);
  if (t.stage === 'day2') await ensureAdvancerTables(env, s);
  return json({ ok: true });
}

// Build/refresh the Final and Money tables from the Day 2 advancement, so no
// one has to seat them by hand. Final envelopes are built once, when first made.
async function ensureAdvancerTables(env, s) {
  const fin = (await env.MB.prepare(
    `SELECT p.torn_id AS id FROM placings pl JOIN tables t ON t.id = pl.table_id JOIN players p ON p.torn_id = pl.torn_id
     WHERE t.stage = 'day2' AND pl.advanced_to = 'final' ORDER BY pl.table_id, pl.place`).all()).results;
  const mon = (await env.MB.prepare(
    `SELECT p.torn_id AS id FROM placings pl JOIN tables t ON t.id = pl.table_id JOIN players p ON p.torn_id = pl.torn_id
     WHERE t.stage = 'day2' AND pl.advanced_to = 'money' ORDER BY pl.table_id, pl.place`).all()).results;
  const now_ = now();
  const seatInto = (id, stage, label, size, live, rows, loc) => {
    const ts = s[stage + '_time'] || null;   // admin-set table time for final/money
    const out = [
      env.MB.prepare(`INSERT INTO tables (id, stage, label, status, seat_size, bounties_live, timeslot, sort_no, created_at)
        VALUES (?1, ?2, ?3, 'live', ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET seat_size = ?4, timeslot = COALESCE(?6, timeslot)`)
        .bind(id, stage, label, size, live, ts, stageSort(stage) * 100, now_),
      env.MB.prepare(`DELETE FROM table_seats WHERE table_id = ?1`).bind(id)
    ];
    rows.forEach((r, i) => {
      out.push(env.MB.prepare(`INSERT OR IGNORE INTO table_seats (table_id, torn_id, seat_no, claimed) VALUES (?1,?2,?3,0)`).bind(id, r.id, i + 1));
      out.push(env.MB.prepare(`UPDATE players SET current_loc = ?2, status = 'active' WHERE torn_id = ?1`).bind(r.id, loc));
    });
    return out;
  };
  let stmts = [];
  if (fin.length) stmts = stmts.concat(seatInto('final', 'final', 'Final Table', num(s, 'final_table_size', 9), 1, fin, 'final'));
  if (mon.length && s.money_table_enabled !== '0') stmts = stmts.concat(seatInto('money', 'money', 'Money Table', mon.length, 0, mon, 'money'));
  if (stmts.length) await env.MB.batch(stmts);
  // build the final table's sealed envelopes once, sized to the ACTUAL advancers
  if (fin.length) {
    const have = await env.MB.prepare(`SELECT COUNT(*) n FROM envelopes WHERE table_id = 'final'`).first();
    if (!Number(have.n)) await buildEnvelopesForStage(env, 'final', [{ tableId: 'final', size: fin.length }], s);
  }
}
function parsePayout(s) {
  try { const a = JSON.parse(s.payout_structure || '[]'); return Array.isArray(a) ? a.map(Number) : []; }
  catch (e) { return []; }
}

/* ============================ steward: knockouts (the bounty core) ============================ */
// Record "eliminator busted eliminated" on a bounty table. Atomically opens the
// next sealed envelope (lowest unopened seq), credits the eliminator, and logs
// the knockout with the envelope's amount. The reveal is returned to the caller.
async function reportKnockout(request, env) {
  const v = await requireRole(request, env, null, 'steward');
  if (!v) return json({ error: 'steward only' }, 403);
  const body = await request.json().catch(() => ({}));
  const tableId = body.tableId, out = Number(body.eliminatedId), by = Number(body.eliminatorId);
  if (!tableId || !out || !by) return json({ error: 'tableId, eliminatedId, eliminatorId required' }, 400);
  if (out === by) return json({ error: 'a player cannot knock themselves out' }, 400);
  const t = await env.MB.prepare(`SELECT id, bounties_live AS live FROM tables WHERE id = ?1`).bind(tableId).first();
  if (!t) return json({ error: 'no such table' }, 404);
  if (!t.live) return json({ error: 'bounties are not live on this table' }, 400);
  // both players must be seated at this table
  const seated = (await env.MB.prepare(`SELECT torn_id AS id FROM table_seats WHERE table_id = ?1`).bind(tableId).all()).results.map(r => Number(r.id));
  if (seated.indexOf(out) < 0 || seated.indexOf(by) < 0) return json({ error: 'both players must be seated at this table' }, 400);
  // guard against double-recording the same victim
  const dup = await env.MB.prepare(`SELECT 1 FROM knockouts WHERE table_id = ?1 AND eliminated_id = ?2`).bind(tableId, out).first();
  if (dup) return json({ error: 'that player is already recorded as out' }, 400);
  // next sealed envelope
  const env1 = await env.MB.prepare(`SELECT id, seq, amount FROM envelopes WHERE table_id = ?1 AND opened = 0 ORDER BY seq LIMIT 1`).bind(tableId).first();
  if (!env1) return json({ error: 'no sealed envelopes left on this table' }, 400);
  const seqRow = await env.MB.prepare(`SELECT COALESCE(MAX(seq),0) m FROM knockouts WHERE table_id = ?1`).bind(tableId).first();
  const koSeq = Number(seqRow.m) + 1;
  await env.MB.batch([
    env.MB.prepare(`UPDATE envelopes SET opened = 1 WHERE id = ?1`).bind(env1.id),
    env.MB.prepare(
      `INSERT INTO knockouts (table_id, seq, eliminated_id, eliminator_id, envelope_id, amount, recorded_at, reported_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`).bind(tableId, koSeq, out, by, env1.id, env1.amount, now(), v.id),
    env.MB.prepare(`UPDATE players SET status = 'eliminated', stage_out = (SELECT stage FROM tables WHERE id = ?2) WHERE torn_id = ?1`).bind(out, tableId)
  ]);
  return json({ ok: true, envelope: { seq: koSeq, amount: env1.amount } });
}

// Data for the drag-and-drop seating editor: this stage's tables (with their
// seated players), the eligible players not yet seated, and each player's poll
// picks so the editor can flag bad fits.
async function getSeating(request, env, url) {
  const v = await requireRole(request, env, url, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const stage = url.searchParams.get('stage');
  if (!stage) return json({ error: 'stage required' }, 400);
  const s = await readSettings(env);
  const tables = (await env.MB.prepare(
    `SELECT id, label, timeslot, seat_size AS size FROM tables WHERE stage = ?1 ORDER BY sort_no, id`).bind(stage).all()).results;
  const seats = (await env.MB.prepare(
    `SELECT ts.table_id AS tableId, ts.torn_id AS tornId, ts.seat_no AS seatNo, p.name
       FROM table_seats ts JOIN tables t ON t.id = ts.table_id LEFT JOIN players p ON p.torn_id = ts.torn_id
      WHERE t.stage = ?1 ORDER BY ts.table_id, ts.seat_no`).bind(stage).all()).results;
  const pool = await stagePool(env, stage, s);
  const seatedIds = new Set(seats.map(r => Number(r.tornId)));
  const unseated = pool.filter(p => !seatedIds.has(Number(p.id)));
  const av = (await env.MB.prepare(`SELECT torn_id AS tornId, slot_id AS slotId FROM availability WHERE phase = ?1`).bind(stage).all()).results;
  const availability = {};
  av.forEach(r => { (availability[r.tornId] = availability[r.tornId] || []).push(r.slotId); });
  return json({ stage, tables, seats, unseated, availability });
}

// Save a hand-tuned seating for a stage (from the drag-and-drop seating editor).
// Replaces every seat on this stage's tables with the given assignment and makes
// the tables assigned-mode. `assignments` is [{ tableId, tornIds: [...] }].
async function seatManual(request, env) {
  const v = await requireRole(request, env, null, 'admin');
  if (!v) return json({ error: 'admin only' }, 403);
  const body = await request.json().catch(() => ({}));
  const stage = body.stage;
  if (!stage) return json({ error: 'stage required' }, 400);
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];
  const tableIds = (await env.MB.prepare(`SELECT id FROM tables WHERE stage = ?1`).bind(stage).all()).results.map(r => r.id);
  const idSet = new Set(tableIds);
  const stmts = tableIds.map(id => env.MB.prepare(`DELETE FROM table_seats WHERE table_id = ?1`).bind(id));
  assignments.forEach(a => {
    if (!idSet.has(a.tableId)) return;
    stmts.push(env.MB.prepare(`UPDATE tables SET seating_mode = 'assigned' WHERE id = ?1`).bind(a.tableId));
    const ids = Array.isArray(a.tornIds) ? a.tornIds.map(Number).filter(Boolean) : [];
    ids.forEach((pid, i) => {
      stmts.push(env.MB.prepare(`INSERT OR IGNORE INTO table_seats (table_id, torn_id, seat_no, claimed) VALUES (?1,?2,?3,0)`).bind(a.tableId, pid, i + 1));
      stmts.push(env.MB.prepare(`UPDATE players SET current_loc = ?2, status = 'active' WHERE torn_id = ?1`).bind(pid, stage));
    });
  });
  await env.MB.batch(stmts);
  return json({ ok: true, seated: assignments.reduce((n, a) => n + ((a.tornIds || []).length), 0) });
}

/* ============================ public: availability + claim ============================ */
async function submitAvailability(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);
  // only registered players can submit availability
  const reg = await env.MB.prepare(`SELECT 1 FROM players WHERE torn_id = ?1`).bind(who.id).first();
  if (!reg) return json({ error: 'You are not registered for this tournament.' }, 403);
  const phase = STAGE_KEYS.includes(body.phase) ? body.phase : 'day1';
  const slots = Array.isArray(body.slots) ? body.slots.map(String) : [];
  const fp = String(body.fingerprint || '');
  const stmts = [env.MB.prepare(`DELETE FROM availability WHERE torn_id = ?1 AND phase = ?2`).bind(who.id, phase)];
  slots.forEach(sl => stmts.push(env.MB.prepare(
    `INSERT OR IGNORE INTO availability (torn_id, phase, slot_id, fingerprint, submitted_at) VALUES (?1,?2,?3,?4,?5)`
  ).bind(who.id, phase, sl, fp, now())));
  await env.MB.batch(stmts);
  // Return what is now stored plus a session token, so the page can show the
  // player's saved hours on later visits without asking for the key again.
  const mine = await readMyAvailability(env, who.id, phase);
  const role = await roleOf(env, who.id);
  const token = await signToken(env, who.id, role);
  return json({ ok: true, saved: mine.slots.length, id: who.id, name: who.name, role, token, ...mine });
}

// The hours one player has saved for a phase, and when they last saved them.
async function readMyAvailability(env, id, phase) {
  const rows = (await env.MB.prepare(
    `SELECT slot_id AS slotId, submitted_at AS at FROM availability WHERE torn_id = ?1 AND phase = ?2`
  ).bind(id, phase).all()).results;
  const slots = rows.map(r => r.slotId)
    .sort((a, b) => Number(String(a).slice(1)) - Number(String(b).slice(1)));
  const submittedAt = rows.reduce((m, r) => Math.max(m, Number(r.at) || 0), 0) || null;
  return { phase, slots, submittedAt };
}

// A player reads back their own saved availability. Identity comes from a
// session token (GET, Bearer) or from a Torn key (POST, used once, not stored).
// A player can only ever read their own rows.
async function myAvailability(request, env, url) {
  let id, name = null, extra = {}, phaseIn;
  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const who = await identify(body.key);
    if (who.error) return json({ error: who.error }, 400);
    id = who.id; name = who.name; phaseIn = body.phase;
    const role = await roleOf(env, id);
    extra = { role, token: await signToken(env, id, role) };
  } else {
    const v = await requireRole(request, env, url, 'player');
    if (!v) return json({ error: 'Session expired. Paste your Torn API key again.' }, 401);
    id = v.id; phaseIn = url.searchParams.get('phase');
  }
  const reg = await env.MB.prepare(`SELECT name FROM players WHERE torn_id = ?1`).bind(id).first();
  if (!reg) return json({ error: 'You are not registered for this tournament.' }, 403);
  const phase = STAGE_KEYS.includes(phaseIn) ? phaseIn : 'day1';
  const mine = await readMyAvailability(env, id, phase);
  return json({ ok: true, id, name: name || reg.name, ...extra, ...mine });
}

// First-come-first-served seat claim on a 'claim' table.
async function claimSeat(request, env) {
  const body = await request.json().catch(() => ({}));
  const who = await identify(body.key);
  if (who.error) return json({ error: who.error }, 400);
  // only registered players can claim a seat
  const reg = await env.MB.prepare(`SELECT 1 FROM players WHERE torn_id = ?1`).bind(who.id).first();
  if (!reg) return json({ error: 'You are not registered for this tournament.' }, 403);
  const t = await env.MB.prepare(`SELECT id, stage, seat_size AS size, seating_mode AS mode FROM tables WHERE id = ?1`).bind(body.tableId).first();
  if (!t) return json({ error: 'no such table' }, 404);
  if (t.mode !== 'claim') return json({ error: 'this table is not open for claiming' }, 400);
  // first-come-first-served selection only opens at the stage's selection time
  const s = await readSettings(env);
  const selAt = Number(s[t.stage + '_select_at']);
  if (selAt && Math.floor(Date.now() / 1000) < selAt) return json({ error: 'Table selection has not opened yet.' }, 400);
  // a player can only hold one seat in a stage
  await env.MB.prepare(`DELETE FROM table_seats WHERE torn_id = ?1 AND table_id IN (SELECT id FROM tables WHERE stage = ?2) AND claimed = 1`).bind(who.id, t.stage).run();
  // Atomic claim: the capacity check and the seat insert are ONE statement, so two
  // players racing for the last seat can't both read the same count and both get in
  // (which previously over-seated the table and duplicated seat numbers). The seat
  // number is computed inside the statement, and the row is only written while the
  // table is still under capacity.
  const res = await env.MB.prepare(
    `INSERT INTO table_seats (table_id, torn_id, seat_no, claimed)
     SELECT ?1, ?2, (SELECT COUNT(*) FROM table_seats WHERE table_id = ?1) + 1, 1
     WHERE (SELECT COUNT(*) FROM table_seats WHERE table_id = ?1) < ?3
     ON CONFLICT(table_id, torn_id) DO NOTHING`
  ).bind(t.id, who.id, Number(t.size)).run();
  const wrote = res && res.meta && (res.meta.changes || res.meta.rows_written);
  if (!wrote) return json({ error: 'table is full' }, 400);
  const row = await env.MB.prepare(`SELECT seat_no AS seatNo FROM table_seats WHERE table_id = ?1 AND torn_id = ?2`).bind(t.id, who.id).first();
  return json({ ok: true, seat: row ? row.seatNo : null });
}

/* ============================ helpers ============================ */
function now() { return Math.floor(Date.now() / 1000); }
async function setSetting(env, k, val) {
  await env.MB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=?3`).bind(k, String(val), now()).run();
}
function stageSort(stage) { return { day1: 1, rebuy: 2, day2: 3, final: 4, money: 5 }[stage] || 9; }
function tableLabel(stage, n) {
  const names = { day1: 'Day 1 · Table ', rebuy: 'Rebuy · Table ', day2: 'Day 2 · Table ' };
  if (stage === 'final') return 'Final Table';
  if (stage === 'money') return 'Money Table';
  return (names[stage] || stage + ' ') + n;
}

/* ---- HMAC session tokens: "{id}.{role}.{exp}.{hexsig}" ---- */
async function hmacKey(env) {
  const secret = env.SESSION_SECRET || 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(env, id, role) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const bodyStr = `${id}.${role}.${exp}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(bodyStr));
  return `${bodyStr}.${hex(sig)}`;
}
async function verifyToken(env, token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 4) return null;
  const [id, role, exp, sig] = parts;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromHex(sig),
    new TextEncoder().encode(`${id}.${role}.${exp}`));
  return ok ? { id: Number(id), role } : null;
}
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

/* ---- JSON response ---- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
