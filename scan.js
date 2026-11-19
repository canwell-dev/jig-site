// Loft scanner (sketch): fits one loft to a triangle mesh. Meant for one tube-like piece (a limb, a horn, a
// bottle); split branches off first. Pure, like jig.js. Not part of the format: it writes an ordinary loft recipe.
//
// 1. Centre curve: start with a straight line along the mesh's main axis (PCA). Slice the mesh across the curve,
//    take each slice's centre, thin the centres to a few path points (Douglas-Peucker); repeat on the new curve.
// 2. Rings: slice across the final curve (the reader's own frame) and resample each outline to RES points by
//    length, counter-clockwise, from the +u side, so ring k matches ring k.
// 3. Sections: start with the two ends; add the ring the blend misses most until every ring is within tolerance.
// 4. Points: each kept ring thinned to a few points (Douglas-Peucker); gentle turns become smooth points.
import { loftCurve, loftFrame, outline } from './jig.js?v=3886609';

const SLICES = 40; // rings along the curve
const RES = 64;    // points per ring
const INSET = 0.02; // first and last slice this far in from the ends, where a cut grazes the end faces
const PASSES = 3;  // centre-curve refinements

// positions: flat [x, y, z, ...]; indices: three per triangle. tolerance: in the mesh's units, default 1% of its size.
// Returns { loft, error: { mean, max }, size }: loft is recipe JSON; error is how far each slice of the mesh lies from
// the loft's outline at the same t (cross-section distance, not true surface distance).
export function scanLoft(positions, indices, { tolerance } = {}) {
  const V = Array.from({ length: positions.length / 3 }, (_, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
  if (V.length < 3 || indices.length < 3) throw new Error('scan: the mesh has no triangles');
  const lo = V.reduce((m, v) => m.map((c, a) => Math.min(c, v[a])), V[0]), hi = V.reduce((m, v) => m.map((c, a) => Math.max(c, v[a])), V[0]);
  const size = dist(lo, hi), tol = tolerance ?? size * 0.01, eps = size * 1e-6;
  const keys = V.map((v) => v.map((c) => Math.round(c / eps)).join()); // welds seams (split normals/UVs) for chaining
  const tris = [];
  for (let k = 0; k + 2 < indices.length; k += 3) tris.push([indices[k], indices[k + 1], indices[k + 2]]);

  // 1. Centre curve: march from the low end of the main axis, then refine on the loft's own curve.
  const { centre, axis } = principal(V, tris);
  const along = V.map((v) => dot(sub(v, centre), axis));
  const from = along.reduce((a, b) => Math.min(a, b)), step = (along.reduce((a, b) => Math.max(a, b)) - from) / SLICES;
  // March there and back: the way back reaches the start already pointing along the piece, so its cuts there are square.
  const there = march(V, keys, tris, add(centre, scale(axis, from + step / 2)), axis, step), end = there[there.length - 1];
  let path, rings = end ? march(V, keys, tris, end.centre, scale(end.z, -1), step).reverse().map((r) => ({ ...r, z: scale(r.z, -1) })) : [];
  for (let pass = 0; ; pass++) {
    if (rings.length < 2) throw new Error('scan: fewer than 2 slices cut the mesh; is it one closed piece?');
    // Centres that step backwards along the curve (an oblique cut near a bend) would fold the next curve over.
    const c = [];
    for (const r of rings) if (!c.length || dot(sub(r.centre, c[c.length - 1]), r.z) > 0) c.push(r.centre);
    if (c.length < 2) throw new Error('scan: the slices do not follow one piece');
    // The slices stop INSET short of each end: carry the end centres out along the curve by that much.
    const len = c.reduce((s, p, i) => s + (i ? dist(p, c[i - 1]) : 0), 0), gap = (len * INSET) / (1 - 2 * INSET);
    const out = (a, b) => add(a, scale(norm(sub(a, b)), gap));
    path = douglasPeucker([out(c[0], c[1]), ...c, out(c[c.length - 1], c[c.length - 2])], tol);
    rings = slices(V, keys, tris, path);
    if (pass === PASSES) break;
  }

  // 2 + 3. Each ring as RES points; keep the fewest whose linear blend stays within tol of every ring.
  rings.forEach((r) => { r.dense = resample(r.loop); });
  rings[0].t = 0; rings[rings.length - 1].t = 1; // the loft holds its end shapes out to the caps
  const kept = [0, rings.length - 1];
  for (;;) {
    let worst = -1, worstErr = tol;
    rings.forEach((r, i) => {
      const shape = blendAt(rings, kept, r.t), e = Math.max(...r.dense.map((p, k) => dist(p, shape[k])));
      if (e > worstErr) { worst = i; worstErr = e; }
    });
    if (worst < 0) break;
    kept.push(worst); kept.sort((a, b) => a - b);
  }

  // 4. Section points, rounded to about a thousandth of the size.
  const digits = Math.max(0, -Math.floor(Math.log10(size / 1000))), r = (x) => +x.toFixed(digits);
  const sections = kept.map((i) => ({ t: r(rings[i].t), points: points(rings[i].dense, tol).map((p) => p.map(r)) }));
  const loft = { path: path.map((p) => p.map(r)), sections };

  // Score: every ring against the outline the loft blends at its t (sections resampled the same way).
  const fitted = sections.map((s) => ({ t: s.t, dense: resample(outline(s.points), false) }));
  const all = fitted.map((_, i) => i), errs = rings.flatMap((ring) => {
    const shape = blendAt(fitted, all, ring.t);
    return ring.dense.map((p) => toPolygon(p, shape));
  });
  return { loft, error: { mean: errs.reduce((a, b) => a + b, 0) / errs.length, max: Math.max(...errs) }, size };
}

// The mesh cut across the loft curve through `path` at SLICES values of t.
function slices(V, keys, tris, path) {
  const curve = loftCurve({ path }), out = [];
  for (let i = 0; i < SLICES; i++) {
    const t = INSET + ((1 - 2 * INSET) * i) / (SLICES - 1), s = section(V, keys, tris, loftFrame(curve, t));
    if (s) out.push({ t, ...s });
  }
  return out;
}

// First guess of the centre line: cut across d, step from the cut's centre along d, turn d halfway toward the last
// step. Stops where no cut surrounds the stepped point (past the far end).
function march(V, keys, tris, p, d, step) {
  const out = [];
  for (let i = 0; i < 4 * SLICES; i++) {
    const x = norm(cross(Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], d)), s = section(V, keys, tris, { p, x, y: cross(d, x), z: d }, i > 0);
    if (!s) break;
    if (out.length) d = norm(add(d, norm(sub(s.centre, out[out.length - 1].centre))));
    out.push({ ...s, z: d });
    p = add(s.centre, scale(d, step));
  }
  return out;
}

// The cut across frame f ({ p, x, y, z }): { loop (2D, in x, y), z, centre (3D) }, or null. Of several loops, the
// largest round p wins, else (unless strict) the largest.
function section(V, keys, tris, f, strict = false) {
  const loops = cut(V, keys, tris, f.p, f.z).map((l) => l.map((q) => [dot(sub(q, f.p), f.x), dot(sub(q, f.p), f.y)]))
    .filter((l) => l.length >= 3 && Math.abs(area(l)) > 0);
  const round = loops.filter((l) => inside([0, 0], l)), pool = round.length || strict ? round : loops;
  if (!pool.length) return null;
  const loop = pool.reduce((a, b) => (Math.abs(area(b)) > Math.abs(area(a)) ? b : a)), [u, v] = centroid(loop);
  return { loop, z: f.z, centre: add(f.p, add(scale(f.x, u), scale(f.y, v))) };
}

// Closed loops where the plane through p with normal n cuts the triangles. Segment ends are keyed by the mesh edge
// they lie on, so they chain up even across seams. An open chain (a hole in the mesh) is closed straight.
function cut(V, keys, tris, p, n) {
  const d = V.map((v) => dot(sub(v, p), n)), segs = [], byEdge = new Map();
  const at = (a, b) => ({ key: [keys[a], keys[b]].sort().join('|'), p: lerp(V[a], V[b], d[a] / (d[a] - d[b])) });
  for (const [a, b, c] of tris) {
    const s = [a, b, c].map((i) => d[i] >= 0), crossing = [[a, b], [b, c], [c, a]].filter((_, j) => s[j] !== s[(j + 1) % 3]);
    if (crossing.length !== 2) continue;
    const seg = crossing.map(([x, y]) => at(x, y)), id = segs.push(seg) - 1;
    for (const e of seg) byEdge.set(e.key, [...(byEdge.get(e.key) ?? []), id]);
  }
  const used = new Set(), loops = [];
  for (let s = 0; s < segs.length; s++) {
    if (used.has(s)) continue;
    used.add(s);
    const loop = [segs[s][0].p];
    let end = segs[s][1];
    for (;;) {
      const next = (byEdge.get(end.key) ?? []).find((i) => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      loop.push(end.p);
      end = segs[next][0].key === end.key ? segs[next][1] : segs[next][0];
    }
    if (end.key !== segs[s][0].key) loop.push(end.p);
    loops.push(loop);
  }
  return loops;
}

// Area-weighted centre and main axis of the surface (power iteration on its covariance), turned so that its
// largest component is positive (a standing limb runs up).
function principal(V, tris) {
  let total = 0, c = [0, 0, 0];
  const w = tris.map(([a, b, d]) => {
    const m = scale(add(add(V[a], V[b]), V[d]), 1 / 3), A = Math.hypot(...cross(sub(V[b], V[a]), sub(V[d], V[a]))) / 2;
    total += A; c = add(c, scale(m, A));
    return { m, A };
  });
  c = scale(c, 1 / total);
  const C = [0, 1, 2].map((i) => [0, 1, 2].map((j) => w.reduce((s, { m, A }) => s + A * (m[i] - c[i]) * (m[j] - c[j]), 0)));
  let axis = norm([0.31, 1, 0.17]);
  for (let k = 0; k < 100; k++) axis = norm(C.map((row) => dot(row, axis)));
  const big = axis.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  return { centre: c, axis: big < 0 ? scale(axis, -1) : axis };
}

// RES points evenly by length round a closed 2D loop, counter-clockwise. From the +u side (seen from the loop's
// centre) when `fromRight`, else from the loop's own point 0.
function resample(loop, fromRight = true) {
  let L = area(loop) < 0 ? [...loop].reverse() : loop;
  if (fromRight) {
    const [cu, cv] = centroid(L);
    const k = L.reduce((b, q, i) => (Math.abs(Math.atan2(q[1] - cv, q[0] - cu)) < Math.abs(Math.atan2(L[b][1] - cv, L[b][0] - cu)) ? i : b), 0);
    L = [...L.slice(k), ...L.slice(0, k)];
  }
  const cum = [0];
  L.forEach((q, i) => cum.push(cum[i] + dist(q, L[(i + 1) % L.length])));
  const out = [];
  for (let k = 0, e = 0; k < RES; k++) {
    const s = (k / RES) * cum[L.length];
    while (cum[e + 1] < s) e++;
    out.push(lerp(L[e], L[(e + 1) % L.length], cum[e + 1] > cum[e] ? (s - cum[e]) / (cum[e + 1] - cum[e]) : 0));
  }
  return out;
}

// The shape the loft blends at t from the rings kept so far (indices into rings, sorted by t).
function blendAt(rings, kept, t) {
  const j = kept.findIndex((i) => rings[i].t >= t);
  if (j <= 0) return rings[kept[Math.max(j, 0)]].dense;
  const a = rings[kept[j - 1]], b = rings[kept[j]], f = (t - a.t) / (b.t - a.t);
  return a.dense.map((p, k) => lerp(p, b.dense[k], f));
}

// A dense ring as a few section points: Douglas-Peucker (ends kept) to tol (halved until there are at least 4), point 0 kept.
// A point where the outline turns less than 50 degrees becomes smooth, with a Catmull-Rom handle.
function points(ring, tol) {
  let keep;
  for (let e = tol; ; e /= 2) { keep = douglasPeucker([...ring, ring[0]], e).slice(0, -1); if (keep.length >= 4 || e < tol / 1e3) break; }
  return keep.map((p, i) => {
    const prev = keep[(i + keep.length - 1) % keep.length], next = keep[(i + 1) % keep.length];
    const a = norm(sub(p, prev)), b = norm(sub(next, p));
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) < (50 * Math.PI) / 180 ? [...p, ...scale(sub(next, prev), 1 / 6)] : p;
  });
}

function douglasPeucker(pts, tol) {
  const keep = new Set([0, pts.length - 1]);
  const go = (i, j) => {
    let far = -1, d = tol;
    for (let k = i + 1; k < j; k++) { const e = toSegment(pts[k], pts[i], pts[j]); if (e > d) { far = k; d = e; } }
    if (far < 0) return;
    keep.add(far); go(i, far); go(far, j);
  };
  go(0, pts.length - 1);
  return [...keep].sort((a, b) => a - b).map((k) => pts[k]);
}

function toSegment(p, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab), f = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return dist(p, add(a, scale(ab, f)));
}
const toPolygon = (p, poly) => Math.min(...poly.map((a, i) => toSegment(p, a, poly[(i + 1) % poly.length])));

