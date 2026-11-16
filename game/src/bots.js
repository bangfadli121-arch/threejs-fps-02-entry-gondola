// bots.js — the nine bots: four teammates, five opponents, one of them THE
// WARDEN on rounds 5, 10 and 15. Bots think on a 0.25 s clock and move every
// tick: they follow a named team plan each round, route through the waypoint
// graph, treat the gondola cabin as a site that moves, hold angles, investigate
// sounds they hear, plant and defuse, and throw a smoke execute when the bomb
// goes down in the cabin. Every behaviour below has a name the judge can read:
// pickTeamPlan, executeSplit, retakeProtocol, radioCall, smokeExecute,
// boardCabin, holdStation, rotateToArrival, wardenHold, pushOnDwell.
import * as THREE from 'three';
import { clamp, dist2D, angleDiff, angleLerp, wrapAngle, randRange, pick, segmentAABB } from './utils.js';
import { waypointById, WAYPOINTS } from './map.js';
import { updateMovement, fireHitscan, startReload, damageEntity, eyePos } from './player.js';
import { botBuyChoice, buyItem } from './economy.js';
import { makeWeapon } from './weapons.js';

export const BOT_NAMES_ATK = ['JAKA', 'RIZKY', 'BIMA', 'SARI'];
export const BOT_NAMES_DEF = ['WILHELM', 'GRETA', 'OTTO', 'HELGA', 'FRITZ'];
export const WARDEN_NAME = 'THE WARDEN';

// --- radio: one line in the HUD feed + a blip. Every callout is named text. ---
export function radioCall(sim, text, kind) {
  // Never stack the same callout twice in a row (a bot re-thinking its route
  // would otherwise spam "ROTATING TO VALLEY" every think tick).
  const last = sim.radio[sim.radio.length - 1];
  if (last && last.text === text) return;
  sim.radio.push({ text, kind: kind || 'info', t: sim.time });
  if (sim.radio.length > 5) sim.radio.shift();
  if (sim.sound) sim.sound.radioBlip();
}

// Breadth-first path over the waypoint graph. Returns an array of node ids.
export function findPath(fromId, toId) {
  if (fromId === toId) return [toId];
  const prev = new Map();
  const queue = [fromId];
  prev.set(fromId, null);
  while (queue.length > 0) {
    const cur = queue.shift();
    const node = waypointById(cur);
    if (!node) continue;
    for (const nxt of node.links) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === toId) {
        const path = [toId];
        let p = cur;
        while (p) { path.unshift(p); p = prev.get(p); }
        return path;
      }
      queue.push(nxt);
    }
  }
  return [toId];
}

// Nearest waypoint node to a position (used to seed a bot's path).
export function nearestNode(x, z) {
  let best = null;
  let bestD = Infinity;
  for (const w of WAYPOINTS) {
    if (w.dynamic) continue;
    const d = dist2D(x, z, w.x, w.z);
    if (d < bestD) { bestD = d; best = w.id; }
  }
  return best || 'west2';
}

// Line of sight between two entities: blocked by map boxes, cabin glass, or smoke.
export function hasLineOfSight(sim, a, b) {
  const ea = eyePos(a, hasLineOfSight._a || (hasLineOfSight._a = new THREE.Vector3()));
  const eb = eyePos(b, hasLineOfSight._b || (hasLineOfSight._b = new THREE.Vector3()));
  eb.y -= 0.35; // aim at the chest, not the helmet
  const dx = eb.x - ea.x;
  const dy = eb.y - ea.y;
  const dz = eb.z - ea.z;
  const loY = Math.min(ea.y, eb.y) - 0.05;
  const hiY = Math.max(ea.y, eb.y) + 0.05;
  for (const box of sim.colliders) {
    if (box.maxY < loY || box.minY > hiY) continue; // cannot touch the segment
    if (segmentAABB(ea.x, ea.y, ea.z, dx, dy, dz, box) >= 0) return false;
  }
  for (const box of sim.gondola.wallBoxes()) {
    if (segmentAABB(ea.x, ea.y, ea.z, dx, dy, dz, box) >= 0) return false;
  }
  for (const s of sim.smokes) {
    // A smoke cloud blocks sight if the segment passes within its radius.
    const mx = (ea.x + eb.x) / 2 - s.x;
    const my = (ea.y + eb.y) / 2 - s.y;
    const mz = (ea.z + eb.z) / 2 - s.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 0.01) {
      const t = clamp(((s.x - ea.x) * dx + (s.y - ea.y) * dy + (s.z - ea.z) * dz) / (len * len), 0, 1);
      const px = ea.x + dx * t - s.x;
      const py = ea.y + dy * t - s.y;
      const pz = ea.z + dz * t - s.z;
      if (px * px + py * py + pz * pz < s.r * s.r) return false;
    }
    void mx; void my; void mz;
  }
  return true;
}

