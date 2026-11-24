// Shape scanner (sketch, draft f35): a mesh as a few joined shapes (box, cylinder, cone, sphere, capsule, lathe,
// extrude, loft), each a recipe mesh with its own place, turn and neighbours. Pure, like jig.js and scan.js.
//
// 1. Pieces: the mesh welded and split into connected pieces.
// 2. Fit (fitRegion): every kind of shape is fitted to a region and built by jig.js, then scored both ways against
//    the region: samples of the region to the shape's triangles, and samples of the shape back to the region (a
//    shape point hidden inside a closed piece counts as on it). Primitives first; lathe, extrude and loft only when
//    no primitive fits within the tolerance.
//    E = W * share * ms / tol^2 + lambda * values + per_shape: share is the region's part of the whole surface, ms the
//    mean squared miss both ways, values the numbers the recipe holds. Lowest E wins.
// 3. Split (top-down): a region is cut in two where it would cost less as two shapes: across an axis at a crease
//    loop or where its cross-section jumps, or by peeling off what sticks out of the best primitive (a nose off a
//    head). Then neighbouring regions that cost less as one shape are merged again.
// 4. Relations: neighbours share welded vertices; a shape hangs under its largest larger neighbour (D-172: a child
//    node), so the head carries the nose.
import { read, geometry, EXT, VERSION } from './jig.js?v=ecb099f';
import { weld, cutContours, scanPiece, scanLoft } from './scan.js?v=ecb099f';

export const DEFAULTS = { lambda: 0.01, perShape: 0.5, weight: 1, crease: 60, depth: 3, samples: 1500 };
const PRIMITIVES = ['sphere', 'cylinder', 'capsule', 'cone', 'box'];

// positions, indices: a triangle mesh (flat arrays). tolerance: default 1% of its size. Options: DEFAULTS, and
// kinds: the shape kinds tried (default all), split: false to fit each piece whole.
// Returns { shapes: [{ id, kind, mesh, origin, axes, triangles, vertices, error: { rms, max, back }, E, confidence,
// values, neighbours, parent, how, faces }], E, size, tol }: mesh is a recipe mesh in its own frame (axes: its x, y,
// z in the source's space; origin: its centre); faces lists the source triangles (welded indices into `weldedTris`).
export function scanShapes(positions, indices, { tolerance, split = true, kinds, ...o } = {}) {
  const opts = { ...DEFAULTS, ...o }, ctx = context(positions, indices, tolerance, opts, kinds);
  let regions = [];
  for (const comp of components(ctx)) {
    const r = region(ctx, comp, comp);
    if (r) regions.push(...(split ? splitRegion(ctx, r, opts.depth) : [r]));
  }
  if (split) regions = mergeRegions(ctx, regions);
  return relate(ctx, regions);
}

// One region's best shape (for tools/autoscan.mjs: one joint's piece). Returns the same shape record, or throws.
export function fitShape(positions, indices, { tolerance, kinds, ...o } = {}) {
  const ctx = context(positions, indices, tolerance, { ...DEFAULTS, ...o }, kinds), all = ctx.tris.map((_, i) => i);
  const r = region(ctx, all, all);
  if (!r) throw new Error('shapes: the mesh has no triangles');
  if (!fit(ctx, r).best) throw new Error('shapes: no shape fits');
  return relate(ctx, [r]).shapes[0];
}

// ---------- context, pieces, regions ----------

function context(positions, indices, tolerance, opts, kinds) {
  if (positions.length < 9 || indices.length < 3) throw new Error('shapes: the mesh has no triangles');
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { lo[i % 3] = Math.min(lo[i % 3], positions[i]); hi[i % 3] = Math.max(hi[i % 3], positions[i]); }
  const size = dist(lo, hi), { V, tris } = weld(positions, indices, size * 1e-4);
  const areas = tris.map(([a, b, c]) => len(cross(sub(V[b], V[a]), sub(V[c], V[a]))) / 2);
  return { V, tris, areas, size, tol: tolerance ?? size * 0.01, total: areas.reduce((s, a) => s + a, 0), opts, kinds: kinds ?? [...PRIMITIVES, 'lathe', 'extrude', 'loft'], fits: new Map() };
}

// Triangles in connected pieces (sharing welded vertices).
function components(ctx) {
  const parent = ctx.V.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b, c] of ctx.tris) { parent[find(b)] = find(a); parent[find(c)] = find(a); }
  const by = new Map();
  ctx.tris.forEach((t, i) => { const k = find(t[0]); by.set(k, [...(by.get(k) ?? []), i]); });
  return [...by.values()];
}

