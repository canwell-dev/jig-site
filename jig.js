// JIG 0.1 reader and baker. Pure: a glTF document with the JIG_recipe extension + parameter values in, a plain
// shape description (read) or the baked glTF (bake) out. No three.js here.

export const VERSION = '0.1';
export const EXT = 'JIG_recipe';

// Read a document. `values` overrides parameter values by name (over baked_values, over defaults).
// Returns { params, vars, floor, meshes, nodes, instances } or throws an Error whose message starts with the
// JSON path. `meshes` are the evaluated recipe meshes; `instances` are { node, mesh, matrix } for every node of the
// default scene that draws a recipe mesh, matrix = world transform, column-major as in glTF.
export function read(doc, values = {}) {
  need(isObj(doc), '', 'document must be an object');
  need(isObj(doc.asset) && doc.asset.version === '2.0', '/asset/version', 'must be "2.0" (a glTF 2.0 document)');
  need(Array.isArray(doc.extensionsUsed) && doc.extensionsUsed.includes(EXT), '/extensionsUsed', `must list "${EXT}"`);
  need(!(Array.isArray(doc.extensionsRequired) && doc.extensionsRequired.includes(EXT)), '/extensionsRequired',
    `must not list "${EXT}", so a baked file loads in every glTF tool`);
  const rat = `/extensions/${EXT}`;
  const r = doc.extensions?.[EXT];
  need(isObj(r), rat, 'must be an object');
  only(r, ['version', 'params', 'vars', 'floor', 'meshes', 'baked_values'], rat);
  need(r.version === VERSION, `${rat}/version`, `must be "${VERSION}"`);

  need(r.params === undefined || isObj(r.params), `${rat}/params`, 'must be an object');
  const baked = r.baked_values;
  need(baked === undefined || isObj(baked), `${rat}/baked_values`, 'must be an object');
  for (const name of Object.keys(baked ?? {})) {
    if (!name.startsWith('//')) need(Object.hasOwn(r.params ?? {}, name), `${rat}/baked_values/${name}`, 'is not a parameter');
  }
  const params = {};
  for (const [name, p] of Object.entries(r.params ?? {})) {
    const at = `${rat}/params/${name}`;
    need(/^[a-z_][a-z0-9_]*$/.test(name), at, 'name must be lower_snake_case');
    need(isObj(p), at, 'must be an object');
    only(p, ['default', 'min', 'max'], at);
    for (const k of ['default', 'min', 'max']) need(typeof p[k] === 'number', `${at}/${k}`, 'must be a number');
    need(p.min <= p.default && p.default <= p.max, at, 'needs min <= default <= max');
    if (baked) need(typeof baked[name] === 'number', `${rat}/baked_values/${name}`, 'must be a number (baked_values holds every parameter)');
    const v = values[name] ?? baked?.[name] ?? p.default;
    params[name] = { ...p, value: Math.min(p.max, Math.max(p.min, v)) };
  }
  const scope = Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.value]));

  // Sketch (draft f2): named expressions, in order; each sees the params and the vars before it.
  need(r.vars === undefined || isObj(r.vars), `${rat}/vars`, 'must be an object');
  const vars = {};
  for (const [name, e] of Object.entries(r.vars ?? {})) {
    if (name.startsWith('//')) continue;
    const at = `${rat}/vars/${name}`;
    need(/^[a-z_][a-z0-9_]*$/.test(name), at, 'name must be lower_snake_case');
    need(!(name in params), at, 'name is already a parameter');
    need(!Object.hasOwn(FUNCS, name), at, 'name is a built-in function');
    vars[name] = scope[name] = num(e, scope, at);
  }

  const meshes = list(r.meshes, `${rat}/meshes`).map((m, i) => mesh(m, scope, `${rat}/meshes/${i}`));

  need(doc.nodes === undefined || Array.isArray(doc.nodes), '/nodes', 'must be a list');
  const nodes = (doc.nodes ?? []).map((n, i) => node(n, meshes.length, scope, `/nodes/${i}`));

  // The default scene's tree, with world matrices. glTF: a node sits in one tree, at most once.
  need(Array.isArray(doc.scenes) && doc.scenes.length > 0, '/scenes', 'must be a non-empty list');
  need(Number.isInteger(doc.scene) && doc.scene >= 0 && doc.scene < doc.scenes.length, '/scene', 'must be a scene index');
  const roots = doc.scenes[doc.scene]?.nodes ?? [];
  need(Array.isArray(roots), `/scenes/${doc.scene}/nodes`, 'must be a list');
  const instances = [], seen = new Set();
  const visit = (i, parent, at) => {
    need(Number.isInteger(i) && i >= 0 && i < nodes.length, at, 'must be a node index');
    need(!seen.has(i), at, `node ${i} is used twice in the scene`);
    seen.add(i);
    const world = mul(parent, nodes[i].matrix);
    if (nodes[i].mesh !== undefined) instances.push({ node: i, mesh: nodes[i].mesh, matrix: world });
    nodes[i].children.forEach((c, j) => visit(c, world, `/nodes/${i}/children/${j}`));
  };
  roots.forEach((i, j) => visit(i, IDENTITY, `/scenes/${doc.scene}/nodes/${j}`));

  // y of the floor in model space; hosts stand the model there. Default: the lowest point on the vertical line
  // through the origin, or 0 when no shape crosses that line.
  const floor = r.floor === undefined ? lowestOnAxis(meshes, instances) : num(r.floor, scope, `${rat}/floor`);
  return { params, vars, floor, meshes, nodes, instances };
}

