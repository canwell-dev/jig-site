// JIG 0.1 reader and baker. Pure: a glTF document with the JIG_recipe extension + parameter values in, a plain
// shape description (read) or the baked glTF (bake) out. No three.js here.

export const VERSION = '0.1';
export const EXT = 'JIG_recipe';

// Read a document. `values` overrides parameter values by name (over baked_values, over defaults).
// Returns { params, vars, floor, meshes, nodes, instances, tree, skins } or throws an Error whose message starts with
// the JSON path. `meshes` are the evaluated recipe meshes, then those of placed documents (draft f10);
// `instances` are { node, mesh, matrix, rec, model } for every shape drawn in the default scene, matrix = world
// transform, column-major as in glTF; `node` is the node of this document that draws or places it.
// `files` (draft f10): file name -> document, for a model's relative `uri`, as if all were in one folder.
export function read(doc, values = {}, { files = {}, stack = [] } = {}) {
  need(isObj(doc), '', 'document must be an object');
  need(isObj(doc.asset) && doc.asset.version === '2.0', '/asset/version', 'must be "2.0" (a glTF 2.0 document)');
  need(Array.isArray(doc.extensionsUsed) && doc.extensionsUsed.includes(EXT), '/extensionsUsed', `must list "${EXT}"`);
  need(!(Array.isArray(doc.extensionsRequired) && doc.extensionsRequired.includes(EXT)), '/extensionsRequired',
    `must not list "${EXT}", so a baked file loads in every glTF tool`);
  const rat = `/extensions/${EXT}`;
  const r = doc.extensions?.[EXT];
  need(isObj(r), rat, 'must be an object');
  only(r, ['version', 'params', 'sets', 'vars', 'floor', 'meshes', 'models', 'skins', 'baked_values', 'baked_set'], rat);
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
    need(p.type === undefined || p.type === 'bool' || p.type === 'color', `${at}/type`, 'must be "bool" or "color" (leave it out for a number)');
    if (p.type === 'color') { // draft f6: linear [r, g, b, a] in 0..1, as glTF's baseColorFactor; not a number, so expressions cannot use it
      only(p, ['type', 'default'], at);
      need(isColor(p.default), `${at}/default`, 'must be a color: linear [r, g, b, a], numbers 0..1');
      if (baked) need(isColor(baked[name]), `${rat}/baked_values/${name}`, 'must be a color: linear [r, g, b, a], numbers 0..1 (baked_values holds every parameter)');
      const v = values[name] ?? baked?.[name] ?? p.default;
      need(isColor(v), `${rat}/params/${name}`, `value must be a color: linear [r, g, b, a], numbers 0..1, is ${JSON.stringify(v)}`);
      params[name] = { ...p, value: [...v] };
      continue;
    }
    if (p.type === 'bool') { // D-47: true/false, 1/0 in expressions
      only(p, ['type', 'default'], at);
      need(typeof p.default === 'boolean', `${at}/default`, 'must be true or false');
      if (baked) need(typeof baked[name] === 'boolean', `${rat}/baked_values/${name}`, 'must be true or false (baked_values holds every parameter)');
      params[name] = { ...p, value: !!(values[name] ?? baked?.[name] ?? p.default) };
      continue;
    }
    only(p, ['default', 'min', 'max'], at);
    for (const k of ['default', 'min', 'max']) need(typeof p[k] === 'number', `${at}/${k}`, 'must be a number');
    need(p.min <= p.default && p.default <= p.max, at, 'needs min <= default <= max');
    if (baked) need(typeof baked[name] === 'number', `${rat}/baked_values/${name}`, 'must be a number (baked_values holds every parameter)');
    const v = values[name] ?? baked?.[name] ?? p.default;
    params[name] = { ...p, value: Math.min(p.max, Math.max(p.min, v)) };
  }
  // Draft f8: named sets of parameter values, as OpenSCAD's parameterSets. A host applies one by passing its
  // values; the reader only checks them. A set may name some parameters only.
  need(r.sets === undefined || isObj(r.sets), `${rat}/sets`, 'must be an object');
  const sets = {};
  for (const [name, set] of Object.entries(r.sets ?? {})) {
    const at = `${rat}/sets/${name}`;
    need(name.trim() !== '', at, 'name must not be empty');
    need(isObj(set), at, 'must be an object of parameter values');
    for (const [k, v] of Object.entries(set)) {
      const p = params[k];
      need(p !== undefined, `${at}/${k}`, 'is not a parameter');
      need(p.type === 'bool' ? typeof v === 'boolean' : p.type === 'color' ? isColor(v) : typeof v === 'number', `${at}/${k}`,
        p.type === 'bool' ? 'must be true or false' : p.type === 'color' ? 'must be a color: linear [r, g, b, a], numbers 0..1' : 'must be a number');
    }
    sets[name] = set;
  }
  need(r.baked_set === undefined || Object.hasOwn(sets, r.baked_set), `${rat}/baked_set`, 'must name a set');
  const scope = Object.fromEntries(Object.entries(params).filter(([, p]) => p.type !== 'color').map(([k, p]) => [k, +p.value]));

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

  // Draft f6: a core glTF material's JIG_recipe sets its color and factor slots; the core slots are the bake's
  // cache. A color is a color parameter's name or a list of linear channels, numbers or expressions, clamped to 0..1.
  need(doc.materials === undefined || Array.isArray(doc.materials), '/materials', 'must be a list');
  const materials = (doc.materials ?? []).map((m, i) => {
    const x = m?.extensions?.[EXT], at = `/materials/${i}/extensions/${EXT}`;
    if (x === undefined || isBaked(m)) return null;
    need(isObj(x), at, 'must be an object');
    only(x, Object.keys(MATERIAL_SLOTS), at);
    const unit = (v) => Math.min(1, Math.max(0, v));
    const color = (c, n, sat) => { // n channels: 4 for baseColorFactor, 3 for emissiveFactor (a parameter's alpha is dropped)
      if (typeof c === 'string' && params[c]?.type === 'color') return params[c].value.slice(0, n);
      need(Array.isArray(c), sat, `must be a color parameter's name or a list of ${n} linear channels`);
      return vec(c, n, scope, sat).map(unit);
    };
    const o = {};
    if (x.baseColorFactor !== undefined) o.baseColorFactor = color(x.baseColorFactor, 4, `${at}/baseColorFactor`);
    for (const k of ['metallicFactor', 'roughnessFactor']) if (x[k] !== undefined) o[k] = unit(num(x[k], scope, `${at}/${k}`));
    if (x.emissiveFactor !== undefined) o.emissiveFactor = color(x.emissiveFactor, 3, `${at}/emissiveFactor`);
    return o;
  });
  const meshes = list(r.meshes, `${rat}/meshes`).map((m, i) => mesh(m, scope, `${rat}/meshes/${i}`, materials.length));

  // Draft f10 (D-72..D-74): other JIG documents, placed by nodes with their own parameter values. Embedded as
  // `document`, or a `uri` as glTF's: a data: URI or a file name looked up in `files`.
  need(r.models === undefined || Array.isArray(r.models), `${rat}/models`, 'must be a list');
  const models = (r.models ?? []).map((m, k) => {
    const at = `${rat}/models/${k}`;
    need(isObj(m), at, 'must be an object');
    only(m, ['uri', 'document'], at);
    need((m.uri === undefined) !== (m.document === undefined), at, 'needs one of uri or document');
    if (m.document !== undefined) return { doc: m.document, label: `models/${k}` };
    need(typeof m.uri === 'string' && m.uri !== '', `${at}/uri`, 'must be a non-empty string');
    const data = /^data:[^,]*?(;base64)?,(.*)$/s.exec(m.uri);
    if (data) {
      try { return { doc: JSON.parse(data[1] ? atob(data[2]) : decodeURIComponent(data[2])), label: `models/${k}` }; }
      catch (e) { need(false, `${at}/uri`, `is not a JSON document: ${e.message}`); }
    }
    need(Object.hasOwn(files, m.uri), `${at}/uri`, `no file "${m.uri}" next to this document`);
    return { doc: files[m.uri], label: m.uri };
  });

  need(doc.nodes === undefined || Array.isArray(doc.nodes), '/nodes', 'must be a list');
  const src = doc.nodes ?? [];

  // The default scene's tree. glTF: a node sits in one tree, at most once. Baked nodes (copies of a repeat) are
  // the bake's cache and are skipped. A node with `repeat`, and every node under it, takes its mesh and
  // transform from JIG_recipe only, so the source subtree draws nothing in a plain glTF tool (D-45).
  need(Array.isArray(doc.scenes) && doc.scenes.length > 0, '/scenes', 'must be a non-empty list');
  need(Number.isInteger(doc.scene) && doc.scene >= 0 && doc.scene < doc.scenes.length, '/scene', 'must be a scene index');
  const all = doc.scenes[doc.scene]?.nodes ?? [];
  need(Array.isArray(all), `/scenes/${doc.scene}/nodes`, 'must be a list');
  const roots = all.filter((i) => !isBaked(src[i])); // baked roots draw skins (draft f10)
  const seen = new Set(), repeated = new Set();
  const check =(i, at, inRepeat) => {
    need(Number.isInteger(i) && i >= 0 && i < src.length, at, 'must be a node index');
    need(!seen.has(i), at, `node ${i} is used twice in the scene`);
    seen.add(i);
    const n = src[i];
    need(isObj(n), `/nodes/${i}`, 'must be an object');
    inRepeat ||= n.extensions?.[EXT]?.repeat !== undefined;
    if (inRepeat) repeated.add(i);
    if (inRepeat) for (const k of ['mesh', 'translation', 'rotation', 'scale', 'matrix']) {
      need(n[k] === undefined, `/nodes/${i}/${k}`, `a node in a repeat takes its mesh and transform from ${EXT} only`);
    }
    need(n.children === undefined || Array.isArray(n.children), `/nodes/${i}/children`, 'must be a list');
    (n.children ?? []).forEach((c, j) => { if (!isBaked(src[c])) check(c, `/nodes/${i}/children/${j}`, inRepeat); });
  };
  roots.forEach((i, j) => check(i, `/scenes/${doc.scene}/nodes/${j}`, false));

  // Draft f10 (D-76, D-77): skins as glTF's; each joint is a node of the scene, and every copy of it a joint.
  need(r.skins === undefined || Array.isArray(r.skins), `${rat}/skins`, 'must be a list');
  const jointOf = new Map();
  (r.skins ?? []).forEach((sk, k) => {
    const at = `${rat}/skins/${k}`;
    need(isObj(sk), at, 'must be an object');
    only(sk, ['joints'], at);
    list(sk.joints, `${at}/joints`).forEach((j, m) => {
      need(seen.has(j), `${at}/joints/${m}`, 'must be a node of the default scene');
      need(!jointOf.has(j), `${at}/joints/${m}`, `node ${j} is already a joint`);
      jointOf.set(j, k);
    });
  });
  const skins = (r.skins ?? []).map(() => []);

  // Evaluate the tree with world matrices. A repeated node is evaluated once per copy, its index and row bound
  // for its subtree (D-44, D-46, D-75). `tree` holds one record per copy: { i, node, rep, shown, kids, world, name,
  // mesh, bound }; a repeat of 0 still evaluates copy 0, unshown, so its errors surface. `nodes[i]` is node i's
  // first copy. `bound` is { rec, skin }: the joint a shape is bound to, the nearest joint at or above its node.
  // A placed document's tree hangs under the placing record, marked `foreign`.
  const nodes = [], instances = [];
  const walk = (i, parent, s, shown, copy, bone) => {
    const x = src[i].extensions?.[EXT], at = `/nodes/${i}`, xat = `${at}/extensions/${EXT}`;
    const rep = isObj(x) && x.repeat !== undefined ? repeat(x.repeat, s, `${xat}/repeat`) : null;
    return Array.from({ length: rep ? Math.max(1, rep.count) : 1 }, (_, k) => {
      const sk = rep ? { ...s, [rep.index]: k, ...rep.rows?.[k] } : s, c = rep ? [...copy, k] : copy;
      const n = node(src[i], meshes.length, sk, at), vis = shown && (!rep || k < rep.count);
      nodes[i] ??= { ...n, repeated: repeated.has(i) };
      const world = mul(parent, n.matrix);
      const rec = { i, node: n, rep: !!rep, shown: vis, kids: [], world, name: src[i].name, mesh: n.mesh };
      let b = bone;
      if (jointOf.has(i)) { b = { rec, skin: jointOf.get(i) }; if (vis) skins[b.skin].push(rec); }
      if (n.mesh !== undefined && b) rec.bound = b;
      if (vis && n.mesh !== undefined) instances.push({ node: i, mesh: n.mesh, matrix: world, copy: c, rec });
      rec.kids = n.children.filter((ch) => !isBaked(src[ch])).flatMap((ch) => walk(ch, world, sk, vis, c, b));
      if (n.jig.model !== undefined) place(n.jig, sk, xat, rec, vis, c, b);
      return rec;
    });
  };
  // Draft f10: a node's `model` and `values`. The placed document is read with those values; its shapes, skins
  // and tree join this one under the node. Its skins join the placing node's skin, or are skins of their own.
  const place = (x, s, xat, rec, vis, c, bone) => {
    need(Number.isInteger(x.model) && x.model >= 0 && x.model < models.length, `${xat}/model`, `must be a model index 0..${models.length - 1}`);
    const m = models[x.model];
    need(m.doc !== doc && !stack.includes(m.doc) && stack.length < 16, `${xat}/model`, 'places itself, or nests deeper than 16');
    need(x.values === undefined || isObj(x.values), `${xat}/values`, 'must be an object');
    const ps = m.doc?.extensions?.[EXT]?.params ?? {}, vals = {};
    for (const [k, e] of Object.entries(x.values ?? {})) {
      if (k.startsWith('//')) continue;
      const kat = `${xat}/values/${k}`;
      need(isObj(ps) && Object.hasOwn(ps, k), kat, `is not a parameter of ${m.label}`);
      need(ps[k]?.type !== 'color', kat, 'a color parameter cannot be passed yet');
      const v = num(e, s, kat);
      vals[k] = ps[k]?.type === 'bool' ? v !== 0 : v;
    }
    let sub;
    try { sub = read(m.doc, vals, { files, stack: [...stack, doc] }); } catch (e) { need(false, `${xat}/model`, `in ${m.label}: ${e.message}`); }
    const off = meshes.length;
    meshes.push(...sub.meshes.map(({ material, ...m }) => m)); // shortcut: a placed document's materials are dropped, until f10 decides how they carry over
    const skinAt = sub.skins.map(() => (bone ? bone.skin : skins.push([]) - 1));
    if (vis) sub.skins.forEach((js, k) => skins[skinAt[k]].push(...js));
    const relink = (r) => {
      r.foreign = true; r.world = mul(rec.world, r.world);
      if (r.mesh !== undefined) { r.mesh += off; r.bound = r.bound ? { rec: r.bound.rec, skin: skinAt[r.bound.skin] } : bone ?? undefined; }
      r.kids.forEach(relink);
    };
    sub.tree.forEach(relink);
    rec.kids.push(...sub.tree);
    if (vis) for (const si of sub.instances) {
      instances.push({ node: rec.i, mesh: si.rec.mesh, matrix: mul(rec.world, si.matrix), copy: [...c, ...si.copy], rec: si.rec, model: true });
    }
  };
  const tree = roots.flatMap((i) => walk(i, IDENTITY, scope, true, [], null));
  src.forEach((n, i) => { if (!nodes[i] && !isBaked(n)) nodes[i] = node(n, meshes.length, scope, `/nodes/${i}`); });

  // y of the floor in model space; hosts stand the model there. Default: the lowest point on the vertical line
  // through the origin, or 0 when no shape crosses that line.
  const floor = r.floor === undefined ? lowestOnAxis(meshes, instances) : num(r.floor, scope, `${rat}/floor`);
  return { params, sets, vars, floor, materials, meshes, nodes, instances, tree, skins };
}