// A region: triangle indices, their samples and area; comp: the piece it belongs to (for the inside test).
function region(ctx, faces, comp) {
  if (!faces.length) return null;
  const tris = faces.map((i) => ctx.tris[i]), area = faces.reduce((s, i) => s + ctx.areas[i], 0);
  if (!(area > 0)) return null;
  return { faces, comp, area, samples: sampleSurface(ctx.V, tris, ctx.opts.samples), key: faces.join(',') };
}

// ---------- 2. fitting ----------

// Every candidate for a region, scored; memoised by the region's triangles.
function fit(ctx, r) {
  if (ctx.fits.has(r.key)) return ctx.fits.get(r.key);
  const tris = r.faces.map((i) => ctx.tris[i]), grid = triGrid(ctx.V, tris), shell = pieceOf(ctx, r.comp);
  const frame = frames(ctx, r, tris), tried = [];
  // A candidate that does not build (a loft scan that finds no cuts, a profile that crosses the axis) is skipped.
  const score = (make) => { try { const s = evaluate(ctx, r, grid, shell, make()); if (s) tried.push(s); } catch { /* skipped */ } };
  for (const c of primitives(ctx, r, frame)) if (ctx.kinds.includes(c.kind)) score(() => c);
  const fitsWell = tried.some((c) => c.error.rms <= ctx.tol / 2 && c.error.back <= ctx.tol);
  if (!fitsWell) {
    if (ctx.kinds.includes('lathe')) for (const a of frame.axes) score(() => latheOf(ctx, r, a, frame.centre));
    if (ctx.kinds.includes('extrude')) for (const a of [...frame.normals, ...frame.axes]) score(() => extrudeOf(ctx, tris, a, frame.centre, r));
    if (ctx.kinds.includes('loft')) for (const how of ['piece', 'march']) score(() => loftOf(ctx, tris, frame, how));
  }
  // Shapes within the tolerance first (accurate before simple), then by E.
  tried.sort((a, b) => within(ctx, b) - within(ctx, a) || a.E - b.E);
  const out = { best: tried[0], tried, grid };
  ctx.fits.set(r.key, out);
  return out;
}

// Candidate frames: the surface's principal axes (longest first) and its two main face directions (for boxes and
// extrusions).
function frames(ctx, r, tris) {
  const P = r.samples, centre = scale(P.reduce(add, [0, 0, 0]), 1 / P.length);
  const C = [0, 1, 2].map((i) => [0, 1, 2].map((j) => P.reduce((s, p) => s + (p[i] - centre[i]) * (p[j] - centre[j]), 0) / P.length));
  const axes = eigen(C);
  // Main face directions: the triangle normal shared (within 10 degrees) by the most area, then the most area square to it.
  const N = tris.map(([a, b, c]) => cross(sub(ctx.V[b], ctx.V[a]), sub(ctx.V[c], ctx.V[a]))), A = N.map(len), n = N.map((v, i) => (A[i] > 0 ? scale(v, 1 / A[i]) : null));
  const step = Math.max(1, Math.floor(n.length / 150)), cos10 = Math.cos(Math.PI / 18);
  const best = (ok) => {
    let top = null, most = 0;
    for (let i = 0; i < n.length; i += step) {
      if (!n[i] || !ok(n[i])) continue;
      let s = 0;
      for (let j = 0; j < n.length; j++) if (n[j] && Math.abs(dot(n[i], n[j])) > cos10) s += A[j];
      if (s > most) { most = s; top = n[i]; }
    }
    return top;
  };
  const n1 = best(() => true), n2 = n1 && best((v) => Math.abs(dot(v, n1)) < Math.sin(Math.PI / 18));
  const m2 = n2 && norm(sub(n2, scale(n1, dot(n1, n2)))), normals = n1 && n2 ? [n1, m2, cross(n1, m2)] : [];
  return { centre, axes, normals };
}

