// player.js — one entity model for the local player AND the bots. A fighter is a
// position, a yaw/pitch, health, armor, a weapon pair and grenades; movement is
// acceleration-based with crouch, jump and AABB collision, and shooting is a
// hitscan ray against bot hit-spheres (head / body / leg) blocked by the world.
// The viewmodel (gun + hands + reload animation) lives here too, attached to
// the camera in main.js.
import * as THREE from 'three';
import {
  clamp, resolveCircleAABB, segmentAABB, raySphere, angleLerp,
} from './utils.js';
import { WEAPONS, makeWeapon, weaponDamage, spreadFor, applyRecoil, recoverWeapon, applyArmorDamage } from './weapons.js';
import { groundHeightAt, MAP } from './map.js';
import { CABIN_HALF, CABIN_FLOOR_Y } from './gondola.js';

export const EYE_HEIGHT = 1.62;
export const EYE_CROUCH = 1.12;
export const PLAYER_RADIUS = 0.42;
export const GRAVITY = 19;
export const JUMP_VEL = 6.4;

const _out = { x: 0, z: 0 }; // collision scratch, never allocated per frame

export function createEntity(opts) {
  const e = {
    id: opts.id,
    name: opts.name,
    team: opts.team, // 'atk' | 'def'
    isPlayer: !!opts.isPlayer,
    isBot: !!opts.isBot,
    isWarden: false,
    pos: new THREE.Vector3(opts.x || 0, 0, opts.z || 0),
    vel: new THREE.Vector3(),
    yaw: opts.yaw || 0,
    pitch: 0,
    hp: 100,
    armor: 0,
    alive: true,
    crouched: false,
    onGround: true,
    inCabin: false,
    weapons: { primary: null, secondary: makeWeapon('pistol') },
    weapon: null,
    grenades: { smoke: 0, flash: 0 },
    hasDefuseKit: false,
    money: 800,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    moveSpeed: 0,
    airborne: false,
    fireHeld: false,
    scoped: false,
    stepT: 0,
    lastHitBy: null,
    lastHitDir: 0,
    mesh: null,
    ai: null,
    plantT: 0,
    defuseT: 0,
  };
  e.weapon = e.weapons.secondary;
  if (opts.primary) {
    e.weapons.primary = makeWeapon(opts.primary);
    e.weapon = e.weapons.primary;
  }
  return e;
}

export function resetEntity(e, x, z, yaw, team) {
  e.pos.set(x, groundHeightAt(x, z), z);
  e.vel.set(0, 0, 0);
  e.yaw = yaw;
  e.pitch = 0;
  e.hp = e.isWarden ? 250 : 100;
  e.armor = 0;
  e.alive = true;
  e.crouched = false;
  e.onGround = true;
  e.inCabin = false;
  e.weapons = { primary: null, secondary: makeWeapon('pistol') };
  e.weapon = e.weapons.secondary;
  e.grenades = { smoke: 0, flash: 0 };
  e.hasDefuseKit = false;
  e.plantT = 0;
  e.defuseT = 0;
  e.fireHeld = false;
  e.scoped = false;
  e.team = team;
  if (e.mesh) e.mesh.visible = true;
}

// --- bot bodies: simple readable figures, team-coloured, Warden oversized. ---
export function buildAgentMesh(scene, e) {
  const g = new THREE.Group();
  const teamColor = e.team === 'atk' ? 0xff7a1a : 0x2f6db3;
  const bodyMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.7 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a986, roughness: 0.8 });
  const scale = e.isWarden ? 1.22 : 1;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62 * scale, 0.78 * scale, 0.36 * scale), bodyMat);
  body.position.y = 0.95 * scale;
  g.add(body);
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.66 * scale, 0.4 * scale, 0.4 * scale), darkMat);
  vest.position.y = 1.05 * scale;
  g.add(vest);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21 * scale, 12, 10), skinMat);
  head.position.y = 1.55 * scale;
  g.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.23 * scale, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), bodyMat);
  helmet.position.y = 1.57 * scale;
  g.add(helmet);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2 * scale, 0.55 * scale, 0.22 * scale), darkMat);
    leg.position.set(s * 0.15 * scale, 0.28 * scale, 0);
    g.add(leg);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16 * scale, 0.55 * scale, 0.18 * scale), bodyMat);
    arm.position.set(s * 0.4 * scale, 1.05 * scale, 0.1 * scale);
    g.add(arm);
  }
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.85 * scale), darkMat);
  gun.position.set(0.18 * scale, 1.15 * scale, 0.4 * scale);
  g.add(gun);
  if (e.isWarden) {
    const plume = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xff3b30, roughness: 0.6 }));
    plume.position.y = 1.95;
    g.add(plume);
  }
  g.visible = false;
  scene.add(g);
  e.mesh = g;
  return g;
}

