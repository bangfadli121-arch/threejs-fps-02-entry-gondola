// hud.js — every pixel of GONDOLA's interface: health, armor, ammo, money,
// round timer, score, kill feed, radio callouts, the GONDOLA tracker, the
// minimap, the buy menu, the Warden banner, the deathcam, the halftime
// scoreboard and the results screen. All DOM, all bright alpine: white panels,
// steel blue, safety orange. The 3D world never draws UI — this module does.
import { fmtMoney, fmtTime, clamp } from './utils.js';
import { catalogFor } from './economy.js';
import { WEAPONS } from './weapons.js';

function el(id) {
  return document.getElementById(id);
}

export class HUD {
  constructor(sim, callbacks) {
    this.sim = sim;
    this.cb = callbacks || {};
    this.lastFeedN = 0;
    this.lastRadioN = 0;
    this.minimapT = 0;
    this.bannerT = 0;
    this.hitT = 0;
    this.buildBuyMenu();
  }

  you() {
    return this.sim.players.find((p) => p.isPlayer);
  }

  // --- per-frame refresh (cheap DOM writes only when values change). ---
  update(dt) {
    const sim = this.sim;
    const you = this.you();
    if (!you) return;
    this.setText('health-num', Math.max(0, Math.ceil(you.hp)));
    this.setText('armor-num', Math.ceil(you.armor));
    this.setBar('hp-bar', you.hp);
    this.setBar('armor-bar', you.armor);
    const w = you.weapon;
    if (w) {
      this.setText('ammo-mag', w.reloading ? '--' : w.mag);
      this.setText('ammo-reserve', '/ ' + w.reserve);
      this.setText('weapon-name', w.def.name + (you.scoped ? ' · SCOPED' : ''));
      el('ammo').classList.toggle('empty', w.mag === 0);
      el('ammo').classList.toggle('reloading', w.reloading);
    }
    this.setText('money', fmtMoney(you.money));
    this.setText('score-atk', sim.score.atk);
    this.setText('score-def', sim.score.def);
    this.setText('kills', you.kills);
    this.setText('deaths', you.deaths);
    this.setText('round-label', 'ROUND ' + sim.round + ' / 15');
    const timerEl = el('timer');
    if (sim.phase === 'buy') {
      timerEl.textContent = 'BUY ' + fmtTime(sim.roundTime);
      timerEl.classList.add('buy');
    } else if (sim.bomb.state === 'planted') {
      timerEl.textContent = 'BOMB ' + fmtTime(sim.bomb.timer);
      timerEl.classList.add('bomb');
    } else {
      timerEl.textContent = fmtTime(sim.roundTime);
      timerEl.classList.remove('buy', 'bomb');
    }
    // Team plan of the round, always visible.
    const plan = you.team === 'atk' ? sim.planAtk : sim.planDef;
    this.setText('plan', plan ? 'PLAN: ' + plan.name : '');
    // Bomb status line.
    const bombEl = el('bomb-status');
    if (sim.bomb.state === 'carried') {
      bombEl.textContent = sim.bomb.carrier === you
        ? 'YOU carry the bomb — plant it INSIDE the cabin'
        : sim.bomb.carrier.name + ' carries the bomb';
      bombEl.className = 'carry';
    } else if (sim.bomb.state === 'planted') {
      bombEl.textContent = 'BOMB PLANTED IN THE CABIN — ' + fmtTime(sim.bomb.timer);
      bombEl.className = 'planted';
    } else if (sim.bomb.state === 'dropped') {
      bombEl.textContent = 'BOMB DROPPED — pick it up';
      bombEl.className = 'dropped';
    } else {
      bombEl.textContent = '';
      bombEl.className = '';
    }
    // Plant / defuse progress ring.
    const prog = el('plant-bar');
    if ((sim.playerPlanting || sim.playerDefusing) && sim.bomb.progress > 0) {
      prog.style.display = 'block';
      prog.firstElementChild.style.width = Math.round(sim.bomb.progress * 100) + '%';
      prog.querySelector('span').textContent = sim.playerPlanting ? 'PLANTING…' : 'DEFUSING…';
    } else {
      prog.style.display = 'none';
    }
    // Context hint.
    const hint = el('hint');
    if (sim.phase === 'play' && you.alive) {
      if (sim.bomb.carrier === you && sim.gondola.isInside(you.pos.x, you.pos.y + 0.9, you.pos.z)) {
        hint.textContent = 'Hold E — PLANT THE BOMB';
      } else if (sim.bomb.state === 'planted' && you.team === 'def' && sim.gondola.isInside(you.pos.x, you.pos.y + 0.9, you.pos.z)) {
        hint.textContent = 'Hold E — DEFUSE THE BOMB' + (you.hasDefuseKit ? ' (kit: 2.5s)' : ' (5s)');
      } else if (sim.bomb.carrier === you) {
        hint.textContent = 'Get inside the gondola cabin to plant';
      } else {
        hint.textContent = '';
      }
    } else {
      hint.textContent = '';
    }

    this.updateFeed();
    this.updateRadio();
    this.updateTracker();
    this.minimapT -= dt;
    if (this.minimapT <= 0) {
      this.minimapT = 0.12;
      this.drawMinimap();
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) el('banner').classList.add('hidden');
    }
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) el('hitmarker').classList.remove('on');
    }
  }

  setText(id, text) {
    const n = el(id);
    if (n && n._v !== text) {
      n._v = text;
      n.textContent = text;
    }
  }

  setBar(id, pct) {
    const n = el(id);
    if (!n) return;
    const v = clamp(pct, 0, 100);
    n.style.width = v + '%';
  }

  updateFeed() {
    const feed = el('feed');
    const sim = this.sim;
    while (this.lastFeedN < sim.feed.length) {
      const line = sim.feed[this.lastFeedN++];
      const div = document.createElement('div');
      div.className = 'feed-line ' + (line.kind || '');
      div.textContent = line.text;
      feed.prepend(div);
      while (feed.children.length > 6) feed.removeChild(feed.lastChild);
    }
  }

  updateRadio() {
    const box = el('radio');
    const sim = this.sim;
    while (this.lastRadioN < sim.radio.length) {
      const line = sim.radio[this.lastRadioN++];
      const div = document.createElement('div');
      div.className = 'radio-line ' + (line.kind || '');
      div.textContent = '▸ ' + line.text;
      box.prepend(div);
      while (box.children.length > 4) box.removeChild(box.lastChild);
    }
  }

  // --- the GONDOLA tracker: cable line, stations, the moving cabin dot. ---
  updateTracker() {
    const t = this.sim.gondola.tracker();
    const cabin = el('tracker-cabin');
    // Map z (-55..55) to 4%..96% along the line.
    const pct = 4 + ((t.z + 55) / 110) * 92;
    cabin.style.left = pct + '%';
    cabin.classList.toggle('transit', t.state === 'transit');
    this.setText('tracker-label', t.label);
    this.setText('tracker-count', t.state === 'dwell'
      ? 'Departs in ' + Math.ceil(t.countdown) + 's'
      : 'Arrives in ' + Math.ceil(t.countdown) + 's');
    el('tracker').classList.toggle('docked', t.state === 'dwell');
  }

  // --- minimap: top-down canvas, stations, lanes, cabin, both teams. ---
  drawMinimap() {
    const cv = el('minimap');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    const mx = (x) => ((x + 50) / 100) * (W - 16) + 8;
    const mz = (z) => ((z + 72) / 144) * (H - 16) + 8;
    ctx.clearRect(0, 0, W, H);
    // Snow background + lane shading.
    ctx.fillStyle = '#eef4f8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#dce9f2';
    ctx.fillRect(mx(-50), mz(-46), mx(50) - mx(-50), mz(46) - mz(-46));
    // Forest (west) and ridge (east) tints.
    ctx.fillStyle = '#cfe3cf';
    ctx.fillRect(mx(-48), mz(-46), mx(-8) - mx(-48), mz(46) - mz(-46));
    ctx.fillStyle = '#e2d9c8';
    ctx.fillRect(mx(8), mz(-46), mx(48) - mx(8), mz(46) - mz(-46));
    // Stations.
    ctx.fillStyle = '#8a6b46';
    ctx.fillRect(mx(-17), mz(-70), mx(17) - mx(-17), mz(-58) - mz(-70));
    ctx.fillStyle = '#9a5f4a';
    ctx.fillRect(mx(-17), mz(58), mx(17) - mx(-17), mz(70) - mz(58));
    // Dock platforms.
    ctx.fillStyle = '#a08a6a';
    ctx.fillRect(mx(-7), mz(-61), mx(7) - mx(-7), mz(-49) - mz(-61));
    ctx.fillRect(mx(7), mz(49), mx(7) - mx(-7), mz(61) - mz(49));
    // Cable lane + cable line.
    ctx.strokeStyle = '#2f6db3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx(0), mz(-55));
    ctx.lineTo(mx(0), mz(55));
    ctx.stroke();
    // Cabin dot.
    const g = this.sim.gondola;
    ctx.fillStyle = '#ff7a1a';
    ctx.beginPath();
    ctx.arc(mx(0), mz(g.z), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Bomb dot when planted.
    if (this.sim.bomb.state === 'planted') {
      ctx.fillStyle = '#e5322d';
      ctx.beginPath();
      ctx.arc(mx(this.sim.bomb.pos.x), mz(this.sim.bomb.pos.z), 5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Players: teammates blue/green, the local player white with a ring.
    const you = this.you();
    for (const p of this.sim.players) {
      if (!p.alive) continue;
      const x = mx(p.pos.x);
      const y = mz(p.pos.z);
      if (p.isPlayer) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#1d2733';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Facing tick.
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.sin(p.yaw) * 9, y - Math.cos(p.yaw) * 9);
        ctx.stroke();
      } else if (p.team === you.team) {
        ctx.fillStyle = p.team === 'atk' ? '#ff9a3c' : '#2f6db3';
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Warden marker.
    if (this.sim.warden.active && this.sim.warden.bot && this.sim.warden.bot.alive) {
      const w = this.sim.warden.bot;
      ctx.fillStyle = '#e5322d';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('W', mx(w.pos.x) - 4, mz(w.pos.z) + 4);
    }
  }

  // --- crosshair, hitmarker, damage direction. ---
  setSpread(px) {
    const c = el('crosshair');
    if (c) c.style.setProperty('--gap', Math.round(px) + 'px');
  }

  flashHitmarker(headshot) {
    const h = el('hitmarker');
    h.classList.toggle('head', !!headshot);
    h.classList.add('on');
    this.hitT = 0.18;
  }

  damageFlash(angleRad) {
    const d = el('dmgdir');
    if (!d) return;
    d.style.transform = 'translate(-50%, -50%) rotate(' + angleRad + 'rad)';
    d.classList.remove('on');
    void d.offsetWidth; // restart the animation
    d.classList.add('on');
  }

  flashbang(strength) {
    const f = el('flash-overlay');
    if (!f) return;
    f.style.opacity = strength;
    setTimeout(() => { f.style.opacity = 0; }, 60);
  }

  // --- centre banner (round wins, Warden intro, halftime). ---
  banner(main, sub, seconds, kind) {
    const b = el('banner');
    el('banner-main').textContent = main;
    el('banner-sub').textContent = sub || '';
    b.className = 'show ' + (kind || '');
    this.bannerT = seconds || 3;
  }

  wardenBanner() {
    this.banner('THE WARDEN HOLDS THE SUMMIT', 'Heavy gunner · 250 HP · $500 bounty if you drop him', 4, 'warden');
  }

  // --- buy menu: built from the economy catalog, keyboard 1-8 works too. ---
  buildBuyMenu() {
    const list = el('buy-items');
    if (!list) return;
    list.innerHTML = '';
    const you = this.you();
    const items = catalogFor(you);
    items.forEach((item, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'buy-row';
      row.dataset.item = item.id;
      row.innerHTML = '<span class="buy-key">' + (i + 1) + '</span>' +
        '<span class="buy-name">' + item.label + '</span>' +
        '<span class="buy-blurb">' + item.blurb + '</span>' +
        '<span class="buy-price">' + fmtMoney(item.price) + '</span>';
      row.addEventListener('click', () => this.buy(item.id));
      list.appendChild(row);
    });
  }

  buy(itemId) {
    const you = this.you();
    if (!you) return;
    // The buy itself lives in economy.js; hud only routes the click.
    this.cb.onBuy && this.cb.onBuy(itemId);
    this.setText('buy-money', fmtMoney(you.money));
  }

  showBuyMsg(text) {
    this.setText('buy-msg', text);
  }

  refreshBuy() {
    this.buildBuyMenu();
    const you = this.you();
    this.setText('buy-money', fmtMoney(you ? you.money : 0));
    this.setText('buy-msg', '');
    // The gondola schedule strip under the buy list.
    const g = this.sim.gondola.tracker();
    this.setText('buy-schedule', 'GONDOLA — ' + g.label);
  }

  showBuy(show) {
    el('buy').classList.toggle('hidden', !show);
    if (show) this.refreshBuy();
  }

  // --- screens: title, halftime scoreboard, results. ---
  showTitle(show) {
    el('title').classList.toggle('hidden', !show);
  }

  showDeathcam(show, killerName) {
    const d = el('deathcam');
    d.classList.toggle('hidden', !show);
    if (show) this.setText('deathcam-text', 'Killed by ' + (killerName || 'an enemy') + ' — deathcam');
  }

  scoreboardRows() {
    const rows = [...this.sim.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return rows.map((p) =>
      '<tr class="' + (p.isPlayer ? 'me' : '') + (p.isWarden ? ' warden' : '') + '">' +
      '<td>' + p.name + (p.isWarden ? ' 👑' : '') + '</td>' +
      '<td>' + (p.team === 'atk' ? 'ATK' : 'DEF') + '</td>' +
      '<td>' + p.kills + '</td><td>' + p.deaths + '</td>' +
      '<td>' + fmtMoney(p.money) + '</td></tr>').join('');
  }

  showHalftime(show) {
    const h = el('halftime');
    h.classList.toggle('hidden', !show);
    if (show) {
      this.setText('halftime-score', 'ATK ' + this.sim.score.atk + ' — ' + this.sim.score.def + ' DEF');
      el('halftime-table').innerHTML = this.scoreboardRows();
    }
  }

  showResults(show) {
    const r = el('results');
    r.classList.toggle('hidden', !show);
    if (show) {
      const you = this.you();
      const winner = this.sim.matchWinner;
      const title = winner === 'draw' ? 'DRAW' :
        (you.team === winner ? 'VICTORY' : 'DEFEAT');
      this.setText('results-title', title + ' — GONDOLA');
      this.setText('results-score', 'ATK ' + this.sim.score.atk + ' — ' + this.sim.score.def + ' DEF');
      this.setText('results-you', 'YOU — ' + you.kills + ' kills · ' + you.deaths + ' deaths · ' + fmtMoney(you.money));
      el('results-table').innerHTML = this.scoreboardRows();
    }
  }

  // Weapon switch / grenade feedback line under the crosshair.
  toast(text) {
    const t = el('toast');
    if (!t) return;
    t.textContent = text;
    t.classList.remove('on');
    void t.offsetWidth;
    t.classList.add('on');
  }
}
