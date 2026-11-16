// utils.js — small shared helpers for GONDOLA. No allocations in the hot loop:
// every helper here works on plain numbers or on caller-owned scratch objects.
export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Angle lerp that takes the short way around the circle.
export function angleLerp(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// Deterministic RNG (mulberry32) so autopilot runs and screenshot scenes are repeatable.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function dist2D(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function fmtMoney(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

// Segment vs axis-aligned box: returns the hit distance along the segment, or -1.
// Used for line-of-sight and bullet blocking. Slab method, no allocation.
export function segmentAABB(px, py, pz, dx, dy, dz, b) {
  let tmin = 0;
  let tmax = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (px < b.minX || px > b.maxX) return -1;
  } else {
    let t1 = (b.minX - px) / dx;
    let t2 = (b.maxX - px) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-9) {
    if (py < b.minY || py > b.maxY) return -1;
  } else {
    let t1 = (b.minY - py) / dy;
    let t2 = (b.maxY - py) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < 1e-9) {
    if (pz < b.minZ || pz > b.maxZ) return -1;
  } else {
    let t1 = (b.minZ - pz) / dz;
    let t2 = (b.maxZ - pz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// Ray (origin + direction, max distance) vs sphere. Returns distance or -1.
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxDist) {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t = tca - thc;
  if (t < 0 || t > maxDist) return -1;
  return t;
}

// Point-in-AABB test, used for the cabin plant zone and trigger volumes.
export function pointInBox(x, y, z, b) {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;
}

// Circle (x,z,r) vs AABB (x,z) push-out, used by movement collision. Returns the
// corrected position in the scratch object `out` {x, z}. No allocation.
export function resolveCircleAABB(x, z, r, b, out) {
  const cx = clamp(x, b.minX, b.maxX);
  const cz = clamp(z, b.minZ, b.maxZ);
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    out.x = cx + (dx / d) * r;
    out.z = cz + (dz / d) * r;
  } else {
    // Centre inside the box: push out along the smallest penetration axis.
    const pl = x - b.minX + r;
    const pr = b.maxX - x + r;
    const pt = z - b.minZ + r;
    const pb = b.maxZ - z + r;
    const m = Math.min(pl, pr, pt, pb);
    out.x = x;
    out.z = z;
    if (m === pl) out.x = b.minX - r;
    else if (m === pr) out.x = b.maxX + r;
    else if (m === pt) out.z = b.minZ - r;
    else out.z = b.maxZ + r;
  }
  return true;
}

// AABB helpers: boxes are plain objects {minX,minY,minZ,maxX,maxY,maxZ}.
export function box(cx, cy, cz, sx, sy, sz) {
  return {
    minX: cx - sx / 2, minY: cy - sy / 2, minZ: cz - sz / 2,
    maxX: cx + sx / 2, maxY: cy + sy / 2, maxZ: cz + sz / 2,
  };
}

// Keep a yaw in (-PI, PI].
export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a <= -Math.PI) a += TAU;
  return a;
}