function centroid(L) {
  const A = area(L);
  if (Math.abs(A) < 1e-30) return scale(L.reduce(add), 1 / L.length);
  let cx = 0, cy = 0;
  L.forEach((p, i) => { const q = L[(i + 1) % L.length], w = p[0] * q[1] - q[0] * p[1]; cx += (p[0] + q[0]) * w; cy += (p[1] + q[1]) * w; });
  return [cx / (6 * A), cy / (6 * A)];
}
function inside([x, y], L) {
  let c = false;
  L.forEach((p, i) => { const q = L[(i + 1) % L.length]; if ((p[1] > y) !== (q[1] > y) && x < p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1])) c = !c; });
  return c;
}
const area = (L) => L.reduce((a, p, j) => { const q = L[(j + 1) % L.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const add = (a, b) => a.map((c, i) => c + b[i]);
const sub = (a, b) => a.map((c, i) => c - b[i]);
const scale = (a, s) => a.map((c) => c * s);
const lerp = (a, b, f) => a.map((c, i) => c + (b[i] - c) * f);
const dot = (a, b) => a.reduce((s, c, i) => s + c * b[i], 0);
const dist = (a, b) => Math.hypot(...sub(a, b));
const norm = (a) => { const l = Math.hypot(...a); return l > 1e-12 ? scale(a, 1 / l) : a; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