export function syncAgentMesh(e) {
  if (!e.mesh) return;
  e.mesh.visible = e.alive;
  if (!e.alive) return;
  e.mesh.position.copy(e.pos);
  e.mesh.rotation.y = e.yaw + Math.PI; // model faces +Z, yaw faces -Z
  e.mesh.position.y = e.pos.y + (e.crouched ? -0.22 : 0);
}

export function eyePos(e, out) {
  out.set(e.pos.x, e.pos.y + (e.crouched ? EYE_CROUCH : EYE_HEIGHT), e.pos.z);
  return out;
}

// --- movement: acceleration, friction, jump, crouch, AABB collision. ---
// input: {f, b, l, r, crouch, jump, walk} — all booleans. Returns nothing;
// the entity's pos/vel are updated in place.
export function updateMovement(sim, e, input, dt) {
  const w = e.weapon ? e.weapon.def.moveSpeed : 5.6;
  let speed = w;
  if (e.crouched) speed *= 0.5;
  else if (input.walk) speed *= 0.55;
  if (e.scoped) speed *= 0.5;

  const sin = Math.sin(e.yaw);
  const cos = Math.cos(e.yaw);
  // Forward is -Z rotated by yaw; right is +X rotated by yaw.
  let mx = 0;
  let mz = 0;
  if (input.f) { mx += -sin; mz += -cos; }
  if (input.b) { mx += sin; mz += cos; }
  if (input.r) { mx += cos; mz += -sin; }
  if (input.l) { mx += -cos; mz += sin; }
  const ml = Math.hypot(mx, mz);
  if (ml > 0) { mx /= ml; mz /= ml; }

  const accel = e.onGround ? 42 : 14;
  e.vel.x += mx * accel * dt;
  e.vel.z += mz * accel * dt;
  // Friction when no input: the stop is a slide, not a snap.
  if (ml === 0 && e.onGround) {
    const f = Math.max(0, 1 - 11 * dt);
    e.vel.x *= f;
    e.vel.z *= f;
  }
  // Cap horizontal speed.
  const hs = Math.hypot(e.vel.x, e.vel.z);
  if (hs > speed) {
    e.vel.x = (e.vel.x / hs) * speed;
    e.vel.z = (e.vel.z / hs) * speed;
  }
  e.moveSpeed = Math.hypot(e.vel.x, e.vel.z);

  // Jump + gravity.
  if (input.jump && e.onGround) {
    e.vel.y = JUMP_VEL;
    e.onGround = false;
  }
  e.vel.y -= GRAVITY * dt;
  e.crouched = !!input.crouch;

  e.pos.x += e.vel.x * dt;
  e.pos.z += e.vel.z * dt;
  e.pos.y += e.vel.y * dt;

  // Ground: snow deck, dock platforms, ramps — and the cabin floor when the
  // entity is up at cabin height inside the cabin footprint.
  let ground = groundHeightAt(e.pos.x, e.pos.z);
  const gz = sim.gondola.z;
  if (e.pos.y > 1.0 && Math.abs(e.pos.x) < CABIN_HALF.x && Math.abs(e.pos.z - gz) < CABIN_HALF.z) {
    ground = Math.max(ground, CABIN_FLOOR_Y);
  }
  if (e.pos.y <= ground) {
    e.pos.y = ground;
    e.vel.y = 0;
    e.onGround = true;
  } else if (e.pos.y > ground + 0.05) {
    e.onGround = false;
  }
  e.airborne = !e.onGround;

  // Map bounds.
  e.pos.x = clamp(e.pos.x, MAP.minX + 1, MAP.maxX - 1);
  e.pos.z = clamp(e.pos.z, MAP.minZ + 1, MAP.maxZ - 1);

  // Colliders: circle vs AABB, only boxes overlapping the body vertically.
  const feet = e.pos.y;
  const head = e.pos.y + (e.crouched ? 1.25 : 1.78);
  const testBox = (b) => {
    if (b.maxY < feet + 0.15 || b.minY > head - 0.15) return;
    if (resolveCircleAABB(e.pos.x, e.pos.z, PLAYER_RADIUS, b, _out)) {
      e.pos.x = _out.x;
      e.pos.z = _out.z;
    }
  };
  for (const b of sim.colliders) testBox(b);
  for (const b of sim.gondola.wallBoxes()) testBox(b);

  // Footsteps: a sound the hearing bus carries to bots and the HUD.
  if (e.onGround && e.moveSpeed > 1.5) {
    e.stepT -= dt * e.moveSpeed;
    if (e.stepT <= 0) {
      e.stepT = 2.6;
      sim.hearing.emit('step', e.pos.x, e.pos.z, e.moveSpeed > 4.5 ? 0.45 : 0.25);
      if (e.isPlayer) sim.sound.step(e.moveSpeed > 4.5, e.inCabin);
    }
  }
}