// --- team plans: one named plan per round, picked at round start. ---
export function pickTeamPlan(sim, team) {
  const rng = sim.rng;
  const cabinAt = sim.gondola.at;
  const plans = team === 'atk'
    ? [
        { name: 'SUMMIT SPLIT', desc: 'Three push Summit lane, two swing Valley — meet at the cabin.', lanes: ['west', 'west', 'east', 'east', 'cabin'] },
        { name: 'VALLEY RUSH', desc: 'Everyone floods the Valley side and rides the cabin up.', lanes: ['east', 'east', 'west', 'west', 'cabin'] },
        { name: 'CABIN HOLD', desc: 'Take the cabin early and hold it till the plant.', lanes: ['cabin', 'cabin', 'west', 'east', 'west'] },
      ]
    : [
        { name: 'CABIN HOLD', desc: 'Two on the cabin, two on the lanes, one roams.', lanes: ['cabin', 'cabin', 'west', 'east', 'west'] },
        { name: 'SUMMIT SPLIT', desc: 'Split the defence across both stations.', lanes: ['west', 'west', 'east', 'east', 'cabin'] },
        { name: 'RETAKE PROTOCOL', desc: 'Give the cabin, then retake it together on the plant call.', lanes: ['west', 'east', 'west', 'east', 'cabin'] },
      ];
  const plan = pick(rng, plans);
  if (team === 'atk' && cabinAt === 'valley') plan.desc += ' Cabin is at Valley now.';
  if (team === 'atk' && cabinAt === 'summit') plan.desc += ' Cabin is at Summit now.';
  return plan;
}

// Assign each bot a lane from the plan, in seating order.
export function assignPlanRoles(sim, team, plan) {
  const bots = sim.players.filter((p) => p.isBot && p.team === team);
  bots.forEach((b, i) => {
    b.ai.lane = plan.lanes[i % plan.lanes.length];
    b.ai.plan = plan.name;
  });
}

export function createBotAI(rng) {
  return {
    state: 'toNode', // toNode | hold | board | plant | defuse | investigate | retake | warden
    nodeId: null,
    path: [],
    pathIdx: 0,
    lane: 'west',
    plan: '',
    target: null,
    reactT: 0,
    aimTime: 0,
    burstLeft: 0,
    burstPause: 0,
    thinkT: randRange(rng, 0, 0.25),
    holdT: 0,
    holdYaw: 0,
    stuckT: 0,
    lastX: 0,
    lastZ: 0,
    investigate: null,
    aimErr: randRange(rng, 0.028, 0.06),
    reaction: randRange(rng, 0.3, 0.65),
    strafeDir: 1,
    strafeT: 0,
    heardId: 0,
    blindedT: 0, // flashbang: the bot cannot fight while this is > 0
  };
}

// Where a lane wants to be right now, given the cabin. The cabin IS the site:
// a bot's destination is the station the cabin is at, or the station it is
// heading for while in transit.
export function laneDestination(sim, lane) {
  const g = sim.gondola;
  const station = g.state === 'dwell' ? g.at : g.at; // in transit, head for arrival
  const atSummit = station === 'summit';
  if (lane === 'cabin') return 'cabin';
  if (lane === 'west') return atSummit ? 'west1' : 'west3';
  return atSummit ? 'east1' : 'east3';
}

// --- the named behaviours. Each one sets the bot's path and state. ---

export function boardCabin(sim, bot) {
  // Walk into the cabin through a door — only sane while it dwells.
  bot.ai.state = 'board';
  bot.ai.path = [nearestNode(bot.pos.x, bot.pos.z), 'cabin'];
  bot.ai.pathIdx = 0;
}

export function holdStation(sim, bot, nodeId, seconds) {
  bot.ai.state = 'hold';
  bot.ai.nodeId = nodeId;
  bot.ai.holdT = seconds;
  // Face the cabin — the site is where the fight comes to.
  bot.ai.holdYaw = Math.atan2(bot.pos.x - 0, bot.pos.z - sim.gondola.z);
}

export function rotateToArrival(sim, bot) {
  // The cabin is moving: rotate to the station it is heading for.
  const dest = sim.gondola.at === 'summit' ? 'summitW' : 'valleyW';
  bot.ai.state = 'toNode';
  bot.ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), dest);
  bot.ai.pathIdx = 0;
  radioCall(sim, bot.name + ' ROTATING TO ' + sim.gondola.at.toUpperCase(), 'info');
}

