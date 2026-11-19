// JIG 0.1 reader. Pure: document + parameter values in, plain shape description out. No three.js here.

export const VERSION = '0.1';

// Read a document. `values` overrides parameter defaults by name.
// Returns { params, shape } or throws an Error whose message starts with the JSON path.
export function read(doc, values = {}) {
  need(isObj(doc), '', 'document must be an object');
  only(doc, ['jig', 'params', 'box'], '');
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

  need(isObj(doc.box), '/box', 'must be an object');
  only(doc.box, ['size', 'color'], '/box');
  need(Array.isArray(doc.box.size) && doc.box.size.length === 3, '/box/size', 'must be [x, y, z]');
  const size = doc.box.size.map((e, i) => num(e, scope, `/box/size/${i}`));
  size.forEach((s, i) => need(s > 0, `/box/size/${i}`, `must be > 0, is ${s}`));
  const color = doc.box.color ?? '#cccccc';
  need(/^#[0-9a-f]{6}$/i.test(color), '/box/color', 'must be "#rrggbb"');

  return { params, shape: { type: 'box', size, color } };
}

// A number, or a string expression over parameters: + - * / ( ) and numbers.
function num(e, scope, at) {
  if (typeof e === 'number') return e;
  need(typeof e === 'string', at, 'must be a number or an expression string');
  try { return evaluate(e, scope); } catch (err) { throw new Error(`${at}: ${err.message}`); }
}

export function evaluate(src, scope) {
  const toks = src.match(/\d+\.?\d*|\.\d+|[a-z_][a-z0-9_]*|[-+*/()]|\S/gi) ?? [];
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  const atom = () => {
    const t = take();
    if (t === undefined) throw new Error(`"${src}": ends too early`);
    if (t === '(') { const v = sum(); if (take() !== ')') throw new Error(`"${src}": missing )`); return v; }
    if (t === '-') return -atom();
    if (/^[\d.]/.test(t)) return Number(t);
    if (/^[a-z_]/i.test(t)) {
      if (!(t in scope)) throw new Error(`"${src}": unknown name "${t}"`);
      return scope[t];
    }
    throw new Error(`"${src}": unexpected "${t}"`);
  };
  const product = () => { let v = atom(); while (peek() === '*' || peek() === '/') v = take() === '*' ? v * atom() : v / atom(); return v; };
  const sum = () => { let v = product(); while (peek() === '+' || peek() === '-') v = take() === '+' ? v + product() : v - product(); return v; };
  const v = sum();
  if (i < toks.length) throw new Error(`"${src}": unexpected "${toks[i]}"`);
  if (!Number.isFinite(v)) throw new Error(`"${src}": is not a finite number`);
  return v;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function need(ok, at, msg) { if (!ok) throw new Error(`${at || '/'}: ${msg}`); }
function only(o, keys, at) {
  for (const k of Object.keys(o)) need(keys.includes(k) || k.startsWith('//'), `${at}/${k}`, 'unknown key');
}
