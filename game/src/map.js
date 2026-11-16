// map.js — the Summit cable-car station: one original alpine map, bright daylight.
// Layout (x east, z south, y up; all gameplay on the snow deck unless noted):
//   Summit Station lodge  z ~ -64        Valley Station hall  z ~ +64
//   Dock platforms (y = 1.6, ramps on both sides) at z = -55 and +55 — the
//   gondola docks flush with them, so players walk straight into the cabin.
//   Cable lane x in [-3.5, 3.5], z in [-46, 46]: fenced off, the cabin's private
//   corridor. Mid splits into a west pine-forest lane and an east rock-ridge lane;
//   the two lanes only join at the station aprons. Crates, pylons and rocks give
//   corners, cover and sightlines worth playing.
// Collision is AABB boxes plus a ground-height function (dock + ramps). No mesh
// is ever read for collision — the sim only ever asks this module.
import * as THREE from 'three';
import { box, mulberry32, randRange } from './utils.js';
import { CABIN_FLOOR_Y } from './gondola.js';

export const MAP = {
  minX: -50, maxX: 50, minZ: -72, maxZ: 72,
  summitZ: -55, valleyZ: 55,
  dockHalfX: 7, dockHalfZ: 6,
  laneHalfX: 3.5, laneEndZ: 46,
};

// Spawn points: attackers start at Valley apron, defenders at Summit apron.
export const SPAWNS = {
  atk: [
    [-14, 52], [-6, 54], [2, 52], [10, 54], [18, 52],
  ],
  def: [
    [-14, -52], [-6, -54], [2, -52], [10, -54], [18, -52],
  ],
};

// Waypoint graph. Nodes are {id, x, z, links:[ids]}; the cabin node is dynamic
// (its z follows the gondola) and bots resolve it through gondola.js.
export const WAYPOINTS = [
  // Summit apron + lodge
  { id: 'summitW', x: -16, z: -50, links: ['summitE', 'summitDockW', 'west1', 'lodgeW'] },
  { id: 'summitE', x: 16, z: -50, links: ['summitW', 'summitDockE', 'east1', 'lodgeE'] },
  { id: 'summitDockW', x: -9.5, z: -55, links: ['summitW', 'cabin'] },
  { id: 'summitDockE', x: 9.5, z: -55, links: ['summitE', 'cabin'] },
  { id: 'lodgeW', x: -16, z: -62, links: ['summitW'] },
  { id: 'lodgeE', x: 16, z: -62, links: ['summitE'] },
  // Valley apron + hall
  { id: 'valleyW', x: -16, z: 50, links: ['valleyE', 'valleyDockW', 'west3', 'hallW'] },
  { id: 'valleyE', x: 16, z: 50, links: ['valleyW', 'valleyDockE', 'east3', 'hallE'] },
  { id: 'valleyDockW', x: -9.5, z: 55, links: ['valleyW', 'cabin'] },
  { id: 'valleyDockE', x: 9.5, z: 55, links: ['valleyE', 'cabin'] },
  { id: 'hallW', x: -16, z: 62, links: ['valleyW'] },
  { id: 'hallE', x: 16, z: 62, links: ['valleyE'] },
  // West pine lane
  { id: 'west1', x: -24, z: -32, links: ['summitW', 'west2', 'forest1'] },
  { id: 'west2', x: -26, z: 0, links: ['west1', 'west3', 'forest2'] },
  { id: 'west3', x: -24, z: 32, links: ['west2', 'valleyW', 'forest3'] },
  { id: 'forest1', x: -38, z: -14, links: ['west1', 'forest2'] },
  { id: 'forest2', x: -40, z: 8, links: ['forest1', 'forest3', 'west2'] },
  { id: 'forest3', x: -38, z: 24, links: ['forest2', 'west3'] },
  // East rock lane
  { id: 'east1', x: 24, z: -32, links: ['summitE', 'east2', 'ridge1'] },
  { id: 'east2', x: 26, z: 0, links: ['east1', 'east3', 'ridge2'] },
  { id: 'east3', x: 24, z: 32, links: ['east2', 'valleyE', 'ridge3'] },
  { id: 'ridge1', x: 38, z: -14, links: ['east1', 'ridge2'] },
  { id: 'ridge2', x: 40, z: 8, links: ['ridge1', 'ridge3', 'east2'] },
  { id: 'ridge3', x: 38, z: 24, links: ['ridge2', 'east3'] },
  // The cabin itself — position resolved live from the gondola.
  { id: 'cabin', x: 0, z: -55, links: ['summitDockW', 'summitDockE', 'valleyDockW', 'valleyDockE'], dynamic: true },
];