// Sphere, and per axis cylinder, capsule, cone; boxes on both frames.
function primitives(ctx, r, frame) {
  const out = [], P = r.samples, tol = ctx.tol;
  const s = sphereFit(P);
  if (s) out.push({ kind: 'sphere', mesh: { sphere: { radius: s.r } }, origin: s.c, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
  for (const a of frame.axes) {
    const { hs, rs, h0, h1, origin, axes } = turned(P, a, frame.centre), mid = (h) => h > h0 + 0.1 * (h1 - h0) && h < h1 - 0.1 * (h1 - h0);
    const side = rs.filter((_, i) => mid(hs[i])), height = h1 - h0;
    if (side.length < 4 || !(height > 0)) continue;
    const r0 = median(side);
    // An end with no surface across it (a joined or open end) has no cap.
    const capped = (end) => hs.some((h, i) => Math.abs(h - end) < 2 * tol + 0.02 * height && rs[i] < 0.6 * r0);
    const caps = capped(h0) ? (capped(h1) ? undefined : 'start') : capped(h1) ? 'end' : 'none';
    out.push({ kind: 'cylinder', mesh: { cylinder: { radius: r0, height, ...(caps && { caps }) } }, origin, axes });
    if (height >= 2 * r0) out.push({ kind: 'capsule', mesh: { capsule: { radius: r0, height } }, origin, axes });
    const { k, b } = lineFit(hs.filter(mid), side), ra = Math.max(0, b + k * h0), rb = Math.max(0, b + k * h1);
    if (ra + rb > 0 && Math.abs(ra - rb) > tol) out.push({ kind: 'cone', mesh: { cone: { radius: [ra, rb], height, ...(caps && { caps }) } }, origin, axes });
  }
  for (const axes of [frame.normals, frame.axes]) {
    if (axes.length < 3) continue;
    const R = [axes[0], axes[1], cross(axes[0], axes[1])], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of P) R.forEach((x, k) => { const d = dot(p, x); lo[k] = Math.min(lo[k], d); hi[k] = Math.max(hi[k], d); });
    const size = lo.map((l, k) => Math.max(hi[k] - l, tol / 10)), origin = R.reduce((o, x, k) => add(o, scale(x, (lo[k] + hi[k]) / 2)), [0, 0, 0]);
    for (const f of [0, 0.15, 0.35]) out.push({ kind: 'box', mesh: { box: { size, ...(f && { radius: (f * Math.min(...size)) / 2 }) } }, origin, axes: R });
  }
  return out;
}

// Heights along axis a and radii round it, through the centre; the frame of a shape turned about a (its y).
function turned(P, a, centre) {
  const hs = P.map((p) => dot(sub(p, centre), a)), rs = P.map((p, i) => len(sub(sub(p, centre), scale(a, hs[i]))));
  const h0 = Math.min(...hs), h1 = Math.max(...hs), x = norm(cross(Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], a));
  return { hs: hs.map((h) => h - (h0 + h1) / 2), rs, h0: (h0 - h1) / 2, h1: (h1 - h0) / 2, origin: add(centre, scale(a, (h0 + h1) / 2)), axes: [x, a, cross(x, a)] };
}

// A turned body about axis a: the wall's radius in 32 bands (the median of the points near the band's outer radius,
// so a cap's points are left out), thinned to half the tolerance.
function latheOf(ctx, r, a, centre) {
  const { hs, rs, h0, h1, origin, axes } = turned(r.samples, a, centre), B = 32, band = Array.from({ length: B }, () => []);
  hs.forEach((h, i) => band[Math.min(B - 1, Math.floor(((h - h0) / (h1 - h0)) * B))].push(rs[i]));
  const prof = band.flatMap((b, k) => { if (!b.length) return []; const top = Math.max(...b); return [[median(b.filter((x) => x > 0.8 * top)), h0 + ((k + 0.5) * (h1 - h0)) / B]]; });
  if (prof.length < 2) return null;
  const pts = douglasPeucker([[prof[0][0], h0], ...prof, [prof.at(-1)[0], h1]], ctx.tol / 2);
  return { kind: 'lathe', mesh: { lathe: { profile: pts } }, origin, axes };
}

// One outline pushed along axis a: the region cut halfway along a, its largest closed contour and those inside it.
function extrudeOf(ctx, tris, a, centre, r) {
  const hs = r.samples.map((p) => dot(sub(p, centre), a)), h0 = Math.min(...hs), h1 = Math.max(...hs);
  if (!(h1 - h0 > ctx.tol)) return null;
  const mid = add(centre, scale(a, (h0 + h1) / 2)), { contours } = cutContours(ctx.V, tris, mid, a);
  const x = norm(cross(Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], a)), y = cross(a, x);
  const loops = contours.filter((c) => c.closed).map((c) => douglasPeucker([...c.points, c.points[0]].map((p) => [dot(sub(p, mid), x), dot(sub(p, mid), y)]), ctx.tol).slice(0, -1)).filter((l) => l.length >= 3);
  if (!loops.length) return null;
  loops.sort((p, q) => Math.abs(area2(q)) - Math.abs(area2(p)));
  const holes = loops.slice(1).filter((l) => inside(l[0], loops[0]));
  return { kind: 'extrude', mesh: { extrude: { outline: loops[0], ...(holes.length && { holes }), depth: h1 - h0 } }, origin: mid, axes: [x, y, a] };
}

