// rounds.js — the round state machine: buy phase, live round, round end,
// halftime side-swap after round 7, match end at first to 8 (max 15).
// WARDEN rounds are 5, 10 and 15: the defenders field THE WARDEN, a heavy bot
// with 2.5x health, an LMG and a banner, worth a $500 bounty. Planting and
// defusing only ever happen inside the gondola cabin — rounds.js is the guard
// that refuses a plant anywhere else.
import { WEAPONS, makeWeapon } from './weapons.js';
import { roundPayout, addMoney } from './economy.js';
import { pickTeamPlan, assignPlanRoles, executeSplit, retakeProtocol, radioCall, botBuyPhase, BOT_NAMES_ATK, BOT_NAMES_DEF, WARDEN_NAME } from './bots.js';
import { createEntity, resetEntity, buildAgentMesh } from './player.js';
import { SPAWNS } from './map.js';
import { mulberry32 } from './utils.js';

export const ROUND_SECONDS = 105;
export const BUY_SECONDS = 20;
export const BOMB_TIMER = 40;
export const PLANT_SECONDS = 5;
export const WARDEN_ROUNDS = [5, 10, 15];
export const WIN_AT = 8;
export const MAX_ROUNDS = 15;
export const HALFTIME_AFTER = 7;

export function isWardenRound(round) {
  return WARDEN_ROUNDS.includes(round);
}

// Build the ten fighters for a fresh match. The local player is an attacker
// in the first half and swaps to defence at halftime.
export function createRoster(sim) {
  const players = [];
  const player = createEntity({ id: 'you', name: 'YOU', team: 'atk', isPlayer: true, x: 2, z: 52, yaw: 0 });
  players.push(player);
  BOT_NAMES_ATK.forEach((name, i) => {
    const s = SPAWNS.atk[(i + 1) % SPAWNS.atk.length];
    const bot = createEntity({ id: 'atk' + i, name, team: 'atk', isBot: true, x: s[0], z: s[1], yaw: 0 });
    players.push(bot);
  });
  BOT_NAMES_DEF.forEach((name, i) => {
    const s = SPAWNS.def[i % SPAWNS.def.length];
    const bot = createEntity({ id: 'def' + i, name, team: 'def', isBot: true, x: s[0], z: s[1], yaw: Math.PI });
    players.push(bot);
  });
  return players;
}

// Put every fighter on their spawn for a new round. Warden rounds replace one
// defender with THE WARDEN.
export function setupRoundSpawns(sim) {
  const wardenRound = isWardenRound(sim.round);
  let wardenBot = null;
  for (const p of sim.players) {
    const spawns = p.team === 'atk' ? SPAWNS.atk : SPAWNS.def;
    const idx = sim.players.filter((q) => q.team === p.team).indexOf(p);
    const s = spawns[idx % spawns.length];
    const yaw = p.team === 'atk' ? 0 : Math.PI;
    p.isWarden = false;
    resetEntity(p, s[0], s[1], yaw, p.team);
    if (p.isBot && p.team === 'def' && wardenRound && !wardenBot) {
      wardenBot = p;
    }
  }
  if (wardenBot) {
    wardenBot.isWarden = true;
    wardenBot.name = WARDEN_NAME;
    wardenBot.hp = 250;
    wardenBot.weapons.primary = makeWeapon('lmg');
    wardenBot.weapon = wardenBot.weapons.primary;
    wardenBot.armor = 100;
    sim.warden = { active: true, bot: wardenBot };
  } else {
    sim.warden = { active: false, bot: null };
    // Restore the normal defender names after a Warden round.
    sim.players.forEach((p) => {
      if (p.isBot && p.team === 'def' && p.name === WARDEN_NAME) {
        p.name = BOT_NAMES_DEF[sim.players.filter((q) => q.team === 'def').indexOf(p)] || 'OTTO';
      }
    });
  }
  // Meshes are rebuilt every round so the Warden's oversized body only ever
  // appears on Warden rounds, and a renamed Warden goes back to normal size.
  for (const p of sim.players) {
    if (p.isBot) {
      if (p.mesh) {
        sim.scene.remove(p.mesh);
        p.mesh = null;
      }
      buildAgentMesh(sim.scene, p);
      p.mesh.visible = p.alive;
    }
  }
}

