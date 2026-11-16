// main.js — bootstrap and render loop for GONDOLA. The sim (sim.js) owns the
// world and steps at a fixed 60 Hz; this module owns the renderer, the camera,
// the keyboard/mouse, the viewmodel, tracers, smoke puffs, the bomb mesh and
// the deathcam. It also owns the URL scene modes (?scene=cover|play|buy|
// results) and the ?autopilot=1 driver the screenshots and the validation use,
// plus the window.__GONDOLA__ debug hooks the validation reads.
import * as THREE from 'three';
import { createGame, startMatch, step, summary, STEP } from './sim.js';
import { startBuyPhase } from './rounds.js';
import { HUD } from './hud.js';
import { createViewmodel, updateMovement, fireHitscan, damageEntity, startReload, switchWeapon, eyePos } from './player.js';
import { buyItem } from './economy.js';
import { clamp, fmtMoney } from './utils.js';

const params = new URLSearchParams(location.search);
const SEED = parseInt(params.get('seed') || '20261117', 10);
const AUTOPILOT = params.get('autopilot') === '1';
const SCENE = params.get('scene') || '';
const TEST_MODE = params.get('test') === '1';

// Console errors are collected for the validation harness — a clean run is 0.
window.__errors = [];
window.addEventListener('error', (ev) => {
  window.__errors.push(String(ev.message || ev.error || 'error'));
});
const _consoleError = console.error.bind(console);
console.error = (...args) => {
  window.__errors.push(args.map(String).join(' '));
  _consoleError(...args);
};

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);

const sim = createGame(scene, { seed: SEED, autopilot: AUTOPILOT });
const hud = new HUD(sim, {
  onBuy: (itemId) => {
    const you = sim.players.find((p) => p.isPlayer);
    if (!you || sim.phase !== 'buy') {
      hud.showBuyMsg('Buy menu is only open between rounds.');
      return;
    }
    const res = buyItem(you, itemId);
    hud.showBuyMsg(res.reason);
    if (res.ok) sim.sound.buy();
    hud.refreshBuy();
  },
});
const viewmodel = createViewmodel(camera);
const you = sim.players.find((p) => p.isPlayer);

// --- bomb mesh: a small orange case with a blinking light, shown when planted or dropped. ---
const bombGroup = new THREE.Group();
const bombCase = new THREE.Mesh(
  new THREE.BoxGeometry(0.55, 0.3, 0.4),
  new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.5, metalness: 0.4 }),
);
bombCase.position.y = 0.15;
bombGroup.add(bombCase);
const bombLight = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 10, 8),
  new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff3b30, emissiveIntensity: 1 }),
);
bombLight.position.set(0, 0.36, 0);
bombGroup.add(bombLight);
bombGroup.visible = false;
scene.add(bombGroup);

// --- tracer lines and smoke puffs, rebuilt from the sim's lists each frame. ---
const tracerGroup = new THREE.Group();
scene.add(tracerGroup);
const smokeGroup = new THREE.Group();
scene.add(smokeGroup);
const smokeMat = new THREE.MeshStandardMaterial({
  color: 0xdfe6ea, roughness: 1, transparent: true, opacity: 0.55,
});
const smokeMeshes = new Map();

// --- input state. ---
const keys = new Set();
let mouseDX = 0;
let mouseDY = 0;
let firing = false;
let scoped = false;
let pointerLocked = false;
let deathcamT = 0;
let spectateTarget = null;
let lastEventN = 0;

