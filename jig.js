// JIG 0.1 reader. Pure: document + parameter values in, plain shape description out. No three.js here.

export const VERSION = '0.1';

// Read a document. `values` overrides parameter defaults by name.
// Returns { params, vars, floor, meshes, nodes } (glTF-shaped: nodes point at meshes by index) or throws an Error whose message starts with the JSON path.
export function read(doc, values = {}) {
  need(isObj(doc), '', 'document must be an object');
  only(doc, ['jig', 'params', 'vars', 'floor', 'meshes', 'nodes'], '');
  need(doc.jig === VERSION, '/jig', `must be "${VERSION}"`);

  const params = {};
  for (const [name, p] of Object.entries(doc.params ?? {})) {
    const at = `/params/${name}`;
    need(/^[a-z_][a-z0-9_]*$/.test(name), at, 'name must be lower_snake_case');
    need(isObj(p), at, 'must be an object');
    only(p, ['default', 'min', 'max'], at);
    for (const k of ['default', 'min', 'max']) need(typeof p[k] === 'number', `${at}/${k}`, 'must be a number');
    need(p.min <= p.default && p.default <= p.max, at, 'needs min <= default <= max');
    const v = values[name] ?? p.default;
    params[name] = { ...p, value: Math.min(p.max, Math.max(p.min, v)) };
  }
  const scope = Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.value]));

  // Sketch (draft f2): named expressions, in order; each sees the params and the vars before it.
  need(doc.vars === undefined || isObj(doc.vars), '/vars', 'must be an object');
  const vars = {};
  for (const [name, e] of Object.entries(doc.vars ?? {})) {
    const at = `/vars/${name}`;
    need(/^[a-z_][a-z0-9_]*$/.test(name), at, 'name must be lower_snake_case');
    need(!(name in params), at, 'name is already a parameter');
    need(!Object.hasOwn(FUNCS, name), at, 'name is a built-in function');
    vars[name] = scope[name] = num(e, scope, at);
  }

  const meshes = list(doc.meshes, '/meshes').map((m, i) => mesh(m, scope, `/meshes/${i}`));
  const nodes = list(doc.nodes, '/nodes').map((n, i) => {
    const at = `/nodes/${i}`;
    need(isObj(n), at, 'must be an object');
    only(n, ['mesh', 'translation', 'rotation', 'scale'], at);
    need(Number.isInteger(n.mesh) && n.mesh >= 0 && n.mesh < meshes.length, `${at}/mesh`, `must be a mesh index 0..${meshes.length - 1}`);
    const translation = vec(n.translation ?? [0, 0, 0], 3, scope, `${at}/translation`);
    const q = vec(n.rotation ?? [0, 0, 0, 1], 4, scope, `${at}/rotation`);
    const len = Math.hypot(...q);
    need(len > 1e-9, `${at}/rotation`, 'must not be all zero');
    const rotation = q.map((c) => c / len); // normalized (D-9), so exported glTF is unit
    const scale = vec(n.scale ?? [1, 1, 1], 3, scope, `${at}/scale`);
    return { mesh: n.mesh, translation, rotation, scale };
  });
  // y of the floor in model space; hosts stand the model there. Default: the lowest point on the vertical line
  // through the origin, or 0 when no shape crosses that line.
  const floor = doc.floor === undefined ? lowestOnAxis(meshes, nodes) : num(doc.floor, scope, '/floor');
  return { params, vars, floor, meshes, nodes };
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

// Lowest y where the line x = z = 0 enters a node's box (slab test in the box's own space).
function lowestOnAxis(meshes, nodes) {
  let low = Infinity;
  for (const n of nodes) {
    if (n.scale.some((c) => c === 0)) continue; // a flat box has no volume to stand on
    const half = meshes[n.mesh].size.map((c) => c / 2);
    // Local point = R⁻¹(world − t) / s, linear in y along the line: a + y·d.
    const a = unrotate(n.rotation, n.translation.map((c) => -c)).map((c, i) => c / n.scale[i]);
    const d = unrotate(n.rotation, [0, 1, 0]).map((c, i) => c / n.scale[i]);
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

// Rotate v by the inverse of unit quaternion q = [x, y, z, w].
function unrotate([x, y, z, w], v) {
  const u = [-x, -y, -z];
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const t = cross(u, v).map((c) => 2 * c);
  const ut = cross(u, t);
  return v.map((c, i) => c + w * t[i] + ut[i]);
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