// --- shooting: one hitscan shot from the entity's eye. ---
// Returns null (no hit / blocked) or {target, part, dist, damage, point}.
// The sim applies the damage; this function only finds the hit.
export function fireHitscan(sim, e, rng) {
  const w = e.weapon;
  if (!w || w.mag <= 0 || w.reloading || w.cooldown > 0) return null;
  w.mag -= 1;
  w.cooldown = w.def.fireInterval;
  const spread = spreadFor(w, e.moveSpeed, e.airborne, e.crouched, e.scoped);
  const eye = eyePos(e, fireHitscan._eye || (fireHitscan._eye = new THREE.Vector3()));
  // Direction from yaw/pitch plus a random cone offset for spread.
  const cp = Math.cos(e.pitch);
  let dx = -Math.sin(e.yaw) * cp;
  let dy = Math.sin(e.pitch);
  let dz = -Math.cos(e.yaw) * cp;
  const rx = (rng() - 0.5) * 2 * spread;
  const ry = (rng() - 0.5) * 2 * spread;
  // Right vector and up vector for the spread offset.
  const rxv = Math.cos(e.yaw);
  const rzv = -Math.sin(e.yaw);
  dx += rxv * rx;
  dz += rzv * rx;
  dy += ry;
  const dl = Math.hypot(dx, dy, dz);
  dx /= dl; dy /= dl; dz /= dl;
  const maxDist = 220;

  // Nearest world block.
  let worldDist = maxDist;
  const segEnd = { x: eye.x + dx * maxDist, y: eye.y + dy * maxDist, z: eye.z + dz * maxDist };
  for (const b of sim.colliders) {
    const t = segmentAABB(eye.x, eye.y, eye.z, segEnd.x - eye.x, segEnd.y - eye.y, segEnd.z - eye.z, b);
    if (t >= 0 && t * maxDist < worldDist) worldDist = t * maxDist;
  }
  for (const b of sim.gondola.wallBoxes()) {
    const t = segmentAABB(eye.x, eye.y, eye.z, segEnd.x - eye.x, segEnd.y - eye.y, segEnd.z - eye.z, b);
    if (t >= 0 && t * maxDist < worldDist) worldDist = t * maxDist;
  }

  // Nearest bot hit-sphere: head, body, leg — the closest sphere wins.
  let best = null;
  for (const t of sim.players) {
    if (t === e || !t.alive) continue;
    if (t.team === e.team) continue;
    const crouch = t.crouched ? 0.55 : 1;
    const tests = [
      ['head', t.pos.x, t.pos.y + 1.55 * crouch + 0.1, t.pos.z, 0.24],
      ['body', t.pos.x, t.pos.y + 0.95 * crouch, t.pos.z, 0.5],
      ['leg', t.pos.x, t.pos.y + 0.35, t.pos.z, 0.42],
    ];
    for (const [part, cx, cy, cz, r] of tests) {
      const d = raySphere(eye.x, eye.y, eye.z, dx, dy, dz, cx, cy, cz, r, maxDist);
      if (d >= 0 && d < worldDist && (!best || d < best.dist)) {
        best = { target: t, part, dist: d };
      }
    }
  }

  // Recoil kick on the shooter.
  const kick = applyRecoil(w, rng);
  e.pitch = clamp(e.pitch + kick, -1.5, 1.5);

  // Tracer + sound + hearing, always, hit or miss.
  const endDist = best ? best.dist : worldDist;
  sim.tracers.push({
    x1: eye.x, y1: eye.y, z1: eye.z,
    x2: eye.x + dx * endDist, y2: eye.y + dy * endDist, z2: eye.z + dz * endDist,
    color: w.def.tracer, ttl: 0.07,
  });
  sim.hearing.emit('shot', e.pos.x, e.pos.z, 1);
  if (e.isPlayer) sim.sound.shot(w.id, 0, e.inCabin);

  if (!best) return { hit: false, dist: endDist };
  const damage = weaponDamage(w.def, best.part, best.dist);
  return { hit: true, target: best.target, part: best.part, dist: best.dist, damage };
}

