// Loft scanner (sketch): fits one loft to a triangle mesh. Meant for one tube-like piece (a limb, a horn, a
// bottle); split branches off first. Pure, like jig.js. Not part of the format: it writes an ordinary loft recipe.
//
// 1. Centre curve: start with a straight line along the mesh's main axis (PCA). Slice the mesh across the curve,
//    take each slice's centre, thin the centres to a few path points (Douglas-Peucker); repeat on the new curve.
// 2. Rings: slice across the final curve (the reader's own frame). A slice's outline is the closed contour of the cut
//    round the curve (sliceMesh's stage A), RES points by arc length from the +u side, counter-clockwise, so ring k
//    matches ring k; concave outlines stay concave. Where no closed contour surrounds the curve (an open cut, fur,
//    fingers), it is what rays from the centre hit (radial): RES points at fixed angles from +u.
// 3. Sections: start with the two ends; add the ring the blend misses most until every ring is within tolerance.
// 4. Points: every section gets the same N smooth points at the same angles (the fewest that stay within
//    tolerance), so the loft blends point to point without twisting.
import { loftCurve, loftFrame, outline, curveLength, roundSection } from './jig.js?v=b6c9e63';
import { nodeOrigins, jointParts } from './glb.js?v=b6c9e63';

const SLICES = 40; // rings along the curve
const RES = 64;    // points per ring
const INSET = 0.02; // first and last slice this far in from the ends, where a cut grazes the end faces
const PASSES = 3;  // centre-curve refinements
const PATH = 0.03; // the centre curve follows the main shape: thinned to 3% of the size (sections to the tolerance)
const REACH = 1.6; // a ray keeps its farthest hit within REACH x the median nearest hit (see section)
const COVER = [0.5, 0.75]; // share of rays that must hit for a slice to count, [along a curve, strict: surrounding p]
const SMOOTH = 2;   // radii are the median over 2 * SMOOTH + 1 neighbouring rays: fur and spikes go, the shape stays

// positions: flat [x, y, z, ...]; indices: three per triangle. tolerance: in the mesh's units, default 1% of its size.
// guide: the loft's path as given (e.g. a limb's joints: shoulder, elbow, wrist, palm), so the curve stays simple and
// follows the main shape; only the sections are fitted, and what lies past its ends (fingers) is left out. For stubby
// or messy pieces. reach: [start, end], true to carry that end of the guide out to the piece's end (a torso, a head,
// whose end joints sit inside). Default: march along the main axis (PCA), end to end, and refine the path from the
// slice centres.
// Returns { loft, error: { mean, max }, size }: loft is recipe JSON; error is how far each slice of the mesh lies from
// the loft's outline at the same t (cross-section distance, not true surface distance).
export function scanLoft(positions, indices, { tolerance, guide, reach = [false, false] } = {}) {
  const P = Array.from({ length: positions.length / 3 }, (_, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
  if (P.length < 3 || indices.length < 3) throw new Error('scan: the mesh has no triangles');
  const lo = P.reduce((m, v) => m.map((c, a) => Math.min(c, v[a])), P[0]), hi = P.reduce((m, v) => m.map((c, a) => Math.max(c, v[a])), P[0]);
  const size = dist(lo, hi), tol = tolerance ?? size * 0.01;
  const { V, tris } = weld(positions, indices, size * 1e-4); // seams joined, so cuts chain into closed contours

  // 1. Centre curve: the guide, or march from the low end of the main axis and refine on the loft's own curve.
  let path, rings;
  const guided = guide?.length >= 2;
  if (guided) { path = reachEnds(V, guide, reach); rings = slices(V, tris, path); }
  else {
    const { centre, axis } = principal(V, tris);
    const along = V.map((v) => dot(sub(v, centre), axis));
    const from = along.reduce((a, b) => Math.min(a, b)), step = (along.reduce((a, b) => Math.max(a, b)) - from) / SLICES;
    // March there and back: the way back reaches the start already pointing along the piece, so its cuts there are square.
    const there = march(V, tris, add(centre, scale(axis, from + step / 2)), axis, step), end = there[there.length - 1];
    rings = end ? march(V, tris, end.centre, scale(end.z, -1), step).reverse().map((r) => ({ ...r, z: scale(r.z, -1) })) : [];
  }
  for (let pass = 0; !guided; pass++) {
    if (rings.length < 2) throw new Error('scan: fewer than 2 slices cut the mesh; is it one closed piece?');
    // Centres that step backwards along the curve (an oblique cut near a bend) would fold the next curve over.
    const c = [];
    for (const r of rings) if (!c.length || dot(sub(r.centre, c[c.length - 1]), r.z) > 0) c.push(r.centre);
    if (c.length < 2) throw new Error('scan: the slices do not follow one piece');
    // The slices stop INSET short of each end: carry the end centres out along the curve by that much.
    const len = c.reduce((s, p, i) => s + (i ? dist(p, c[i - 1]) : 0), 0), gap = (len * INSET) / (1 - 2 * INSET);
    const out = (a, b) => add(a, scale(norm(sub(a, b)), gap));
    // A centre wobbles with its slice (a bulge on one side); average over neighbours before thinning.
    const even = c.map((p, i) => (i === 0 || i === c.length - 1 ? p : scale(c.slice(Math.max(0, i - 1), i + 2).reduce(add), 1 / c.slice(Math.max(0, i - 1), i + 2).length)));
    path = douglasPeucker([out(even[0], even[1]), ...even, out(even[even.length - 1], even[even.length - 2])], Math.max(tol, size * PATH));
    rings = slices(V, tris, path);
    if (pass === PASSES) break;
  }
  if (rings.length < 2) throw new Error('scan: fewer than 2 slices cut the mesh; is it one closed piece?');

  // 2 + 3. Each ring is RES points at fixed angles; keep the fewest whose linear blend stays within tol of every ring.
  // Contour rings start where they cross +u, which wanders a little from ring to ring: turn each to match the one before.
  rings.forEach((r, i) => { r.dense = i ? alignContour(rings[i - 1].dense, r.loop) : r.loop; });
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

  // 4. Section points, rounded to about a thousandth of the size; the same count for every section.
  const digits = Math.max(0, -Math.floor(Math.log10(size / 1000))), r = (x) => +x.toFixed(digits);
  const n = [8, 16, 32].find((k) => kept.every((i) => fits(rings[i].dense, k, tol))) ?? 64;
  const sections = kept.map((i) => ({ t: r(rings[i].t), points: points(rings[i].dense, n).map((p) => p.map(r)) }));
  const loft = { path: path.map((p) => p.map(r)), sections };

  // Score: every ring against the outline the loft blends at its t (sections resampled the same way).
  const fitted = sections.map((s) => ({ t: s.t, dense: resample(outline(s.points), false) }));
  const all = fitted.map((_, i) => i), errs = rings.flatMap((ring) => {
    const shape = blendAt(fitted, all, ring.t);
    return ring.dense.map((p) => toPolygon(p, shape));
  });
  return { loft, error: { mean: errs.reduce((a, b) => a + b, 0) / errs.length, max: Math.max(...errs) }, size };
}

// ---------- A. Slicing: mesh -> plane cuts -> ordered contours (independent of lofts) ----------

// Mesh vertices welded by position (spatial hash, cells of `tol`, 27 neighbours): glTF splits vertices at UV and
// normal seams, and a cut must run across them. Returns { V, tris }: points and triangles of welded indices, with
// triangles that collapse (two corners welded) left out.
export function weld(positions, indices, tol) {
  const cells = new Map(), V = [], id = [], key = (a, b, c) => `${a},${b},${c}`;
  for (let i = 0; i < positions.length / 3; i++) {
    const p = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]], c = p.map((x) => Math.floor(x / tol));
    let hit = -1;
    for (let dx = -1; dx <= 1 && hit < 0; dx++) for (let dy = -1; dy <= 1 && hit < 0; dy++) for (let dz = -1; dz <= 1 && hit < 0; dz++) {
      for (const j of cells.get(key(c[0] + dx, c[1] + dy, c[2] + dz)) ?? []) if (dist(V[j], p) <= tol) { hit = j; break; }
    }
    if (hit < 0) { hit = V.push(p) - 1; const k = key(...c); cells.set(k, [...(cells.get(k) ?? []), hit]); }
    id.push(hit);
  }
  const tris = [];
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const t = [id[indices[k]], id[indices[k + 1]], id[indices[k + 2]]];
    if (t[0] !== t[1] && t[1] !== t[2] && t[2] !== t[0]) tris.push(t);
  }
  return { V, tris };
}