// The existing loft scanners (scan.js): scanPiece guided along the main axis, or scanLoft marching along the piece
// (it follows a bend). The path is moved into the frame.
function loftOf(ctx, tris, frame, how) {
  const at = new Map(), positions = [], indices = tris.flat().map((i) => { if (!at.has(i)) { at.set(i, positions.length / 3); positions.push(...ctx.V[i]); } return at.get(i); });
  const a = frame.axes[0], g = [sub(frame.centre, scale(a, ctx.size)), add(frame.centre, scale(a, ctx.size))];
  const { loft } = how === 'march' ? scanLoft(positions, indices, { tolerance: ctx.tol }) : scanPiece(positions, indices, { guide: g, tol: ctx.tol });
  return { kind: 'loft', mesh: { loft: { ...loft, path: loft.path.map((p) => sub(p, frame.centre)) } }, origin: frame.centre, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
}

// A candidate built and scored: rms and max miss from the region to it, rms back from it to the region.
function evaluate(ctx, r, grid, shell, c) {
  if (!c) return null;
  const mesh = round(c.mesh, ctx.size), g = geometry(read(docOf(mesh)).meshes[0]);
  const W = Array.from({ length: g.positions.length / 3 }, (_, i) => place(c, [g.positions[3 * i], g.positions[3 * i + 1], g.positions[3 * i + 2]]));
  const T = Array.from({ length: g.indices.length / 3 }, (_, i) => [g.indices[3 * i], g.indices[3 * i + 1], g.indices[3 * i + 2]]);
  if (!T.length) return null;
  const mine = triGrid(W, T), fwd = r.samples.map((p) => nearest(mine, p));
  const back = sampleSurface(W, T, Math.ceil(ctx.opts.samples / 2)).map((q) => { const d = nearest(grid, q); return d > ctx.tol && shell && insideShell(shell, q) ? 0 : d; });
  const ms = (fwd.reduce((s, d) => s + d * d, 0) / fwd.length + back.reduce((s, d) => s + d * d, 0) / back.length) / 2;
  const values = count(mesh), { weight, lambda, perShape } = ctx.opts;
  return {
    ...c, mesh, values, grid: mine,
    error: { rms: Math.sqrt(fwd.reduce((s, d) => s + d * d, 0) / fwd.length), max: Math.max(...fwd), back: Math.sqrt(back.reduce((s, d) => s + d * d, 0) / back.length) },
    E: (weight * (r.area / ctx.total) * ms) / ctx.tol ** 2 + lambda * values + perShape,
  };
}

const place = (c, p) => add(c.origin, add(add(scale(c.axes[0], p[0]), scale(c.axes[1], p[1])), scale(c.axes[2], p[2])));
const docOf = (mesh) => ({ asset: { version: '2.0' }, extensionsUsed: [EXT], extensions: { [EXT]: { version: VERSION, meshes: [mesh] } }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ extensions: { [EXT]: { mesh: 0 } } }] });
// The numbers a recipe holds (its complexity); `sides` and `caps` are not shape.
const count = (x, k) => (k === 'sides' ? 0 : Array.isArray(x) ? x.reduce((s, v) => s + count(v), 0) : typeof x === 'number' ? 1 : x && typeof x === 'object' ? Object.entries(x).reduce((s, [kk, v]) => s + count(v, kk), 0) : 0);
// Numbers to a thousandth of the size, as scanPiece writes them.
function round(x, size) {
  const digits = Math.max(0, -Math.floor(Math.log10(size / 1000))), r = (v) => (Array.isArray(v) ? v.map(r) : typeof v === 'number' ? +v.toFixed(digits) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, w]) => [k, r(w)])) : v);
  return r(x);
}

// ---------- 3. splitting and merging ----------

function cost(ctx, r) { return fit(ctx, r).best?.E ?? Infinity; }
// A part of a split must fit on its own: within 0.6 tol on average, and back from the shape within tol.
const fits = (ctx, r) => { const b = fit(ctx, r).best; return b && within(ctx, b); };
const within = (ctx, c) => c.error.rms <= 0.6 * ctx.tol && c.error.back <= ctx.tol;

// Top-down: the cheapest split of a region (two or more parts, each within the tolerance), kept while it costs less
// than the region whole, or whenever the whole does not fit (accurate before simple).
function splitRegion(ctx, r, depth) {
  const whole = cost(ctx, r), b = fit(ctx, r).best;
  if (depth <= 0 || r.faces.length < 8 || (PRIMITIVES.includes(b?.kind) && b.error.rms <= ctx.tol / 2 && b.error.back <= ctx.tol)) return [r]; // an obvious primitive stays whole
  let best = null;
  for (const parts of splits(ctx, r)) {
    const regions = parts.map((f) => region(ctx, f, r.comp));
    if (regions.some((q) => !q || q.faces.length < 4) || !regions.every((q) => fits(ctx, q))) continue;
    const e = regions.reduce((s, q) => s + cost(ctx, q), 0);
    if ((e < whole || !fits(ctx, r)) && (!best || e < best.e)) best = { e, regions };
  }
  if (!best) return [r];
  for (const q of best.regions) q.split = true;
  return best.regions.flatMap((q) => splitRegion(ctx, q, depth - 1));
}