addEventListener('keydown', (ev) => {
  if (ev.repeat) return;
  keys.add(ev.code);
  if (ev.code === 'KeyR') startReload(you);
  if (ev.code === 'Digit1') switchWeapon(you, 'secondary');
  if (ev.code === 'Digit2') switchWeapon(you, 'primary');
  if (ev.code === 'Digit3') throwGrenade('smoke');
  if (ev.code === 'Digit4') throwGrenade('flash');
  if (ev.code === 'KeyB' && sim.phase === 'buy') hud.showBuy(!document.getElementById('buy').classList.contains('hidden') ? false : true);
  if (ev.code === 'Tab') {
    ev.preventDefault();
    showScoreboard(true);
  }
  if (ev.code === 'KeyM') sim.sound.setMuted(!sim.sound.muted);
  if (ev.code === 'KeyE') {
    // Plant / defuse intent is read every step; the key just arms it.
  }
  // Buy-menu number keys.
  if (sim.phase === 'buy' && /^Digit[1-8]$/.test(ev.code)) {
    const items = document.querySelectorAll('#buy-items .buy-row');
    const row = items[parseInt(ev.code.slice(5), 10) - 1];
    if (row) row.click();
  }
  if (ev.code === 'KeyR' && sim.phase === 'matchEnd') {
    startMatch(sim);
    hud.showResults(false);
    hud.showTitle(false);
  }
});
addEventListener('keyup', (ev) => {
  keys.delete(ev.code);
  if (ev.code === 'Tab') showScoreboard(false);
});
addEventListener('mousedown', (ev) => {
  if (ev.button === 0) firing = true;
  if (ev.button === 2) scoped = true;
});
addEventListener('mouseup', (ev) => {
  if (ev.button === 0) firing = false;
  if (ev.button === 2) scoped = false;
});
addEventListener('mousemove', (ev) => {
  if (!pointerLocked) return;
  mouseDX += ev.movementX || 0;
  mouseDY += ev.movementY || 0;
});
addEventListener('contextmenu', (ev) => ev.preventDefault());
renderer.domElement.addEventListener('click', () => {
  if (sim.phase === 'play' || sim.phase === 'buy') {
    sim.sound.ensure();
    if (!AUTOPILOT && document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock();
    }
  }
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- grenades: smoke blocks sight (bots + minimap), flash blinds facing bots. ---
function throwGrenade(kind) {
  if (!you.alive || sim.phase !== 'play') return;
  if (you.grenades[kind] <= 0) {
    hud.toast('No ' + kind + ' grenade — buy one in the buy menu (B).');
    return;
  }
  you.grenades[kind] -= 1;
  const eye = eyePos(you, throwGrenade._eye || (throwGrenade._eye = new THREE.Vector3()));
  const cp = Math.cos(you.pitch);
  const dx = -Math.sin(you.yaw) * cp;
  const dy = Math.sin(you.pitch);
  const dz = -Math.cos(you.yaw) * cp;
  const tx = eye.x + dx * 9;
  const ty = Math.max(1.2, eye.y + dy * 9);
  const tz = eye.z + dz * 9;
  if (kind === 'smoke') {
    sim.smokes.push({ x: tx, y: ty, z: tz, r: 3.4, ttl: 12 });
    hud.toast('Smoke out!');
  } else {
    sim.sound.flash();
    hud.flashbang(0.85);
    for (const p of sim.players) {
      if (!p.isBot || !p.alive || p.team === you.team) continue;
      const d = Math.hypot(p.pos.x - you.pos.x, p.pos.z - you.pos.z);
      if (d < 26) p.ai.blindedT = 2.5;
    }
    hud.toast('Flash out!');
  }
}

// --- scoreboard overlay (Tab). ---
function showScoreboard(show) {
  const s = document.getElementById('scoreboard');
  if (!s) return;
  s.classList.toggle('hidden', !show);
  if (show) {
    document.getElementById('scoreboard-table').innerHTML = hud.scoreboardRows();
    document.getElementById('scoreboard-score').textContent =
      'ATK ' + sim.score.atk + ' — ' + sim.score.def + ' DEF · Round ' + sim.round;
  }
}

// --- scene modes for screenshots and validation. ---
function applySceneMode() {
  if (SCENE === 'cover') {
    // Title screen over the valley, cabin mid-transit, bright noon.
    sim.gondola.state = 'transit';
    sim.gondola.from = 'summit';
    sim.gondola.at = 'valley';
    sim.gondola.t = 6;
    sim.gondola.z = 0;
    hud.showTitle(true);
  } else if (SCENE === 'play') {
    startMatch(sim);
    hud.showTitle(false);
  } else if (SCENE === 'buy') {
    startMatch(sim);
    hud.showTitle(false);
    hud.showBuy(true);
    // A little money so the buy menu reads as a real choice.
    you.money = 5200;
    hud.refreshBuy();
  } else if (SCENE === 'results') {
    startMatch(sim);
    sim.score = { atk: 8, def: 5 };
    sim.round = 13;
    sim.phase = 'matchEnd';
    sim.matchWinner = 'atk';
    hud.showTitle(false);
    hud.showResults(true);
  }
  if (TEST_MODE) startMatch(sim);
}

// --- debug hooks for validation and screenshots (window.__GONDOLA__). ---
window.__GONDOLA__ = {
  sim,
  summary: () => summary(sim),
  errors: () => window.__errors,
  start: () => { startMatch(sim); hud.showTitle(false); },
  teleport: (x, z) => {
    you.pos.x = x;
    you.pos.z = z;
    you.pos.y = 0;
    you.vel.set(0, 0, 0);
    return { x: you.pos.x, z: you.pos.z };
  },
  lookAt: (x, z) => {
    you.yaw = Math.atan2(-(x - you.pos.x), -(z - you.pos.z));
    you.pitch = 0;
    return you.yaw;
  },
  setPlanting: (b) => { sim.playerPlanting = b; },
  setDefusing: (b) => { sim.playerDefusing = b; },
  forcePlant: () => {
    // Teleport into the cabin and plant, for validation.
    you.pos.set(0, 1.6, sim.gondola.z);
    you.vel.set(0, 0, 0);
    sim.bomb.carrier = you;
    sim.bomb.state = 'carried';
    sim.playerPlanting = true;
    return true;
  },
  forceFirefight: () => {
    // Stage a firefight at the Summit dock for the play screenshot: the player
    // faces two defenders at the dock, one already tagged by a tracer.
    sim._stageFreeze = 30; // hold the autopilot still for the shot
    you.pos.set(-9, 0, -40);
    you.yaw = Math.atan2(-(-14 + 9), -(-48 + 40));
    you.pitch = 0.02;
    you.vel.set(0, 0, 0);
    const defs = sim.players.filter((p) => p.isBot && p.team === 'def' && p.alive);
    if (defs[0]) { defs[0].pos.set(-14, 0, -48); defs[0].yaw = Math.PI; }
    if (defs[1]) { defs[1].pos.set(6, 0, -46); defs[1].yaw = Math.PI; }
    const hit = fireHitscan(sim, you, sim.rng);
    if (hit && hit.hit) {
      damageEntity(sim, hit.target, hit.damage, you, hit.part);
      hud.flashHitmarker(hit.part === 'head');
    }
    return { hit: !!(hit && hit.hit) };
  },
  setPhase: (phase) => { sim.phase = phase; },
  // Eliminate a whole team (validates the elimination → round end → next round path).
  killTeam: (team) => {
    for (const p of sim.players) {
      if (p.team === team && p.alive) damageEntity(sim, p, 9999, you, 'body');
    }
    return sim.players.filter((p) => p.team === team && p.alive).length;
  },
  // Jump to a round number's buy phase (validates Warden rounds: 5, 10, 15).
  toRound: (n) => {
    sim.round = n;
    startBuyPhase(sim);
    return { round: sim.round, warden: sim.warden.active };
  },
  showResults: () => {
    sim.score = { atk: 8, def: 5 };
    sim.matchWinner = 'atk';
    sim.phase = 'matchEnd';
    hud.showResults(true);
  },
};

// --- events from the sim, consumed once (HUD banners, deathcam, screens). ---
function consumeEvents() {
  while (lastEventN < sim.events.length) {
    const ev = sim.events[lastEventN++];
    if (ev.kind === 'roundStart') {
      const plan = you.team === 'atk' ? sim.planAtk : sim.planDef;
      hud.banner('ROUND ' + sim.round, plan ? 'Plan: ' + plan.name : '', 2.5);
      hud.showBuy(false);
      hud.showHalftime(false);
    } else if (ev.kind === 'buyPhase') {
      hud.showBuy(true);
      if (sim.warden.active) hud.wardenBanner();
    } else if (ev.kind === 'roundEnd') {
      const won = ev.winner === you.team;
      hud.banner(won ? 'ROUND WON' : 'ROUND LOST', ev.reason + '  ·  ATK ' + sim.score.atk + ' — ' + sim.score.def + ' DEF', 4, won ? 'win' : 'lose');
      hud.showBuy(false);
    } else if (ev.kind === 'halftime') {
      hud.showHalftime(true);
      hud.banner('HALFTIME — SIDES SWAP', 'ATK ' + sim.score.atk + ' — ' + sim.score.def + ' DEF', 4);
    } else if (ev.kind === 'matchEnd') {
      hud.showResults(true);
      hud.showBuy(false);
      hud.showHalftime(false);
    } else if (ev.kind === 'playerDied') {
      deathcamT = 3;
      spectateTarget = null;
      hud.showDeathcam(true, ev.by ? ev.by.name : null);
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (ev.kind === 'playerHit') {
      hud.damageFlash(ev.by ? Math.atan2(you.pos.x - ev.by.pos.x, you.pos.z - ev.by.pos.z) - you.yaw : 0);
    } else if (ev.kind === 'bombPlanted') {
      hud.banner('BOMB PLANTED', 'Defend the cabin — ' + 40 + 's', 3, 'warn');
    }
  }
}

// --- title screen buttons. ---
document.getElementById('play-btn').addEventListener('click', () => {
  sim.sound.ensure();
  startMatch(sim);
  hud.showTitle(false);
  if (!AUTOPILOT) renderer.domElement.requestPointerLock();
});
document.getElementById('how-btn').addEventListener('click', () => {
  document.getElementById('how-panel').classList.toggle('hidden');
});

// --- the main loop: fixed-step accumulator + render. ---
let lastT = performance.now();
let acc = 0;
const _eye = new THREE.Vector3();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.25) dt = 0.25; // tab-switch guard
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    // --- the local player's input, only when they are alive and playing. ---
    if (!AUTOPILOT && sim.phase === 'play' && you.alive && deathcamT <= 0) {
      mouseDX *= 1; // consume accumulated mouse deltas
      you.yaw -= mouseDX * 0.0022;
      you.pitch = clamp(you.pitch - mouseDY * 0.0022, -1.5, 1.5);
      mouseDX = 0;
      mouseDY = 0;
      const input = {
        f: keys.has('KeyW'), b: keys.has('KeyS'),
        l: keys.has('KeyA'), r: keys.has('KeyD'),
        crouch: keys.has('ControlLeft') || keys.has('KeyC'),
        jump: keys.has('Space'),
        walk: keys.has('ShiftLeft'),
      };
      updateMovement(sim, you, input, STEP);
      you.scoped = scoped && you.weapon && you.weapon.id === 'sniper';
      sim.playerPlanting = keys.has('KeyE') && sim.bomb.carrier === you;
      sim.playerDefusing = keys.has('KeyE') && sim.bomb.state === 'planted' && you.team === 'def';
      if (firing && you.weapon && you.weapon.cooldown <= 0 && !you.weapon.reloading) {
        const hit = fireHitscan(sim, you, sim.rng);
        if (hit) {
          sim.stats.shots += 1;
          if (hit.hit) {
            sim.stats.hits += 1;
            damageEntity(sim, hit.target, hit.damage, you, hit.part);
            hud.flashHitmarker(hit.part === 'head');
            sim.sound.hitmarker(hit.part === 'head');
          }
        } else if (you.weapon.mag === 0) {
          sim.sound.dryFire();
        }
      }
      if (you.weapon && you.weapon.mag === 0 && you.weapon.reserve > 0 && !you.weapon.reloading) {
        startReload(you);
      }
    }
    step(sim, STEP);
    steps += 1;
    acc -= STEP;
  }
  if (steps === 5) acc = 0; // drop backlog rather than spiral

  consumeEvents();
  if (deathcamT > 0) deathcamT -= dt;

  // --- camera: first person, deathcam, spectate, or the title orbit. ---
  if (sim.phase === 'title' || SCENE === 'cover') {
    // Track the cabin: it stays framed centre-right while the title sits left.
    const gz = sim.gondola.z;
    camera.position.set(17, 8.5, gz - 26);
    camera.lookAt(0, 3.4, gz + 2);
    camera.fov = 58;
    viewmodel.group.visible = false;
    document.body.classList.add('title-mode');
  } else if (deathcamT > 0 && you.lastHitBy && you.lastHitBy.alive) {
    const k = you.lastHitBy;
    camera.position.set(k.pos.x - Math.sin(k.yaw) * -3, k.pos.y + 2.6, k.pos.z - Math.cos(k.yaw) * -3);
    camera.lookAt(k.pos.x, k.pos.y + 1.4, k.pos.z);
    camera.fov = 60;
  } else if (!you.alive) {
    // Spectate a living teammate.
    if (!spectateTarget || !spectateTarget.alive) {
      spectateTarget = sim.players.find((p) => p.alive && p.team === you.team && !p.isPlayer) || null;
    }
    if (spectateTarget) {
      eyePos(spectateTarget, _eye);
      camera.position.copy(_eye);
      camera.rotation.set(spectateTarget.pitch, spectateTarget.yaw, 0);
    }
    camera.fov = 75;
  } else {
    document.body.classList.remove('title-mode');
    eyePos(you, _eye);
    camera.position.copy(_eye);
    camera.rotation.set(you.pitch, you.yaw, 0);
    const targetFov = you.scoped ? 29 : 75;
    camera.fov += (targetFov - camera.fov) * 0.25;
    viewmodel.update(dt, you, firing);
  }
  camera.updateProjectionMatrix();

  // --- bomb mesh + tracers + smoke, from the sim's lists. ---
  if (sim.bomb.state === 'planted' || sim.bomb.state === 'dropped') {
    bombGroup.visible = true;
    bombGroup.position.set(sim.bomb.pos.x, sim.gondola.z === sim.bomb.pos.z ? 1.6 : 0, sim.bomb.pos.z);
    bombGroup.position.y = sim.bomb.state === 'planted' ? 1.6 : 0;
    bombLight.material.emissiveIntensity = sim.bomb.state === 'planted'
      ? (Math.sin(sim.time * 8) > 0 ? 1.6 : 0.2) : 0.4;
  } else {
    bombGroup.visible = false;
  }
  while (tracerGroup.children.length > 0) {
    const child = tracerGroup.children[0];
    tracerGroup.remove(child);
    child.geometry.dispose();
    child.material.dispose();
  }
  for (const tr of sim.tracers) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(tr.x1, tr.y1, tr.z1),
      new THREE.Vector3(tr.x2, tr.y2, tr.z2),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: tr.color, transparent: true, opacity: clamp(tr.ttl / 0.07, 0, 1) });
    tracerGroup.add(new THREE.Line(geo, mat));
  }
  const seenSmokes = new Set();
  for (const s of sim.smokes) {
    seenSmokes.add(s);
    let mesh = smokeMeshes.get(s);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(s.r, 12, 10), smokeMat);
      smokeMeshes.set(s, mesh);
      smokeGroup.add(mesh);
    }
    mesh.position.set(s.x, s.y, s.z);
    mesh.material.opacity = 0.55 * clamp(s.ttl / 2, 0, 1);
  }
  for (const [s, mesh] of smokeMeshes) {
    if (!seenSmokes.has(s)) {
      smokeGroup.remove(mesh);
      mesh.geometry.dispose();
      smokeMeshes.delete(s);
    }
  }

  // --- HUD + crosshair spread. ---
  hud.update(dt);
  if (you.weapon) {
    const spreadPx = 5 + you.weapon.bloom * 900 + (you.moveSpeed > 0.6 ? 9 : 0) + (you.airborne ? 10 : 0);
    hud.setSpread(spreadPx);
  }

  renderer.render(scene, camera);
}

applySceneMode();
requestAnimationFrame(frame);
