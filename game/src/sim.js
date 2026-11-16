// sim.js — the fixed-step simulation (60 Hz), kept apart from rendering.
// One state object holds everything: the fighters, the gondola, the bomb, the
// money, the radio, the hearing bus and the tracers. main.js runs the loop and
// renders; this module only ever steps the world. No object is allocated in the
// hot loop except the small tracer records the renderer consumes.
import * as THREE from 'three';
import { mulberry32 } from './utils.js';
import { Gondola } from './gondola.js';
import { buildWorld } from './map.js';
import { HearingBus, SoundSynth } from './audio.js';
import { createRoster, startBuyPhase, tickRounds, plantBomb, defuseBomb, ROUND_SECONDS } from './rounds.js';
import { createBotAI, updateBot, radioCall } from './bots.js';
import { syncAgentMesh } from './player.js';
import { recoverWeapon } from './weapons.js';
import { buyItem } from './economy.js';

export const STEP = 1 / 60;

export function createGame(scene, opts = {}) {
  const seed = opts.seed || 20261117;
  const sim = {
    scene,
    rng: mulberry32(seed),
    seed,
    time: 0,
    tick: 0,
    phase: 'title',
    phaseT: 0,
    round: 1,
    score: { atk: 0, def: 0 },
    roundTime: ROUND_SECONDS,
    roundWinner: null,
    roundReason: '',
    matchWinner: null,
    halftimeDone: false,
    players: [],
    gondola: null,
    colliders: [],
    hearing: new HearingBus(),
    sound: new SoundSynth(),
    feed: [], // kill feed lines {text, kind}
    radio: [], // radio callouts {text, kind, t}
    smokes: [], // {x, y, z, r, ttl}
    tracers: [], // {x1,y1,z1,x2,y2,z2,color,ttl}
    events: [], // {kind, ...} — consumed by main.js (HUD, deathcam)
    bomb: { state: 'none', carrier: null, progress: 0, timer: 40, pos: { x: 0, z: 0 } },
    planAtk: null,
    planDef: null,
    warden: { active: false, bot: null },
    autopilot: !!opts.autopilot,
    _stageFreeze: 0, // seconds the autopilot holds still (staged screenshots)
    playerPlanting: false,
    playerDefusing: false,
    _autoBoughtRound: 0,
    _beepT: 0,
    _plantOnlyNote: false,
    stats: { shots: 0, hits: 0 },
  };

  // World first (colliders), then the gondola, then the fighters.
  const world = buildWorld(scene);
  sim.colliders = world.colliders;
  sim.gondola = new Gondola(scene);
  sim.players = createRoster(sim);
  for (const p of sim.players) {
    if (p.isBot) {
      p.ai = createBotAI(sim.rng);
      p.ai.nodeId = null;
    }
  }
  if (sim.autopilot) {
    const you = sim.players.find((p) => p.isPlayer);
    you.ai = createBotAI(sim.rng);
  }

  // Rounds call back into the sim through these bindings so bots and the
  // player share one code path for planting and defusing.
  sim.plantBomb = (p) => plantBomb(sim, p);
  sim.defuseBomb = (p) => defuseBomb(sim, p);

  return sim;
}

// Start a fresh match from the title screen.
export function startMatch(sim) {
  sim.round = 1;
  sim.score = { atk: 0, def: 0 };
  sim.halftimeDone = false;
  sim.matchWinner = null;
  for (const p of sim.players) {
    p.money = 800;
    p.kills = 0;
    p.deaths = 0;
    p.damageDealt = 0;
    p.lossStreak = 0;
    p.team = p.isPlayer ? 'atk' : p.team;
    if (p.isBot) p.team = p.id.startsWith('atk') ? 'atk' : 'def';
  }
  // Restore defender names (a Warden round may have renamed one).
  const defNames = ['WILHELM', 'GRETA', 'OTTO', 'HELGA', 'FRITZ'];
  sim.players.filter((p) => p.isBot && p.team === 'def').forEach((p, i) => { p.name = defNames[i % defNames.length]; });
  startBuyPhase(sim);
}