// Candidate splits: [faces, faces, ...]. Peel: the triangles off the best primitive by over 2 tol, in connected
// bits of at least 2% of the region. Cuts: across the main axis at a crease loop or a jump in cross-section.
function splits(ctx, r) {
  const out = [], f = fit(ctx, r), prim = f.tried.find((c) => PRIMITIVES.includes(c.kind)) ?? f.best;
  if (prim) {
    const off = new Set(r.faces.filter((i) => nearest(prim.grid, centroid(ctx, i)) > 2 * ctx.tol));
    const bits = connected(ctx, [...off]).filter((b) => b.reduce((s, i) => s + ctx.areas[i], 0) > 0.02 * r.area && b.length >= 4);
    if (bits.length && off.size < r.faces.length) {
      const peeled = new Set(bits.flat());
      out.push([r.faces.filter((i) => !peeled.has(i)), ...bits.slice(0, 4)]);
    }
  }
  const { centre, axes } = frames(ctx, r, r.faces.map((i) => ctx.tris[i])), cos = Math.cos((ctx.opts.crease * Math.PI) / 180);
  const creases = creaseEdges(ctx, r, cos);
  for (const a of axes.slice(0, 1)) { // shortcut: cuts across the main axis only; try the others when a model needs it
    const h = (p) => dot(sub(p, centre), a), hs = r.faces.map((i) => h(centroid(ctx, i))), h0 = Math.min(...hs), h1 = Math.max(...hs);
    if (!(h1 - h0 > 4 * ctx.tol)) continue;
    const cuts = [...clusters(creases.map(([p, q]) => (h(ctx.V[p]) + h(ctx.V[q])) / 2), 2 * ctx.tol).map((c) => c + ctx.tol / 4), ...jumps(r.samples.map(h), r.samples.map((p) => len(sub(sub(p, centre), scale(a, h(p))))), ctx.tol)];
    for (const c of cuts) {
      if (c < h0 + 2 * ctx.tol || c > h1 - 2 * ctx.tol) continue;
      const A = r.faces.filter((_, k) => hs[k] < c), B = r.faces.filter((_, k) => hs[k] >= c);
      // A cut gives its sides as connected bits: a ring cut off a U makes three.
      if (A.length && B.length) out.push([...connected(ctx, A), ...connected(ctx, B)]);
    }
  }
  return out;
}