// Start the buy phase of a round: money, plans, bot shopping, bomb carrier.
export function startBuyPhase(sim) {
  sim.phase = 'buy';
  sim.phaseT = 0;
  sim.roundTime = BUY_SECONDS;
  sim.bomb = { state: 'carried', carrier: null, progress: 0, timer: BOMB_TIMER, pos: { x: 0, z: 0 } };
  sim.smokes = [];
  sim.feed.length = 0;
  setupRoundSpawns(sim);
  // One named plan per team, shown on the HUD all round.
  sim.planAtk = pickTeamPlan(sim, 'atk');
  sim.planDef = pickTeamPlan(sim, 'def');
  assignPlanRoles(sim, 'atk', sim.planAtk);
  assignPlanRoles(sim, 'def', sim.planDef);
  executeSplit(sim, 'atk');
  executeSplit(sim, 'def');
  botBuyPhase(sim);
  if (sim.warden.active) {
    sim.radio.push({ text: 'THE WARDEN HOLDS THE SUMMIT — $500 bounty', kind: 'warden' });
    sim.sound.wardenHorn();
  } else {
    radioCall(sim, 'Plan: ' + sim.planAtk.name + ' — ' + sim.planAtk.desc, 'info');
  }
  sim.events.push({ kind: 'buyPhase', round: sim.round });
}

// The live round begins: the timer runs, the gondola keeps cycling.
export function startLiveRound(sim) {
  sim.phase = 'play';
  sim.phaseT = 0;
  sim.roundTime = ROUND_SECONDS;
  sim.events.push({ kind: 'roundStart', round: sim.round });
}

// --- plant / defuse: only inside the cabin, only by holding the spot. ---
export function tryStartPlant(sim, p) {
  if (sim.phase !== 'play') return { ok: false, reason: 'Not a live round.' };
  if (sim.bomb.state !== 'carried' || sim.bomb.carrier !== p) {
    return { ok: false, reason: 'You do not carry the bomb.' };
  }
  if (!sim.gondola.isInside(p.pos.x, p.pos.y + 0.9, p.pos.z)) {
    return { ok: false, reason: 'Plant ONLY inside the gondola cabin.' };
  }
  return { ok: true };
}

export function plantBomb(sim, p) {
  sim.bomb.state = 'planted';
  sim.bomb.carrier = null;
  sim.bomb.timer = BOMB_TIMER;
  sim.bomb.pos.x = p.pos.x;
  sim.bomb.pos.z = p.pos.z;
  sim.bomb.progress = 0;
  sim.sound.plantBeep(true);
  sim.hearing.emit('plant', p.pos.x, p.pos.z, 1);
  radioCall(sim, 'BOMB PLANTED IN THE CABIN — ' + BOMB_TIMER + 's', 'warn');
  sim.events.push({ kind: 'bombPlanted', by: p });
  // Defenders switch to RETAKE PROTOCOL the moment the bomb goes down.
  retakeProtocol(sim, 'def');
  return true;
}

export function tryStartDefuse(sim, p) {
  if (sim.phase !== 'play') return { ok: false, reason: 'Not a live round.' };
  if (sim.bomb.state !== 'planted') return { ok: false, reason: 'The bomb is not planted.' };
  if (!sim.gondola.isInside(p.pos.x, p.pos.y + 0.9, p.pos.z)) {
    return { ok: false, reason: 'Defuse ONLY inside the gondola cabin.' };
  }
  return { ok: true };
}

export function defuseBomb(sim, p) {
  sim.bomb.state = 'defused';
  sim.bomb.progress = 0;
  sim.events.push({ kind: 'bombDefused', by: p });
  radioCall(sim, 'BOMB DEFUSED — ' + p.name, 'info');
  endRound(sim, 'def', 'Bomb defused in the cabin');
}

