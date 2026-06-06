'use strict';
/**
 * server.js — Authoritative game server
 * Node.js + ws  ·  20 Hz tick  ·  4 runners + 1 master
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');
const S     = require('../shared.js');   // SHARED

const PORT  = process.env.PORT || 3000;

// ──────────────────────────────────────────────────────────────────────────────
// HTTP — serve /public  +  /shared.js
// ──────────────────────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'application/javascript',
  '.css':'text/css','.png':'image/png','.ico':'image/x-icon',
};
const httpServer = http.createServer((req, res) => {
  let fp = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (fp === '/shared.js') fp = path.join(__dirname, 'shared.js');
  else                     fp = path.join(__dirname, 'public', fp);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Message types (protocol)
// ──────────────────────────────────────────────────────────────────────────────
const T = {
  // C→S
  JOIN:     'JOIN',
  SET_ROLE: 'SET_ROLE',
  READY:    'READY',
  INPUT:    'INPUT',
  ABILITY:  'ABILITY',   // master uses ability

  // S→C
  LOBBY:    'LOBBY',
  START:    'START',
  TICK:     'TICK',
  ACK:      'ACK',       // reconcile ack  {ackSeq, state}
  NOTIFY:   'NOTIFY',    // toast message  {msg, color}
  PATCH:    'PATCH',     // platform / trap delta
  OVER:     'OVER',      // game over      {winnerId, winnerName}
  ERR:      'ERR',
};

const PLAYER_COLORS = ['#34d399','#60a5fa','#fb923c','#f472b6'];

// ──────────────────────────────────────────────────────────────────────────────
// Global state
// ──────────────────────────────────────────────────────────────────────────────
let nextId   = 1;
let lobby    = {
  phase  : 'waiting',   // 'waiting' | 'playing' | 'ended'
  players: {},          // id → PlayerRecord
};
let game     = null;    // GameState | null

// ──────────────────────────────────────────────────────────────────────────────
// Ability definitions (cost, cooldown in ticks, duration in ticks)
// ──────────────────────────────────────────────────────────────────────────────
const ABILITIES = {
  // ── traps ──────────────────────────────────────
  spike:    { cost:20, cd:220, type:'trap' },
  wind:     { cost:18, cd:180, type:'trap', duration:260 },
  fall:     { cost:25, cd:280, type:'trap' },   // remove a platform temporarily

  // ── bonuses ─────────────────────────────────────
  speed:    { cost:15, cd:150, type:'bonus' },
  checkpoint:{ cost:22, cd:280, type:'bonus' }, // temp safe platform
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function ws_send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}
function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  for (const [id, pr] of Object.entries(lobby.players)) {
    if (String(id) === String(excludeId)) continue;
    if (pr.ws.readyState === 1) pr.ws.send(msg);
  }
}
function broadcastAll(data) { broadcast(data, null); }

function lobbySnapshot() {
  return {
    type  : T.LOBBY,
    phase : lobby.phase,
    players: Object.values(lobby.players).map(p => ({
      id: p.id, name: p.name, role: p.role, ready: p.ready, color: p.color,
    })),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Game startup
// ──────────────────────────────────────────────────────────────────────────────
function startGame() {
  lobby.phase = 'playing';

  const platforms    = S.buildPlatforms();
  const masterPlayer = Object.values(lobby.players).find(p => p.role === 'master');

  const runners = Object.values(lobby.players)
    .filter(p => p.role === 'runner')
    .map((p, i) => ({
      id: p.id, name: p.name, color: p.color,
      x: 60 + i * 110, y: S.WORLD_H - 80,
      vx: 0, vy: 0,
      onGround: false, jumpsLeft: 1,
      speedBoost: 0, jumpBoost: 0, shieldTimer: 0,
      finished: false, rank: 0,
      respawnX: 60 + i * 110, respawnY: S.WORLD_H - 80,
    }));

  game = {
    tick          : 0,
    platforms,
    tempPlatforms : [],   // {id, x, y, w, h, timer, maxTimer}
    traps         : [],   // {id, type, x, y, timer}
    trapId        : 0,
    tempPlatId    : 0,
    runners,
    masterId      : masterPlayer ? masterPlayer.id : null,
    inputQueues   : {},   // runnerId → [{seq,input,tick}]
    masterEnergy  : 100,
    masterMax     : 100,
    cooldowns     : {},   // abilityId → ticksLeft
    globalWind    : 0,
    windTimer     : 0,
    finishCount   : 0,
    loopInterval  : null,
  };
  for (const r of runners) game.inputQueues[r.id] = [];

  broadcastAll({
    type         : T.START,
    platforms    : serializePlats(platforms),
    runners      : serializeRunners(runners),
    tempPlatforms: [],
    traps        : [],
    masterId     : game.masterId,
  });

  game.loopInterval = setInterval(gameTick, S.TICK_MS);
  console.log(`[game] started — ${runners.length} runner(s), master: ${game.masterId}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Serialisers
// ──────────────────────────────────────────────────────────────────────────────
function serializePlats(ps) {
  return ps.map(p => ({
    id: p.id, x: p.x, y: p.y, w: p.w, h: p.h,
    type: p.type, slippery: p.slippery, removed: p.removed,
  }));
}
function serializeRunners(rs) {
  return rs.map(r => ({
    id: r.id, name: r.name, color: r.color,
    x: r.x, y: r.y, vx: r.vx, vy: r.vy,
    onGround: r.onGround, speedBoost: r.speedBoost,
    shieldTimer: r.shieldTimer, finished: r.finished, rank: r.rank,
  }));
}
function serializeTraps(ts) {
  return ts.map(t => ({ id: t.id, type: t.type, x: t.x, y: t.y, timer: t.timer }));
}
function serializeTempPlats(ts) {
  return ts.map(t => ({
    id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, timer: t.timer, maxTimer: t.maxTimer,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Main game tick (20 Hz)
// ──────────────────────────────────────────────────────────────────────────────
function gameTick() {
  if (!game) return;
  game.tick++;

  // 1. Regen master energy
  game.masterEnergy = Math.min(game.masterMax, game.masterEnergy + 0.14);
  for (const k of Object.keys(game.cooldowns)) {
    if (game.cooldowns[k] > 0) game.cooldowns[k]--;
  }

  // 2. Wind timer
  if (game.windTimer > 0) {
    game.windTimer--;
    if (game.windTimer === 0) game.globalWind = 0;
  }

  // 3. Process runner inputs
  //    Apply every queued input in sequence (not just the last one).
  //    The client sends at ~60 fps, server ticks at 20 Hz, so ~3 inputs
  //    arrive per tick. Discarding all but the last causes the server
  //    position to perpetually lag, making reconciliation snap every tick.
  for (const runner of game.runners) {
    if (runner.finished) continue;
    const queue  = game.inputQueues[runner.id] || [];
    queue.sort((a, b) => a.seq - b.seq);
    game.inputQueues[runner.id] = [];

    // Default: repeat last known input if queue is empty (client on bad connection)
    if (queue.length === 0) queue.push({ seq: -1, input: { left:false, right:false, jump:false } });

    const allPlats = [...game.platforms, ...game.tempPlatforms];
    let lastSeq = -1;

    for (const item of queue) {
      // Step physics once per received input
      const next = S.stepPlayer(runner, item.input, allPlats, game.globalWind);
      Object.assign(runner, next);
      if (item.seq > lastSeq) lastSeq = item.seq;
    }

    // Ack the highest seq processed → client discards those from its replay buffer
    if (lastSeq >= 0) {
      const pr = lobby.players[runner.id];
      if (pr) ws_send(pr.ws, {
        type  : T.ACK,
        ackSeq: lastSeq,
        state : {
          x:           runner.x,
          y:           runner.y,
          vx:          runner.vx,
          vy:          runner.vy,
          onGround:    runner.onGround,
          jumpsLeft:   runner.jumpsLeft,
          speedBoost:  runner.speedBoost,
          shieldTimer: runner.shieldTimer,
          tick:        game.tick,
        },
      });
    }

    // Goal check — player must be physically ON the goal platform.
    // The old check used `runner.y + PLAYER_H >= goal.y` which is true for
    // every y value in the world (goal.y = 52, runner starts near y = 2920).
    // Fix: require the player's feet to be within a small band around goal.y.
    const goal = game.platforms.find(p => p.type === 'goal');
    if (goal && !runner.finished &&
        runner.x + S.PLAYER_W > goal.x && runner.x < goal.x + goal.w &&
        runner.y + S.PLAYER_H >= goal.y && runner.y + S.PLAYER_H <= goal.y + goal.h + 16 &&
        runner.vy >= 0) {
      runner.finished = true;
      runner.rank     = ++game.finishCount;
      broadcastAll({ type: T.OVER, winnerId: runner.id, winnerName: runner.name });
      scheduleReset();
      return;
    }

    // Fall off world
    if (runner.y > S.WORLD_H + 200) {
      runner.x = runner.respawnX; runner.y = runner.respawnY;
      runner.vx = 0; runner.vy = 0;
      broadcastAll({ type: T.NOTIFY, msg: `${runner.name} fell!`, color: '#ef4444' });
    }
  }

  // 4. Tick traps
  for (let i = game.traps.length - 1; i >= 0; i--) {
    const t = game.traps[i];
    t.timer--;

    if (t.type === 'spike' && t.timer > 0) {
      for (const r of game.runners) {
        if (r.finished || r.shieldTimer > 0) continue;
        if (r.x < t.x + 18 && r.x + S.PLAYER_W > t.x &&
            r.y < t.y + 18 && r.y + S.PLAYER_H > t.y) {
          r.vy = -9; r.vx = r.x > t.x ? 7 : -7;
          r.shieldTimer = 80;
          broadcastAll({ type: T.NOTIFY, msg: `⚡ ${r.name} hit!`, color: '#fca5a5' });
        }
      }
    }

    if (t.timer <= 0) game.traps.splice(i, 1);
  }

  // 5. Tick temp platforms
  for (let i = game.tempPlatforms.length - 1; i >= 0; i--) {
    const p = game.tempPlatforms[i];
    p.timer--;
    if (p.timer <= 0) {
      game.tempPlatforms.splice(i, 1);
      broadcastAll({ type: T.PATCH, action: 'rm_temp', id: p.id });
    }
  }

  // 6. Tick permanent platform timers
  S.tickPlatforms(game.platforms);

  // 7. Broadcast authoritative state
  broadcastAll({
    type         : T.TICK,
    tick         : game.tick,
    runners      : serializeRunners(game.runners),
    traps        : serializeTraps(game.traps),
    tempPlatforms: serializeTempPlats(game.tempPlatforms),
    platforms    : serializePlats(game.platforms),  // includes removed flags
    masterEnergy : game.masterEnergy,
    cooldowns    : game.cooldowns,
    wind         : game.globalWind,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Master ability handler
// ──────────────────────────────────────────────────────────────────────────────
function handleAbility(senderId, { ability, x, y }) {
  if (!game) return;
  if (String(game.masterId) !== String(senderId)) return;

  const def = ABILITIES[ability];
  if (!def) return;

  if (game.masterEnergy < def.cost) {
    ws_send(lobby.players[senderId]?.ws, { type: T.NOTIFY, msg: 'Not enough energy!', color: '#ef4444' });
    return;
  }
  if ((game.cooldowns[ability] || 0) > 0) {
    ws_send(lobby.players[senderId]?.ws, { type: T.NOTIFY, msg: 'On cooldown!', color: '#f59e0b' });
    return;
  }

  game.masterEnergy -= def.cost;
  game.cooldowns[ability] = def.cd;
  const wx = x, wy = y;

  switch (ability) {
    case 'spike': {
      const trap = { id: game.trapId++, type: 'spike', x: wx - 9, y: wy - 8, timer: 180 };
      game.traps.push(trap);
      broadcastAll({ type: T.PATCH, action: 'add_trap', trap });
      broadcastAll({ type: T.NOTIFY, msg: '⚡ Spike placed!', color: '#ef4444' });
      break;
    }
    case 'wind': {
      game.globalWind = Math.random() > 0.5 ? 1 : -1;
      game.windTimer  = def.duration;
      broadcastAll({ type: T.PATCH, action: 'wind', wind: game.globalWind, timer: def.duration });
      broadcastAll({ type: T.NOTIFY, msg: `🌬️ Wind! (${game.globalWind > 0 ? '→' : '←'})`, color: '#93c5fd' });
      break;
    }
    case 'fall': {
      // Remove nearest non-critical platform temporarily
      let best = null, bestD = 90;
      for (const p of game.platforms) {
        if (p.removed || p.type === 'goal' || p.type === 'ground') continue;
        const d = Math.hypot(p.x + p.w / 2 - wx, p.y - wy);
        if (d < bestD) { best = p; bestD = d; }
      }
      if (best) {
        best.removed = true; best.removedTimer = 340;
        broadcastAll({ type: T.PATCH, action: 'rm_plat', id: best.id, restoreIn: 340 });
        broadcastAll({ type: T.NOTIFY, msg: '💥 Platform gone!', color: '#f87171' });
      }
      break;
    }
    case 'speed': {
      const target = nearestRunner(wx, wy);
      if (target) {
        target.speedBoost = 180;
        broadcastAll({ type: T.NOTIFY, msg: `💨 ${target.name} speed!`, color: '#4ade80' });
      }
      break;
    }
    case 'checkpoint': {
      const tp = {
        id: `tp${game.tempPlatId++}`,
        x: wx - 45, y: wy,
        w: 90, h: 14,
        timer: 380, maxTimer: 380,
      };
      game.tempPlatforms.push(tp);
      broadcastAll({ type: T.PATCH, action: 'add_temp', plat: tp });
      broadcastAll({ type: T.NOTIFY, msg: '🟦 Safe platform!', color: '#34d399' });
      break;
    }
  }
}

function nearestRunner(wx, wy) {
  let best = null, bestD = Infinity;
  for (const r of game.runners) {
    if (r.finished) continue;
    const d = Math.hypot(r.x + S.PLAYER_W / 2 - wx, r.y + S.PLAYER_H / 2 - wy);
    if (d < bestD) { best = r; bestD = d; }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────────
// Game reset
// ──────────────────────────────────────────────────────────────────────────────
function scheduleReset() {
  if (game?.loopInterval) clearInterval(game.loopInterval);
  game = null;
  lobby.phase = 'ended';
  setTimeout(() => {
    lobby.phase = 'waiting';
    for (const p of Object.values(lobby.players)) { p.ready = false; p.role = null; }
    broadcastAll(lobbySnapshot());
  }, 6000);
}

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket server
// ──────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const playerCount = Object.keys(lobby.players).length;

  if (playerCount >= 5) { // 4 runners + 1 master
    ws_send(ws, { type: T.ERR, msg: 'Lobby full (max 5).' });
    ws.close(); return;
  }
  if (lobby.phase === 'playing') {
    ws_send(ws, { type: T.ERR, msg: 'Match in progress.' });
    ws.close(); return;
  }

  const id    = nextId++;
  const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
  lobby.players[id] = { id, name: `P${id}`, role: null, ready: false, ws, color };

  console.log(`[lobby] player ${id} joined  (${Object.keys(lobby.players).length} total)`);

  // Send this player their id + current lobby state
  ws_send(ws, { type: T.LOBBY, yourId: id, yourColor: color, ...lobbySnapshot() });
  broadcast(lobbySnapshot(), id);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const pr = lobby.players[id];

    switch (msg.type) {
      case T.JOIN: {
        if (msg.name) pr.name = msg.name.trim().slice(0, 16) || pr.name;
        broadcastAll(lobbySnapshot());
        break;
      }
      case T.SET_ROLE: {
        if (lobby.phase !== 'waiting') break;
        if (msg.role === 'master') {
          const taken = Object.values(lobby.players).find(p => p.id !== id && p.role === 'master');
          if (taken) { ws_send(ws, { type: T.ERR, msg: 'Master role taken.' }); break; }
        }
        pr.role = msg.role; pr.ready = false;
        broadcastAll(lobbySnapshot());
        break;
      }
      case T.READY: {
        if (lobby.phase !== 'waiting' || !pr.role) break;
        pr.ready = !!msg.ready;
        broadcastAll(lobbySnapshot());
        tryAutoStart();
        break;
      }
      case T.INPUT: {
        if (lobby.phase !== 'playing' || !game) break;
        const q = game.inputQueues[id];
        if (q) q.push({ seq: msg.seq, input: msg.input, tick: msg.tick });
        break;
      }
      case T.ABILITY: {
        if (lobby.phase !== 'playing') break;
        handleAbility(id, msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    delete lobby.players[id];
    console.log(`[lobby] player ${id} left  (${Object.keys(lobby.players).length} remain)`);
    if (game) {
      const idx = game.runners.findIndex(r => r.id === id);
      if (idx !== -1) game.runners.splice(idx, 1);
      delete game.inputQueues[id];
      if (game.runners.length === 0) scheduleReset();
    }
    broadcastAll(lobbySnapshot());
  });
});

function tryAutoStart() {
  const all     = Object.values(lobby.players);
  const allReady = all.length >= 2 && all.every(p => p.ready && p.role);
  const hasRunner = all.some(p => p.role === 'runner');
  const hasMaster = all.some(p => p.role === 'master');
  if (allReady && hasRunner && hasMaster) startGame();
}

httpServer.listen(PORT, () => {
  console.log(`\n🎮  Chaos Climb  →  http://localhost:${PORT}\n`);
});