// Draft f10: the files a document's models name by relative `uri`, and theirs, as { name: document }, for read's
// `files`. `load(name)` returns a file's text (or a promise of it); names are relative to one folder.
export async function loadFiles(doc, load, files = {}) {
  for (const m of doc?.extensions?.[EXT]?.models ?? []) {
    const u = m?.uri;
    if (typeof u !== 'string' || u.startsWith('data:') || Object.hasOwn(files, u)) continue;
    files[u] = JSON.parse(await load(u));
    await loadFiles(files[u], load, files);
  }
  if (Array.isArray(doc?.extensions?.[EXT]?.models)) for (const m of doc.extensions[EXT].models) if (m?.document) await loadFiles(m.document, load, files);
  return files;
}

// A node's `repeat` (D-44): count rounded and clamped to 0..1024; the index is a fresh lower_snake_case name.
function repeat(r, scope, at) {
  need(isObj(r), at, 'must be an object');
  only(r, ['count', 'index', 'each'], at);
  const fresh = (name, nat) => {
    need(typeof name === 'string' && /^[a-z_][a-z0-9_]*$/.test(name), nat, 'must be a lower_snake_case name');
    need(!Object.hasOwn(scope, name) && !Object.hasOwn(FUNCS, name), nat, `"${name}" is already a parameter, variable, enclosing name or function`);
  };
  fresh(r.index, `${at}/index`);
  if (r.each === undefined) return { count: Math.min(1024, Math.max(0, Math.round(num(r.count, scope, `${at}/count`)))), index: r.index };
  // Draft f10 (D-75): one row of named values per copy; a row's values do not see the rows' names.
  need(r.count === undefined, `${at}/count`, 'cannot stand next to each (the rows are the count)');
  const rows = list(r.each, `${at}/each`), keys = isObj(rows[0]) ? Object.keys(rows[0]).filter((k) => !k.startsWith('//')) : [];
  need(rows.length <= 1024, `${at}/each`, 'has more than 1024 rows');
  keys.forEach((k) => { fresh(k, `${at}/each/0/${k}`); need(k !== r.index, `${at}/each/0/${k}`, 'is the index'); });
  return { count: rows.length, index: r.index, rows: rows.map((row, j) => {
    need(isObj(row), `${at}/each/${j}`, 'must be an object');
    const ks = Object.keys(row).filter((k) => !k.startsWith('//'));
    need(ks.length === keys.length && ks.every((k) => keys.includes(k)), `${at}/each/${j}`, `must have the keys of row 0: ${keys.join(', ')}`);
    return Object.fromEntries(ks.map((k) => [k, num(row[k], scope, `${at}/each/${j}/${k}`)]));
  }) };
}

