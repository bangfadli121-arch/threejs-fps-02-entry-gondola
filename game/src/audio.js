// audio.js — every sound in GONDOLA is synthesised with WebAudio: no audio files,
// no network, no assets. Gunshots, reloads, footsteps, plant beeps, the cable
// hum, the Warden's horn and the radio blips are all oscillators and noise
// buffers built at runtime. The hearing system (HearingBus) is the same bus the
// bots listen on: a gunshot inside the glass cabin echoes differently, footsteps
// carry through walls with a direction, and bots investigate what they hear.
import { clamp, dist2D } from './utils.js';

// --- HearingBus: one named system for sound that travels and gets reacted to. ---
// A "heard event" is {kind, x, z, loud, at}. Bots subscribe through
// hearing.eventsSince(t); the HUD shows a direction tick for the local player.
export class HearingBus {
  constructor() {
    this.events = [];
    this.lastId = 0;
  }

  // kind: 'shot' | 'step' | 'plant' | 'explosion' | 'cable' | 'reload'
  // loud is 0..1; only events loud enough travel far enough to matter.
  emit(kind, x, z, loud) {
    const ev = { id: ++this.lastId, kind, x, z, loud, at: performance.now() / 1000 };
    this.events.push(ev);
    if (this.events.length > 64) this.events.shift();
    return ev;
  }

  // Events a listener at (x, z) can hear: range grows with loudness, and a
  // gunshot inside the glass cabin (inCabin) echoes — it carries 1.6x further.
  hearableFrom(x, z, inCabin) {
    const out = [];
    for (const ev of this.events) {
      const range = ev.loud * 55 * (ev.kind === 'shot' && inCabin ? 1.6 : 1);
      const d = dist2D(x, z, ev.x, ev.z);
      if (d <= range) out.push({ ev, dist: d });
    }
    return out;
  }

  // The newest event of a kind, for bots that react to a single cue.
  latest(kind) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].kind === kind) return this.events[i];
    }
    return null;
  }

  clear() {
    this.events.length = 0;
  }
}

// --- SoundSynth: WebAudio instruments, created lazily on first user gesture. ---
export class SoundSynth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
    this.cableHum = null;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.42;
      this.master.connect(this.ctx.destination);
      // Shared white-noise buffer for shots, steps and explosions.
      const len = this.ctx.sampleRate * 1;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return true;
    } catch {
      return false;
    }
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.42;
  }

  _noise(dur, filterFreq, gain, type = 'lowpass', when = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  _tone(freq, dur, gain, type = 'sine', slideTo = 0, when = 0) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo > 0) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // distance 0..1 attenuates and low-passes the sound, like hearing through air.
  shot(weaponId, dist01, inCabin) {
    if (!this.ensure()) return;
    const v = clamp(1 - dist01 * 0.75, 0.15, 1);
    if (weaponId === 'sniper') {
      this._noise(0.32, 900, 0.9 * v);
      this._tone(160, 0.22, 0.5 * v, 'square', 55);
    } else if (weaponId === 'lmg') {
      this._noise(0.16, 1400, 0.7 * v);
      this._tone(110, 0.12, 0.4 * v, 'sawtooth', 70);
    } else if (weaponId === 'pistol') {
      this._noise(0.1, 2200, 0.55 * v);
      this._tone(220, 0.08, 0.3 * v, 'square', 90);
    } else {
      this._noise(0.13, 1700, 0.75 * v);
      this._tone(140, 0.1, 0.35 * v, 'sawtooth', 80);
    }
    // The glass cabin echoes: a short metallic tail after every shot inside it.
    if (inCabin) {
      this._tone(1180, 0.28, 0.12 * v, 'sine', 900, 0.05);
      this._tone(790, 0.34, 0.09 * v, 'sine', 620, 0.09);
    }
  }

  dryFire() {
    this._tone(900, 0.05, 0.12, 'square');
  }

  reload() {
    this._noise(0.07, 3200, 0.25, 'highpass');
    this._noise(0.07, 2600, 0.3, 'highpass', 0.35);
    this._tone(420, 0.06, 0.15, 'square', 300, 0.7);
  }

  step(running, inCabin) {
    const f = running ? 700 : 420;
    this._noise(0.06, f, running ? 0.16 : 0.1);
    if (inCabin) this._tone(240, 0.09, 0.05, 'sine', 180);
  }

  plantBeep(final) {
    this._tone(final ? 1560 : 1040, final ? 0.35 : 0.09, 0.22, 'sine');
  }

  defuseBeep() {
    this._tone(880, 0.09, 0.2, 'sine');
    this._tone(880, 0.09, 0.2, 'sine', 0, 0.16);
  }

  explosion() {
    this._noise(1.4, 320, 1.0);
    this._tone(70, 1.1, 0.8, 'sine', 28);
    this._noise(0.5, 2400, 0.4, 'highpass', 0.05);
  }

  radioBlip() {
    this._tone(1240, 0.07, 0.16, 'sine');
    this._tone(1560, 0.06, 0.14, 'sine', 0, 0.09);
  }

  wardenHorn() {
    this._tone(98, 0.9, 0.5, 'sawtooth', 65);
    this._tone(147, 0.9, 0.35, 'sawtooth', 98, 0.05);
    this._noise(0.8, 500, 0.25);
  }

  roundWin() {
    this._tone(523, 0.16, 0.25, 'sine');
    this._tone(659, 0.16, 0.25, 'sine', 0, 0.14);
    this._tone(784, 0.3, 0.28, 'sine', 0, 0.28);
  }

  roundLose() {
    this._tone(392, 0.2, 0.22, 'sine');
    this._tone(311, 0.34, 0.22, 'sine', 0, 0.18);
  }

  hitmarker(headshot) {
    this._tone(headshot ? 2100 : 1500, 0.05, 0.18, 'sine');
  }

  buy() {
    this._tone(980, 0.08, 0.16, 'sine');
    this._tone(1310, 0.1, 0.16, 'sine', 0, 0.07);
  }

  flash() {
    this._tone(2400, 0.4, 0.1, 'sine', 1800);
  }

  // A low cable hum that starts when the gondola departs and stops at arrival.
  startCableHum() {
    if (!this.ensure() || this.cableHum) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 58;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 2.2;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(g.gain);
    osc.connect(g).connect(this.master);
    osc.start();
    lfo.start();
    this.cableHum = { osc, lfo, g };
  }

  stopCableHum() {
    if (!this.cableHum) return;
    try {
      this.cableHum.osc.stop();
      this.cableHum.lfo.stop();
    } catch { /* already stopped */ }
    this.cableHum = null;
  }
}
