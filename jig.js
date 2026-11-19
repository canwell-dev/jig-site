// JIG 0.1 reader and baker. Pure: a glTF document with the JIG_recipe extension + parameter values in, a plain
// shape description (read) or the baked glTF (bake) out. No three.js here.

export const VERSION = '0.1';
export const EXT = 'JIG_recipe';

// Read a document. `values` overrides parameter values by name (over baked_values, over defaults).
// Returns { params, vars, floor, meshes, nodes, instances } or throws an Error whose message starts with the
// JSON path. `meshes` are the evaluated recipe meshes; `instances` are { mesh, matrix } for every node of the
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
    if (nodes[i].mesh !== undefined) instances.push({ mesh: nodes[i].mesh, matrix: world });
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
  only(m, ['box'], at);
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
    chunks.push(bytes);
    const i = add('bufferViews', { buffer: base.buffers, byteOffset: offset, byteLength: bytes.byteLength, target });
    offset += bytes.byteLength; // every chunk is a multiple of 4 bytes, so views stay aligned
    return i;
  };
  for (const m of out.meshes) {
    const { positions, normals, indices } = boxGeometry(m.size);
    const half = m.size.map((c) => Math.fround(c / 2));
    const pos = add('accessors', { bufferView: view(positions, 34962), componentType: 5126, count: positions.length / 3,
      type: 'VEC3', min: half.map((c) => -c), max: half });
    const nor = add('accessors', { bufferView: view(normals, 34962), componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const idx = add('accessors', { bufferView: view(indices, 34963), componentType: 5123, count: indices.length, type: 'SCALAR' });
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
function compose(t, [x, y, z, w], s) {
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function mul(a, b) {
  const m = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) m[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return m;
}

// Lowest y where the line x = z = 0 enters an instance's box (slab test in the box's own space).
function lowestOnAxis(meshes, instances) {
  let low = Infinity;
  for (const { mesh: mi, matrix: m } of instances) {
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

function inverse3([[a, b, c], [d, e, f], [g, h, i]]) {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

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