// A glTF node. Its JIG_recipe may set mesh, translation, rotation and scale; the core slots with a twin there
// are the bake's cache (D-14) and are ignored here. Other core slots are plain glTF.
function node(n, meshCount, scope, at) {
  need(isObj(n), at, 'must be an object');
  const xat = `${at}/extensions/${EXT}`;
  const x = n.extensions?.[EXT] ?? {};
  need(isObj(x), xat, 'must be an object');
  only(x, ['mesh', 'translation', 'rotation', 'euler', 'scale', 'repeat', 'model', 'values'], xat);
  need(x.values === undefined || x.model !== undefined, `${xat}/values`, 'needs model');
  need(x.rotation === undefined || x.euler === undefined, `${xat}/euler`, 'cannot stand next to rotation');
  if (x.mesh !== undefined) {
    need(Number.isInteger(x.mesh) && x.mesh >= 0 && x.mesh < meshCount, `${xat}/mesh`, `must be a recipe mesh index 0..${meshCount - 1}`);
  }
  if (n.matrix !== undefined) {
    need(['translation', 'rotation', 'euler', 'scale'].every((k) => x[k] === undefined), `${at}/matrix`,
      `a node with a matrix cannot take translation, rotation, euler or scale from ${EXT}`);
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
  if (x.euler !== undefined) rotation = eulerQuat(vec(x.euler, 3, scope, `${xat}/euler`));
  const scale = pick('scale', 3, [1, 1, 1]);
  const children = n.children ?? [];
  need(Array.isArray(children), `${at}/children`, 'must be a list');
  return { mesh: x.mesh, translation, rotation, scale, matrix: n.matrix ?? compose(translation, rotation, scale), children, jig: x };
}

// Euler angles in degrees about glTF's (Y-up) axes: x, then y, then z, each about the fixed axes (matrix Rz·Ry·Rx), as a
// glTF quaternion. Not Blender's frame, which is Z-up (D-69).
export function eulerQuat(deg) {
  const [cx, cy, cz] = deg.map((d) => Math.cos((d * Math.PI) / 360)), [sx, sy, sz] = deg.map((d) => Math.sin((d * Math.PI) / 360));
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

function mesh(m, scope, at, materialCount) {
  need(isObj(m), at, 'must be an object');
  only(m, ['box', 'loft', 'extrude', 'material'], at);
  need(Object.keys(m).filter((k) => !k.startsWith('//') && k !== 'material').length === 1, at, 'must have one shape: box, loft or extrude');
  if (m.material !== undefined) { // sketch (draft f6): glTF's primitive.material
    need(Number.isInteger(m.material) && m.material >= 0 && m.material < materialCount, `${at}/material`, `must be a material index 0..${materialCount - 1}`);
    return { ...mesh({ ...m, material: undefined }, scope, at), material: m.material };
  }
  if (m.loft !== undefined) return loft(m.loft, scope, `${at}/loft`);
  if (m.extrude !== undefined) return extrude(m.extrude, scope, `${at}/extrude`);
  const b = m.box;
  at += '/box';
  need(isObj(b), at, 'must be an object');
  only(b, ['size'], at);
  const size = vec(b.size, 3, scope, `${at}/size`);
  size.forEach((s, i) => need(s > 0, `${at}/size/${i}`, `must be > 0, is ${s}`));
  return { type: 'box', size }; // centred on the origin
}

// --- Bake (D-11, D-14..D-17, D-23) ---

const OWNED = ['meshes', 'accessors', 'bufferViews', 'buffers', 'nodes', 'materials', 'skins'];
const KHR_VARIANTS = 'KHR_materials_variants';
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
  if (d.extensions?.[EXT]?.sets !== undefined && d.extensions[KHR_VARIANTS] !== undefined) { // variants come from the sets
    delete d.extensions[KHR_VARIANTS];
    if (Array.isArray(d.extensionsUsed)) d.extensionsUsed = d.extensionsUsed.filter((e) => e !== KHR_VARIANTS);
  }
  for (const m of Array.isArray(d.materials) ? d.materials : []) {
    const x = m?.extensions?.[EXT];
    if (!isObj(x)) continue;
    for (const [k, place] of Object.entries(MATERIAL_SLOTS)) {
      if (x[k] === undefined) continue;
      if (place === 'top') delete m[k];
      else if (isObj(m.pbrMetallicRoughness)) delete m.pbrMetallicRoughness[k];
    }
    if (isObj(m.pbrMetallicRoughness) && !Object.keys(m.pbrMetallicRoughness).length) delete m.pbrMetallicRoughness;
  }
  for (const sc of Array.isArray(d.scenes) ? d.scenes : []) { // drop baked skinned-mesh roots (draft f10)
    if (Array.isArray(sc?.nodes)) sc.nodes = sc.nodes.filter((c) => c < (d.nodes?.length ?? 0));
  }
  for (const n of Array.isArray(d.nodes) ? d.nodes : []) {
    if (Array.isArray(n?.children)) { // drop links to removed baked copies (D-45)
      const kept = n.children.filter((c) => c < d.nodes.length);
      if (kept.length < n.children.length) { if (kept.length) n.children = kept; else delete n.children; }
    }
    const x = n?.extensions?.[EXT];
    if (isObj(x)) for (const k of ['mesh', 'translation', 'rotation', 'scale']) if (twin(x, k) !== undefined) delete n[k];
  }
  return d;
}

// Bake at `values` (over baked_values, over defaults). Returns { gltf, bin }: gltf is the document with a fresh
// cache and baked_values; bin is the buffer's bytes. The buffer is embedded as a data URI unless `uri` names a
// separate file (D-23). The same document and values give the same bytes (D-15).
// `set` names a set to bake with (its values under `values`) and records it as baked_set; null drops baked_set;
// left out, baked_set stays as it is.
export function bake(doc, values = {}, { uri, set, files } = {}) {
  const d = strip(doc);
  const r = d.extensions?.[EXT];
  if (typeof set === 'string') {
    need(isObj(r?.sets?.[set]), `/extensions/${EXT}/sets`, `has no set named "${set}"`);
    values = { ...r.sets[set], ...values };
  }
  const out = read(d, values, { files });
  d.asset.generator = `JIG ${VERSION} reference baker`;
  r.baked_values = Object.fromEntries(Object.entries(out.params).map(([k, p]) => [k, p.value]));
  if (set !== undefined) { delete r.baked_set; if (set !== null) r.baked_set = set; }

  const base = Object.fromEntries(OWNED.map((k) => [k, d[k]?.length ?? 0]));
  const add = (k, item) => (d[k] ??= []).push({ ...item, extensions: { ...item.extensions, [EXT]: { baked: true } } }) - 1;
  const authored = structuredClone(d.materials ?? []); // before the cache: the base of variant materials

  // Sets as KHR_materials_variants (draft f8): each set is a variant; a material whose recipe slots differ at a set's
  // values (over this bake's) gets a baked copy with them, mapped on every primitive that uses the material.
  const names = Object.keys(out.sets), mapping = {};
  names.forEach((name, v) => {
    const mats = read(d, { ...r.baked_values, ...out.sets[name] }, { files }).materials;
    mats.forEach((m, i) => {
      if (!m || JSON.stringify(m) === JSON.stringify(out.materials[i])) return;
      const { extensions: { [EXT]: _, ...ext } = {}, ...rest } = authored[i];
      const copy = slots({ ...rest, ...(Object.keys(ext).length && { extensions: ext }) }, m);
      if (rest.name !== undefined) copy.name = `${rest.name} (${name})`;
      (mapping[i] ??= []).push({ material: add('materials', copy), variants: [v] });
    });
  });
  if (names.length) {
    d.extensions[KHR_VARIANTS] = { variants: names.map((name) => ({ name })) };
    if (!d.extensionsUsed.includes(KHR_VARIANTS)) d.extensionsUsed.push(KHR_VARIANTS);
  }
  const chunks = [];
  let offset = 0;
  const view = (array, target) => {
    const bytes = new Uint8Array(array.buffer);
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4); // keep every view 4-byte aligned
    padded.set(bytes);
    chunks.push(padded);
    const i = add('bufferViews', { buffer: base.buffers, byteOffset: offset, byteLength: bytes.byteLength, ...(target && { target }) });
    offset += padded.byteLength;
    return i;
  };
  // Only meshes a shown node draws unskinned are baked, in recipe order; meshAt maps recipe mesh to core mesh.
  const used = new Set(out.instances.filter((x) => !x.rec.bound).map((x) => x.mesh)), meshAt = {};
  for (const [mi, m] of out.meshes.entries()) {
    if (!used.has(mi)) continue;
    meshAt[mi] = base.meshes + Object.keys(meshAt).length;
    const { positions, normals, indices: all } = geometry(m);
    const short = positions.length / 3 <= 65535; // glTF reserves 65535 in 16-bit indices
    const indices = short ? Uint16Array.from(all) : all;
    const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
    const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
    const pos = add('accessors', { bufferView: view(positions, 34962), componentType: 5126, count: positions.length / 3,
      type: 'VEC3', min, max });
    const nor = add('accessors', { bufferView: view(normals, 34962), componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
    add('meshes', { primitives: [{ attributes: { POSITION: pos, NORMAL: nor }, indices: idx, ...(m.material !== undefined && { material: m.material }),
      ...(mapping[m.material] && { extensions: { [KHR_VARIANTS]: { mappings: mapping[m.material] } } }) }] });
  }
  out.materials.forEach((m, i) => { if (m) slots(d.materials[i], m); }); // the material cache (D-57)

  // Nodes outside any repeat get their cache in place; each shown copy of a repeated node becomes a baked node,
  // with baked copies of its subtree, appended to the repeated node's children (D-45); so does each shown node of
  // a placed document (draft f10). A shape bound to a joint is drawn by its skin's mesh, not by its node.
  const nodeOf = new Map();
  const copyOf = (rec) => {
    const kids = rec.kids.filter((r) => r.shown).map(copyOf), n = rec.node, b = {};
    if (rec.name !== undefined) b.name = rec.name;
    if (rec.mesh !== undefined && !rec.bound) b.mesh = meshAt[rec.mesh];
    for (const [k, id] of [['translation', '0,0,0'], ['rotation', '0,0,0,1'], ['scale', '1,1,1']]) if (String(n[k]) !== id) b[k] = n[k];
    if (kids.length) b.children = kids;
    const i = add('nodes', b);
    nodeOf.set(rec, i);
    return i;
  };
  const bound = new Set(out.instances.filter((x) => !x.model && x.rec.bound).map((x) => x.node));
  for (const [i, n] of out.nodes.entries()) {
    if (!n || n.repeated) continue;
    if (n.jig.mesh !== undefined && !bound.has(i)) d.nodes[i].mesh = meshAt[n.jig.mesh];
    for (const k of ['translation', 'rotation', 'scale']) if (twin(n.jig, k) !== undefined) d.nodes[i][k] = n[k];
  }
  const place = (recs) => recs.forEach((rec) => {
    if (!rec.rep && !rec.foreign) { nodeOf.set(rec, rec.i); return place(rec.kids); }
    if (rec.shown) (d.nodes[nodeOf.get(rec.parent) ?? rec.i].children ??= []).push(copyOf(rec));
  });
  const parents = (recs, parent) => recs.forEach((rec) => { if (rec.foreign && !parent?.foreign) rec.parent = parent; parents(rec.kids, rec); });
  parents(out.tree, null);
  place(out.tree);

  // Skins (draft f10, D-77): glTF skins with the joints' baked nodes and inverse bind matrices at this pose. The
  // shapes bound to a skin are one baked mesh, a primitive per shape, in model space at the bind pose, each vertex
  // bound to its joint with weight 1, drawn by a baked root node of the default scene.
  const geoms = {};
  out.skins.forEach((joints, s) => {
    if (!joints.length) return;
    const shapes = out.instances.filter((x) => x.rec.bound?.skin === s);
    const ibm = new Float32Array(joints.flatMap((j) => invert(j.world)));
    const inverseBindMatrices = add('accessors', { bufferView: view(ibm), componentType: 5126, count: joints.length, type: 'MAT4' });
    const skin = add('skins', { inverseBindMatrices, joints: joints.map((j) => nodeOf.get(j)) });
    if (!shapes.length) return;
    const primitives = shapes.map((x) => {
      const g = (geoms[x.mesh] ??= geometry(out.meshes[x.mesh])), n = g.positions.length / 3, m = x.matrix;
      const nm = inverse3([0, 1, 2].map((rw) => [0, 1, 2].map((c) => m[c * 4 + rw]))) ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n);
      for (let v = 0; v < n; v++) {
        const [px, py, pz] = g.positions.subarray(3 * v, 3 * v + 3), [qx, qy, qz] = g.normals.subarray(3 * v, 3 * v + 3);
        for (let a = 0; a < 3; a++) positions[3 * v + a] = m[a] * px + m[4 + a] * py + m[8 + a] * pz + m[12 + a];
        const w = [0, 1, 2].map((a) => nm[0][a] * qx + nm[1][a] * qy + nm[2][a] * qz), l = Math.hypot(...w) || 1;
        for (let a = 0; a < 3; a++) normals[3 * v + a] = w[a] / l;
      }
      const joint = joints.indexOf(x.rec.bound.rec);
      const short = n <= 65535, indices = short ? Uint16Array.from(g.indices) : g.indices;
      const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
      const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
      const acc = (array, componentType, type, extra = {}) => add('accessors', { bufferView: view(array, 34962), componentType, count: n, type, ...extra });
      const attributes = { POSITION: acc(positions, 5126, 'VEC3', { min, max }), NORMAL: acc(normals, 5126, 'VEC3'),
        JOINTS_0: acc(new Uint16Array(4 * n).map((_, i) => (i % 4 ? 0 : joint)), 5123, 'VEC4'),
        WEIGHTS_0: acc(new Float32Array(4 * n).map((_, i) => (i % 4 ? 0 : 1)), 5126, 'VEC4') };
      const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
      const mat = out.meshes[x.mesh].material;
      return { attributes, indices: idx, ...(mat !== undefined && { material: mat }),
        ...(mapping[mat] && { extensions: { [KHR_VARIANTS]: { mappings: mapping[mat] } } }) };
    });
    const mesh = add('meshes', { primitives });
    d.scenes[d.scene].nodes.push(add('nodes', { name: `skin ${s}`, mesh, skin }));
  });

  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.byteLength; }
  add('buffers', { byteLength: bin.byteLength, uri: uri ?? `data:application/octet-stream;base64,${base64(bin)}` });
  return { gltf: d, bin };
}