// A glTF node. Its JIG_recipe may set mesh, translation, rotation and scale; the core slots with a twin there
// are the bake's cache (D-14) and are ignored here. Other core slots are plain glTF.
function node(n, meshCount, scope, at) {
  need(isObj(n), at, 'must be an object');
  const xat = `${at}/extensions/${EXT}`;
  const x = n.extensions?.[EXT] ?? {};
  need(isObj(x), xat, 'must be an object');
  only(x, ['mesh', 'translation', 'rotation', 'scale'], xat);
  if (x.mesh !== undefined) {
    need(Number.isInteger(x.mesh) && x.mesh >= 0 && x.mesh < meshCount, `${xat}/mesh`, `must be a recipe mesh index 0..${meshCount - 1}`);
  }
  if (n.matrix !== undefined) {
    need(['translation', 'rotation', 'scale'].every((k) => x[k] === undefined), `${at}/matrix`,
      `a node with a matrix cannot take translation, rotation or scale from ${EXT}`);
    need(Array.isArray(n.matrix) && n.matrix.length === 16 && n.matrix.every((c) => typeof c === 'number'), `${at}/matrix`, 'must be a list of 16 numbers');
  }
  const pick = (k, size, dflt) => {
    if (x[k] !== undefined) return vec(x[k], size, scope, `${xat}/${k}`);
    if (n[k] === undefined) return dflt;
    need(Array.isArray(n[k]) && n[k].length === size && n[k].every((c) => typeof c === 'number'), `${at}/${k}`, `must be a list of ${size} numbers`);
    return n[k];
  };
  const translation = pick('translation', 3, [0, 0, 0]);
  let rotation = pick('rotation', 4, [0, 0, 0, 1]);
  if (x.rotation !== undefined) {
    const len = Math.hypot(...rotation);
    need(len > 1e-9, `${xat}/rotation`, 'must not be all zero');
    rotation = rotation.map((c) => c / len); // normalized (D-9), so the baked glTF is unit
  }
  const scale = pick('scale', 3, [1, 1, 1]);
  const children = n.children ?? [];
  need(Array.isArray(children), `${at}/children`, 'must be a list');
  return { mesh: x.mesh, translation, rotation, scale, matrix: n.matrix ?? compose(translation, rotation, scale), children, jig: x };
}

function mesh(m, scope, at) {
  need(isObj(m), at, 'must be an object');
  only(m, ['box', 'loft'], at);
  need(Object.keys(m).filter((k) => !k.startsWith('//')).length === 1, at, 'must have one shape: box or loft');
  if (m.loft !== undefined) return loft(m.loft, scope, `${at}/loft`);
  const b = m.box;
  at += '/box';
  need(isObj(b), at, 'must be an object');
  only(b, ['size'], at);
  const size = vec(b.size, 3, scope, `${at}/size`);
  size.forEach((s, i) => need(s > 0, `${at}/size/${i}`, `must be > 0, is ${s}`));
  return { type: 'box', size }; // centred on the origin
}

