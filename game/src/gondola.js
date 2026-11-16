// gondola.js — the moving bomb site. One glass cable car runs the cable between
// Summit Station (z = -55) and Valley Station (z = +55), on a fixed loop:
// dwell 15 s at a station, transit 12 s to the other side, dwell again.
// Planting and defusing are ONLY possible inside the cabin, so the whole round
// is a fight over a site that keeps moving. The HUD tracker reads this module.
import * as THREE from 'three';
import { clamp, lerp, pointInBox } from './utils.js';

export const DWELL_SECONDS = 15;
export const TRANSIT_SECONDS = 12;
export const SUMMIT_Z = -55;
export const VALLEY_Z = 55;
export const CABLE_Y = 5.6; // cable height above the deck
export const CABIN_HALF = { x: 2.6, y: 1.7, z: 3.4 }; // interior half-extents
export const CABIN_FLOOR_Y = 1.6; // cabin floor height (dock decks match it)

// The cabin rides at deck height on its dock: its floor sits at CABIN_FLOOR_Y and
// its roof hangs from the cable. Dock platforms at both stations are built to
// exactly this height, so players walk straight in while it dwells.
export class Gondola {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.state = 'dwell'; // 'dwell' | 'transit'
    this.at = 'summit'; // station it dwells at, or is heading to while in transit
    this.from = 'summit';
    this.t = 0; // seconds in the current state
    this.z = SUMMIT_Z;
    this.progress = 0; // 0..1 along the current leg
    this.riders = new Set(); // entities currently standing in the cabin
    this.buildMesh();
    scene.add(this.group);
    this.updateMesh();
  }

  stationZ(name) {
    return name === 'summit' ? SUMMIT_Z : VALLEY_Z;
  }

  otherStation(name) {
    return name === 'summit' ? 'valley' : 'summit';
  }

  // Advance the cycle by dt seconds. Returns an event string when the state flips.
  update(dt) {
    this.t += dt;
    let event = null;
    if (this.state === 'dwell') {
      this.progress = clamp(this.t / DWELL_SECONDS, 0, 1);
      if (this.t >= DWELL_SECONDS) {
        this.state = 'transit';
        this.from = this.at;
        this.at = this.otherStation(this.at);
        this.t = 0;
        this.progress = 0;
        event = 'depart:' + this.from;
      }
    } else {
      this.progress = clamp(this.t / TRANSIT_SECONDS, 0, 1);
      const eased = this.progress * this.progress * (3 - 2 * this.progress); // smoothstep
      this.z = lerp(this.stationZ(this.from), this.stationZ(this.at), eased);
      if (this.t >= TRANSIT_SECONDS) {
        this.state = 'dwell';
        this.t = 0;
        this.progress = 0;
        this.z = this.stationZ(this.at);
        event = 'arrive:' + this.at;
      }
    }
    this.updateMesh();
    return event;
  }

  // The cabin's glass walls as AABBs, recomputed from the live z each tick.
  // Side walls are solid; each end wall leaves a 1.8 m door gap in the middle,
  // so players board through the ends while the cabin dwells at a dock.
  wallBoxes() {
    const z = this.z;
    const y0 = CABIN_FLOOR_Y;
    const y1 = CABIN_FLOOR_Y + CABIN_HALF.y * 2;
    const out = [
      { minX: -2.78, maxX: -2.42, minY: y0, maxY: y1, minZ: z - 3.4, maxZ: z + 3.4 },
      { minX: 2.42, maxX: 2.78, minY: y0, maxY: y1, minZ: z - 3.4, maxZ: z + 3.4 },
    ];
    for (const s of [-1, 1]) {
      const ez = z + s * 3.4;
      out.push(
        { minX: -2.6, maxX: -0.9, minY: y0, maxY: y1, minZ: ez - 0.15, maxZ: ez + 0.15 },
        { minX: 0.9, maxX: 2.6, minY: y0, maxY: y1, minZ: ez - 0.15, maxZ: ez + 0.15 },
      );
    }
    return out;
  }

  // The cabin's world-space plant zone: the whole interior. Planting outside it
  // is refused by rounds.js — this box is the only site on the map.
  plantBox() {
    return {
      minX: -CABIN_HALF.x, maxX: CABIN_HALF.x,
      minY: CABIN_FLOOR_Y - 0.2, maxY: CABIN_FLOOR_Y + CABIN_HALF.y * 2,
      minZ: this.z - CABIN_HALF.z, maxZ: this.z + CABIN_HALF.z,
    };
  }

  isInside(x, y, z) {
    return pointInBox(x, y, z, this.plantBox());
  }

  // Is the cabin docked at a station right now (doors walkable)?
  get docked() {
    return this.state === 'dwell';
  }

  get dockStation() {
    return this.state === 'dwell' ? this.at : null;
  }

  // Seconds until the cabin next leaves its station (or arrives, in transit).
  get countdown() {
    return this.state === 'dwell'
      ? DWELL_SECONDS - this.t
      : TRANSIT_SECONDS - this.t;
  }

  // Tracker payload for the HUD: where the cabin is, where it is going, and the
  // countdown the player plans around.
  tracker() {
    return {
      state: this.state,
      at: this.at,
      from: this.from,
      z: this.z,
      progress: this.progress,
      countdown: this.countdown,
      label:
        this.state === 'dwell'
          ? 'DOCKED — ' + this.at.toUpperCase() + ' · departs in ' + Math.ceil(this.countdown) + 's'
          : 'IN TRANSIT → ' + this.at.toUpperCase() + ' · arrives in ' + Math.ceil(this.countdown) + 's',
    };
  }

  // Cabin sway while moving: a gentle pendulum so the ride reads in the view.
  sway() {
    if (this.state !== 'transit') return 0;
    return Math.sin(this.t * 2.1) * 0.012 * Math.sin(Math.PI * this.progress);
  }

  buildMesh() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x2f6db3, roughness: 0.45, metalness: 0.55 });
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x27435f, roughness: 0.5, metalness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0xbfe3ff, roughness: 0.08, metalness: 0.1,
      transparent: true, opacity: 0.28, side: THREE.DoubleSide,
    });
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a6b46, roughness: 0.85, metalness: 0.05 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.2 });
    const g = this.group;

    // Floor (warm wood deck) and roof frame.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(CABIN_HALF.x * 2, 0.16, CABIN_HALF.z * 2), wood);
    floor.position.y = CABIN_FLOOR_Y - 0.08;
    g.add(floor);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(CABIN_HALF.x * 2 + 0.3, 0.22, CABIN_HALF.z * 2 + 0.3), steel);
    roof.position.y = CABIN_FLOOR_Y + CABIN_HALF.y * 2 + 0.1;
    g.add(roof);
    // Hanger arm up to the cable.
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, CABLE_Y - (CABIN_FLOOR_Y + CABIN_HALF.y * 2), 0.35), darkSteel);
    arm.position.y = CABIN_FLOOR_Y + CABIN_HALF.y * 2 + (CABLE_Y - (CABIN_FLOOR_Y + CABIN_HALF.y * 2)) / 2;
    g.add(arm);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 16), darkSteel);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = CABLE_Y + 0.1;
    g.add(wheel);

    // Glass walls: two long sides + two ends, with steel corner posts.
    const glassSide = new THREE.BoxGeometry(0.06, CABIN_HALF.y * 2, CABIN_HALF.z * 2);
    for (const sx of [-1, 1]) {
      const pane = new THREE.Mesh(glassSide, glass);
      pane.position.set(sx * CABIN_HALF.x, CABIN_FLOOR_Y + CABIN_HALF.y, 0);
      g.add(pane);
    }
    const glassEnd = new THREE.BoxGeometry(CABIN_HALF.x * 2, CABIN_HALF.y * 2, 0.06);
    for (const sz of [-1, 1]) {
      const pane = new THREE.Mesh(glassEnd, glass);
      pane.position.set(0, CABIN_FLOOR_Y + CABIN_HALF.y, sz * CABIN_HALF.z);
      g.add(pane);
    }
    // Corner posts + door frames at both ends (doors are the plant entry).
    const post = new THREE.BoxGeometry(0.22, CABIN_HALF.y * 2 + 0.2, 0.22);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Mesh(post, steel);
        p.position.set(sx * CABIN_HALF.x, CABIN_FLOOR_Y + CABIN_HALF.y, sz * CABIN_HALF.z);
        g.add(p);
      }
    }
    // Orange safety stripe around the cabin + a roof beacon.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(CABIN_HALF.x * 2 + 0.06, 0.18, CABIN_HALF.z * 2 + 0.06), orange);
    stripe.position.y = CABIN_FLOOR_Y + 0.35;
    g.add(stripe);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff5a00, emissiveIntensity: 0.9 }));
    beacon.position.y = CABIN_FLOOR_Y + CABIN_HALF.y * 2 + 0.35;
    g.add(beacon);
    this.beacon = beacon;

    // Interior: two bench seats and a grab rail, so the plant spot reads as a cabin.
    const bench = new THREE.BoxGeometry(1.1, 0.5, CABIN_HALF.z * 2 - 0.6);
    for (const sx of [-1, 1]) {
      const b = new THREE.Mesh(bench, darkSteel);
      b.position.set(sx * (CABIN_HALF.x - 0.6), CABIN_FLOOR_Y + 0.25, 0);
      g.add(b);
    }
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, CABIN_HALF.z * 2 - 0.4, 8), steel);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(0, CABIN_FLOOR_Y + 2.4, 0);
    g.add(rail);
  }

  updateMesh() {
    this.group.position.set(0, 0, this.z);
    this.group.rotation.x = this.sway();
    if (this.beacon) {
      const mat = this.beacon.material;
      mat.emissiveIntensity = this.state === 'transit' ? 0.9 + 0.7 * Math.sin(this.t * 9) : 0.9;
    }
  }

  // Move every rider with the cabin so standing inside it rides along.
  applyRiderDelta(dz, entities) {
    if (dz === 0) return;
    for (const e of entities) {
      if (!e.alive) continue;
      if (this.isInside(e.pos.x, e.pos.y + 0.9, e.pos.z)) {
        e.pos.z += dz;
        e.inCabin = true;
      } else {
        e.inCabin = false;
      }
    }
  }
}
