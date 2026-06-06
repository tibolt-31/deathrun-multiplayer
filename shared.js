/**
 * shared.js — Deterministic physics & level data shared by server AND client.
 * No DOM, no WebSocket, no Node APIs — pure functions only.
 * Exported as SHARED global (browser) or module.exports (Node).
 */
const SHARED = (() => {

// ─── Physics ──────────────────────────────────────────────────────────────────
const GRAVITY      = 0.52;
const JUMP_FORCE   = -13.2;
const MOVE_SPEED   = 3.8;
const FRICTION_GND = 0.75;
const FRICTION_AIR = 0.92;
const MAX_FALL_SPD = 20;
const PLAYER_W     = 22;
const PLAYER_H     = 30;
const WORLD_W      = 480;
const WORLD_H      = 3000;
const TICK_RATE    = 20;
const TICK_MS      = 1000 / TICK_RATE;

// ─── Level ────────────────────────────────────────────────────────────────────
function buildPlatforms() {
  const H  = WORLD_H;
  const PH = 14;
  let   id = 0;
  const ps = [];

  const add = (x, yFromBottom, w, type = 'normal') =>
    ps.push({ id: id++, x, y: H - yFromBottom, w, h: PH, type,
              slippery: false, removed: false, removedTimer: 0 });

  // Ground
  ps.push({ id: id++, x: 0, y: H - 28, w: WORLD_W, h: 28, type: 'ground',
            slippery: false, removed: false, removedTimer: 0 });

  // Goal
  ps.push({ id: id++, x: WORLD_W / 2 - 70, y: 52, w: 140, h: PH, type: 'goal',
            slippery: false, removed: false, removedTimer: 0 });

  // Layout: [x, yFromBottom, width]  — hand-designed for good flow
  const rows = [
    [50,  95, 110], [270, 95, 110],
    [150,160,  90], [330,185,  80],
    [ 30,230,  80], [210,250,  95], [360,210, 75],
    [100,305,  90], [280,320,  85],
    [ 40,375,  80], [190,390, 100], [355,360, 75],
    [120,445,  85], [300,460,  90],
    [ 50,515,  80], [230,530,  95], [370,505, 70],
    [ 90,585,  90], [260,600,  80],
    [ 30,655,  75], [180,670, 100], [350,645, 80],
    [110,725,  85], [290,740,  80],
    [ 60,795,  80], [220,810,  95], [370,785, 70],
    [100,865,  90], [270,880,  80],
    [ 40,935,  75], [190,950, 100], [360,925, 80],
    [120,1005, 85], [295,1020, 80],
    [ 55,1075, 80], [225,1090, 95], [370,1065,70],
    [100,1145, 90], [270,1160, 80],
    [ 35,1215, 80], [185,1230,100], [355,1205,75],
    [115,1285, 85], [290,1300, 80],
    [ 60,1355, 80], [220,1370, 95], [365,1345,70],
    [ 95,1425, 90], [265,1440, 80],
    [ 40,1495, 80], [190,1510,100], [360,1485,75],
    [120,1565, 85], [295,1580, 80],
    [ 55,1635, 80], [225,1650, 95], [370,1625,70],
    [100,1705, 90], [270,1720, 80],
    [ 35,1775, 75], [185,1790,100], [355,1765,80],
    [115,1845, 85], [290,1860, 80],
    [ 60,1915, 80], [220,1930, 95], [365,1905,70],
    [ 95,1985, 90], [265,2000, 80],
    [ 40,2055, 80], [190,2070,100], [360,2045,75],
    [120,2125, 85], [295,2140, 80],
    [ 55,2195, 80], [225,2210, 95], [370,2185,70],
    [100,2265, 90], [270,2280, 80],
    [ 35,2335, 75], [185,2350,100], [355,2325,80],
    [115,2405, 85], [290,2420, 80],
    [ 60,2475, 80], [220,2490, 95], [365,2465,70],
    [ 95,2545, 90], [265,2560, 80],
    [ 40,2615, 80], [185,2630,100], [360,2605,75],
    [120,2685, 85], [295,2700, 80],
    [ 55,2755, 80], [225,2770, 95], [370,2745,70],
    [100,2825, 90], [270,2840, 80],
    [150,2900, 95], [310,2900, 90],
    [190,2945,100],
  ];
  rows.forEach(([x, y, w, t]) => add(x, y, w, t || 'normal'));
  return ps;
}

// ─── Physics step (deterministic) ────────────────────────────────────────────
/**
 * @param {object} p  player state {x,y,vx,vy,onGround,jumpsLeft,...}
 * @param {object} in input {left,right,jump}
 * @param {Array}  platforms  array of platform objects
 * @param {number} windForce  horizontal wind bias (0 = none)
 * @returns {object}  new player state (mutates a clone)
 */
function stepPlayer(p, inp, platforms, windForce = 0) {
  let { x, y, vx, vy, onGround, jumpsLeft = 1,
        speedBoost = 0, jumpBoost = 0, shieldTimer = 0 } = p;

  const spd = MOVE_SPEED + (speedBoost > 0 ? 2.2 : 0);

  if (inp.left)        vx = -spd;
  else if (inp.right)  vx =  spd;
  else                 vx *= onGround ? FRICTION_GND : FRICTION_AIR;

  vx += windForce * 0.06;

  if (inp.jump && jumpsLeft > 0) {
    vy = JUMP_FORCE + (jumpBoost > 0 ? -1.5 : 0);
    jumpsLeft--;
    onGround = false;
  }

  vy = Math.min(vy + GRAVITY, MAX_FALL_SPD);
  x += vx;
  y += vy;
  x  = Math.max(0, Math.min(WORLD_W - PLAYER_W, x));

  // Platform collision
  onGround = false;
  for (const pl of platforms) {
    if (pl.removed) continue;
    if (pl.type === 'wind_zone') continue;
    if (x + PLAYER_W <= pl.x || x >= pl.x + pl.w) continue;
    const prevBot = (y - vy) + PLAYER_H;
    if (vy >= 0 && prevBot <= pl.y + 3 && y + PLAYER_H >= pl.y && y + PLAYER_H <= pl.y + pl.h + 12) {
      y        = pl.y - PLAYER_H;
      vy       = 0;
      onGround = true;
      jumpsLeft = 1;
      vx      *= pl.slippery ? 0.96 : FRICTION_GND;
      if (pl.type === 'launch') vy = -22;
    }
  }

  if (speedBoost  > 0) speedBoost--;
  if (jumpBoost   > 0) jumpBoost--;
  if (shieldTimer > 0) shieldTimer--;

  return { x, y, vx, vy, onGround, jumpsLeft, speedBoost, jumpBoost, shieldTimer };
}

// ─── Platform tick (decrement timers) ────────────────────────────────────────
function tickPlatforms(platforms) {
  for (const p of platforms) {
    if (p.removed && p.removedTimer > 0) {
      p.removedTimer--;
      if (p.removedTimer <= 0) p.removed = false;
    }
  }
}

return {
  GRAVITY, JUMP_FORCE, MOVE_SPEED, FRICTION_GND, FRICTION_AIR,
  MAX_FALL_SPD, PLAYER_W, PLAYER_H, WORLD_W, WORLD_H, TICK_RATE, TICK_MS,
  buildPlatforms, stepPlayer, tickPlatforms,
};
})();

if (typeof module !== 'undefined') module.exports = SHARED;