// Edges where neighbouring triangles turn more than the crease angle: [vertex, vertex] pairs.
function creaseEdges(ctx, r, cos) {
  const by = new Map(), out = [];
  for (const i of r.faces) {
    const t = ctx.tris[i];
    for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`; by.set(key, [...(by.get(key) ?? []), i]); }
  }
  const normal = (i) => { const [a, b, c] = ctx.tris[i]; return norm(cross(sub(ctx.V[b], ctx.V[a]), sub(ctx.V[c], ctx.V[a]))); };
  for (const [key, f] of by) if (f.length === 2 && dot(normal(f[0]), normal(f[1])) < cos) out.push(key.split(',').map(Number));
  return out;
}

// Heights where the outer radius (in 24 bands) steps by more than 2 tol: the two biggest steps.
function jumps(hs, rs, tol) {
  const h0 = Math.min(...hs), h1 = Math.max(...hs), B = 24, band = Array(B).fill(0);
  hs.forEach((h, i) => { const k = Math.min(B - 1, Math.floor(((h - h0) / (h1 - h0)) * B)); band[k] = Math.max(band[k], rs[i]); });
  const steps = [];
  for (let k = 1; k < B; k++) if (band[k] && band[k - 1] && Math.abs(band[k] - band[k - 1]) > 2 * tol) steps.push([Math.abs(band[k] - band[k - 1]), h0 + (k * (h1 - h0)) / B]);
  return steps.sort((a, b) => b[0] - a[0]).slice(0, 2).map((s) => s[1]);
}

// Neighbouring regions joined while one shape costs less than the two (cheapest join first).
function mergeRegions(ctx, regions) {
  for (;;) {
    const touch = adjacency(ctx, regions);
    let best = null;
    touch.forEach((ns, i) => ns.forEach((j) => {
      if (j <= i || regions[i].comp !== regions[j].comp) return;
      const u = region(ctx, [...regions[i].faces, ...regions[j].faces].sort((a, b) => a - b), regions[i].comp);
      const gain = cost(ctx, regions[i]) + cost(ctx, regions[j]) - cost(ctx, u);
      if (gain > 0 && (!best || gain > best.gain)) best = { gain, i, j, u };
    }));
    if (!best) return regions;
    best.u.split = true;
    regions = [...regions.filter((_, k) => k !== best.i && k !== best.j), best.u];
  }
}

// ---------- 4. relations ----------

function adjacency(ctx, regions) {
  const owner = new Map();
  regions.forEach((r, k) => r.faces.forEach((i) => ctx.tris[i].forEach((v) => owner.set(v, [...new Set([...(owner.get(v) ?? []), k])]))));
  const touch = regions.map(() => new Set());
  for (const ks of owner.values()) for (const a of ks) for (const b of ks) if (a !== b) touch[a].add(b);
  return touch;
}

function relate(ctx, regions) {
  const touch = adjacency(ctx, regions), order = regions.map((_, i) => i).sort((a, b) => regions[b].area - regions[a].area);
  const id = new Map(order.map((k, n) => [k, n])), shapes = [];
  for (const k of order) {
    const r = regions[k], f = fit(ctx, r), b = f.best;
    if (!b) continue;
    const parent = [...touch[k]].filter((j) => id.get(j) < id.get(k)).sort((x, y) => id.get(x) - id.get(y))[0];
    const second = f.tried.find((c) => c.kind !== b.kind);
    const verts = new Set(r.faces.flatMap((i) => ctx.tris[i]));
    shapes.push({
      id: id.get(k), kind: b.kind, mesh: b.mesh, origin: b.origin, axes: b.axes,
      triangles: r.faces.length, vertices: verts.size, error: b.error, E: b.E, values: b.values,
      confidence: second ? +((second.E - b.E) / second.E).toFixed(3) : 1, // how clearly it beat the next kind of shape
      neighbours: [...touch[k]].map((j) => id.get(j)).sort((x, y) => x - y), parent: parent === undefined ? null : id.get(parent),
      how: r.split ? 'combined' : 'alone', faces: r.faces,
    });
  }
  return { shapes, E: shapes.reduce((s, x) => s + x.E, 0), size: ctx.size, tol: ctx.tol, weldedVertices: ctx.V, weldedTris: ctx.tris };
}

// ---------- geometry helpers ----------

// n points spread over triangles by area (deterministic: stratified by area, barycentric by a low-discrepancy pair).
function sampleSurface(V, tris, n) {
  const A = tris.map(([a, b, c]) => len(cross(sub(V[b], V[a]), sub(V[c], V[a]))) / 2), total = A.reduce((s, a) => s + a, 0), out = [];
  if (!(total > 0)) return tris.map(([a]) => V[a]);
  let t = 0, acc = A[0];
  for (let k = 0; k < n; k++) {
    const at = ((k + 0.5) / n) * total;
    while (acc < at && t < tris.length - 1) acc += A[++t];
    let u = (k * 0.6180339887) % 1, v = (k * 0.7548776662) % 1;
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const [a, b, c] = tris[t];
    out.push(add(V[a], add(scale(sub(V[b], V[a]), u), scale(sub(V[c], V[a]), v))));
  }
  return out;
}

// Triangles bucketed in cubic cells (at most 24 a side), for nearest-surface queries.
function triGrid(V, tris) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const i of t) { lo = lo.map((c, k) => Math.min(c, V[i][k])); hi = hi.map((c, k) => Math.max(c, V[i][k])); }
  const cell = Math.max(dist(lo, hi) / 24, 1e-9), ix = (p) => p.map((c, k) => Math.floor((c - lo[k]) / cell)), span = ix(hi).map((c) => c + 1);
  const cells = Array.from({ length: span[0] * span[1] * span[2] }, () => null), key = (x, y, z) => (x * span[1] + y) * span[2] + z;
  tris.forEach((t, n) => {
    const P = t.map((i) => V[i]), a = ix(P.reduce((m, p) => m.map((c, k) => Math.min(c, p[k])))), b = ix(P.reduce((m, p) => m.map((c, k) => Math.max(c, p[k]))));
    for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) (cells[key(x, y, z)] ??= []).push(n);
  });
  return { V, tris, cell, cells, key, ix, span };
}

// Distance from p to the nearest triangle: shells of cells outward until the shell lies farther than the best hit.
function nearest(g, p) {
  const c = g.ix(p), S = g.span;
  let best = Infinity;
  const reach = Math.max(...S.map((s, k) => Math.max(Math.abs(c[k]), Math.abs(s - c[k])))) + 1;
  const visit = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= S[0] || y >= S[1] || z >= S[2]) return;
    const list = g.cells[g.key(x, y, z)];
    if (list) for (const n of list) { const t = g.tris[n], d = toTriangle(p, g.V[t[0]], g.V[t[1]], g.V[t[2]]); if (d < best) best = d; }
  };
  for (let r = 0; r <= reach; r++) {
    if (best < (r - 1) * g.cell) break;
    for (let x = c[0] - r; x <= c[0] + r; x++) for (let y = c[1] - r; y <= c[1] + r; y++) {
      const edge = Math.abs(x - c[0]) === r || Math.abs(y - c[1]) === r;
      if (edge) for (let z = c[2] - r; z <= c[2] + r; z++) visit(x, y, z);
      else { visit(x, y, c[2] - r); if (r) visit(x, y, c[2] + r); }
    }
  }
  return best;
}

// Point-triangle distance (Ericson, Real-Time Collision Detection 5.1.5); a triangle with no area (a pole) by its corners.
function toTriangle(p, a, b, c) {
  const d = closest(p, a, b, c);
  return Number.isNaN(d) ? Math.min(dist(p, a), dist(p, b), dist(p, c)) : d;
}
function closest(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return dist(p, add(a, scale(ab, d1 / (d1 - d3))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return dist(p, add(a, scale(ac, d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return dist(p, add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))));
  const den = 1 / (va + vb + vc);
  return dist(p, add(a, add(scale(ab, vb * den), scale(ac, vc * den))));
}

// A closed piece (every edge on two triangles) for the inside test, or null for an open one.
function pieceOf(ctx, comp) {
  ctx.shells ??= new Map();
  const k = comp[0];
  if (!ctx.shells.has(k)) {
    const edges = new Map();
    for (const i of comp) { const t = ctx.tris[i]; for (let j = 0; j < 3; j++) { const a = t[j], b = t[(j + 1) % 3], e = a < b ? `${a},${b}` : `${b},${a}`; edges.set(e, (edges.get(e) ?? 0) + 1); } }
    ctx.shells.set(k, [...edges.values()].every((n) => n === 2) ? comp.map((i) => ctx.tris[i].map((v) => ctx.V[v])) : null);
  }
  return ctx.shells.get(k);
}

// Inside a closed piece: an odd number of crossings along a fixed skew ray (Moller-Trumbore).
function insideShell(T, p) {
  const d = [0.5773, 0.5791, 0.5755];
  let n = 0;
  for (const [a, b, c] of T) {
    const e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-15) continue;
    const s = sub(p, a), u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), v = dot(d, q) / det;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, q) / det > 0) n++;
  }
  return n % 2 === 1;
}

// Sphere through points by least squares (|p|^2 = 2 c.p + k), or null when degenerate.
function sphereFit(P) {
  const M = Array.from({ length: 4 }, () => Array(5).fill(0));
  for (const p of P) { const row = [2 * p[0], 2 * p[1], 2 * p[2], 1], b = dot(p, p); for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) M[i][j] += row[i] * row[j]; M[i][4] += row[i] * b; } }
  for (let i = 0; i < 4; i++) {
    const piv = M.slice(i).reduce((m, r, k) => (Math.abs(r[i]) > Math.abs(M[m][i]) ? k + i : m), i);
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let k = 0; k < 4; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j < 5; j++) M[k][j] -= f * M[i][j]; }
  }
  const x = M.map((r, i) => r[4] / r[i]), c = x.slice(0, 3), r2 = x[3] + dot(c, c);
  return r2 > 0 ? { c, r: Math.sqrt(r2) } : null;
}

// Eigenvectors of a symmetric 3x3 matrix (Jacobi), largest eigenvalue first, as a right-handed frame.
function eigen(C) {
  const A = C.map((r) => [...r]), Q = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = c * a - s * b; A[k][q] = s * a + c * b; }
      for (let k = 0; k < 3; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = c * a - s * b; A[q][k] = s * a + c * b; }
      for (let k = 0; k < 3; k++) { const a = Q[k][p], b = Q[k][q]; Q[k][p] = c * a - s * b; Q[k][q] = s * a + c * b; }
    }
  }
  const v = [0, 1, 2].sort((i, j) => A[j][j] - A[i][i]).map((i) => [Q[0][i], Q[1][i], Q[2][i]]);
  return [v[0], v[1], cross(v[0], v[1])];
}

function connected(ctx, faces) {
  const set = new Set(faces), byV = new Map(), seen = new Set(), out = [];
  for (const i of faces) for (const v of ctx.tris[i]) byV.set(v, [...(byV.get(v) ?? []), i]);
  for (const s of faces) {
    if (seen.has(s)) continue;
    const bit = [], stack = [s];
    seen.add(s);
    while (stack.length) { const i = stack.pop(); bit.push(i); for (const v of ctx.tris[i]) for (const j of byV.get(v)) if (set.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); } }
    out.push(bit.sort((a, b) => a - b));
  }
  return out;
}

// 1D values grouped where they lie within gap of each other: the groups' means.
function clusters(xs, gap) {
  const s = [...xs].sort((a, b) => a - b), out = [];
  let g = [];
  for (const x of s) { if (g.length && x - g.at(-1) > gap) { out.push(g.reduce((a, b) => a + b) / g.length); g = []; } g.push(x); }
  if (g.length) out.push(g.reduce((a, b) => a + b) / g.length);
  return out;
}

function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts;
  let far = 0, at = 0;
  const [a, b] = [pts[0], pts.at(-1)];
  for (let i = 1; i < pts.length - 1; i++) { const d = toSegment2(pts[i], a, b); if (d > far) { far = d; at = i; } }
  return far <= tol ? [a, b] : [...douglasPeucker(pts.slice(0, at + 1), tol).slice(0, -1), ...douglasPeucker(pts.slice(at), tol)];
}
function toSegment2(p, a, b) {
  const d = [b[0] - a[0], b[1] - a[1]], l = d[0] * d[0] + d[1] * d[1], t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]);
}
function lineFit(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0), k = sxx ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx : 0;
  return { k, b: my - k * mx };
}
const area2 = (L) => L.reduce((s, p, i) => { const q = L[(i + 1) % L.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function inside(p, L) {
  let ins = false;
  for (let i = 0, j = L.length - 1; i < L.length; j = i++) if ((L[i][1] > p[1]) !== (L[j][1] > p[1]) && p[0] < ((L[j][0] - L[i][0]) * (p[1] - L[i][1])) / (L[j][1] - L[i][1]) + L[i][0]) ins = !ins;
  return ins;
}
const centroid = (ctx, i) => scale(ctx.tris[i].map((v) => ctx.V[v]).reduce(add), 1 / 3);
const median = (xs) => quantile(xs, 0.5);
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => len(sub(a, b));
const norm = (a) => { const l = len(a); return l ? scale(a, 1 / l) : a; };

// Turn a frame (axes: x, y, z columns) into a glTF quaternion [x, y, z, w].
export function frameQuat([x, y, z]) {
  const m00 = x[0], m11 = y[1], m22 = z[2], tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]; }
  return q;
}

// A scan as a JIG document: a node per shape with its recipe mesh, under its parent's node (D-172), turned and placed
// relative to it; each shape in its own colour (the segmentation at a glance). Sides 32 on round shapes.
const PALETTE = [[0.85, 0.37, 0.27], [0.25, 0.55, 0.85], [0.35, 0.7, 0.35], [0.9, 0.7, 0.2], [0.6, 0.4, 0.8], [0.2, 0.7, 0.7], [0.85, 0.45, 0.65], [0.55, 0.55, 0.55]];
export function shapesDoc({ shapes }, { source = 'a mesh' } = {}) {
  const local = (s) => {
    const p = shapes.find((q) => q.id === s.parent), R = p ? p.axes : [[1, 0, 0], [0, 1, 0], [0, 0, 1]], o = p ? p.origin : [0, 0, 0];
    const into = (v) => R.map((a) => dot(a, v)), axes = s.axes.map(into), t = into(sub(s.origin, o));
    const q = frameQuat(axes).map((c) => +c.toFixed(6));
    return { translation: t.map((c) => +c.toFixed(4)), ...(Math.abs(q[3]) < 1 - 1e-9 && { rotation: q }) };
  };
  const nodes = shapes.map((s) => ({ name: `${s.kind} ${s.id}`, extensions: { [EXT]: { mesh: s.id, ...local(s) } } }));
  shapes.forEach((s) => { if (s.parent !== null) (nodes[s.parent].children ??= []).push(s.id); });
  const round = (m) => (m.loft || m.lathe || m.cylinder || m.cone || m.sphere || m.capsule ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, sides: 32 }])) : m);
  return {
    asset: { version: '2.0', extras: { source: `Scanned from ${source} by tools/scan.mjs --shapes` } },
    extensionsUsed: [EXT],
    extensions: { [EXT]: { version: VERSION, meshes: shapes.map((s) => ({ ...round(s.mesh), material: s.id })) } },
    materials: shapes.map((s) => ({ name: `${s.kind} ${s.id}`, pbrMetallicRoughness: { baseColorFactor: [...PALETTE[s.id % PALETTE.length], 1], metallicFactor: 0, roughnessFactor: 0.7 } })),
    scene: 0, scenes: [{ nodes: shapes.filter((s) => s.parent === null).map((s) => s.id) }], nodes,
  };
}
