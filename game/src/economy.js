// economy.js — GONDOLA money: earn it in rounds, spend it in the buy menu.
// Start $800, kill +$300, round win +$3,250, round loss +$1,900 with a +$500
// loss-streak bonus (max two streak steps, CS-style). Killing THE WARDEN pays
// a $500 bounty on top. Everything the HUD and the buy menu show comes from here.
import { WEAPONS, BUY_CATALOG, makeWeapon } from './weapons.js';

export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const WIN_REWARD = 3250;
export const LOSS_REWARD = 1900;
export const LOSS_STREAK_BONUS = 500;
export const MAX_LOSS_STREAK = 2;
export const WARDEN_BOUNTY = 500;
export const MAX_MONEY = 16000;

export function startMoney() {
  return START_MONEY;
}

export function addMoney(p, amount) {
  p.money = Math.min(MAX_MONEY, p.money + amount);
  return p.money;
}

// End-of-round payout for one player. `won` is whether their team won the round,
// `lossStreak` is how many rounds in a row their team has lost (1 for the first).
export function roundPayout(p, won, lossStreak) {
  if (won) return WIN_REWARD;
  const streak = Math.min(Math.max(0, lossStreak - 1), MAX_LOSS_STREAK);
  return LOSS_REWARD + streak * LOSS_STREAK_BONUS;
}

// The buy catalog, filtered for a player: defenders may buy the defuse kit,
// attackers may not; the Warden's LMG is never listed.
export function catalogFor(p) {
  return BUY_CATALOG.filter((item) => {
    if (item.id === 'defusekit' && p.team !== 'def') return false;
    return true;
  });
}

// Buy one catalog item. Returns {ok, reason} — the buy menu shows the reason.
export function buyItem(p, itemId) {
  const item = BUY_CATALOG.find((c) => c.id === itemId);
  if (!item) return { ok: false, reason: 'No such item.' };
  if (item.id === 'defusekit' && p.team !== 'def') {
    return { ok: false, reason: 'Defuse kits are for defenders only.' };
  }
  if (p.money < item.price) {
    return { ok: false, reason: 'Not enough money — need $' + item.price + '.' };
  }
  if (item.id === 'armor' && p.armor >= 100) {
    return { ok: false, reason: 'Armor already full.' };
  }
  if (item.id === 'defusekit' && p.hasDefuseKit) {
    return { ok: false, reason: 'You already carry a defuse kit.' };
  }
  if (item.id === 'smoke' && p.grenades.smoke >= 2) {
    return { ok: false, reason: 'Smoke pouch is full (2).' };
  }
  if (item.id === 'flash' && p.grenades.flash >= 2) {
    return { ok: false, reason: 'Flash pouch is full (2).' };
  }
  p.money -= item.price;
  switch (item.id) {
    case 'armor':
      p.armor = 100;
      break;
    case 'smoke':
      p.grenades.smoke += 1;
      break;
    case 'flash':
      p.grenades.flash += 1;
      break;
    case 'defusekit':
      p.hasDefuseKit = true;
      break;
    case 'ammo':
      for (const slot of ['primary', 'secondary']) {
        const w = p.weapons[slot];
        if (w) w.reserve = w.def.reserve;
      }
      break;
    default: {
      // A gun: it becomes the primary, keeping the pistol as secondary.
      const w = makeWeapon(item.id);
      p.weapons.primary = w;
      p.weapon = w;
      break;
    }
  }
  return { ok: true, reason: 'Bought ' + item.label + '.' };
}

// What a bot can afford, in priority order — bots buy like players do.
export function botBuyChoice(p, rng) {
  const want = [];
  if (p.money >= WEAPONS.rifle.price && (!p.weapons.primary || p.weapons.primary.id === 'pistol')) {
    want.push('rifle');
  } else if (p.money >= WEAPONS.smg.price && (!p.weapons.primary || p.weapons.primary.id === 'pistol')) {
    want.push('smg');
  }
  if (p.team === 'def' && p.money >= 400 && !p.hasDefuseKit && rng() < 0.6) want.push('defusekit');
  if (p.money >= 650 && p.armor < 50 && rng() < 0.7) want.push('armor');
  if (p.team === 'atk' && p.money >= 300 && p.grenades.smoke < 1 && rng() < 0.5) want.push('smoke');
  if (p.money >= 200 && p.grenades.flash < 1 && rng() < 0.4) want.push('flash');
  return want;
}

// A short money line for the HUD and the scoreboard.
export function moneyLine(p) {
  return '$' + p.money;
}