// The contours where the plane through p with normal n cuts the welded mesh. A cut point is keyed by the mesh edge it
// lies on, so segments join by topology, not by distance or order of discovery. A vertex on the plane counts as
// above it (d >= 0), so a cut through a vertex or along a coplanar face gives each point once. Chains that stay open
// (a hole or the edge of a partial mesh) are joined end to end when within `gap`, else kept open and reported.
// Returns { contours: [{ points (3D), closed }], failures: [{ reason, ... }] }; closed contours run counter-clockwise
// seen from +n.
export function cutContours(V, tris, p, n, { gap = 0, minLength = 0 } = {}) {
  const d = V.map((v) => dot(sub(v, p), n)), at = new Map(), next = new Map(), seen = new Set(), failures = [];
  const link = (a, b) => { next.set(a, [...(next.get(a) ?? []), b]); };
  for (const [a, b, c] of tris) {
    const keys = [];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      if ((d[x] >= 0) === (d[y] >= 0)) continue;
      const k = x < y ? `${x}_${y}` : `${y}_${x}`;
      if (!at.has(k)) at.set(k, lerp(V[x], V[y], d[x] / (d[x] - d[y])));
      keys.push(k);
    }
    if (keys.length !== 2) continue;
    const s = keys[0] < keys[1] ? `${keys[0]}|${keys[1]}` : `${keys[1]}|${keys[0]}`;
    if (seen.has(s)) continue; // the same cut twice: a doubled face
    seen.add(s); link(keys[0], keys[1]); link(keys[1], keys[0]);
  }
  const branch = [...next].filter(([, ns]) => ns.length > 2);
  if (branch.length) failures.push({ reason: `non-manifold: ${branch.length} cut points join more than two segments; chained through the first two`, at: branch.map(([k]) => at.get(k)) });
  // Walk chains: from open ends first, then whatever is left (loops).
  const used = new Set(), edge = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`), chains = [];
  const walk = (start) => {
    const keys = [start];
    for (let cur = start; ;) {
      const nx = (next.get(cur) ?? []).find((k) => !used.has(edge(cur, k)));
      if (nx === undefined) break;
      used.add(edge(cur, nx));
      if (nx === start) return { keys, closed: true };
      keys.push(nx); cur = nx;
    }
    return { keys, closed: false };
  };
  for (const [k, ns] of next) if (ns.length === 1 && !used.has(edge(k, ns[0]))) chains.push(walk(k));
  for (const [k, ns] of next) if (ns.some((m) => !used.has(edge(k, m)))) chains.push(walk(k));
  let contours = chains.map(({ keys, closed }) => ({ points: keys.map((k) => at.get(k)), closed })).filter((c) => c.points.length > 1);
  // Small gaps: join open chains whose ends meet within `gap`, then close a chain whose own ends meet.
  for (let joined = true; joined && gap > 0;) {
    joined = false;
    const open = contours.filter((c) => !c.closed);
    for (const a of open) {
      if (dist(a.points[0], a.points.at(-1)) <= gap && a.points.length > 2) { a.closed = true; joined = true; break; }
      const b = open.find((o) => o !== a && [o.points[0], o.points.at(-1)].some((q) => dist(a.points.at(-1), q) <= gap));
      if (!b) continue;
      if (dist(a.points.at(-1), b.points[0]) > gap) b.points.reverse();
      a.points.push(...b.points); contours = contours.filter((c) => c !== b); joined = true; break;
    }
  }
  const x = norm(cross(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n)), y = cross(n, x), flat = (q) => [dot(sub(q, p), x), dot(sub(q, p), y)];
  for (const c of contours) {
    c.points = c.points.filter((q, i, a) => i === 0 || dist(q, a[i - 1]) > minLength); // duplicate and tiny steps
    if (c.closed && c.points.length > 2 && dist(c.points[0], c.points.at(-1)) <= minLength) c.points.pop();
    if (c.closed && area(c.points.map(flat)) < 0) c.points.reverse();
    if (!c.closed) failures.push({ reason: `open contour of ${c.points.length} points: the mesh has a hole or boundary here (ends ${+dist(c.points[0], c.points.at(-1)).toPrecision(3)} apart)`, ends: [c.points[0], c.points.at(-1)] });
  }
  return { contours: contours.filter((c) => c.points.length >= (c.closed ? 3 : 2)), failures };
}

// Profiles of a mesh cut by parallel planes: P(i) = origin + i * spacing * direction. direction is normalized
// (negated when `reverse`); origin defaults to half a step in from the mesh's low end along it, and count to as many
// planes as fit in `distance`, or in the mesh. tol (weld, gap, tiny steps) defaults to 1e-4 of the mesh's size.
// Returns { params, profiles: [{ index, plane_origin, plane_normal, contours: [{ points, closed, point_count }],
// failures }] }: points are 3D, where the mesh is; nothing is dropped silently.
export function sliceMesh(positions, indices, { origin, direction = [0, 0, 1], spacing, count, distance, reverse = false, tol, gap } = {}) {
  if (positions.length < 9 || indices.length < 3) throw new Error('slice: the mesh has no triangles');
  let n = norm(direction.map(Number));
  if (!(Math.hypot(...n) > 0.5)) throw new Error('slice: direction must be a non-zero vector');
  if (reverse) n = scale(n, -1);
  const P = Array.from({ length: positions.length / 3 }, (_, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
  const along = P.map((v) => dot(v, n)), lo = Math.min(...along), hi = Math.max(...along);
  const size = dist(P.reduce((m, v) => m.map((c, a) => Math.min(c, v[a]))), P.reduce((m, v) => m.map((c, a) => Math.max(c, v[a]))));
  tol ??= size * 1e-4;
  count = count === undefined ? undefined : Math.round(count);
  spacing ??= (distance ?? hi - lo) / (count ?? 20);
  if (!(spacing > 0)) throw new Error('slice: spacing must be > 0');
  origin ??= add(P[along.indexOf(lo)], scale(n, spacing / 2));
  count ??= Math.max(1, Math.floor((distance ?? hi - dot(origin, n)) / spacing) + 1);
  const { V, tris } = weld(positions, indices, tol), profiles = [];
  for (let i = 0; i < count; i++) {
    const p = add(origin, scale(n, i * spacing)), { contours, failures } = cutContours(V, tris, p, n, { gap: gap ?? tol * 10, minLength: tol });
    profiles.push({ index: i, plane_origin: p, plane_normal: n, contours: contours.map((c) => ({ ...c, point_count: c.points.length })), failures });
  }
  return { params: { origin, direction: n, spacing, count, tol, vertices: V.length, triangles: tris.length }, profiles };
}

// ---------- B. Curve processing: contours -> loft-ready (resampled, wound, aligned) ----------

// n points evenly by arc length along a contour (3D), closed or open; the first point stays.
export function resampleContour(pts, n, closed = true) {
  const L = closed ? [...pts, pts[0]] : pts, cum = [0];
  for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + dist(L[i], L[i - 1]));
  const total = cum.at(-1), out = [];
  for (let k = 0, e = 0; k < n; k++) {
    const s = (k / (closed ? n : n - 1)) * total;
    while (e < L.length - 2 && cum[e + 1] < s) e++;
    out.push(lerp(L[e], L[e + 1], cum[e + 1] > cum[e] ? (s - cum[e]) / (cum[e + 1] - cum[e]) : 0));
  }
  return out;
}

// A closed resampled contour turned (cyclic shift) so that point k lies nearest point k of `prev`: neighbouring
// profiles then blend point to point without twisting. Both must have the same count and winding (cutContours).
export function alignContour(prev, cur) {
  const n = cur.length;
  let best = 0, bestE = Infinity;
  for (let s = 0; s < n; s++) {
    let e = 0;
    for (let k = 0; k < n && e < bestE; k++) e += dist(prev[k], cur[(k + s) % n]) ** 2;
    if (e < bestE) { bestE = e; best = s; }
  }
  return [...cur.slice(best), ...cur.slice(0, best)];
}

// Every closed contour of every profile resampled to n points; each aligned to the closed contour of the profile
// before whose centre is nearest (so a scan through two legs keeps each leg's points matched). Open contours are
// resampled, not aligned. Returns a new scan.
// A scanned loft as one to build on: under a joint (the path from `origin`), sections placed by distance d along the
// path (so a recipe can extend the path and keep them), `points` smooth points each [u, v, hu, hv], all starting at
// u 0, v > 0 (the back of an upright loft, the top of a sideways one, as jig.js frames them) so they blend point to
// point. symmetric: each outline averaged with its mirror (u -> -u) and the path put on x = origin's. from, to: the
// share of the path to keep sections from (to leave out cuts that take in a neighbour); the path is cut to the first
// and last kept sections, as a loft holds its end sections out to its path's ends.
// Returns { path, sections, start } (start: where the path starts, in the scan's own coordinates).
export function jigLoft(loft, { origin = [0, 0, 0], points = 24, symmetric = false, from = 0, to = 1 } = {}) {
  const r = (x) => +x.toFixed(3), length = curveLength(loftCurve({ path: loft.path }));
  const kept = loft.sections.filter((x) => x.t >= from - 1e-9 && x.t <= to + 1e-9);
  if (!kept.length) throw new Error(`jigLoft: no sections between ${from} and ${to}`);
  const d0 = kept[0].t * length, d1 = kept[kept.length - 1].t * length;
  // The path from d0 to d1 (along its polyline). shortcut: a smooth path's length is its polyline's; fine for the
  // nearly straight paths a guide gives.
  const at = (d) => { let a = 0; for (let i = 1; i < loft.path.length; i++) { const p = loft.path[i - 1], q = loft.path[i], l = Math.hypot(...q.map((c, k) => c - p[k])); if (a + l >= d - 1e-9 || i === loft.path.length - 1) return p.map((c, k) => c + (q[k] - c) * Math.min(1, (d - a) / l)); a += l; } return loft.path[0]; };
  let a = 0; const inside = [];
  for (let i = 1; i < loft.path.length - 1; i++) { a += Math.hypot(...loft.path[i].map((c, k) => c - loft.path[i - 1][k])); if (a > d0 + 1e-6 && a < d1 - 1e-6) inside.push(loft.path[i]); }
  const path = [at(d0), ...inside, at(d1)];
  const ring = (pts) => {
    let q = resampleContour(pts.map(([u, v]) => [u, v]), points * 4);
    if (symmetric) { const m = alignContour(q, q.map(([u, v]) => [-u, v]).reverse()); q = q.map((p, i) => [(p[0] + m[i][0]) / 2, (p[1] + m[i][1]) / 2]); }
    const start = q.reduce((b, p, i) => (p[1] > 0 && Math.abs(p[0]) < Math.abs(q[b][0]) ? i : b), Math.max(0, q.findIndex((p) => p[1] > 0)));
    const e = resampleContour([...q.slice(start), ...q.slice(0, start)], points);
    return e.map((p, i) => { const a = e[(i + points - 1) % points], b = e[(i + 1) % points]; return [p[0], p[1], (b[0] - a[0]) / 6, (b[1] - a[1]) / 6].map(r); });
  };
  return {
    path: path.map((p) => p.map((c, i) => (symmetric && i === 0 ? 0 : r(c - origin[i])))),
    sections: kept.map((x) => ({ d: r(x.t * length - d0), points: ring(x.points) })),
    start: path[0],
  };
}

export function loftReady(scan, n = 64) {
  let prev = [];
  const profiles = scan.profiles.map((pr) => {
    const contours = pr.contours.map((c) => {
      let points = resampleContour(c.points, n, c.closed);
      if (c.closed && prev.length) {
        const m = mean(points), near = prev.reduce((a, b) => (dist(mean(b), m) < dist(mean(a), m) ? b : a));
        points = alignContour(near, points);
      }
      return { ...c, points, point_count: n };
    });
    prev = contours.filter((c) => c.closed).map((c) => c.points).concat(contours.some((c) => c.closed) ? [] : prev);
    return { ...pr, contours };
  });
  return { ...scan, params: { ...scan.params, points: n }, profiles };
}
const mean = (pts) => scale(pts.reduce(add), 1 / pts.length);

// A scan as DXF (R12): each contour a 3D POLYLINE on layer slice_<index>, closed ones flagged closed.
export function scanDxf(scan) {
  const out = ['0', 'SECTION', '2', 'ENTITIES'];
  for (const pr of scan.profiles) for (const c of pr.contours) {
    const layer = `slice_${pr.index}`;
    out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', String(8 | (c.closed ? 1 : 0)));
    for (const [x, y, z] of c.points) out.push('0', 'VERTEX', '8', layer, '10', String(x), '20', String(y), '30', String(z), '70', '32');
    out.push('0', 'SEQEND', '8', layer);
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}

// The mesh cut across the loft curve through `path` at SLICES values of t.
function slices(V, tris, path) {
  const curve = loftCurve({ path }), out = [];
  for (let i = 0; i < SLICES; i++) {
    const t = INSET + ((1 - 2 * INSET) * i) / (SLICES - 1), s = section(V, tris, loftFrame(curve, t));
    if (s) out.push({ t, ...s });
  }
  return out;
}

// The guide with each end in reach moved out along its end segment to the farthest vertex that way.
function reachEnds(V, guide, reach) {
  const g = guide.map((p) => [...p]), n = g.length;
  [[0, 1], [n - 1, n - 2]].forEach(([end, prev], k) => {
    if (!reach[k]) return;
    const d = norm(sub(g[end], g[prev]));
    g[end] = add(g[end], scale(d, Math.max(0, ...V.map((v) => dot(sub(v, g[end]), d)))));
  });
  return g;
}

// First guess of the centre line: cut across d, step from the cut's centre along d, turn d halfway toward the last
// step. Stops where no cut surrounds the stepped point (past the far end).
function march(V, tris, p, d, step) {
  const out = [];
  for (let i = 0; i < 4 * SLICES; i++) {
    const x = norm(cross(Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], d)), s = section(V, tris, { p, x, y: cross(d, x), z: d }, i > 0);
    if (!s) break;
    if (out.length) d = norm(add(d, norm(sub(s.centre, out[out.length - 1].centre))));
    out.push({ ...s, z: d });
    p = add(s.centre, scale(d, step));
  }
  return out;
}

// The cut across frame f ({ p, x, y, z }): { loop (2D, in x, y), z, centre (3D) }, or null when the cut does not
// surround p (strict) or any point. A closed contour of the cut is used as it is (RES points by arc length from the
// +u side); without one, the outline is radial: RES rays from the centre, each to its farthest crossing within
// REACH x the median nearest crossing; that wraps fingers, fur and open edges into one outline but leaves out another
// limb an oblique cut also crosses. Done twice: from p (or the crossings' mean), then from the first outline's centroid.
function section(V, tris, f, strict = false) {
  // First the true cut: the closed contour round p (the largest that is, when nested), else (not strict) the largest.
  const flat = (q) => [dot(sub(q, f.p), f.x), dot(sub(q, f.p), f.y)];
  const loops = cutContours(V, tris, f.p, f.z).contours.filter((c) => c.closed).map((c) => c.points.map(flat)).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  const round = loops.find((L) => inside([0, 0], L)) ?? (strict ? undefined : loops[0]);
  const ring = round && resample(round), c = ring && centroid(ring), far = ring?.map((q) => dist(q, c)).sort((a, b) => a - b);
  // A contour reaching far past its median radius has swallowed a limb joined to it (an arm at the shoulder): radial clips it.
  if (ring && far.at(-1) <= REACH * far[far.length >> 1]) {
    const [u, v] = c;
    return { loop: ring, z: f.z, centre: add(f.p, add(scale(f.x, u), scale(f.y, v))) };
  }
  // Else radial (open cuts: a part split off a bigger mesh, fur, fingers).
  const segs = cut(V, tris, f.p, f.z).map((sg) => sg.map((q) => [dot(sub(q, f.p), f.x), dot(sub(q, f.p), f.y)]));
  if (segs.length < 3) return null;
  const cover = COVER[+strict]; // a torso with its arms cut off has holes at the sides
  let loop = radial(segs, [0, 0], cover);
  if (!loop && !strict) loop = radial(segs, scale(segs.flat().reduce(add), 1 / (2 * segs.length)), cover);
  if (!loop) return null;
  loop = radial(segs, centroid(loop), cover) ?? loop;
  const [u, v] = centroid(loop);
  return { loop, z: f.z, centre: add(f.p, add(scale(f.x, u), scale(f.y, v))) };
}

function radial(segs, o, cover) {
  const hits = Array.from({ length: RES }, (_, k) => {
    const d = [Math.cos((2 * Math.PI * k) / RES), Math.sin((2 * Math.PI * k) / RES)], ts = [];
    for (const [a, b] of segs) {
      const e = sub(b, a), ao = sub(a, o), den = d[0] * e[1] - d[1] * e[0];
      if (Math.abs(den) < 1e-15) continue;
      const t = (ao[0] * e[1] - ao[1] * e[0]) / den, u = (ao[0] * d[1] - ao[1] * d[0]) / den;
      if (t > 0 && u >= 0 && u <= 1) ts.push(t);
    }
    return ts;
  });
  const near = hits.filter((ts) => ts.length).map((ts) => Math.min(...ts)).sort((a, b) => a - b);
  if (near.length < RES * cover) return null;
  const limit = REACH * near[near.length >> 1];
  const r = hits.map((ts) => Math.max(-1, ...ts.filter((t) => t <= limit)));
  // Rays with nothing in reach take the radius between their nearest neighbours that have one.
  const ok = r.map((x, k) => (x > 0 ? k : -1)).filter((k) => k >= 0);
  const filled = r.map((x, k) => {
    if (x > 0) return x;
    const a = ok.findLast((j) => j < k) ?? ok[ok.length - 1] - RES, b = ok.find((j) => j > k) ?? ok[0] + RES;
    return r[(a + RES) % RES] + ((r[b % RES] - r[(a + RES) % RES]) * (k - a)) / (b - a);
  });
  return filled.map((_, k) => {
    const x = Array.from({ length: 2 * SMOOTH + 1 }, (_, j) => filled[(k + j - SMOOTH + RES) % RES]).sort((a, b) => a - b)[SMOOTH];
    const w = (2 * Math.PI * k) / RES;
    return [o[0] + x * Math.cos(w), o[1] + x * Math.sin(w)];
  });
}

// The segments where the plane through p with normal n cuts the triangles, as [a, b] points.
function cut(V, tris, p, n) {
  const d = V.map((v) => dot(sub(v, p), n)), segs = [];
  for (const [a, b, c] of tris) {
    const s = [a, b, c].map((i) => d[i] >= 0), crossing = [[a, b], [b, c], [c, a]].filter((_, j) => s[j] !== s[(j + 1) % 3]);
    if (crossing.length === 2) segs.push(crossing.map(([x, y]) => lerp(V[x], V[y], d[x] / (d[x] - d[y]))));
  }
  return segs;
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

// A dense ring as n smooth section points, every RES / n-th, with Catmull-Rom handles.
function points(ring, n) {
  const step = RES / n, at = (k) => ring[((k * step) % RES + RES) % RES];
  return Array.from({ length: n }, (_, k) => [...at(k), ...scale(sub(at(k + 1), at(k - 1)), 1 / 6)]);
}
const fits = (ring, n, tol) => ring.every((p) => toPolygon(p, outline(points(ring, n))) <= tol);

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

const inside = ([x, y], L) => L.reduce((odd, a, i) => {
  const b = L[(i + 1) % L.length];
  return (a[1] > y) !== (b[1] > y) && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]) ? !odd : odd;
}, false);

function centroid(L) {
  const A = area(L);
  if (Math.abs(A) < 1e-30) return scale(L.reduce(add), 1 / L.length);
  let cx = 0, cy = 0;
  L.forEach((p, i) => { const q = L[(i + 1) % L.length], w = p[0] * q[1] - q[0] * p[1]; cx += (p[0] + q[0]) * w; cy += (p[1] + q[1]) * w; });
  return [cx / (6 * A), cy / (6 * A)];
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

// ---------- C. Node by node, for tools/autoscan.mjs: one piece of a figure (a joint's triangles) as one loft ----------

const STATIONS = 40; // cuts along a piece's spine
const SLABS = 20;    // slabs across the spine for the front and side views
const NS = [6, 8, 12, 16, 24, 32]; // point counts tried, fewest first
const SQUIRCLE = [2.5, 3, 4];      // squircle exponents tried after the ellipse

// The spine of a piece (welded vertices V): the guide's line (a joint toward its next joint), carried out to the piece's
// ends along it, then moved into the middle of the piece as a front view and a side view see it: SLABS slabs across
// the line, each one's centre the middle of its vertices' extent across and in depth; averaged over 3 slabs and thinned
// to 2 tol or 5% of its length, so a straight piece keeps 2 points and a bent one (a neck, a tail) gets a path.
export function fitSpine(V, guide, tol, trace) {
  const a = guide[0], z = norm(sub(guide.at(-1), a)), x = norm(cross(Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], z)), y = cross(z, x);
  const along = V.map((v) => dot(sub(v, a), z)), lo = Math.min(...along), hi = Math.max(...along), step = (hi - lo) / SLABS;
  if (!(step > 0)) throw new Error('scan: the piece has no length along its guide');
  const slabs = Array.from({ length: SLABS }, () => [Infinity, -Infinity, Infinity, -Infinity]);
  V.forEach((v, i) => {
    const s = slabs[Math.min(SLABS - 1, Math.floor((along[i] - lo) / step))], u = dot(sub(v, a), x), w = dot(sub(v, a), y);
    s[0] = Math.min(s[0], u); s[1] = Math.max(s[1], u); s[2] = Math.min(s[2], w); s[3] = Math.max(s[3], w);
  });
  const c = slabs.flatMap((s, k) => (s[0] <= s[1] ? [[(s[0] + s[1]) / 2, (s[2] + s[3]) / 2, lo + (k + 0.5) * step]] : []));
  const even = c.map((_, i) => { const n = c.slice(Math.max(0, i - 1), i + 2); return [0, 1, 2].map((k) => n.reduce((s, q) => s + q[k], 0) / n.length); });
  even[0][2] = lo; even.at(-1)[2] = hi;
  const path = douglasPeucker(even.map(([u, w, s]) => add(a, add(add(scale(x, u), scale(y, w)), scale(z, s)))), Math.max(2 * tol, (hi - lo) * 0.05)); // the sections take the detail
  if (trace) Object.assign(trace, { a, x, y, z, lo, hi, step, slabs, centres: c, even, path }); // tools/scanviz.mjs
  return path;
}

// N points round a closed 2D ring, counter-clockwise from its point 0: a corner [u, v] where the ring turns more than
// 60 degrees, the rest smooth with Catmull-Rom handles, spread over the stretches between corners by their length.
function smoothPoints(ring, n) {
  const R = resampleContour(ring, RES), at = (i) => R[((i % RES) + RES) % RES];
  const turn = (i) => { const a = sub(at(i), at(i - 2)), b = sub(at(i + 2), at(i)); return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (Math.hypot(...a) * Math.hypot(...b) || 1)))); };
  const corners = R.map((_, i) => i).filter((i) => turn(i) > Math.PI / 3 && turn(i) >= turn(i - 1) && turn(i) > turn(i + 1));
  let idx = Array.from({ length: n }, (_, k) => (k * RES) / n);
  if (corners.length && corners.length <= n / 2) {
    const k = corners.length, gaps = corners.map((c, j) => (j + 1 < k ? corners[j + 1] : corners[0] + RES) - c);
    const share = gaps.map((g) => ((n - k) * g) / RES), m = share.map(Math.floor);
    for (let left = n - k - m.reduce((x, y) => x + y, 0); left > 0; left--) { const j = share.map((x, i) => x - m[i]).reduce((b, x, i, f) => (x > f[b] ? i : b), 0); m[j]++; share[j] = m[j]; }
    idx = corners.flatMap((c, j) => [c, ...Array.from({ length: m[j] }, (_, q) => c + (gaps[j] * (q + 1)) / (m[j] + 1))]).map((i) => i % RES).sort((x, y) => x - y);
  }
  const point = (i) => { const f = i - Math.floor(i); return f ? lerp(at(Math.floor(i)), at(Math.floor(i) + 1), f) : at(i); };
  return idx.map((i, k) => {
    if (corners.includes(i)) return at(i);
    return [...point(i), ...scale(sub(point(idx[(k + 1) % n]), point(idx[(k + n - 1) % n])), 1 / 6)];
  });
}
const symmetric = (ring) => { const m = alignContour(ring, ring.map(([u, v]) => [-u, v]).reverse()); return ring.map((p, i) => [(p[0] + m[i][0]) / 2, (p[1] + m[i][1]) / 2]); };

// The simplest outline within tol of a cut (ring: RES points from +u, counter-clockwise, in the section's u, v): a
// circle, an ellipse or a squircle round the cut's box centre, else N points, symmetric about u = 0 before free, the
// fewest N that fit. Returns { form: 'round' | 'symmetric' | 'free', shape?, n?, points, score }: score is the farthest
// miss either way over tol (1 or less fits); when nothing fits, the best one tried.
export function fitRing(ring, tol, tried) {
  const us = ring.map((p) => p[0]), vs = ring.map((p) => p[1]), rx = (Math.max(...us) - Math.min(...us)) / 2, ry = (Math.max(...vs) - Math.min(...vs)) / 2;
  const center = [(Math.max(...us) + Math.min(...us)) / 2, (Math.max(...vs) + Math.min(...vs)) / 2];
  let best;
  const fits = (c) => {
    const poly = outline(c.points);
    c.score = Math.max(...ring.map((p) => toPolygon(p, poly)), ...poly.map((p) => toPolygon(p, ring))) / tol;
    tried?.push(c);
    if (!best || c.score < best.score) best = c;
    return c.score <= 1;
  };
  for (const shape of [{ circle: (rx + ry) / 2 }, { ellipse: [rx, ry] }, ...SQUIRCLE.map((n) => ({ squircle: [rx, ry, n] }))]) {
    const c = { form: 'round', shape: { ...shape, center }, points: roundSection({ ...shape, center }) };
    if (fits(c)) return c;
  }
  const sym = symmetric(ring);
  for (const n of NS) for (const [form, src] of [['symmetric', sym], ['free', ring]]) { const c = { form, n, points: smoothPoints(src, n) }; if (fits(c)) return c; }
  return best;
}

// One piece as one loft (plan steps 3 to 6): the spine (fitSpine from guide, or `path` as given); STATIONS cuts across
// it; sections first where the cuts' extents need them (each end, then the cut a straight blend of the extents misses
// most, until within tol); each section the simplest outline that fits (fitRing), all of one loft in one form (round
// shapes, or the most points any needs, symmetric when none needs free points: a loft's sections share their point
// count); then a section added at the cut the loft misses most, until within tol or maxSections.
// Returns { loft, error: { mean, max }, stations: [{ t, f, dense }], forms, size }: error is how far each cut lies from
// the loft's outline at its t (cross-section distance), stations the cuts (insideScan).
// trace (tools/scanviz.mjs): filled with the steps: spine, ext, where (sections from the extents), tried, rounds.
export function scanPiece(positions, indices, { guide, path, tol, maxSections = 12, trace } = {}) {
  const P = Array.from({ length: positions.length / 3 }, (_, i) => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]);
  if (P.length < 3 || indices.length < 3) throw new Error('scan: the piece has no triangles');
  const lo = P.reduce((m, v) => m.map((c, a) => Math.min(c, v[a])), P[0]), hi = P.reduce((m, v) => m.map((c, a) => Math.max(c, v[a])), P[0]);
  const size = dist(lo, hi);
  tol ??= size * 0.01;
  const { V, tris } = weld(positions, indices, size * 1e-4);
  const digits = Math.max(0, -Math.floor(Math.log10(size / 1000))), unit = 10 ** -digits; // numbers are written to a thousandth of the size
  if (trace) trace.spine = path ? { path } : {};
  path ??= fitSpine(V, guide, tol, trace?.spine);
  const curve = loftCurve({ path }), stations = [];
  for (let i = 0; i < STATIONS; i++) {
    const t = INSET + ((1 - 2 * INSET) * i) / (STATIONS - 1), f = loftFrame(curve, t), s = section(V, tris, f);
    const thin = s && [0, 1].some((k) => Math.max(...s.loop.map((q) => q[k])) - Math.min(...s.loop.map((q) => q[k])) < 4 * unit); // grazes the piece
    if (s && !thin) stations.push({ t, f, dense: stations.length ? alignContour(stations.at(-1).dense, s.loop) : s.loop });
  }
  if (stations.length < 2) throw new Error('scan: fewer than 2 cuts go round the piece');
  stations[0].t = 0; stations.at(-1).t = 1; // the loft holds its end shapes out to the caps

  // Where: the cuts' extents [u min, u max, v min, v max], blended straight between sections.
  const box = (L) => [Math.min(...L.map((p) => p[0])), Math.max(...L.map((p) => p[0])), Math.min(...L.map((p) => p[1])), Math.max(...L.map((p) => p[1]))];
  const ext = stations.map((s) => box(s.dense));
  let kept = [0, stations.length - 1];
  for (;;) {
    let worst = -1, miss = tol;
    stations.forEach((s, i) => {
      const j = kept.findIndex((k) => k >= i), a = kept[Math.max(0, j - 1)], b = kept[j], f = b === a ? 0 : (s.t - stations[a].t) / (stations[b].t - stations[a].t);
      const e = Math.max(...ext[i].map((x, k) => Math.abs(x - (ext[a][k] + (ext[b][k] - ext[a][k]) * f))));
      if (e > miss && !kept.includes(i)) { worst = i; miss = e; }
    });
    if (worst < 0 || kept.length >= maxSections) break;
    kept = [...kept, worst].sort((a, b) => a - b);
  }
  if (trace) Object.assign(trace, { ext, where: [...kept], tried: new Map(), rounds: [] });

  // What: each section fitted, the loft in one form, scored against every cut; add sections where it misses.
  const fitted = new Map(), fitOf = (i) => { if (!fitted.has(i)) { const tried = []; fitted.set(i, fitRing(stations[i].dense, tol, tried)); trace?.tried.set(i, tried); } return fitted.get(i); };
  const sectionsOf = (list) => {
    const fits = list.map(fitOf);
    if (fits.every((f) => f.form === 'round')) return list.map((i, k) => ({ t: stations[i].t, points: fits[k].shape, pts: fits[k].points }));
    const n = Math.max(...fits.map((f) => f.n ?? 0)), sym = fits.every((f) => f.form !== 'free');
    return list.map((i) => { const pts = smoothPoints(sym ? symmetric(stations[i].dense) : stations[i].dense, n); return { t: stations[i].t, points: pts, pts }; });
  };
  const misses = (secs) => {
    const rings = secs.map((s) => ({ t: s.t, dense: resample(outline(s.pts), false) })), all = rings.map((_, i) => i);
    return stations.map((st) => { const shape = blendAt(rings, all, st.t); return st.dense.map((p) => toPolygon(p, shape)); });
  };
  let secs, errs;
  for (;;) {
    secs = sectionsOf(kept); errs = misses(secs);
    const worst = errs.map((e) => Math.max(...e)), w = worst.indexOf(Math.max(...worst));
    trace?.rounds.push({ kept: [...kept], worst, secs });
    if (worst[w] <= tol || kept.length >= maxSections || kept.includes(w)) break;
    kept = [...kept, w].sort((a, b) => a - b);
  }
  const r = (x) => (Array.isArray(x) ? x.map(r) : typeof x === 'number' ? +x.toFixed(digits) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r(v)])));
  const flat = errs.flat();
  return {
    loft: { path: r(path), sections: secs.map((s) => ({ t: r(s.t), points: r(s.points) })) },
    error: { mean: flat.reduce((a, b) => a + b, 0) / flat.length, max: Math.max(...flat) },
    stations, forms: kept.map((i) => fitOf(i).form), size,
  };
}

// Whether point p lies inside a scanned piece: within the outline of its nearest cut, and no farther from that cut
// along the spine than the cuts lie apart.
export function insideScan(stations, p) {
  const s = stations.reduce((a, b) => (dist(b.f.p, p) < dist(a.f.p, p) ? b : a)), gap = dist(stations[0].f.p, stations[1].f.p);
  const q = sub(p, s.f.p);
  return Math.abs(dot(q, s.f.z)) <= gap && inside([dot(q, s.f.x), dot(q, s.f.y)], s.dense);
}

// How alike two meshes look in outline, without a browser: per view, the pixels both cover over the pixels either
// covers (1: the same outline), as tools/render.mjs measures with three.js. a, b: { positions, indices }; views: names
// as tools/render.html's (front looks down -z) or directions [x, y, z] to look from; px: the image's size.
export function silhouetteIoU(a, b, { views = ['front', 'side', 'iso'], px = 256 } = {}) {
  const dirs = { front: [0, 0, 1], back: [0, 0, -1], side: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0.001], iso: [1, 0.7, 1] };
  return Object.fromEntries(views.map((view) => {
    const z = norm(dirs[view] ?? view), x = norm(cross(Math.abs(z[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0], z)), y = cross(z, x);
    const flat = (m) => Array.from({ length: m.positions.length / 3 }, (_, i) => { const p = [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]]; return [dot(p, x), dot(p, y)]; });
    const A = flat(a), B = flat(b), lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of [...A, ...B]) for (const k of [0, 1]) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const s = (px * 0.999) / Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-12);
    const mask = (F, idx) => {
      const M = new Uint8Array(px * px);
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const [p, q, r] = [idx[t], idx[t + 1], idx[t + 2]].map((k) => [(F[k][0] - lo[0]) * s, (F[k][1] - lo[1]) * s]);
        const edge = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]), sign = Math.sign(edge(p, q, r));
        if (!sign) continue;
        const i0 = Math.max(0, Math.floor(Math.min(p[0], q[0], r[0]))), i1 = Math.min(px - 1, Math.floor(Math.max(p[0], q[0], r[0])));
        const j0 = Math.max(0, Math.floor(Math.min(p[1], q[1], r[1]))), j1 = Math.min(px - 1, Math.floor(Math.max(p[1], q[1], r[1])));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const c = [i + 0.5, j + 0.5];
          if (sign * edge(p, q, c) >= 0 && sign * edge(q, r, c) >= 0 && sign * edge(r, p, c) >= 0) M[j * px + i] = 1;
        }
      }
      return M;
    };
    const MA = mask(A, a.indices), MB = mask(B, b.indices);
    let both = 0, either = 0;
    for (let i = 0; i < MA.length; i++) { both += MA[i] & MB[i]; either += MA[i] | MB[i]; }
    return [view, either ? both / either : 0];
  }));
}

// ---------- D. Symmetry: a part's mirror plane, and a pose that turns a centre-line leaf (a head) upright by it ----------

// The plane a point cloud P ([[x, y, z]]) is most nearly mirror-symmetric about, near `guess` (a normal): normals within
// span degrees of it searched coarse to fine, the plane's offset with them. Returns { normal, d (normal . p = d), miss:
// the mean distance from a mirrored point to the nearest point, symmetric: the share of points whose mirror lands within
// tol of a point (1: a perfect mirror), tilt: degrees from guess }.
export function symmetryPlane(P, guess = [1, 0, 0], { span = 40, tol } = {}) {
  const lo = P.reduce((m, v) => m.map((c, a) => Math.min(c, v[a])), P[0]), hi = P.reduce((m, v) => m.map((c, a) => Math.max(c, v[a])), P[0]);
  const cell = dist(lo, hi) / 40, K = 64, grid = new Map(), at = (x, a) => Math.floor((x - lo[a]) / cell) + 1; // K > 40 + 2 cells a side
  tol ??= cell / 2;
  for (const p of P) { const k = (at(p[0], 0) * K + at(p[1], 1)) * K + at(p[2], 2); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  const near = (q) => { // the nearest point within a cell (else cell): the 27 cells round q
    const c = [at(q[0], 0), at(q[1], 1), at(q[2], 2)];
    let best = cell * cell;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      for (const p of grid.get(((c[0] + i) * K + c[1] + j) * K + c[2] + k) ?? []) { const e = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; if (e < best) best = e; }
    }
    return Math.sqrt(best);
  };
  const every = (n) => P.filter((_, i) => i % Math.max(1, Math.floor(P.length / n)) === 0), coarse = every(200), fine = every(800), mid = mean(P);
  let sample = coarse;
  const g = norm(guess), a = norm(cross(Math.abs(g[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], g)), b = cross(g, a);
  const normal = (th, ph) => norm(add(g, add(scale(a, Math.tan(th)), scale(b, Math.tan(ph)))));
  const misses = (n, d) => sample.map((p) => near(sub(p, scale(n, 2 * (dot(p, n) - d)))));
  const cost = (n, d) => misses(n, d).reduce((s, x) => s + x, 0) / sample.length;
  const deg = Math.PI / 180;
  let best = { th: 0, ph: 0, d: dot(mid, g) }; best.c = cost(g, best.d);
  for (const [step, reach] of [[5, span], [1, 5], [0.25, 1]]) {
    if (step < 5 && sample === coarse) { sample = fine; best.c = cost(normal(best.th, best.ph), best.d); }
    const c0 = { ...best };
    for (let i = -reach; i <= reach; i += step) for (let j = -reach; j <= reach; j += step) {
      const th = c0.th + i * deg, ph = c0.ph + j * deg, n = normal(th, ph);
      for (const dd of step === 5 ? [0] : [-1, 0, 1]) { const d = (step === 5 ? dot(mid, n) : c0.d) + dd * cell * step / 5, c = cost(n, d); if (c < best.c) best = { th, ph, d, c }; }
    }
  }
  const n = normal(best.th, best.ph), m = misses(n, best.d);
  return { normal: n, d: best.d, miss: best.c, symmetric: m.filter((x) => x <= tol).length / m.length, tilt: Math.acos(Math.min(1, dot(n, g))) / deg };
}

// The straightened pose with each leaf joint on the centre line (a head: its origin within a tenth of its pieces' width
// of the root's mid-plane x = root's x) turned so its pieces' mirror plane stands on that mid-plane, normal along x.
// Turns of under half a degree, or for parts too unlike a mirror (symmetric under 0.5, within symmetryPlane's own
// tol: 1/80 of the part's size), are left out.
// Returns { pose, levelled: [{ joint, tilt, symmetric, miss }] }.
// shortcut: the body's mid-plane is taken as x = const (straightPose puts the arms along x); a figure turned at its root
// needs that plane measured too.
export function levelPose(gltf, sk, pose) {
  const S = nodeOrigins(gltf, pose), parts = jointParts(gltf, pose, sk.owner), extra = [], levelled = [];
  for (const [n, j] of Object.entries(sk.joints)) {
    if (j.children.length) continue;
    const P = parts.filter((p) => p.joint === n).flatMap((p) => Array.from({ length: p.positions.length / 3 }, (_, i) => [p.positions[3 * i], p.positions[3 * i + 1], p.positions[3 * i + 2]]));
    if (P.length < 50) continue;
    const xs = P.map((p) => p[0]), width = Math.max(...xs) - Math.min(...xs);
    if (Math.abs(S[n][0] - S[sk.root][0]) > 0.1 * width) continue;
    const sym = symmetryPlane(P), axis = cross(sym.normal, [1, 0, 0]);
    levelled.push({ joint: n, tilt: sym.tilt, symmetric: sym.symmetric, miss: sym.miss });
    if (sym.tilt >= 0.5 && sym.symmetric >= 0.5) extra.push([n, { turn: [...axis, sym.tilt] }]);
  }
  return { pose: [...pose, ...extra], levelled };
}