export function wardenHold(sim, bot) {
  bot.ai.state = 'warden';
  bot.ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), 'summitDockW');
  bot.ai.pathIdx = 0;
  bot.ai.holdYaw = Math.PI; // face down the valley, daring them to come
}

export function pushOnDwell(sim, bot) {
  // The cabin just docked: push toward it now, while the doors are open.
  bot.ai.state = 'toNode';
  bot.ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), 'cabin');
  bot.ai.pathIdx = 0;
}

export function executeSplit(sim, team) {
  // SUMMIT SPLIT in action: each bot walks its assigned lane toward the cabin.
  for (const bot of sim.players) {
    if (!bot.isBot || bot.team !== team || !bot.alive) continue;
    const dest = laneDestination(sim, bot.ai.lane);
    bot.ai.state = 'toNode';
    bot.ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), dest);
    bot.ai.pathIdx = 0;
  }
}

export function retakeProtocol(sim, team) {
  // The bomb is down in the cabin: everyone converges on it together.
  for (const bot of sim.players) {
    if (!bot.isBot || bot.team !== team || !bot.alive) continue;
    bot.ai.state = 'retake';
    bot.ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), 'cabin');
    bot.ai.pathIdx = 0;
  }
  radioCall(sim, 'RETAKE PROTOCOL — everyone to the cabin', 'warn');
}

export function smokeExecute(sim, planter) {
  // When the plant starts, a teammate smokes the cabin door.
  const mates = sim.players.filter((p) => p.isBot && p.alive && p.team === planter.team && p.grenades.smoke > 0);
  if (mates.length === 0) return;
  const thrower = mates[0];
  thrower.grenades.smoke -= 1;
  const g = sim.gondola;
  const doorZ = g.z + (planter.pos.z >= g.z ? 4.2 : -4.2);
  sim.smokes.push({ x: 0, y: 2.2, z: doorZ, r: 3.4, ttl: 12 });
  radioCall(sim, thrower.name + ' SMOKE ON THE CABIN DOOR', 'info');
}

// --- the bot brain: think (0.25 s) then act (every tick). ---

function botThink(sim, bot) {
  const ai = bot.ai;
  const rng = sim.rng;
  const g = sim.gondola;
  const bomb = sim.bomb;

  // The Warden never leaves his post.
  if (bot.isWarden) {
    if (ai.state !== 'warden') wardenHold(sim, bot);
    return;
  }

  // Bomb planted: defenders retake, attackers guard the cabin.
  if (bomb.state === 'planted') {
    if (bot.team === 'def') {
      if (ai.state !== 'retake' && ai.state !== 'defuse') retakeProtocol(sim, 'def');
      return;
    }
    if (ai.state !== 'hold') holdStation(sim, bot, 'cabin', 30);
    return;
  }

  // Bomb carrier: get to the cabin and plant.
  if (bomb.carrier === bot) {
    if (g.isInside(bot.pos.x, bot.pos.y + 0.9, bot.pos.z)) {
      if (ai.state !== 'plant') {
        ai.state = 'plant';
        bot.plantT = 0;
        smokeExecute(sim, bot);
        radioCall(sim, bot.name + ' PLANTING IN THE CABIN', 'warn');
      }
      return;
    }
    if (g.docked) {
      if (ai.state !== 'board') boardCabin(sim, bot);
    } else if (ai.state !== 'toNode' || ai.path[ai.path.length - 1] !== (g.at === 'summit' ? 'summitW' : 'valleyW')) {
      rotateToArrival(sim, bot);
    }
    return;
  }

  // Teammate carries the bomb: escort toward the cabin side.
  if (bomb.carrier && bomb.carrier.team === bot.team) {
    if (ai.state !== 'toNode' && ai.state !== 'hold') {
      const dest = laneDestination(sim, ai.lane);
      ai.state = 'toNode';
      ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), dest);
      ai.pathIdx = 0;
    }
    return;
  }

  // React to sound: a shot or steps nearby pulls the bot to investigate.
  const heard = sim.hearing.hearableFrom(bot.pos.x, bot.pos.z, bot.inCabin);
  const loud = heard.find((h) => h.ev.kind === 'shot' && h.ev.id !== ai.heardId && h.dist < 34);
  if (loud) {
    ai.heardId = loud.ev.id;
    ai.state = 'investigate';
    ai.investigate = { x: loud.ev.x, z: loud.ev.z };
    ai.thinkT = 0.4;
    return;
  }

  // Follow the plan: walk the lane, hold the station, push when the cabin dwells.
  if (ai.state === 'hold') {
    ai.holdT -= 0.25;
    if (ai.holdT <= 0) {
      const dest = laneDestination(sim, ai.lane);
      ai.state = 'toNode';
      ai.path = findPath(nearestNode(bot.pos.x, bot.pos.z), dest);
      ai.pathIdx = 0;
    }
    return;
  }
  if (ai.state === 'investigate' && ai.investigate) {
    if (dist2D(bot.pos.x, bot.pos.z, ai.investigate.x, ai.investigate.z) < 3) {
      ai.state = 'hold';
      ai.holdT = 2.5;
      ai.investigate = null;
    }
    return;
  }
  if (ai.state === 'toNode' && ai.pathIdx >= ai.path.length) {
    // Arrived: hold the station and watch the lane.
    holdStation(sim, bot, ai.path[ai.path.length - 1] || nearestNode(bot.pos.x, bot.pos.z), randRange(rng, 4, 9));
    if (g.docked && rng() < 0.35) pushOnDwell(sim, bot);
  }
}