// --- Bake (D-11, D-14..D-17, D-23) ---

const OWNED = ['meshes', 'accessors', 'bufferViews', 'buffers'];
const isBaked = (o) => o?.extensions?.[EXT]?.baked === true;

// Remove the bake's cache: every item marked baked, and the core node slots that have a twin in JIG_recipe.
// Returns a new document; the input is not changed.
export function strip(doc) {
  const d = structuredClone(doc);
  for (const k of OWNED) {
    if (!Array.isArray(d[k])) continue;
    const first = d[k].findIndex(isBaked);
    if (first < 0) continue;
    const late = d[k].findIndex((o, i) => i > first && !isBaked(o));
    need(late < 0, `/${k}/${late}`, 'baked items must come after all other items (D-17)');
    d[k] = d[k].slice(0, first);
    if (!d[k].length) delete d[k];
  }
  for (const n of Array.isArray(d.nodes) ? d.nodes : []) {
    const x = n?.extensions?.[EXT];
    if (isObj(x)) for (const k of ['mesh', 'translation', 'rotation', 'scale']) if (x[k] !== undefined) delete n[k];
  }
  return d;
}

// Bake at `values` (over baked_values, over defaults). Returns { gltf, bin }: gltf is the document with a fresh
// cache and baked_values; bin is the buffer's bytes. The buffer is embedded as a data URI unless `uri` names a
// separate file (D-23). The same document and values give the same bytes (D-15).
export function bake(doc, values = {}, { uri } = {}) {
  const d = strip(doc);
  const out = read(d, values);
  d.extensions[EXT].baked_values = Object.fromEntries(Object.entries(out.params).map(([k, p]) => [k, p.value]));

  const base = Object.fromEntries(OWNED.map((k) => [k, d[k]?.length ?? 0]));
  const add = (k, item) => (d[k] ??= []).push({ ...item, extensions: { [EXT]: { baked: true } } }) - 1;
  const chunks = [];
  let offset = 0;
  const view = (array, target) => {
    const bytes = new Uint8Array(array.buffer);
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4); // keep every view 4-byte aligned
    padded.set(bytes);
    chunks.push(padded);
    const i = add('bufferViews', { buffer: base.buffers, byteOffset: offset, byteLength: bytes.byteLength, target });
    offset += padded.byteLength;
    return i;
  };
  for (const m of out.meshes) {
    const { positions, normals, indices: all } = geometry(m);
    const short = positions.length / 3 <= 65536;
    const indices = short ? Uint16Array.from(all) : all;
    const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
    const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
    const pos = add('accessors', { bufferView: view(positions, 34962), componentType: 5126, count: positions.length / 3,
      type: 'VEC3', min, max });
    const nor = add('accessors', { bufferView: view(normals, 34962), componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
    add('meshes', { primitives: [{ attributes: { POSITION: pos, NORMAL: nor }, indices: idx }] });
  }
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.byteLength; }
  add('buffers', { byteLength: bin.byteLength, uri: uri ?? `data:application/octet-stream;base64,${base64(bin)}` });

  for (const [i, n] of out.nodes.entries()) {
    if (n.jig.mesh !== undefined) d.nodes[i].mesh = base.meshes + n.jig.mesh;
    for (const k of ['translation', 'rotation', 'scale']) if (n.jig[k] !== undefined) d.nodes[i][k] = n[k];
  }
  return { gltf: d, bin };
}

// Triangles of a recipe mesh: { positions, normals, indices } (Float32Array, Float32Array, Uint32Array).
export function geometry(m) {
  if (m.type === 'loft') return loftGeometry(m);
  const g = boxGeometry(m.size);
  return { ...g, indices: Uint32Array.from(g.indices) };
}

// Box centred on the origin: 6 faces x 4 corners, outward normals, counter-clockwise seen from outside.
function boxGeometry(size) {
  const positions = [], normals = [], indices = [];
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const u = (a + 1) % 3, v = (a + 2) % 3, first = positions.length / 3;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // counter-clockwise around +a, since u x v = a
    if (s < 0) corners.reverse();
    for (const [cu, cv] of corners) {
      const p = [0, 0, 0], n = [0, 0, 0];
      p[a] = (s * size[a]) / 2; p[u] = (cu * size[u]) / 2; p[v] = (cv * size[v]) / 2; n[a] = s;
      positions.push(...p); normals.push(...n);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint16Array(indices) };
}