// One fixed step. Called exactly 60 times a second by main.js's accumulator.
export function step(sim, dt) {
  sim.time += dt;
  sim.tick += 1;

  // --- the gondola keeps its loop whatever the phase: dwell, transit, dwell. ---
  const oldZ = sim.gondola.z;
  const gEvent = sim.gondola.update(dt);
  if (gEvent) {
    if (gEvent.startsWith('depart:')) {
      sim.sound.startCableHum();
      radioCall(sim, 'GONDOLA DEPARTING ' + gEvent.slice(7).toUpperCase(), 'info');
    } else if (gEvent.startsWith('arrive:')) {
      sim.sound.stopCableHum();
      radioCall(sim, 'GONDOLA DOCKED AT ' + gEvent.slice(7).toUpperCase(), 'info');
    }
  }
  const dz = sim.gondola.z - oldZ;
  if (dz !== 0) sim.gondola.applyRiderDelta(dz, sim.players);

  // --- rounds: timer, bomb, elimination, halftime, match end. ---
  tickRounds(sim, dt);

  // --- bots (and the autopilot player) think and move. ---
  if (sim.phase === 'play' || sim.phase === 'buy') {
    for (const p of sim.players) {
      if (!p.isBot || !p.alive) continue;
      updateBot(sim, p, dt);
    }
    if (sim.autopilot) {
      const you = sim.players.find((p) => p.isPlayer);
      // _stageFreeze holds the autopilot still for staged screenshots.
      if (sim._stageFreeze > 0) sim._stageFreeze -= dt;
      else if (you && you.alive && sim.phase === 'play') updateBot(sim, you, dt);
    }
  }

  // --- autopilot shopping: the player buys like a bot in the buy phase. ---
  if (sim.autopilot && sim.phase === 'buy' && sim._autoBoughtRound !== sim.round) {
    sim._autoBoughtRound = sim.round;
    const you = sim.players.find((p) => p.isPlayer);
    if (you) {
      if (you.money >= 2700) buyItem(you, 'rifle');
      else if (you.money >= 1500) buyItem(you, 'smg');
      if (you.money >= 650) buyItem(you, 'armor');
      if (you.team === 'atk' && you.money >= 300) buyItem(you, 'smoke');
    }
  }

  // --- the local player's plant / defuse (E held, inside the cabin). ---
  const you = sim.players.find((p) => p.isPlayer);
  if (you && you.alive && sim.phase === 'play') {
    if (sim.playerPlanting && sim.bomb.carrier === you) {
      if (sim.gondola.isInside(you.pos.x, you.pos.y + 0.9, you.pos.z)) {
        you.plantT += dt;
        sim.bomb.progress = you.plantT / 5;
        if (you.plantT >= 5) {
          you.plantT = 0;
          sim.bomb.progress = 0;
          sim.plantBomb(you);
        }
      } else {
        you.plantT = 0;
        sim.bomb.progress = 0;
      }
    } else if (sim.playerDefusing && sim.bomb.state === 'planted') {
      if (sim.gondola.isInside(you.pos.x, you.pos.y + 0.9, you.pos.z)) {
        you.defuseT += dt;
        const need = you.hasDefuseKit ? 2.5 : 5;
        sim.bomb.progress = you.defuseT / need;
        if (you.defuseT >= need) {
          you.defuseT = 0;
          sim.bomb.progress = 0;
          sim.defuseBomb(you);
        }
      } else {
        you.defuseT = 0;
        sim.bomb.progress = 0;
      }
    } else {
      you.plantT = 0;
      you.defuseT = 0;
    }
    // Dropped bomb pickup.
    if (sim.bomb.state === 'dropped' && you.team === 'atk') {
      const d = Math.hypot(you.pos.x - sim.bomb.pos.x, you.pos.z - sim.bomb.pos.z);
      if (d < 1.6) {
        sim.bomb.state = 'carried';
        sim.bomb.carrier = you;
        radioCall(sim, 'YOU picked up the bomb', 'info');
      }
    }
  }
  // Bots pick up a dropped bomb too.
  if (sim.bomb.state === 'dropped') {
    for (const p of sim.players) {
      if (!p.isBot || !p.alive || p.team !== 'atk') continue;
      const d = Math.hypot(p.pos.x - sim.bomb.pos.x, p.pos.z - sim.bomb.pos.z);
      if (d < 1.6) {
        sim.bomb.state = 'carried';
        sim.bomb.carrier = p;
        radioCall(sim, p.name + ' picked up the bomb', 'info');
        break;
      }
    }
  }

  // --- weapon cooldowns / reloads tick for everyone. ---
  for (const p of sim.players) {
    if (!p.alive || !p.weapon) continue;
    recoverWeapon(p.weapon, dt);
  }

  // --- smoke clouds and tracers decay. ---
  for (let i = sim.smokes.length - 1; i >= 0; i--) {
    sim.smokes[i].ttl -= dt;
    if (sim.smokes[i].ttl <= 0) sim.smokes.splice(i, 1);
  }
  for (let i = sim.tracers.length - 1; i >= 0; i--) {
    sim.tracers[i].ttl -= dt;
    if (sim.tracers[i].ttl <= 0) sim.tracers.splice(i, 1);
  }

  // --- keep the 3D bodies where the sim says they are. ---
  for (const p of sim.players) {
    if (p.isBot) syncAgentMesh(p);
  }
}

// A small read-only summary for the HUD and for the validation hooks.
export function summary(sim) {
  const you = sim.players.find((p) => p.isPlayer);
  return {
    phase: sim.phase,
    round: sim.round,
    score: { atk: sim.score.atk, def: sim.score.def },
    roundTime: Math.max(0, sim.roundTime),
    gondola: sim.gondola.tracker(),
    bomb: { state: sim.bomb.state, timer: sim.bomb.timer, carrier: sim.bomb.carrier ? sim.bomb.carrier.name : null },
    you: you ? { hp: you.hp, armor: you.armor, money: you.money, alive: you.alive, team: you.team, x: +you.pos.x.toFixed(2), z: +you.pos.z.toFixed(2) } : null,
    alive: {
      atk: sim.players.filter((p) => p.team === 'atk' && p.alive).length,
      def: sim.players.filter((p) => p.team === 'def' && p.alive).length,
    },
  };
}
