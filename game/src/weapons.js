// weapons.js — the GONDOLA armoury: four buyable guns plus the Warden's LMG.
// Every gun is data, not code: fire rate, damage falloff, recoil, spread and price
// live in one table so the buy menu, the HUD and the sim all read the same truth.
// Damage model: head x4 (helmet x2), body x1, legs x0.75. Recoil climbs with
// every consecutive shot and spread blooms while moving or airborne, so stopping
// to aim always pays — the gunplay the bounty asks for.
import { clamp, randRange } from './utils.js';

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', kind: 'pistol', price: 0, auto: false,
    damage: 34, headMult: 4, legMult: 0.75, range: 42, falloff: 0.45,
    fireInterval: 0.16, reloadTime: 1.4, mag: 12, reserve: 36,
    spreadBase: 0.011, spreadMove: 0.030, spreadAir: 0.055, spreadBloom: 0.004,
    recoilKick: 0.011, recoilRecover: 0.055, moveSpeed: 6.1, zoom: 1,
    tracer: 0xffe08a, desc: 'Reliable sidearm. Free, always in your holster.',
  },
  smg: {
    id: 'smg', name: 'V10 Spray', kind: 'smg', price: 1500, auto: true,
    damage: 26, headMult: 4, legMult: 0.75, range: 34, falloff: 0.5,
    fireInterval: 0.075, reloadTime: 1.9, mag: 25, reserve: 100,
    spreadBase: 0.02, spreadMove: 0.042, spreadAir: 0.07, spreadBloom: 0.006,
    recoilKick: 0.008, recoilRecover: 0.075, moveSpeed: 5.9, zoom: 1,
    tracer: 0xffd23e, desc: 'Close-quarters hose. Melts cabin fights, wild at range.',
  },
  rifle: {
    id: 'rifle', name: 'AR-77 Ridge', kind: 'rifle', price: 2700, auto: true,
    damage: 33, headMult: 4, legMult: 0.75, range: 70, falloff: 0.35,
    fireInterval: 0.105, reloadTime: 2.2, mag: 30, reserve: 90,
    spreadBase: 0.009, spreadMove: 0.034, spreadAir: 0.06, spreadBloom: 0.005,
    recoilKick: 0.014, recoilRecover: 0.06, moveSpeed: 5.6, zoom: 1,
    tracer: 0xffe08a, desc: 'The all-rounder. Tap it on the bridge, hold it in the cabin.',
  },
  sniper: {
    id: 'sniper', name: 'GL-9 Longshot', kind: 'sniper', price: 4750, auto: false,
    damage: 115, headMult: 4, legMult: 0.75, range: 120, falloff: 0.12,
    fireInterval: 1.15, reloadTime: 2.9, mag: 5, reserve: 15,
    spreadBase: 0.0015, spreadMove: 0.09, spreadAir: 0.14, spreadBloom: 0.002,
    recoilKick: 0.055, recoilRecover: 0.03, moveSpeed: 5.1, zoom: 2.6,
    tracer: 0x9fd8ff, desc: 'One shot, one ridge-line. Scope with right click.',
  },
  lmg: {
    id: 'lmg', name: 'WARDEN LMG', kind: 'lmg', price: 0, auto: true,
    damage: 30, headMult: 4, legMult: 0.75, range: 60, falloff: 0.4,
    fireInterval: 0.09, reloadTime: 3.2, mag: 60, reserve: 120,
    spreadBase: 0.018, spreadMove: 0.04, spreadAir: 0.065, spreadBloom: 0.005,
    recoilKick: 0.012, recoilRecover: 0.065, moveSpeed: 4.9, zoom: 1,
    tracer: 0xff5a3c, desc: 'The Warden\'s belt-fed anchor gun. Not for sale.',
  },
};

export const BUY_CATALOG = [
  { id: 'smg', label: 'V10 Spray — SMG', price: 1500, blurb: '25/100 · close range shredder' },
  { id: 'rifle', label: 'AR-77 Ridge — Rifle', price: 2700, blurb: '30/90 · the all-rounder' },
  { id: 'sniper', label: 'GL-9 Longshot — Sniper', price: 4750, blurb: '5/15 · scope, one-tap headshot' },
  { id: 'armor', label: 'Steel Vest — Armor', price: 650, blurb: '+100 armor, halves body damage' },
  { id: 'smoke', label: 'Smoke Grenade', price: 300, blurb: 'Blocks sight for 12 s — plant cover' },
  { id: 'flash', label: 'Flash Grenade', price: 200, blurb: 'Blinds anyone facing it' },
  { id: 'defusekit', label: 'Defuse Kit', price: 400, blurb: 'Defuse in 2.5 s instead of 5 s' },
  { id: 'ammo', label: 'Refill Reserve Ammo', price: 250, blurb: 'Top up every mag you own' },
];

// A live gun instance: mag, reserve, bloom and reload state.
export function makeWeapon(id) {
  const def = WEAPONS[id];
  return {
    id: def.id, def,
    mag: def.mag, reserve: def.reserve,
    bloom: 0, reloadT: 0, reloading: false,
    cooldown: 0, lastShot: -10,
  };
}

// Damage at a distance, by hit zone. `part` is 'head' | 'body' | 'leg'.
export function weaponDamage(def, part, dist) {
  const fall = dist > def.range ? 1 - def.falloff * clamp((dist - def.range) / def.range, 0, 1) : 1;
  let d = def.damage * fall;
  if (part === 'head') d *= def.headMult;
  else if (part === 'leg') d *= def.legMult;
  return d;
}

// Current spread in radians for a shooter, from movement state and bloom.
export function spreadFor(weapon, moveSpeed, airborne, crouched, scoped) {
  const def = weapon.def;
  let s = def.spreadBase + weapon.bloom;
  if (moveSpeed > 0.6) s += def.spreadMove * clamp(moveSpeed / 6, 0, 1);
  if (airborne) s += def.spreadAir;
  if (crouched) s *= 0.7;
  if (scoped) s *= 0.22;
  return s;
}

// Apply one shot of recoil: pitch kick + bloom growth. Returns the pitch kick.
export function applyRecoil(weapon, rng) {
  const def = weapon.def;
  weapon.bloom = clamp(weapon.bloom + def.spreadBloom, 0, 0.09);
  weapon.lastShot = 0;
  return def.recoilKick * randRange(rng, 0.85, 1.2);
}

// Recover bloom and recoil over dt seconds of not firing.
export function recoverWeapon(weapon, dt) {
  weapon.bloom = Math.max(0, weapon.bloom - weapon.def.recoilRecover * dt);
  if (weapon.cooldown > 0) weapon.cooldown -= dt;
  if (weapon.reloading) {
    weapon.reloadT -= dt;
    if (weapon.reloadT <= 0) {
      weapon.reloading = false;
      const need = weapon.def.mag - weapon.mag;
      const take = Math.min(need, weapon.reserve);
      weapon.mag += take;
      weapon.reserve -= take;
    }
  }
}

export function startReload(weapon) {
  if (weapon.reloading) return false;
  if (weapon.mag >= weapon.def.mag || weapon.reserve <= 0) return false;
  weapon.reloading = true;
  weapon.reloadT = weapon.def.reloadTime;
  return true;
}

// Armor absorbs half the damage until it breaks; the rest hits health.
export function applyArmorDamage(target, raw) {
  let remaining = raw;
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, raw * 0.5);
    target.armor -= absorbed;
    remaining = raw - absorbed;
  }
  target.hp -= remaining;
  return remaining;
}