// Triangles of a recipe mesh: { positions, normals, indices } (Float32Array, Float32Array, Uint32Array).
export function geometry(m) {
  if (m.type === 'loft') return loftGeometry(m);
  if (m.type === 'extrude') return extrudeGeometry(m);
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

// Inverse of an affine column-major 4x4 (a node's world transform); a flat one has none, so identity stands in.
function invert(m) {
  const r = inverse3([0, 1, 2].map((rw) => [0, 1, 2].map((c) => m[c * 4 + rw])));
  if (!r) return IDENTITY;
  const t = r.map((row) => -(row[0] * m[12] + row[1] * m[13] + row[2] * m[14]));
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, t[0], t[1], t[2], 1];
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
    const pts = points(s.points, scope, `${sat}/points`);
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

// A closed outline in loft's point form (D-39): [u, v] corners and [u, v, hu, hv] smooth points.
function points(x, scope, at) {
  const pts = list(x, at).map((p, j) => {
    need(Array.isArray(p) && (p.length === 2 || p.length === 4), `${at}/${j}`, 'must be [u, v] or [u, v, hu, hv]');
    return p.map((e, k) => num(e, scope, `${at}/${j}/${k}`));
  });
  need(pts.length >= 3, at, 'needs at least 3 points');
  need(Math.abs(area(outline(pts))) > 1e-12, at, 'must enclose an area');
  return pts;
}

// Draft f9: a flat outline with holes, in loft's point form, in the xy plane, pushed along z by depth, centred on
// the origin like a box.
function extrude(e, scope, at) {
  need(isObj(e), at, 'must be an object');
  only(e, ['outline', 'holes', 'depth'], at);
  const out = points(e.outline, scope, `${at}/outline`);
  const holes = e.holes === undefined ? [] : list(e.holes, `${at}/holes`).map((h, i) => points(h, scope, `${at}/holes/${i}`));
  const poly = outline(out);
  // shortcut: checks one point of each hole, not that holes stay clear of the outline and of each other; upgrade
  // when a model needs that error.
  holes.forEach((h, i) => need(inside(h[0], poly), `${at}/holes/${i}`, 'must lie inside the outline'));
  const depth = num(e.depth, scope, `${at}/depth`);
  need(depth > 0, `${at}/depth`, `must be > 0, is ${depth}`);
  return { type: 'extrude', outline: out, holes, depth };
}
const inside = ([x, y], poly) => poly.reduce((c, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return (p[1] > y) !== (q[1] > y) && x < p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]) ? !c : c;
}, false);