function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// The one JSON layout for documents and bakes (D-15): anything that fits in 90 columns goes on one line.
export function stringify(v, indent = '') {
  const one = oneLine(v);
  if (v === null || typeof v !== 'object' || indent.length + one.length <= 90) return one;
  const inner = indent + '  ';
  const items = Array.isArray(v)
    ? v.map((x) => inner + stringify(x, inner))
    : Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${stringify(x, inner)}`);
  return Array.isArray(v) ? `[\n${items.join(',\n')}\n${indent}]` : `{\n${items.join(',\n')}\n${indent}}`;
}
function oneLine(v) {
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const e = Object.entries(v);
  return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`).join(', ')} }` : '{}';
}

// --- Geometry helpers ---

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// glTF TRS to a column-major matrix: scale, then rotation, then translation.
export function compose(t, [x, y, z, w], s) {
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function mul(a, b) {
  const m = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) m[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return m;
}

// Lowest y where the line x = z = 0 enters an instance's shape: a slab test in a box's own space, the
// triangles for other shapes.
function lowestOnAxis(meshes, instances) {
  let low = Infinity;
  for (const { mesh: mi, matrix: m } of instances) {
    if (meshes[mi].type !== 'box') { low = Math.min(low, lowestOnTriangles(geometry(meshes[mi]), m)); continue; }
    // Local point = A⁻¹(world − t), linear in y along the line: a + y·d. A is the matrix's 3x3 part.
    const inv = inverse3([0, 1, 2].map((r) => [0, 1, 2].map((c) => m[c * 4 + r])));
    if (!inv) continue; // a flat box has no volume to stand on
    const t = [m[12], m[13], m[14]];
    const a = inv.map((row) => -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]));
    const d = inv.map((row) => row[1]);
    const half = meshes[mi].size.map((c) => c / 2);
    let lo = -Infinity, hi = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) { if (Math.abs(a[i]) > half[i]) lo = Infinity; continue; }
      const [t0, t1] = [(-half[i] - a[i]) / d[i], (half[i] - a[i]) / d[i]].sort((p, q) => p - q);
      lo = Math.max(lo, t0); hi = Math.min(hi, t1);
    }
    if (lo <= hi) low = Math.min(low, lo);
  }
  return low === Infinity ? 0 : low;
}

function lowestOnTriangles({ positions: p, indices }, m) {
  const w = (i) => [0, 1, 2].map((r) => m[r] * p[3 * i] + m[4 + r] * p[3 * i + 1] + m[8 + r] * p[3 * i + 2] + m[12 + r]);
  let low = Infinity;
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]].map(w);
    // Barycentric coordinates of x = z = 0 in the triangle's shadow on the xz plane.
    const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(det) < 1e-15) continue;
    const u = (-a[0] * (c[2] - a[2]) + (c[0] - a[0]) * a[2]) / det;
    const v = (-(b[0] - a[0]) * a[2] + a[0] * (b[2] - a[2])) / det;
    if (u >= 0 && v >= 0 && u + v <= 1) low = Math.min(low, a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]));
  }
  return low;
}

function inverse3([[a, b, c], [d, e, f], [g, h, i]]) {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

// --- Loft (sketch, draft f4) ---
// { path: [[x, y, z], ...], sections: [{ t, points: [[u, v], ...], twist }, ...], sides, steps, blend }. The surface
// runs the whole curve through `path`; t is the fraction of the curve's length. Every section has the same number
// of points and point k meets point k (D-34). Between sections the points, handles and twist blend linearly or
// smoothly (`blend`); before the first and after the last section the shape holds. Both ends are capped.

function loft(l, scope, at) {
  need(isObj(l), at, 'must be an object');
  only(l, ['path', 'sections', 'sides', 'steps', 'blend'], at);
  const path = list(l.path, `${at}/path`).map((p, i) => vec(p, 3, scope, `${at}/path/${i}`));
  need(path.length >= 2, `${at}/path`, 'needs at least 2 points');
  path.forEach((p, i) => need(i === 0 || dist(p, path[i - 1]) > 1e-9, `${at}/path/${i}`, 'repeats the point before it'));
  const sections = list(l.sections, `${at}/sections`).map((s, i) => {
    const sat = `${at}/sections/${i}`;
    need(isObj(s), sat, 'must be an object');
    only(s, ['t', 'points', 'twist'], sat);
    const t = num(s.t, scope, `${sat}/t`);
    need(t >= 0 && t <= 1, `${sat}/t`, `must be in 0..1, is ${t}`);
    const pts = list(s.points, `${sat}/points`).map((p, j) => {
      const pat = `${sat}/points/${j}`;
      need(Array.isArray(p) && (p.length === 2 || p.length === 4), pat, 'must be [u, v] or [u, v, hu, hv]');
      return p.map((e, k) => num(e, scope, `${pat}/${k}`));
    });
    need(pts.length >= 3, `${sat}/points`, 'needs at least 3 points');
    need(Math.abs(area(outline(pts))) > 1e-12, `${sat}/points`, 'must enclose an area');
    return { t, points: pts, twist: s.twist === undefined ? 0 : num(s.twist, scope, `${sat}/twist`) };
  });
  sections.forEach((s, i) => {
    const sat = `${at}/sections/${i}/points`;
    need(s.points.length === sections[0].points.length, sat, `must have ${sections[0].points.length} points, as section 0 has`);
    need(Math.sign(area(outline(s.points))) === Math.sign(area(outline(sections[0].points))), sat, 'must wind the same way as section 0');
  });
  // Rounded, then clamped (D-37), so a quality parameter can drive them.
  const int = (k, dflt, lo, hi) => Math.min(hi, Math.max(lo, Math.round(l[k] === undefined ? dflt : num(l[k], scope, `${at}/${k}`))));
  const blend = l.blend ?? 'linear';
  need(BLEND.includes(blend), `${at}/blend`, `must be one of ${BLEND.map((x) => `"${x}"`).join(', ')}`);
  return { type: 'loft', path, sections, sides: int('sides', 24, 3, 256), steps: int('steps', 48, 1, 1024), blend };
}

const BLEND = ['linear', 'smooth'];
const SAMPLES = 32; // curve samples per path segment

// Dense samples along the curve: { t, p, x, y, z, segment }; z is the tangent, x and y the section's axes.
// y starts as world up made square to the curve (-z when the curve starts vertical) and is carried along
// without twist. Centripetal Catmull-Rom through the path, its ends extended by reflection.
export function loftCurve(m) {
  const P = m.path, n = P.length;
  const ext = [sub(scale(P[0], 2), P[1]), ...P, sub(scale(P[n - 1], 2), P[n - 2])];
  const pts = [], seg = [];
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < SAMPLES; k++) { pts.push(catmullRom(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], k / SAMPLES)); seg.push(i); }
  }
  pts.push(P[n - 1]); seg.push(n - 2);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + dist(pts[i], pts[i - 1]));
  const total = len[len.length - 1];
  let y;
  return pts.map((p, i) => {
    const z = norm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
    if (!y) y = Math.abs(z[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
    y = norm(sub(y, scale(z, dot(y, z))));
    return { t: len[i] / total, p, x: cross(y, z), y, z, segment: seg[i] };
  });
}

// The curve's point and axes at t, between the dense samples.
export function loftFrame(curve, t) {
  let i = 1;
  while (i < curve.length - 1 && curve[i].t < t) i++;
  const a = curve[i - 1], b = curve[i], f = b.t > a.t ? Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1) : 0;
  const lerp = (u, v) => u.map((c, k) => c + (v[k] - c) * f);
  const z = norm(lerp(a.z, b.z)), y0 = lerp(a.y, b.y), y = norm(sub(y0, scale(z, dot(y0, z))));
  return { p: lerp(a.p, b.p), x: cross(y, z), y, z };
}

function loftGeometry(m) {
  const curve = loftCurve(m), sorted = [...m.sections].sort((a, b) => a.t - b.t);
  const spans = edgeSpans(sorted, m.sides), n = spans.reduce((a, b) => a + b, 0);
  const ccw = area(outline(sorted[0].points)) > 0;
  const ts = [...new Set([...Array.from({ length: m.steps + 1 }, (_, i) => i / m.steps), ...sorted.map((s) => s.t)])].sort((a, b) => a - b);
  const shapeAt = (t) => {
    const { points, twist } = blendAt(sorted, m.blend, t), ring = turn(resample(points, spans), twist);
    return ccw ? ring : [ring[0], ...ring.slice(1).reverse()]; // counter-clockwise, so the surface faces out
  };
  const positions = [], indices = [];
  const frames = ts.map((t) => loftFrame(curve, t));
  ts.forEach((t, r) => {
    const { p, x, y } = frames[r];
    for (const [u, v] of shapeAt(t)) positions.push(...[0, 1, 2].map((a) => p[a] + u * x[a] + v * y[a]));
  });
  for (let r = 0; r < ts.length - 1; r++) for (let j = 0; j < n; j++) {
    const a = r * n + j, a1 = r * n + ((j + 1) % n), b = a + n, b1 = a1 + n;
    indices.push(a, a1, b1, a, b1, b);
  }
  // Smooth normals on the side: area-weighted face normals summed per vertex.
  const at = (i) => positions.slice(3 * i, 3 * i + 3);
  const normals = new Array(positions.length).fill(0);
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]];
    const f = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    for (const i of [a, b, c]) for (let q = 0; q < 3; q++) normals[3 * i + q] += f[q];
  }
  for (let i = 0; i < normals.length; i += 3) normals.splice(i, 3, ...norm(normals.slice(i, i + 3)));
  // Flat caps: a fan from the ring's centre, facing back at the start and forward at the end.
  for (const [r, s] of [[0, -1], [ts.length - 1, 1]]) {
    const first = positions.length / 3, ring = Array.from({ length: n }, (_, j) => at(r * n + j));
    const c = [0, 1, 2].map((a) => ring.reduce((sum, p) => sum + p[a], 0) / n);
    for (const p of [c, ...ring]) { positions.push(...p); normals.push(...scale(frames[r].z, s)); }
    for (let j = 0; j < n; j++) {
      const a = first + 1 + j, b = first + 1 + ((j + 1) % n);
      indices.push(...(s < 0 ? [first, b, a] : [first, a, b]));
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

const CURVE_STEPS = 16; // polygon edges per bezier edge

// A section's closed outline as a polygon, starting at its point 0. A point [u, v] is a corner; [u, v, hu, hv]
// is smooth, with bezier handles at (u, v) ± (hu, hv). An edge with a smooth end is a cubic bezier.
export const outline = (pts) => flatten(pts).poly;

// The outline, and where each point starts in it.
function flatten(pts) {
  const out = [], starts = [];
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    starts.push(out.length);
    out.push([a[0], a[1]]);
    if (a.length < 4 && b.length < 4) return;
    const c1 = [a[0] + (a[2] ?? 0), a[1] + (a[3] ?? 0)], c2 = [b[0] - (b[2] ?? 0), b[1] - (b[3] ?? 0)];
    for (let k = 1; k < CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, s = 1 - t;
      out.push([0, 1].map((q) => s * s * s * a[q] + 3 * s * s * t * c1[q] + 3 * s * t * t * c2[q] + t * t * t * b[q]));
    }
  });
  return { poly: out, starts };
}

// Section points as [u, v, hu, hv] (a corner has zero handles), and twist, at t: held before the first and after the
// last section; between them blended linearly or by centripetal Catmull-Rom over the sections (D-35, D-41, D-42).
function blendAt(sorted, blend, t) {
  const n = sorted.length, j = sorted.findIndex((s) => s.t > t);
  const full = (s) => s.points.flatMap((p) => [p[0], p[1], p[2] ?? 0, p[3] ?? 0]).concat([s.twist]);
  const out = (v) => ({ points: Array.from({ length: (v.length - 1) / 4 }, (_, k) => v.slice(4 * k, 4 * k + 4)), twist: v[v.length - 1] });
  if (j <= 0) return out(full(sorted[j < 0 ? n - 1 : 0]));
  const f = (t - sorted[j - 1].t) / (sorted[j].t - sorted[j - 1].t);
  // Shape and twist in separate curves: their units differ, and each gets its own centripetal knots.
  const part = (i, tw) => { const v = full(sorted[i]); return tw ? v.slice(-1) : v.slice(0, -1); };
  const at = (i, tw) => {
    if (i >= 0 && i < n) return part(i, tw);
    const [e, inner] = i < 0 ? [0, 1] : [n - 1, n - 2]; // ends extended by reflection, as the path
    return part(e, tw).map((c, q) => 2 * c - part(inner, tw)[q]);
  };
  const mix = (tw) => (blend === 'smooth'
    ? catmullRom(at(j - 2, tw), at(j - 1, tw), at(j, tw), at(j + 1, tw), f)
    : at(j - 1, tw).map((c, q) => c + (at(j, tw)[q] - c) * f));
  return out([...mix(false), ...mix(true)]);
}

// Points per edge: `sides` in all, each edge by its mean share of the perimeter over the sections (at least 1).
function edgeSpans(sections, sides) {
  const shares = sections.map((s) => { const L = edges(s.points).map(polyLength), sum = L.reduce((a, b) => a + b, 0); return L.map((x) => x / sum); });
  // + 1e-9: equal spans round alike despite float error (a quarter of 6 is 1.5 or 1.4999...).
  return shares[0].map((_, e) => Math.max(1, Math.round((sides * shares.reduce((a, s) => a + s[e], 0)) / shares.length + 1e-9)));
}

// Each edge (point k to point k + 1) as an open polyline from its start to its end.
function edges(pts) {
  const { poly, starts } = flatten(pts);
  return starts.map((s, k) => poly.slice(s, starts[k + 1] ?? poly.length).concat([poly[starts[k + 1] ?? 0]]));
}

const polyLength = (poly) => poly.reduce((a, p, i) => (i ? a + dist(p, poly[i - 1]) : 0), 0);

// The ring: edge e gets spans[e] points, evenly by length, starting at its point.
function resample(pts, spans) {
  return edges(pts).flatMap((poly, e) => {
    const cum = [0];
    for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i], poly[i - 1]));
    return Array.from({ length: spans[e] }, (_, k) => {
      const d = (k / spans[e]) * cum[cum.length - 1];
      let i = 0;
      while (i < poly.length - 2 && cum[i + 1] < d) i++;
      const len = cum[i + 1] - cum[i], g = len ? (d - cum[i]) / len : 0;
      return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * g, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * g];
    });
  });
}

// 2D points turned by deg degrees, from +u toward +v.
export function turn(pts, deg) {
  if (!deg) return pts;
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return pts.map(([u, v]) => [u * c - v * s, u * s + v * c]);
}

// The loft's section at t, for a new section that keeps the shape: { points, twist }. A point stays a corner when
// it is a corner in the sections around t.
export function sectionAt(m, t) {
  const sorted = [...m.sections].sort((a, b) => a.t - b.t), j = sorted.findIndex((s) => s.t > t);
  const around = j < 0 ? [sorted[sorted.length - 1]] : j === 0 ? [sorted[0]] : [sorted[j - 1], sorted[j]];
  const { points, twist } = blendAt(sorted, m.blend, t);
  return { points: points.map((p, k) => (around.every((s) => s.points[k].length === 2) ? p.slice(0, 2) : p)), twist };
}

// Barry-Goldman form, alpha = 0.5; u in 0..1 runs from p1 to p2.
// A knot gap of 0 (two equal sections) counts as tiny, so the blend holds still there.
function catmullRom(p0, p1, p2, p3, u) {
  const k = (a, b) => Math.sqrt(dist(a, b)) || 1e-9;
  const t1 = k(p0, p1), t2 = t1 + k(p1, p2), t3 = t2 + k(p2, p3);
  const t = t1 + u * (t2 - t1);
  const L = (a, b, ta, tb) => a.map((c, i) => ((tb - t) * c + (t - ta) * b[i]) / (tb - ta));
  const a1 = L(p0, p1, 0, t1), a2 = L(p1, p2, t1, t2), a3 = L(p2, p3, t2, t3);
  return L(L(a1, a2, 0, t2), L(a2, a3, t1, t3), t1, t2);
}

// Signed area of a closed 2D polygon, > 0 when counter-clockwise.
const area = (pts) => pts.reduce((a, p, j) => { const q = pts[(j + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const sub = (a, b) => a.map((c, i) => c - b[i]);
const scale = (a, s) => a.map((c) => c * s);
const dot = (a, b) => a.reduce((s, c, i) => s + c * b[i], 0);
const dist = (a, b) => Math.hypot(...sub(a, b));
const norm = (a) => { const l = Math.hypot(...a); return l > 1e-12 ? scale(a, 1 / l) : a; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// [x, y, z] or [x, y, z, w] of numbers or expressions.
function vec(v, n, scope, at) {
  need(Array.isArray(v) && v.length === n, at, `must be a list of ${n}`);
  return v.map((e, i) => num(e, scope, `${at}/${i}`));
}

function list(x, at) { need(Array.isArray(x) && x.length > 0, at, 'must be a non-empty list'); return x; }

// A number, or a string expression over parameters: + - * / ( ), numbers and GLSL scalar functions.
function num(e, scope, at) {
  if (typeof e === 'number') return e;
  need(typeof e === 'string', at, 'must be a number or an expression string');
  try { return evaluate(e, scope); } catch (err) { throw new Error(`${at}: ${err.message}`); }
}

export function evaluate(src, scope) {
  const toks = src.match(/\d+\.?\d*|\.\d+|[a-z_][a-z0-9_]*|[-+*/(),]|\S/gi) ?? [];
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  const atom = () => {
    const t = take();
    if (t === undefined) throw new Error(`"${src}": ends too early`);
    if (t === '(') { const v = sum(); if (take() !== ')') throw new Error(`"${src}": missing )`); return v; }
    if (t === '-') return -atom();
    if (/^[\d.]/.test(t)) return Number(t);
    if (/^[a-z_]/i.test(t)) {
      if (peek() === '(') return call(t);
      if (!(t in scope)) throw new Error(`"${src}": unknown name "${t}"`);
      return scope[t];
    }
    throw new Error(`"${src}": unexpected "${t}"`);
  };
  const call = (name) => {
    const f = Object.hasOwn(FUNCS, name) ? FUNCS[name] : undefined;
    if (!f) throw new Error(`"${src}": unknown function "${name}"`);
    take(); // (
    const args = [];
    if (peek() !== ')') do args.push(sum()); while (peek() === ',' && take());
    if (take() !== ')') throw new Error(`"${src}": missing ) after ${name}(`);
    const arity = name === 'atan' ? [1, 2] : [f.length];
    if (!arity.includes(args.length)) throw new Error(`"${src}": ${name} takes ${arity.join(' or ')} arguments, got ${args.length}`);
    return f(...args);
  };
  const product = () => { let v = atom(); while (peek() === '*' || peek() === '/') v = take() === '*' ? v * atom() : v / atom(); return v; };
  const sum = () => { let v = product(); while (peek() === '+' || peek() === '-') v = take() === '+' ? v + product() : v - product(); return v; };
  const v = sum();
  if (i < toks.length) throw new Error(`"${src}": unexpected "${toks[i]}"`);
  if (!Number.isFinite(v)) throw new Error(`"${src}": is not a finite number`);
  return v;
}

// GLSL ES built-ins on scalars, with GLSL's definitions (mod floors, step is edge <= x).
const FUNCS = {
  abs: Math.abs, sign: Math.sign, floor: Math.floor, ceil: Math.ceil, fract: (x) => x - Math.floor(x),
  mod: (x, y) => x - y * Math.floor(x / y), min: Math.min, max: Math.max,
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi), mix: (a, b, t) => a * (1 - t) + b * t,
  step: (edge, x) => (x < edge ? 0 : 1),
  smoothstep: (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); },
  sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, exp2: (x) => 2 ** x, log2: Math.log2,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: (y, x) => (x === undefined ? Math.atan(y) : Math.atan2(y, x)),
  radians: (d) => (d * Math.PI) / 180, degrees: (r) => (r * 180) / Math.PI,
};

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function need(ok, at, msg) { if (!ok) throw new Error(`${at || '/'}: ${msg}`); }
function only(o, keys, at) {
  for (const k of Object.keys(o)) need(keys.includes(k) || k.startsWith('//'), `${at}/${k}`, 'unknown key');
}