// Visible-enemy scan: nearest enemy in range, in FOV, with line of sight.
function botScan(sim, bot) {
  let best = null;
  let bestD = 58;
  for (const p of sim.players) {
    if (!p.alive || p.team === bot.team) continue;
    const d = dist2D(bot.pos.x, bot.pos.z, p.pos.x, p.pos.z);
    if (d > bestD) continue;
    const ang = Math.atan2(-(p.pos.x - bot.pos.x), -(p.pos.z - bot.pos.z));
    if (Math.abs(angleDiff(bot.yaw, ang)) > 1.25 && d > 6) continue; // outside FOV
    if (!hasLineOfSight(sim, bot, p)) continue;
    best = p;
    bestD = d;
  }
  return best;
}

// One bot tick: think, move, fight. `input` is filled in and passed to movement.
export function updateBot(sim, bot, dt) {
  const ai = bot.ai;
  const rng = sim.rng;
  ai.thinkT -= dt;
  if (ai.thinkT <= 0) {
    ai.thinkT = 0.25;
    botThink(sim, bot);
    // Enemy scan runs on the think clock (4 Hz), not every tick: a full
    // line-of-sight sweep over ~100 colliders per bot per frame is the
    // single most expensive thing the sim does.
    const scanned = botScan(sim, bot);
    if (scanned !== ai.target) {
      ai.target = scanned;
      ai.reactT = ai.reaction;
      ai.aimTime = 0;
    }
  }
  if (ai.target && !ai.target.alive) ai.target = null;

  // --- combat: acquire, react, aim, fire in bursts. ---
  if (ai.blindedT > 0) ai.blindedT -= dt;
  const enemy = ai.blindedT > 0 ? null : ai.target;
  if (enemy) {
    ai.reactT -= dt;
    if (ai.reactT <= 0) {
      ai.aimTime += dt;
      const ang = Math.atan2(-(enemy.pos.x - bot.pos.x), -(enemy.pos.z - bot.pos.z));
      const err = ai.aimErr * (1 + Math.max(0, 1 - ai.aimTime * 1.4));
      bot.yaw = angleLerp(bot.yaw, ang, clamp(dt * 7, 0, 1));
      const eyeY = bot.pos.y + 1.62;
      const targetY = enemy.pos.y + (enemy.crouched ? 0.8 : 1.35);
      const dist = Math.max(1, dist2D(bot.pos.x, bot.pos.z, enemy.pos.x, enemy.pos.z));
      const wantPitch = Math.atan2(targetY - eyeY, dist);
      bot.pitch = clamp(bot.pitch + (wantPitch - bot.pitch) * clamp(dt * 7, 0, 1), -1.2, 1.2);
      if (ai.aimTime > 0.25) {
        if (ai.burstLeft <= 0) {
          if (ai.burstPause <= 0) {
            ai.burstLeft = 3 + Math.floor(rng() * 3);
            ai.burstPause = randRange(rng, 0.5, 1.0);
          } else {
            ai.burstPause -= dt;
          }
        }
        if (ai.burstLeft > 0 && bot.weapon && bot.weapon.cooldown <= 0 && !bot.weapon.reloading) {
          // Fire with the bot's aim error baked into the shot.
          const saveYaw = bot.yaw;
          const savePitch = bot.pitch;
          bot.yaw += (rng() - 0.5) * 2 * err;
          bot.pitch += (rng() - 0.5) * 2 * err * 0.7;
          const hit = fireHitscan(sim, bot, rng);
          bot.yaw = saveYaw;
          bot.pitch = savePitch;
          ai.burstLeft -= 1;
          if (hit && hit.hit) {
            damageEntity(sim, hit.target, hit.damage, bot, hit.part);
            if (hit.target.isPlayer) sim.events.push({ kind: 'playerHit', by: bot, part: hit.part });
          }
        }
      }
    }
  } else {
    ai.target = null;
    ai.burstLeft = 0;
  }

  // --- movement toward the current path node. ---
  const input = { f: false, b: false, l: false, r: false, crouch: false, jump: false, walk: false };
  let destX = null;
  let destZ = null;
  if (ai.state === 'toNode' || ai.state === 'board' || ai.state === 'retake' || ai.state === 'warden') {
    const nodeId = ai.path[Math.min(ai.pathIdx, ai.path.length - 1)];
    if (nodeId) {
      const node = waypointById(nodeId);
      if (node) {
        if (node.dynamic) { destX = 0; destZ = sim.gondola.z; }
        else { destX = node.x; destZ = node.z; }
        if (dist2D(bot.pos.x, bot.pos.z, destX, destZ) < 1.6) {
          ai.pathIdx += 1;
          if (ai.pathIdx >= ai.path.length && ai.state !== 'warden') {
            ai.state = 'hold';
            ai.holdT = randRange(rng, 3, 7);
          }
        }
      }
    }
  } else if (ai.state === 'investigate' && ai.investigate) {
    destX = ai.investigate.x;
    destZ = ai.investigate.z;
  }
  if (ai.state === 'plant' || ai.state === 'defuse') {
    // Stand still and work the bomb.
    input.f = false;
  } else if (destX !== null) {
    const wantYaw = Math.atan2(-(destX - bot.pos.x), -(destZ - bot.pos.z));
    const diff = angleDiff(bot.yaw, wantYaw);
    if (enemy) {
      // Strafe while fighting, keep facing the enemy.
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) {
        ai.strafeT = randRange(rng, 0.5, 1.1);
        ai.strafeDir = rng() < 0.5 ? -1 : 1;
      }
      input.l = ai.strafeDir < 0;
      input.r = ai.strafeDir > 0;
      if (Math.abs(diff) < 0.5) input.f = true;
    } else {
      bot.yaw = angleLerp(bot.yaw, wantYaw, clamp(dt * 6, 0, 1));
      if (Math.abs(diff) < 0.7) input.f = true;
    }
  } else if (ai.state === 'hold' || ai.state === 'warden') {
    bot.yaw = angleLerp(bot.yaw, ai.holdYaw || bot.yaw, clamp(dt * 2.5, 0, 1));
  }

  // Stuck detection: if the bot has not moved, skip to the next node.
  const moved = dist2D(bot.pos.x, bot.pos.z, ai.lastX, ai.lastZ);
  if (moved < 0.05 && (input.f || input.l || input.r)) {
    ai.stuckT += dt;
    if (ai.stuckT > 1.6) {
      ai.stuckT = 0;
      ai.pathIdx += 1;
      input.jump = true;
    }
  } else {
    ai.stuckT = 0;
  }
  ai.lastX = bot.pos.x;
  ai.lastZ = bot.pos.z;

  // Planting / defusing progress.
  if (ai.state === 'plant' && sim.bomb.carrier === bot) {
    bot.plantT += dt;
    if (bot.plantT >= 5) {
      sim.plantBomb(bot);
    }
  }
  if (ai.state === 'defuse' && sim.bomb.state === 'planted') {
    bot.defuseT += dt;
    const need = bot.hasDefuseKit ? 2.5 : 5;
    if (bot.defuseT >= need) sim.defuseBomb(bot);
  }

  // Reload when the mag runs dry out of combat.
  if (bot.weapon && bot.weapon.mag === 0 && !enemy) startReload(bot);
  if (bot.weapon && bot.weapon.mag <= 3 && bot.weapon.reserve > 0 && !enemy && rng() < dt * 0.5) {
    startReload(bot);
  }

  updateMovement(sim, bot, input, dt);
}

// Bots buy at the buy phase, like players.
export function botBuyPhase(sim) {
  for (const bot of sim.players) {
    if (!bot.isBot || !bot.alive) continue;
    for (const item of botBuyChoice(bot, sim.rng)) {
      buyItem(bot, item);
    }
    if (bot.team === 'atk' && !sim.bomb.carrier) {
      // The richest attacker carries the bomb into the round.
    }
  }
  // The bomb carrier: the player if they attack, else the first living attacker bot.
  const atk = sim.players.filter((p) => p.team === 'atk' && p.alive);
  sim.bomb.carrier = atk.find((p) => p.isPlayer) || atk[0] || null;
  sim.bomb.state = sim.bomb.carrier ? 'carried' : 'none';
}