// Caps: ear clipping, holes first bridged to the outline. Walls: a quad per outline edge, smooth normals across
// curve samples and smooth points, split at corners.
function extrudeGeometry(m) {
  const loops = [m.outline, ...m.holes].map((pts, i) => {
    const { poly, starts } = flatten(pts);
    const hard = new Set(starts.filter((_, k) => pts[k].length === 2));
    const keep = (area(poly) > 0) === (i === 0); // outline counter-clockwise, holes clockwise
    const order = keep ? poly.map((_, k) => k) : poly.map((_, k) => (poly.length - k) % poly.length);
    return { poly: order.map((k) => poly[k]), hard: order.map((k) => hard.has(k)) };
  });
  const positions = [], normals = [], indices = [], h = m.depth / 2;
  const flat = loops.flatMap((l) => l.poly);
  const tris = triangulate(loops.map((l) => l.poly));
  for (const [z, s] of [[h, 1], [-h, -1]]) {
    const first = positions.length / 3;
    for (const [x, y] of flat) { positions.push(x, y, z); normals.push(0, 0, s); }
    for (let k = 0; k < tris.length; k += 3) {
      const t = s > 0 ? [tris[k], tris[k + 1], tris[k + 2]] : [tris[k], tris[k + 2], tris[k + 1]];
      indices.push(...t.map((i) => first + i));
    }
  }
  for (const { poly, hard } of loops) {
    const L = poly.length;
    const edge = (k) => { const a = poly[k % L], b = poly[(k + 1) % L]; return norm([b[1] - a[1], a[0] - b[0], 0]); };
    const at = (k, e) => (hard[k % L] ? edge(e) : norm(edge((k + L - 1) % L).map((c, q) => c + edge(k)[q])));
    for (let k = 0; k < L; k++) {
      const a = poly[k], b = poly[(k + 1) % L], na = at(k, k), nb = at(k + 1, k), first = positions.length / 3;
      for (const [p, nn, z] of [[a, na, -h], [b, nb, -h], [b, nb, h], [a, na, h]]) { positions.push(p[0], p[1], z); normals.push(...nn); }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

// Triangles over loops[0] (counter-clockwise) minus the other loops (clockwise), as indices into all loops' points
// in order. Each hole joins the ring by a bridge to the nearest ring point it sees, rightmost holes first.
export function triangulate(loops) {
  const pts = loops.flat(), same = (a, b) => a[0] === b[0] && a[1] === b[1];
  let off = 0;
  const ids = loops.map((l) => { const r = l.map((_, k) => off + k); off += l.length; return r; });
  let ring = ids[0];
  const right = (l) => Math.max(...l.map((i) => pts[i][0]));
  const holes = ids.slice(1).sort((a, b) => right(b) - right(a));
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const crosses = (a, b, c, d) => // segments ab and cd cross, not just touch at an end
    ![c, d].some((p) => same(p, a) || same(p, b)) && o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  holes.forEach((hole, hi) => {
    const m = hole.reduce((best, i) => (pts[i][0] > pts[best][0] ? i : best), hole[0]), M = pts[m];
    const edges = [ring, ...holes.slice(hi)].flatMap((l) => l.map((i, k) => [pts[i], pts[l[(k + 1) % l.length]]]));
    const near = ring.map((_, k) => k).sort((a, b) => dist2(pts[ring[a]], M) - dist2(pts[ring[b]], M));
    const k = near.find((k) => edges.every(([c, d]) => !crosses(M, pts[ring[k]], c, d)));
    need(k !== undefined, '', 'a hole cannot be joined to the outline');
    const j = hole.indexOf(m);
    ring = [...ring.slice(0, k + 1), ...hole.slice(j), ...hole.slice(0, j), m, ring[k], ...ring.slice(k + 1)];
  });
  const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0;
  const tri = (V, i) => [V[(i + V.length - 1) % V.length], V[i], V[(i + 1) % V.length]];
  const tris = [], V = [...ring];
  while (V.length > 3) {
    let cut = V.findIndex((_, i) => {
      const [a, b, c] = tri(V, i).map((x) => pts[x]);
      return turn(a, b, c) > 0 && !V.some((x) => ![a, b, c].some((q) => same(pts[x], q)) && inTri(pts[x], a, b, c));
    });
    if (cut < 0) cut = V.findIndex((_, i) => turn(...tri(V, i).map((x) => pts[x])) === 0); // drop a flat corner
    need(cut >= 0, '', 'outline and holes overlap or cross');
    const t = tri(V, cut);
    if (turn(...t.map((x) => pts[x])) > 0) tris.push(...t);
    V.splice(cut, 1);
  }
  if (turn(...V.map((x) => pts[x])) > 0) tris.push(...V);
  return tris;
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

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
  // Flat caps, triangulated in the section plane so concave sections stay right (as extrude caps), facing back
  // at the start and forward at the end.
  for (const [r, s] of [[0, -1], [ts.length - 1, 1]]) {
    const first = positions.length / 3, tris = triangulate([shapeAt(ts[r])]);
    for (let j = 0; j < n; j++) { positions.push(...at(r * n + j)); normals.push(...scale(frames[r].z, s)); }
    for (let k = 0; k < tris.length; k += 3) indices.push(...(s < 0 ? [tris[k], tris[k + 2], tris[k + 1]] : tris.slice(k, k + 3)).map((i) => first + i));
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
// Material slots a recipe may set, and where glTF keeps them (D-6 amended).
const MATERIAL_SLOTS = { baseColorFactor: 'pbr', metallicFactor: 'pbr', roughnessFactor: 'pbr', emissiveFactor: 'top' };
// Write evaluated material slots into their core glTF places; returns the material.
function slots(core, m) {
  const pbr = Object.fromEntries(Object.entries(m).filter(([k]) => MATERIAL_SLOTS[k] === 'pbr'));
  if (Object.keys(pbr).length) core.pbrMetallicRoughness = { ...pbr, ...core.pbrMetallicRoughness };
  if (m.emissiveFactor) core.emissiveFactor = m.emissiveFactor;
  return core;
}
// A color value: linear [r, g, b, a], numbers 0..1, as glTF's baseColorFactor and Blender's color sockets.
const isColor = (c) => Array.isArray(c) && c.length === 4 && c.every((x) => typeof x === 'number' && x >= 0 && x <= 1);
// A recipe slot that sets core slot k: euler sets rotation.
const twin = (x, k) => x[k] ?? (k === 'rotation' ? x.euler : undefined);
function need(ok, at, msg) { if (!ok) throw new Error(`${at || '/'}: ${msg}`); }
function only(o, keys, at) {
  for (const k of Object.keys(o)) need(keys.includes(k) || k.startsWith('//'), `${at}/${k}`, 'unknown key');
}