// Apply a hit to a target: armor, health, death, rewards, killfeed.
export function damageEntity(sim, target, damage, attacker, part) {
  if (!target.alive) return;
  const dealt = applyArmorDamage(target, damage);
  if (attacker) attacker.damageDealt += dealt;
  target.lastHitBy = attacker;
  if (attacker) {
    const dx = target.pos.x - attacker.pos.x;
    const dz = target.pos.z - attacker.pos.z;
    target.lastHitDir = Math.atan2(dx, dz);
  }
  if (target.hp > 0) return;
  target.hp = 0;
  target.alive = false;
  target.deaths += 1;
  if (target.mesh) target.mesh.visible = false;
  if (attacker && attacker !== target) {
    attacker.kills += 1;
    attacker.money = Math.min(16000, attacker.money + 300);
    if (target.isWarden) {
      attacker.money = Math.min(16000, attacker.money + 500);
      sim.feed.push({ text: attacker.name + ' killed THE WARDEN (+$500 bounty)', kind: 'warden' });
    }
  }
  sim.feed.push({
    text: (attacker ? attacker.name : 'The mountain') + ' ▸ ' + target.name +
      (part === 'head' ? ' (headshot)' : ''),
    kind: attacker && attacker.team === 'atk' ? 'atk' : 'def',
  });
  if (target.isPlayer) sim.events.push({ kind: 'playerDied', by: attacker });
  // Drop the bomb where the carrier fell.
  if (sim.bomb.carrier === target) {
    sim.bomb.carrier = null;
    sim.bomb.state = 'dropped';
    sim.bomb.pos.x = target.pos.x;
    sim.bomb.pos.z = target.pos.z;
    sim.radio.push({ text: 'BOMB DOWN — ' + (target.isPlayer ? 'you dropped it' : target.name + ' dropped it'), kind: 'warn' });
  }
}

export function startReload(e) {
  if (!e.weapon) return false;
  if (e.weapon.reloading) return false;
  if (e.weapon.mag >= e.weapon.def.mag || e.weapon.reserve <= 0) return false;
  e.weapon.reloading = true;
  e.weapon.reloadT = e.weapon.def.reloadTime;
  return true;
}

export function switchWeapon(e, slot) {
  const w = e.weapons[slot];
  if (!w || e.weapon === w) return false;
  if (e.weapon) e.weapon.reloading = false;
  e.weapon = w;
  e.scoped = false;
  return true;
}

// --- viewmodel: gun + hands attached to the camera. ---
export function createViewmodel(camera) {
  const g = new THREE.Group();
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.5, metalness: 0.5 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.3 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a986, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.62), gunMat);
  body.position.set(0, 0, -0.1);
  g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.5);
  g.add(barrel);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.05), accentMat);
  sight.position.set(0, 0.1, -0.2);
  g.add(sight);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), gunMat);
  mag.position.set(0, -0.13, -0.05);
  g.add(mag);
  // Hands: a grip hand and a fore hand on the barrel.
  const hand1 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.13), skinMat);
  hand1.position.set(0.02, -0.1, 0.02);
  g.add(hand1);
  const hand2 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.12), skinMat);
  hand2.position.set(-0.03, -0.07, -0.32);
  g.add(hand2);
  g.position.set(0.34, -0.3, -0.55);
  camera.add(g);
  return {
    group: g,
    bobT: 0,
    kick: 0,
    reloadAnim: 0,
    update(dt, e, firing) {
      this.bobT += dt * (2 + e.moveSpeed * 1.6);
      const bob = e.moveSpeed > 0.5 ? Math.sin(this.bobT) * 0.008 : 0;
      const bobY = e.moveSpeed > 0.5 ? Math.abs(Math.cos(this.bobT)) * 0.01 : 0;
      if (firing) this.kick = 0.09;
      this.kick = Math.max(0, this.kick - dt * 0.55);
      const w = e.weapon;
      if (w && w.reloading) {
        this.reloadAnim = Math.min(1, this.reloadAnim + dt / w.def.reloadTime);
      } else {
        this.reloadAnim = 0;
      }
      // Reload dips the gun down and tilts it; scoped sniper centres the gun.
      const dip = Math.sin(this.reloadAnim * Math.PI) * 0.22;
      const scoped = e.scoped && e.weapon && e.weapon.id === 'sniper';
      g.position.set(
        scoped ? 0 : 0.34 + bob,
        -0.3 + bobY - dip,
        -0.55 + this.kick + dip * 0.4,
      );
      g.rotation.x = this.kick * 1.6 + dip * 0.9;
      g.rotation.z = scoped ? 0 : dip * 0.25;
      g.visible = e.alive;
    },
  };
}