// --- round end: score, money, halftime, match end. ---
export function endRound(sim, winnerTeam, reason) {
  if (sim.phase === 'roundEnd' || sim.phase === 'matchEnd') return;
  sim.phase = 'roundEnd';
  sim.phaseT = 0;
  sim.roundWinner = winnerTeam;
  sim.roundReason = reason;
  if (winnerTeam === 'atk') sim.score.atk += 1;
  else sim.score.def += 1;
  // Money: winners +$3,250, losers +$1,900 plus a $500 loss-streak bonus.
  for (const p of sim.players) {
    const won = p.team === winnerTeam;
    if (!won) p.lossStreak = (p.lossStreak || 0) + 1;
    else p.lossStreak = 0;
    addMoney(p, roundPayout(p, won, p.lossStreak || 0));
  }
  const you = sim.players.find((p) => p.isPlayer);
  if (you.team === winnerTeam) sim.sound.roundWin();
  else sim.sound.roundLose();
  sim.events.push({ kind: 'roundEnd', winner: winnerTeam, reason });
}

export function nextAfterRoundEnd(sim) {
  // Halftime after round 7: swap sides, show the scoreboard, keep playing.
  if (sim.round === HALFTIME_AFTER && !sim.halftimeDone) {
    sim.halftimeDone = true;
    for (const p of sim.players) {
      p.team = p.team === 'atk' ? 'def' : 'atk';
    }
    sim.phase = 'halftime';
    sim.phaseT = 0;
    sim.events.push({ kind: 'halftime' });
    return;
  }
  sim.round += 1;
  if (sim.score.atk >= WIN_AT || sim.score.def >= WIN_AT || sim.round > MAX_ROUNDS) {
    sim.phase = 'matchEnd';
    sim.phaseT = 0;
    sim.matchWinner = sim.score.atk > sim.score.def ? 'atk' : sim.score.def > sim.score.atk ? 'def' : 'draw';
    sim.events.push({ kind: 'matchEnd', winner: sim.matchWinner });
    return;
  }
  startBuyPhase(sim);
}

// The round timer and bomb timer tick inside the fixed step.
export function tickRounds(sim, dt) {
  if (sim.phase === 'play') {
    sim.roundTime -= dt;
    if (sim.bomb.state === 'planted') {
      sim.bomb.timer -= dt;
      // Beep faster as the bomb counts down.
      const beepEvery = sim.bomb.timer < 10 ? 0.5 : 1;
      sim._beepT = (sim._beepT || 0) + dt;
      if (sim._beepT >= beepEvery) {
        sim._beepT = 0;
        sim.sound.plantBeep(false);
      }
      if (sim.bomb.timer <= 0) {
        sim.bomb.state = 'exploded';
        sim.sound.explosion();
        sim.hearing.emit('explosion', sim.bomb.pos.x, sim.bomb.pos.z, 1);
        endRound(sim, 'atk', 'The bomb detonated in the cabin');
        return;
      }
    }
    if (sim.roundTime <= 0) {
      if (sim.bomb.state === 'planted') {
        // The bomb still ticks after the round clock ends.
      } else {
        endRound(sim, 'def', 'Time expired — defenders hold the cabin');
      }
    }
    // Elimination check.
    const atkAlive = sim.players.some((p) => p.team === 'atk' && p.alive);
    const defAlive = sim.players.some((p) => p.team === 'def' && p.alive);
    if (sim.bomb.state !== 'planted') {
      if (!atkAlive) endRound(sim, 'def', 'Attackers eliminated');
      else if (!defAlive) endRound(sim, 'atk', 'Defenders eliminated');
    } else if (!defAlive) {
      endRound(sim, 'atk', 'Defenders eliminated — bomb will detonate');
    } else if (!atkAlive) {
      // Attackers all dead but the bomb is planted: defenders must still defuse.
      if (!sim._plantOnlyNote) {
        sim._plantOnlyNote = true;
        radioCall(sim, 'All attackers down — defuse the bomb!', 'warn');
      }
    }
  } else if (sim.phase === 'buy') {
    sim.roundTime -= dt;
    if (sim.roundTime <= 0) startLiveRound(sim);
  } else if (sim.phase === 'roundEnd') {
    sim.phaseT += dt;
    if (sim.phaseT >= 4.5) nextAfterRoundEnd(sim);
  } else if (sim.phase === 'halftime') {
    sim.phaseT += dt;
    if (sim.phaseT >= 6) {
      sim.round += 1;
      startBuyPhase(sim);
    }
  }
}