export function waypointById(id) {
  return WAYPOINTS.find((w) => w.id === id);
}

// Ground height at (x, z): 0 on the snow deck, 1.6 on the dock platforms,
// ramps on the dock sides. The cabin floor is NOT here — the sim adds it.
export function groundHeightAt(x, z) {
  for (const dz of [-55, 55]) {
    if (z >= dz - 6 && z <= dz + 6) {
      if (x >= -7 && x <= 7) return CABIN_FLOOR_Y;
      if (x >= -11 && x < -7) return CABIN_FLOOR_Y * (x + 11) / 4;
      if (x > 7 && x <= 11) return CABIN_FLOOR_Y * (11 - x) / 4;
    }
  }
  return 0;
}

export function buildWorld(scene) {
  const colliders = [];
  const rng = mulberry32(20261117);
  const add = (mesh, collider) => {
    scene.add(mesh);
    if (collider) colliders.push(collider);
    return mesh;
  };
  const mat = (color, rough = 0.85, metal = 0.05) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

  // --- sky, light, fog: bright alpine noon. No dusk, no ember, no dark. ---
  scene.background = new THREE.Color(0x8ec8ee);
  scene.fog = new THREE.Fog(0xcfe6f5, 90, 260);
  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0xf4f8ff, 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3da, 1.9);
  sun.position.set(45, 70, 25);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xd8ecff, 0.5);
  fill.position.set(-30, 40, -40);
  scene.add(fill);

  // --- the valley far below, seen from the deck edges and the cabin. ---
  const valleyFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(700, 700), mat(0x5d8a4a, 1, 0));
  valleyFloor.rotation.x = -Math.PI / 2;
  valleyFloor.position.y = -26;
  scene.add(valleyFloor);
  // Distant snow mountains ringing the map.
  const mountainMat = mat(0xe8f0f6, 1, 0);
  const rockMat = mat(0x7a8894, 1, 0);
  const mountainSpots = [
    [-160, -140, 120, 90], [40, -190, 150, 110], [180, -120, 110, 80],
    [-190, 60, 130, 95], [190, 80, 140, 100], [-120, 190, 120, 85], [120, 180, 130, 90],
  ];
  for (const [mx, mz, h, r] of mountainSpots) {
    const peak = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mountainMat);
    peak.position.set(mx, -26 + h / 2 - 4, mz);
    scene.add(peak);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r, h * 0.45, 7), rockMat);
    base.position.set(mx, -26 + h * 0.22 - 4, mz);
    scene.add(base);
  }

  // --- the playable snow deck. ---
  const snow = new THREE.Mesh(new THREE.PlaneGeometry(104, 148), mat(0xf2f7fb, 1, 0));
  snow.rotation.x = -Math.PI / 2;
  snow.position.y = 0;
  scene.add(snow);
  // Deck edge cliffs (visual drop to the valley) + low safety rail.
  const cliffMat = mat(0x8b98a5, 1, 0);
  for (const [cx, cz, sx, sz] of [
    [0, -74, 104, 4], [0, 74, 104, 4], [-52, 0, 4, 148], [52, 0, 4, 148],
  ]) {
    const cliff = new THREE.Mesh(new THREE.BoxGeometry(sx, 26, sz), cliffMat);
    cliff.position.set(cx, -13, cz);
    scene.add(cliff);
  }

  // --- stations: Summit lodge (wood + glass) and Valley hall (brick + steel). ---
  const wood = mat(0x8a6b46);
  const woodDark = mat(0x6b4f33);
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xbfe3ff, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35,
  });
  const brick = mat(0x9a5f4a);
  const steelBlue = mat(0x2f6db3, 0.45, 0.55);
  const steelDark = mat(0x27435f, 0.5, 0.6);
  const orange = mat(0xff7a1a, 0.5, 0.2);

  function station(zc, isSummit) {
    const g = new THREE.Group();
    const wallMat = isSummit ? wood : brick;
    const roofMat = isSummit ? woodDark : steelDark;
    // Main hall: back wall + side walls + sloped roof.
    const hall = new THREE.Mesh(new THREE.BoxGeometry(34, 7, 10), wallMat);
    hall.position.set(0, 3.5, zc + (isSummit ? -6 : 6));
    g.add(hall);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(37, 0.6, 13), roofMat);
    roof.position.set(0, 7.4, zc + (isSummit ? -6 : 6));
    roof.rotation.x = isSummit ? 0.1 : -0.1;
    g.add(roof);
    // Glass front facing the apron.
    const front = new THREE.Mesh(new THREE.BoxGeometry(30, 4.5, 0.25), glassMat);
    front.position.set(0, 2.6, zc + (isSummit ? -0.9 : 0.9));
    g.add(front);
    // Sign band with the station name in big block letters (boxes, no font asset).
    const sign = new THREE.Mesh(new THREE.BoxGeometry(isSummit ? 12 : 11, 1.1, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
    sign.position.set(0, 6.2, zc + (isSummit ? -0.7 : 0.7));
    g.add(sign);
    const signBar = new THREE.Mesh(new THREE.BoxGeometry(isSummit ? 12.6 : 11.6, 0.25, 0.5), orange);
    signBar.position.set(0, 5.5, zc + (isSummit ? -0.7 : 0.7));
    g.add(signBar);
    // Corner columns + ticket booths.
    for (const sx of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(1.2, 7, 1.2), steelBlue);
      col.position.set(sx * 16, 3.5, zc + (isSummit ? -1 : 1));
      g.add(col);
      const booth = new THREE.Mesh(new THREE.BoxGeometry(4, 2.6, 3), wallMat);
      booth.position.set(sx * 12, 1.3, zc + (isSummit ? -2.5 : 2.5));
      g.add(booth);
    }
    scene.add(g);
    // Colliders: hall body and booths (the glass front is walk-through at the door gaps).
    colliders.push(box(0, 3.5, zc + (isSummit ? -6 : 6), 34, 7, 10));
    for (const sx of [-1, 1]) {
      colliders.push(box(sx * 12, 1.3, zc + (isSummit ? -2.5 : 2.5), 4, 2.6, 3));
    }
    return g;
  }
  station(-64, true);
  station(64, false);

  // --- dock platforms (y = 1.6) with side ramps, at both stations. ---
  const dockMat = mat(0x7d6a55);
  const dockTopMat = mat(0xa08a6a);
  function dock(zc) {
    const g = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(14, 1.6, 12), dockMat);
    slab.position.set(0, 0.8, zc);
    g.add(slab);
    const top = new THREE.Mesh(new THREE.BoxGeometry(14, 0.12, 12), dockTopMat);
    top.position.set(0, 1.66, zc);
    g.add(top);
    // Safety stripe along the dock edge facing the lane.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(14, 0.08, 0.5), orange);
    stripe.position.set(0, 1.7, zc + (zc < 0 ? 5.7 : -5.7));
    g.add(stripe);
    // Ramps: wedges on both sides (visual prisms approximated by rotated slabs).
    for (const sx of [-1, 1]) {
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.18, 12), dockTopMat);
      ramp.position.set(sx * 9.1, 0.82, zc);
      ramp.rotation.z = sx * -0.36;
      g.add(ramp);
      // Ramp side rails.
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 12), steelBlue);
      rail.position.set(sx * 11.1, 0.9, zc);
      g.add(rail);
    }
    // Dock sign posts.
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.4, 0.3), steelDark);
      post.position.set(sx * 6.4, 3.3, zc + (zc < 0 ? 5.4 : -5.4));
      g.add(post);
    }
    scene.add(g);
    // The dock slab is a step, not a wall: groundHeightAt handles walking up it.
    // Only the side rails block.
    for (const sx of [-1, 1]) {
      colliders.push(box(sx * 11.1, 0.9, zc, 0.24, 1.8, 12));
    }
  }
  dock(-55);
  dock(55);

  // --- cable: a steel line from Summit tower to Valley tower, over the lane. ---
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.4, metalness: 0.8 });
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 118, 6), cableMat);
  cable.rotation.x = Math.PI / 2;
  cable.position.set(0, 5.6, 0);
  scene.add(cable);
  // Second cable (return line) offset sideways, like a real gondola.
  const cable2 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 118, 6), cableMat);
  cable2.rotation.x = Math.PI / 2;
  cable2.position.set(1.6, 5.6, 0);
  scene.add(cable2);

  // --- pylons at z = -20 and +20: legs the cabin passes between, cross beam above. ---
  for (const pz of [-20, 20]) {
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 8.4, 0.9), steelDark);
      leg.position.set(sx * 3.4, 4.2, pz);
      scene.add(leg);
      colliders.push(box(sx * 3.4, 4.2, pz, 0.9, 8.4, 0.9));
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.8, 1.0), steelBlue);
    beam.position.set(0, 8.2, pz);
    scene.add(beam);
    const sheave = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 12), steelDark);
    sheave.rotation.x = Math.PI / 2;
    sheave.position.set(0, 5.9, pz);
    scene.add(sheave);
  }

  // --- rope fences along the cable lane: the lane is the cabin's, not the players'. ---
  const ropeMat = mat(0xc94f2e, 0.7, 0.1);
  for (const sx of [-1, 1]) {
    const fence = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 92), ropeMat);
    fence.position.set(sx * 3.5, 0.45, 0);
    scene.add(fence);
    colliders.push(box(sx * 3.5, 0.45, 0, 0.18, 0.9, 92));
    // Fence posts every 8 m.
    for (let z = -44; z <= 44; z += 8) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.1, 0.22), steelDark);
      post.position.set(sx * 3.5, 0.55, z);
      scene.add(post);
    }
  }

  // --- pine forest (west lane) and rock ridge (east lane). ---
  const trunkMat = mat(0x5a4028);
  const pineMat = mat(0x2e6b34, 1, 0);
  const pineMat2 = mat(0x3a7d3f, 1, 0);
  function pine(x, z, s, withCollider) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * s, 0.3 * s, 1.6 * s, 6), trunkMat);
    trunk.position.y = 0.8 * s;
    g.add(trunk);
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry((1.7 - i * 0.42) * s, 1.9 * s, 8), i % 2 ? pineMat : pineMat2);
      cone.position.y = (1.5 + i * 1.25) * s;
      g.add(cone);
    }
    g.position.set(x, 0, z);
    scene.add(g);
    if (withCollider) colliders.push(box(x, 1.2 * s, z, 0.7 * s, 2.4 * s, 0.7 * s));
  }
  const pineSpots = [
    [-14, -38, 1.2], [-20, -44, 1.0], [-30, -40, 1.3], [-38, -34, 1.1], [-44, -26, 1.2],
    [-12, -18, 0.9], [-18, -8, 1.2], [-32, -16, 1.0], [-42, -6, 1.3], [-36, 4, 1.0],
    [-14, 12, 1.1], [-22, 20, 1.2], [-34, 14, 0.9], [-42, 26, 1.2], [-30, 34, 1.1],
    [-16, 40, 1.0], [-44, 40, 1.3], [-38, -44, 1.0], [14, -40, 1.1], [44, -38, 1.2],
  ];
  for (const [x, z, s] of pineSpots) pine(x, z, s, true);
  // Extra pines far outside the lanes, decoration only.
  for (let i = 0; i < 26; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const x = side * randRange(rng, 44, 90) * (rng() < 0.5 ? 1 : 1);
    const z = randRange(rng, -110, 110);
    if (Math.abs(x) < 52 && Math.abs(z) < 74) continue;
    pine(x, z, randRange(rng, 1.4, 2.4), false);
  }

  // --- rocks (east ridge + scattered cover). ---
  const rockMat2 = mat(0x8d9aa5, 1, 0);
  const rockSpots = [
    [30, -24, 2.2, 1.6, 1.8], [36, -6, 2.8, 2.0, 2.2], [28, 14, 2.0, 1.4, 1.6],
    [40, 26, 3.0, 2.2, 2.4], [16, 30, 1.8, 1.2, 1.5], [-30, -24, 2.4, 1.8, 2.0],
    [-16, 26, 2.0, 1.5, 1.7], [10, -34, 1.6, 1.2, 1.4], [-10, 36, 1.8, 1.3, 1.5],
  ];
  for (const [x, z, sx, sy, sz] of rockSpots) {
    const rock = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), rockMat2);
    rock.position.set(x, sy / 2 - 0.1, z);
    rock.rotation.y = randRange(rng, 0, Math.PI);
    scene.add(rock);
    colliders.push(box(x, sy / 2, z, sx, sy, sz));
  }

  // --- crates: wooden cover on the lanes and aprons. ---
  const crateMat = mat(0x9a7b4f);
  const crateMat2 = mat(0x7d9db5, 0.6, 0.2);
  const crateSpots = [
    [-16, -44, 1.4], [-12, -46, 1.0], [16, -44, 1.4], [12, -46, 1.0],
    [-24, -24, 1.4], [-28, -22, 1.0], [24, -24, 1.4], [28, -22, 1.0],
    [-24, 6, 1.4], [-20, 8, 1.0], [24, 6, 1.4], [20, 8, 1.0],
    [-24, 26, 1.4], [24, 26, 1.4], [-16, 44, 1.4], [16, 44, 1.4],
    [-8, -38, 1.2], [8, -38, 1.2], [-8, 38, 1.2], [8, 38, 1.2],
  ];
  for (const [x, z, s] of crateSpots) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), rng() < 0.3 ? crateMat2 : crateMat);
    crate.position.set(x, s / 2, z);
    crate.rotation.y = randRange(rng, -0.3, 0.3);
    scene.add(crate);
    colliders.push(box(x, s / 2, z, s, s, s));
  }
  // A stacked pair at mid-west and mid-east for a sightline break.
  for (const [x, z] of [[-26, -2], [26, -2]]) {
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), crateMat2);
    top.position.set(x, 1.4 + 0.55, z);
    scene.add(top);
    colliders.push(box(x, 1.4 + 0.55, z, 1.1, 1.1, 1.1));
  }

  // --- benches + lamp posts on the aprons (small cover, bright accents). ---
  for (const [x, z] of [[-20, -52], [20, -52], [-20, 52], [20, 52]]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 1), woodDark);
    bench.position.set(x, 0.55, z);
    scene.add(bench);
    colliders.push(box(x, 0.55, z, 3, 1.1, 1));
  }
  for (const [x, z] of [[-8, -44], [8, -44], [-8, 44], [8, 44]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 4.4, 8), steelDark);
    pole.position.set(x, 2.2, z);
    scene.add(pole);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffdf80, emissiveIntensity: 0.7 }));
    lamp.position.set(x, 4.5, z);
    scene.add(lamp);
    colliders.push(box(x, 2.2, z, 0.3, 4.4, 0.3));
  }

  // --- mid plaza markers: orange safety bollards down the lane edges. ---
  for (let z = -40; z <= 40; z += 10) {
    for (const sx of [-1, 1]) {
      const bol = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.9, 8), orange);
      bol.position.set(sx * 4.4, 0.45, z);
      scene.add(bol);
    }
  }

  return { colliders, waypoints: WAYPOINTS, spawns: SPAWNS };
}
