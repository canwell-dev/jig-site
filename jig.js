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
    need(p.type === undefined || p.type === 'bool' || p.type === 'color' || p.type === 'choice', `${at}/type`, 'must be "bool", "color" or "choice" (leave it out for a number)');
    if (p.type === 'choice') { // draft f21: one of named options, its index 0, 1, ... in expressions
      only(p, ['type', 'options', 'default'], at);
      need(Array.isArray(p.options) && p.options.length >= 2 && p.options.every((o) => typeof o === 'string' && o !== ''), `${at}/options`, 'must be a list of at least 2 non-empty strings');
      need(new Set(p.options).size === p.options.length, `${at}/options`, 'must not repeat an option');
      need(p.options.includes(p.default), `${at}/default`, `must be one of ${JSON.stringify(p.options)}`);
      if (baked) need(p.options.includes(baked[name]), `${rat}/baked_values/${name}`, `must be one of ${JSON.stringify(p.options)} (baked_values holds every parameter)`);
      const v = values[name] ?? baked?.[name] ?? p.default;
      need(p.options.includes(v), `${rat}/params/${name}`, `value must be one of ${JSON.stringify(p.options)}, is ${JSON.stringify(v)}`);
      params[name] = { ...p, value: v };
      continue;
    }
    if (p.type === 'color') { // draft f6: linear [r, g, b, a] in 0..1, as glTF's baseColorFactor; a vec4 in expressions (D-91)
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
  // D-96: well-known parameters a host may set by name; the reader checks their kind only, not what the model does.
  for (const k of ['seed', 'width', 'height', 'depth']) {
    const p = params[k], at = `${rat}/params/${k}`;
    if (!p) continue;
    need(p.type === undefined, `${at}/type`, 'is a well-known parameter (§3.3): must be a number parameter');
    if (k !== 'seed') need(p.min > 0, `${at}/min`, 'is an extent in metres (§3.3): must be > 0');
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
      need(p.type === 'bool' ? typeof v === 'boolean' : p.type === 'color' ? isColor(v) : p.type === 'choice' ? p.options.includes(v) : typeof v === 'number', `${at}/${k}`,
        p.type === 'bool' ? 'must be true or false' : p.type === 'color' ? 'must be a color: linear [r, g, b, a], numbers 0..1' : p.type === 'choice' ? `must be one of ${JSON.stringify(p.options)}` : 'must be a number');
    }
    sets[name] = set;
  }
  need(r.baked_set === undefined || Object.hasOwn(sets, r.baked_set), `${rat}/baked_set`, 'must name a set');
  const scope = Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.type === 'color' ? [...p.value] : p.type === 'choice' ? p.options.indexOf(p.value) : +p.value]));

  // Sketch (draft f2): named expressions, in order; each sees the params and the vars before it. A var may hold a
  // color (vec4, D-91).
  need(r.vars === undefined || isObj(r.vars), `${rat}/vars`, 'must be an object');
  const vars = {};
  for (const [name, e] of Object.entries(r.vars ?? {})) {
    if (name.startsWith('//')) continue;
    const at = `${rat}/vars/${name}`;
    need(/^[a-z_][a-z0-9_]*$/.test(name), at, 'name must be lower_snake_case');
    need(!(name in params), at, 'name is already a parameter');
    need(!Object.hasOwn(FUNCS, name), at, 'name is a built-in function');
    vars[name] = scope[name] = typeof e === 'number' ? e : value(e, scope, at);
  }

  // Draft f6: a core glTF material's JIG_recipe sets its color and factor slots; the core slots are the bake's
  // cache. A color is an expression giving a vec4 (D-91) or a list of linear channels, clamped to 0..1.
  need(doc.materials === undefined || Array.isArray(doc.materials), '/materials', 'must be a list');
  const materialAt = (m, i, scope) => {
    const x = m?.extensions?.[EXT], at = `/materials/${i}/extensions/${EXT}`;
    if (x === undefined || isBaked(m)) return null;
    need(isObj(x), at, 'must be an object');
    only(x, [...Object.keys(MATERIAL_SLOTS), ...Object.keys(TEXTURE_SLOTS)], at);
    const unit = (v) => Math.min(1, Math.max(0, v));
    const o = {};
    if (x.baseColorFactor !== undefined) o.baseColorFactor = color(x.baseColorFactor, 4, scope, `${at}/baseColorFactor`);
    for (const k of ['metallicFactor', 'roughnessFactor']) if (x[k] !== undefined) o[k] = unit(num(x[k], scope, `${at}/${k}`));
    if (x.emissiveFactor !== undefined) o.emissiveFactor = color(x.emissiveFactor, 3, scope, `${at}/emissiveFactor`);
    // Draft f12 (D-82): KHR_materials_emissive_strength's twin, clamped to >= 0.
    if (x.emissiveStrength !== undefined) o.emissiveStrength = Math.max(0, num(x.emissiveStrength, scope, `${at}/emissiveStrength`));
    // Draft f19 (D-102): KHR_materials_transmission's and KHR_materials_ior's twins; ior is >= 1 or exactly 0, as the extension.
    if (x.transmissionFactor !== undefined) o.transmissionFactor = unit(num(x.transmissionFactor, scope, `${at}/transmissionFactor`));
    if (x.ior !== undefined) { const v = num(x.ior, scope, `${at}/ior`); o.ior = v === 0 ? 0 : Math.max(1, v); }
    // Draft f11 (D-81): a texture slot's KHR_texture_transform, its values numbers or expressions.
    for (const [k, place] of Object.entries(TEXTURE_SLOTS)) {
      const t = x[k], tat = `${at}/${k}`;
      if (t === undefined) continue;
      need(isObj(t), tat, 'must be an object');
      only(t, ['offset', 'rotation', 'scale'], tat);
      const core = place === 'pbr' ? m.pbrMetallicRoughness?.[k] : m[k];
      need(isObj(core) && Number.isInteger(core.index), tat, `needs the core ${place === 'pbr' ? 'pbrMetallicRoughness.' : ''}${k} it transforms`);
      o[k] = {};
      if (t.offset !== undefined) o[k].offset = vec(t.offset, 2, scope, `${tat}/offset`);
      if (t.rotation !== undefined) o[k].rotation = num(t.rotation, scope, `${tat}/rotation`);
      if (t.scale !== undefined) o[k].scale = vec(t.scale, 2, scope, `${tat}/scale`);
    }
    return o;
  };
  // Draft f20 (D-104): a material is evaluated in the scope of each copy whose mesh uses it, as a mesh is (D-92).
  // materials[i] is material i at the first copy that uses it (at the parameters when none does); a copy where it
  // evaluates otherwise draws a finished material of its own (`placed`). `pending` holds the error of a material
  // that fails at the parameters, as it may need a copy's names.
  const pending = new Map();
  const materials = (doc.materials ?? []).map((m, i) => {
    try { return materialAt(m, i, scope); } catch (e) { pending.set(i, e); return null; }
  });
  // Draft f15 (D-92): a recipe mesh is evaluated in the scope of each copy that draws it, so it sees that copy's
  // indices and rows. meshes[i] is recipe mesh i at the first copy that draws it (at the parameters when none does);
  // a copy whose evaluated shape differs gets an entry after them. Equal evaluated shapes share one entry.
  const recipeMeshes = list(r.meshes, `${rat}/meshes`), meshes = new Array(recipeMeshes.length), meshKey = new Map();
  const intern = (m, key, slot) => {
    if (!meshKey.has(key)) meshKey.set(key, slot !== undefined && meshes[slot] === undefined ? (meshes[slot] = m, slot) : meshes.push(m) - 1);
    return meshKey.get(key);
  };
  let own;
  const meshAt = (i, s) => {
    const m = mesh(recipeMeshes[i], s, `${rat}/meshes/${i}`, materials.length), j = m.material;
    if (j !== undefined && (materials[j] || pending.has(j))) {
      const o = materialAt(doc.materials[j], j, s);
      if (pending.has(j)) { pending.delete(j); materials[j] = o; }
      else if (JSON.stringify(o) !== JSON.stringify(materials[j])) {
        own ??= strip(doc);
        const { extensions: { [EXT]: _, ...ext } = {}, ...rest } = structuredClone(own.materials[j]);
        const mat = slots({ ...rest, ...(Object.keys(ext).length && { extensions: ext }) }, o);
        delete m.material;
        m.placed = addPlaced(lift(mat, ownTexture(own), '', `${rat}/meshes/${i}/material`));
      }
    }
    return intern(m, `${i} ${JSON.stringify(m)}`, i);
  };

  // Draft f10 (D-72..D-74): other JIG documents, placed by nodes with their own parameter values. Embedded as
  // `document`, or a `uri` as glTF's: a data: URI or a file name looked up in `files`.
  need(r.models === undefined || Array.isArray(r.models), `${rat}/models`, 'must be a list');
  const placed = [], placedKey = new Map(); // draft f10 (D-78): materials of placed documents, as finished glTF materials
  // Draft f11: the textures those materials use, each { texture, image, sampler } with the image's uri made relative
  // to this document; a placed material's texture slots index this list.
  const placedTextures = [], textureKey = new Map();
  const lift = (mat, lookup, dir, at) => {
    for (const slot of textureSlots(mat)) {
      const { texture, image, sampler } = structuredClone(lookup(slot.index));
      need(typeof image?.uri === 'string', at, "a placed document's image needs a uri");
      if (!/^([a-z][a-z0-9+.-]*:|\/)/i.test(image.uri)) image.uri = dir + image.uri;
      const e = { texture, image, ...(sampler && { sampler }) }, key = JSON.stringify(e);
      if (!textureKey.has(key)) textureKey.set(key, placedTextures.push(e) - 1);
      slot.index = textureKey.get(key);
    }
    return mat;
  };
  const addPlaced = (mat) => {
    const key = JSON.stringify(mat);
    if (!placedKey.has(key)) placedKey.set(key, placed.push(mat) - 1);
    return placedKey.get(key);
  };
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
    return { doc: files[m.uri], label: m.uri, dir: m.uri.slice(0, m.uri.lastIndexOf('/') + 1) };
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
  // Draft f20 (D-106): `on` places the node on a loft, taken where the node's parent puts its origin; the node's own
  // transform applies after the placement.
  const nodeAt = (raw, s, at) => {
    const n = node(raw, recipeMeshes.length, s, at), on = n.jig.on, oat = `${at}/extensions/${EXT}/on`;
    if (on === undefined) return n;
    need(isObj(on), oat, 'must be { "mesh", "t" or "d", "u" }');
    only(on, ['mesh', 't', 'd', 'u'], oat);
    need(Number.isInteger(on.mesh) && on.mesh >= 0 && on.mesh < recipeMeshes.length, `${oat}/mesh`, `must be a recipe mesh index 0..${recipeMeshes.length - 1}`);
    const m = mesh(recipeMeshes[on.mesh], s, `${rat}/meshes/${on.mesh}`, materials.length);
    need(m.type === 'loft', `${oat}/mesh`, `must be a loft, is a ${m.type}`);
    need((on.t === undefined) !== (on.d === undefined), oat, 'needs t or d, not both (D-94)');
    let t;
    if (on.t !== undefined) { t = num(on.t, s, `${oat}/t`); need(t >= 0 && t <= 1, `${oat}/t`, `must be in 0..1, is ${t}`); }
    else { const L = curveLength(loftCurve(m)), d = num(on.d, s, `${oat}/d`); t = Math.min(1, Math.max(0, (d < 0 ? L + d : d) / L)); }
    const u = on.u === undefined ? undefined : num(on.u, s, `${oat}/u`);
    need(u === undefined || (u >= 0 && u <= 1), `${oat}/u`, `must be in 0..1, is ${u}`);
    const f = loftPlace(m, t, u), q = frameQuat(f.x, f.y, f.z), R = compose([0, 0, 0], q, [1, 1, 1]);
    n.translation = [0, 1, 2].map((a) => f.p[a] + R[a] * n.translation[0] + R[4 + a] * n.translation[1] + R[8 + a] * n.translation[2]);
    n.rotation = qmul(q, n.rotation);
    n.matrix = compose(n.translation, n.rotation, n.scale);
    return n;
  };
  const walk = (i, parent, s, shown, copy, bone) => {
    const x = src[i].extensions?.[EXT], at = `/nodes/${i}`, xat = `${at}/extensions/${EXT}`;
    const rep = isObj(x) && x.repeat !== undefined ? repeat(x.repeat, s, `${xat}/repeat`) : null;
    return Array.from({ length: rep ? Math.max(1, rep.count) : 1 }, (_, k) => {
      const sk = rep ? { ...s, [rep.index]: k, ...rep.rows?.[k] } : s, c = rep ? [...copy, k] : copy;
      const n = nodeAt(src[i], sk, at), vis = shown && (!rep || k < rep.count);
      if (n.mesh !== undefined) n.mesh = meshAt(n.mesh, sk);
      nodes[i] ??= { ...n, repeated: repeated.has(i) };
      const world = mul(parent, n.matrix);
      const rec = { i, node: n, rep: !!rep, shown: vis, kids: [], world, name: n.name, mesh: n.mesh };
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
      if (ps[k]?.type === 'color') { vals[k] = color(e, 4, s, kat); continue; } // a color expression or linear channels (D-78, D-91)
      const opts = ps[k]?.type === 'choice' && Array.isArray(ps[k].options) ? ps[k].options : null;
      if (opts?.includes(e)) { vals[k] = e; continue; } // draft f21: an option by name, or an expression giving its index
      const v = num(e, s, kat);
      if (opts) need(Number.isInteger(v) && v >= 0 && v < opts.length, kat, `must be one of ${JSON.stringify(opts)} or an index 0..${opts.length - 1}, is ${v}`);
      vals[k] = ps[k]?.type === 'bool' ? v !== 0 : opts ? opts[v] : v;
    }
    let sub;
    try { sub = read(m.doc, vals, { files, stack: [...stack, doc] }); } catch (e) { need(false, `${xat}/model`, `in ${m.label}: ${e.message}`); }
    // Its materials come along (D-78): each one a shape uses, at this copy's values, as a finished glTF material.
    m.stripped ??= strip(m.doc);
    const dir = m.dir ?? '', sd = m.stripped;
    const own = ownTexture(sd, `${xat}/model`, `in ${m.label}: `); // a texture of the placed document itself
    // Its shapes join this document's, shared with equal shapes placed before (D-92).
    const remap = sub.meshes.map(({ material, placed: pm, ...mesh }) => {
      if (pm !== undefined) mesh.placed = addPlaced(lift(structuredClone(sub.placed[pm]), (i) => sub.placedTextures[i], dir, `${xat}/model`));
      else if (material !== undefined) {
        const { extensions: { [EXT]: _, ...ext } = {}, ...rest } = structuredClone(sd.materials[material]);
        const mat = slots({ ...rest, ...(Object.keys(ext).length && { extensions: ext }) }, sub.materials[material] ?? {});
        mesh.placed = addPlaced(lift(mat, own, dir, `${xat}/model`));
      }
      return intern(mesh, `placed ${JSON.stringify(mesh)}`);
    });
    const skinAt = sub.skins.map(() => (bone ? bone.skin : skins.push([]) - 1));
    if (vis) sub.skins.forEach((js, k) => skins[skinAt[k]].push(...js));
    const relink = (r) => {
      r.foreign = true; r.world = mul(rec.world, r.world);
      if (rec.name !== undefined && r.name !== undefined) r.name = `${rec.name}/${r.name}`; // D-79: the placing copy's name first
      if (r.mesh !== undefined) { r.mesh = remap[r.mesh]; r.bound = r.bound ? { rec: r.bound.rec, skin: skinAt[r.bound.skin] } : bone ?? undefined; }
      r.kids.forEach(relink);
    };
    sub.tree.forEach(relink);
    rec.kids.push(...sub.tree);
    if (vis) for (const si of sub.instances) {
      instances.push({ node: rec.i, mesh: si.rec.mesh, matrix: mul(rec.world, si.matrix), copy: [...c, ...si.copy], rec: si.rec, model: true });
    }
  };
  const tree = roots.flatMap((i) => walk(i, IDENTITY, scope, true, [], null));
  src.forEach((n, i) => { if (!nodes[i] && !isBaked(n)) nodes[i] = nodeAt(n, scope, `/nodes/${i}`); });
  for (let i = 0; i < recipeMeshes.length; i++) if (meshes[i] === undefined) meshAt(i, scope); // drawn by no copy
  for (const e of pending.values()) throw e; // used by no copy, and wrong at the parameters

  // y of the floor in model space; hosts stand the model there. Default: the lowest point on the vertical line
  // through the origin, or 0 when no shape crosses that line.
  const floor = r.floor === undefined ? lowestOnAxis(meshes, instances) : num(r.floor, scope, `${rat}/floor`);
  return { params, sets, vars, floor, materials, meshes, nodes, instances, tree, skins, placed, placedTextures };
}

// A texture of a stripped document as { texture, image, sampler }, for `lift`.
const ownTexture = (sd, at = '', pre = '') => (i) => {
  const { source, sampler, ...texture } = sd.textures?.[i] ?? {};
  need(isObj(sd.textures?.[i]) && isObj(sd.images?.[source]), at, `${pre}texture ${i} or its image is missing`);
  return { texture, image: sd.images[source], sampler: sampler === undefined ? undefined : sd.samplers?.[sampler] };
};

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
  only(x, ['name', 'mesh', 'translation', 'rotation', 'euler', 'scale', 'repeat', 'model', 'values', 'on'], xat);
  need(x.values === undefined || x.model !== undefined, `${xat}/values`, 'needs model');
  need(x.rotation === undefined || x.euler === undefined, `${xat}/euler`, 'cannot stand next to rotation');
  if (x.mesh !== undefined) {
    need(Number.isInteger(x.mesh) && x.mesh >= 0 && x.mesh < meshCount, `${xat}/mesh`, `must be a recipe mesh index 0..${meshCount - 1}`);
  }
  if (n.matrix !== undefined) {
    need(x.on === undefined, `${at}/matrix`, `a node placed by ${EXT} on cannot have a matrix`);
    need(['translation', 'rotation', 'euler', 'scale'].every((k) => x[k] === undefined), `${at}/matrix`,
      `a node with a matrix cannot take translation, rotation, euler or scale from ${EXT}`);
    need(Array.isArray(n.matrix) && n.matrix.length === 16 && n.matrix.every((c) => typeof c === 'number'), `${at}/matrix`, 'must be a list of 16 numbers');
  }
  const pick = (k, size, dflt) => {
    if (x[k] !== undefined) return vec(x[k], size, scope, `${xat}/${k}`);
    if (n[k] === undefined || (x.on !== undefined && k !== 'scale')) return dflt; // with `on` they are cache
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
  // Draft f10 (D-79): a name template; {expression} is replaced by its value.
  let name = n.name;
  if (x.name !== undefined) {
    need(typeof x.name === 'string', `${xat}/name`, 'must be a string');
    name = x.name.replace(/\{([^{}]*)\}/g, (_, e) => fmt(num(e, scope, `${xat}/name`)));
    need(name !== '' && !/[{}]/.test(name), `${xat}/name`, 'must give a non-empty name without unmatched { or }');
  }
  return { name, mesh: x.mesh, translation, rotation, scale, matrix: n.matrix ?? compose(translation, rotation, scale), children, jig: x };
}

// Euler angles in degrees about glTF's (Y-up) axes: x, then y, then z, each about the fixed axes (matrix Rz·Ry·Rx), as a
// glTF quaternion. Not Blender's frame, which is Z-up (D-69).
export function eulerQuat(deg) {
  const [cx, cy, cz] = deg.map((d) => Math.cos((d * Math.PI) / 360)), [sx, sy, sz] = deg.map((d) => Math.sin((d * Math.PI) / 360));
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

function mesh(m, scope, at, materialCount) {
  need(isObj(m), at, 'must be an object');
  only(m, ['box', 'loft', 'extrude', 'lathe', 'material', 'uv'], at);
  need(Object.keys(m).filter((k) => !k.startsWith('//') && k !== 'material' && k !== 'uv').length === 1, at, 'must have one shape: box, loft, extrude or lathe');
  if (m.uv !== undefined) { // draft f11 (D-80): texture coordinates as fractions of the shape, or in meters
    need(UV.includes(m.uv), `${at}/uv`, `must be one of ${UV.map((u) => `"${u}"`).join(', ')}`);
    return { ...mesh({ ...m, uv: undefined }, scope, at, materialCount), uv: m.uv };
  }
  if (m.material !== undefined) { // sketch (draft f6): glTF's primitive.material
    need(Number.isInteger(m.material) && m.material >= 0 && m.material < materialCount, `${at}/material`, `must be a material index 0..${materialCount - 1}`);
    return { ...mesh({ ...m, material: undefined }, scope, at), material: m.material };
  }
  if (m.loft !== undefined) return loft(m.loft, scope, `${at}/loft`);
  if (m.extrude !== undefined) return extrude(m.extrude, scope, `${at}/extrude`);
  if (m.lathe !== undefined) return lathe(m.lathe, scope, `${at}/lathe`);
  const b = m.box;
  at += '/box';
  need(isObj(b), at, 'must be an object');
  only(b, ['size', 'radius'], at);
  const size = vec(b.size, 3, scope, `${at}/size`);
  size.forEach((s, i) => need(s > 0, `${at}/size/${i}`, `must be > 0, is ${s}`));
  // Draft f19 (D-98): every edge and corner rounded, clamped to half the smallest side.
  const radius = b.radius === undefined ? 0 : num(b.radius, scope, `${at}/radius`);
  need(radius >= 0, `${at}/radius`, `must be >= 0, is ${radius}`);
  return { type: 'box', size, ...(radius > 0 && { radius: Math.min(radius, ...size.map((s) => s / 2)) }) }; // centred on the origin
}

// --- Bake (D-11, D-14..D-17, D-23) ---

const OWNED = ['meshes', 'accessors', 'bufferViews', 'buffers', 'nodes', 'materials', 'skins', 'images', 'samplers', 'textures'];
const KHR_TT = 'KHR_texture_transform';
const KHR_VARIANTS = 'KHR_materials_variants';
const KHR_ES = 'KHR_materials_emissive_strength';
// Recipe slots kept in a material extension: [extension, default]; the bake writes the extension only off the default.
const EXT_SLOTS = { emissiveStrength: [KHR_ES, 1], transmissionFactor: ['KHR_materials_transmission', 0], ior: ['KHR_materials_ior', 1.5] };
const MATERIAL_EXTS = [KHR_TT, ...Object.values(EXT_SLOTS).map(([e]) => e)];
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
      else if (place === 'ext') { if (isObj(m.extensions)) { delete m.extensions[EXT_SLOTS[k][0]]; if (!Object.keys(m.extensions).length) delete m.extensions; } }
      else if (isObj(m.pbrMetallicRoughness)) delete m.pbrMetallicRoughness[k];
    }
    for (const [k, place] of Object.entries(TEXTURE_SLOTS)) { // the cache of a texture transform twin (draft f11)
      const core = place === 'top' ? m[k] : m.pbrMetallicRoughness?.[k];
      if (x[k] === undefined || !isObj(core?.extensions)) continue;
      delete core.extensions[KHR_TT];
      if (!Object.keys(core.extensions).length) delete core.extensions;
    }
    if (isObj(m.pbrMetallicRoughness) && !Object.keys(m.pbrMetallicRoughness).length) delete m.pbrMetallicRoughness;
  }
  for (const e of MATERIAL_EXTS) if (Array.isArray(d.extensionsUsed) && !JSON.stringify(d.materials ?? []).includes(`"${e}"`)) {
    d.extensionsUsed = d.extensionsUsed.filter((u) => u !== e);
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
    if (isObj(x)) for (const k of ['name', 'mesh', 'translation', 'rotation', 'scale']) if (twin(x, k) !== undefined) delete n[k];
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
  // Placed documents' materials (D-78): a baked material each, in order of first use.
  const placedAt = {}, texAt = {};
  const placedTexture = (i) => { // draft f11: a placed material's texture, with its image and sampler, as baked items
    const { texture, image, sampler } = out.placedTextures[i];
    return add('textures', { ...texture, source: add('images', image), ...(sampler && { sampler: add('samplers', sampler) }) });
  };
  const placedMaterial = (p) => {
    const mat = structuredClone(out.placed[p]);
    for (const slot of textureSlots(mat)) slot.index = (texAt[slot.index] ??= placedTexture(slot.index));
    return add('materials', mat);
  };
  const matIndex = (m) => (m.placed === undefined ? m.material : (placedAt[m.placed] ??= placedMaterial(m.placed)));
  // Only meshes a shown node draws unskinned are baked, in recipe order; meshAt maps recipe mesh to core mesh.
  const used = new Set(out.instances.filter((x) => !x.rec.bound).map((x) => x.mesh)), meshAt = {};
  for (const [mi, m] of out.meshes.entries()) {
    if (!used.has(mi)) continue;
    meshAt[mi] = base.meshes + Object.keys(meshAt).length;
    const { positions, normals, uvs, indices: all } = geometry(m);
    const short = positions.length / 3 <= 65535; // glTF reserves 65535 in 16-bit indices
    const indices = short ? Uint16Array.from(all) : all;
    const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
    const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
    const pos = add('accessors', { bufferView: view(positions, 34962), componentType: 5126, count: positions.length / 3,
      type: 'VEC3', min, max });
    const nor = add('accessors', { bufferView: view(normals, 34962), componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const tex = add('accessors', { bufferView: view(uvs, 34962), componentType: 5126, count: uvs.length / 2, type: 'VEC2' });
    const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
    const mat = matIndex(m);
    add('meshes', { primitives: [{ attributes: { POSITION: pos, NORMAL: nor, TEXCOORD_0: tex }, indices: idx, ...(mat !== undefined && { material: mat }),
      ...(mapping[m.material] && { extensions: { [KHR_VARIANTS]: { mappings: mapping[m.material] } } }) }] });
  }
  out.materials.forEach((m, i) => { if (m) slots(d.materials[i], m); }); // the material cache (D-57)
  for (const e of MATERIAL_EXTS) if (JSON.stringify(d.materials ?? []).includes(`"${e}"`) && !d.extensionsUsed.includes(e)) d.extensionsUsed.push(e);

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
    if (n.mesh !== undefined && !bound.has(i)) d.nodes[i].mesh = meshAt[n.mesh];
    for (const k of ['name', 'translation', 'rotation', 'scale']) if (twin(n.jig, k) !== undefined) d.nodes[i][k] = n[k];
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
      // D-97: a mirroring matrix (negative determinant) turns faces inside out once baked into vertices; flip winding back
      const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
      const tri = det < 0 ? Uint32Array.from(g.indices, (_, i) => g.indices[i - (i % 3) + [0, 2, 1][i % 3]]) : g.indices;
      const short = n <= 65535, indices = short ? Uint16Array.from(tri) : tri;
      const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
      const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
      const acc = (array, componentType, type, extra = {}) => add('accessors', { bufferView: view(array, 34962), componentType, count: n, type, ...extra });
      const attributes = { POSITION: acc(positions, 5126, 'VEC3', { min, max }), NORMAL: acc(normals, 5126, 'VEC3'),
        TEXCOORD_0: acc(g.uvs, 5126, 'VEC2'),
        JOINTS_0: acc(new Uint16Array(4 * n).map((_, i) => (i % 4 ? 0 : joint)), 5123, 'VEC4'),
        WEIGHTS_0: acc(new Float32Array(4 * n).map((_, i) => (i % 4 ? 0 : 1)), 5126, 'VEC4') };
      const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
      const mat = matIndex(out.meshes[x.mesh]), own = out.meshes[x.mesh].material;
      return { attributes, indices: idx, ...(mat !== undefined && { material: mat }),
        ...(mapping[own] && { extensions: { [KHR_VARIANTS]: { mappings: mapping[own] } } }) };
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

// Triangles of a recipe mesh: { positions, normals, uvs, indices } (Float32Array x 3, Uint32Array). uvs are
// TEXCOORD_0 in glTF's convention (draft f11, D-80): `"uv": "fit"` (default) fractions 0..1 of the shape, "meters"
// the same layout in meters.
export function geometry(m) {
  const fit = (m.uv ?? 'fit') === 'fit';
  if (m.type === 'loft') return loftGeometry(m, fit);
  if (m.type === 'extrude') return extrudeGeometry(m, fit);
  if (m.type === 'lathe') return latheGeometry(m, fit);
  const g = m.radius ? roundedBoxGeometry(m.size, m.radius, fit) : boxGeometry(m.size, fit);
  return { ...g, indices: Uint32Array.from(g.indices) };
}
const UV = ['fit', 'meters'];

// A flat face's coordinates: (u, v) in its own plane, seen from outside with +v up; fit to its bounds or in meters.
function planarUv(pts, fit) {
  const lo = [0, 1].map((a) => Math.min(...pts.map((p) => p[a]))), hi = [0, 1].map((a) => Math.max(...pts.map((p) => p[a])));
  return pts.map(([u, v]) => (fit ? [(u - lo[0]) / (hi[0] - lo[0] || 1), (hi[1] - v) / (hi[1] - lo[1] || 1)] : [u, -v]));
}

// Box centred on the origin: 6 faces x 4 corners, outward normals, counter-clockwise seen from outside.
function boxGeometry(size, fit = true) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const u = (a + 1) % 3, v = (a + 2) % 3, first = positions.length / 3;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]; // counter-clockwise around +a, since u x v = a
    if (s < 0) corners.reverse();
    for (const [cu, cv] of corners) {
      const p = [0, 0, 0], n = [0, 0, 0];
      p[a] = (s * size[a]) / 2; p[u] = (cu * size[u]) / 2; p[v] = (cv * size[v]) / 2; n[a] = s;
      positions.push(...p); normals.push(...n);
    }
    // seen from outside: u runs along +u on a + face, back along it on a − face
    uvs.push(...planarUv(corners.map(([cu, cv]) => [(s * cu * size[u]) / 2, (cv * size[v]) / 2]), fit).flat());
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint16Array(indices) };
}

// Rounded box (D-98): each face a 6 x 6 grid whose outer two rows on each side are half the rounding (0°, 22.5°,
// 45° from the face), so faces meet at 45° with equal positions and normals. A point is the inner box's nearest
// point plus r along the normal; edges are quarter circles of BEVEL_STEPS segments, corners sphere octants.
function roundedBoxGeometry(size, r, fit = true) {
  const positions = [], normals = [], uvs = [], indices = [], t = Math.tan(Math.PI / 8);
  // Along a face axis of half-size h: [inner coordinate, normal component before normalizing].
  const steps = (h) => [[-(h - r), -1], [-(h - r), -t], [-(h - r), 0], [h - r, 0], [h - r, t], [h - r, 1]];
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const u = (a + 1) % 3, v = (a + 2) % 3, first = positions.length / 3, flat = [];
    const su = steps(size[u] / 2), sv = steps(size[v] / 2);
    for (const [iv, dv] of sv) for (const [iu, du] of su) {
      const d = [0, 0, 0], c = [0, 0, 0];
      d[a] = s; d[u] = du; d[v] = dv;
      c[a] = s * (size[a] / 2 - r); c[u] = iu; c[v] = iv;
      const n = norm(d), p = c.map((x, k) => x + r * n[k]);
      positions.push(...p); normals.push(...n); flat.push([s * p[u], p[v]]); // seen from outside, as boxGeometry
    }
    uvs.push(...planarUv(flat, fit).flat());
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
      const q = first + j * 6 + i; // u x v = a: counter-clockwise on a + face, reversed on a − face
      if (s > 0) indices.push(q, q + 1, q + 7, q, q + 7, q + 6);
      else indices.push(q, q + 7, q + 1, q, q + 6, q + 7);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
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
    if (meshes[mi].type !== 'box' || meshes[mi].radius) { low = Math.min(low, lowestOnTriangles(geometry(meshes[mi]), m)); continue; }
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
// smoothly (`blend`); before the first and after the last section the shape holds. Ends are capped as `caps` says.

function loft(l, scope, at) {
  need(isObj(l), at, 'must be an object');
  only(l, ['path', 'sections', 'sides', 'steps', 'blend', 'caps', 'cap_depth', 'closed'], at);
  need(l.closed === undefined || typeof l.closed === 'boolean', `${at}/closed`, 'must be true or false');
  const closed = l.closed === true;
  need(!closed || l.caps === undefined, `${at}/caps`, 'a closed loft has no ends to cap (D-93)');
  const { path, radius } = pathOf(l.path, closed, scope, `${at}/path`);
  const curve = loftCurve({ path, radius, closed }), length = curveLength(curve);
  const sections = list(l.sections, `${at}/sections`).map((s, i) => {
    const sat = `${at}/sections/${i}`;
    need(isObj(s), sat, 'must be an object');
    only(s, ['t', 'd', 'points', 'twist'], sat);
    need((s.t === undefined) !== (s.d === undefined), sat, 'needs t or d, not both (D-94)');
    let t;
    if (s.t !== undefined) {
      t = num(s.t, scope, `${sat}/t`);
      need(t >= 0 && t <= 1, `${sat}/t`, `must be in 0..1, is ${t}`);
    } else {
      // Metres from the start, or from the end when negative; clamped to the curve, so a parameter may drive it.
      const d = num(s.d, scope, `${sat}/d`);
      t = Math.min(1, Math.max(0, (d < 0 ? length + d : d) / length));
    }
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
  // A closed loft has no ends (D-93): both read as "none", so no flat cap or dome is built.
  const caps = closed ? { start: 'none', end: 'none' } : capsOf(l.caps, `${at}/caps`, true), dome = [caps?.start, caps?.end].includes('dome');
  // Draft f17 (D-100): a dome's depth as a fraction of its end ring's mean radius.
  need(l.cap_depth === undefined || dome, `${at}/cap_depth`, 'needs a "dome" cap');
  const capDepth = l.cap_depth === undefined ? 1 : num(l.cap_depth, scope, `${at}/cap_depth`);
  need(capDepth > 0, `${at}/cap_depth`, `must be > 0, is ${capDepth}`);
  const m = { type: 'loft', path, sections, sides: int('sides', 24, 3, 256), steps: int('steps', 48, 1, 1024), blend, ...(caps && { caps }), ...(dome && { capDepth }),
    ...(radius && { radius }), ...(closed && { closed }) };
  // The caps are the first and last section's rings as loftGeometry builds them; triangulate them here to name the section.
  const sorted = [...sections].sort((a, b) => a.t - b.t), spans = edgeSpans(sorted, m.sides);
  for (const [s, end] of [[sorted[0], 'start'], [sorted[sorted.length - 1], 'end']]) {
    // shortcut: a dome over a section that is not star-shaped about its centroid folds without an error; add the check when a model hits it.
    if (capKind(caps, end) !== 'flat') continue;
    const ring = resample(s.points, spans);
    try { triangulate([area(ring) > 0 ? ring : ring.reverse()]); } catch { need(false, `${at}/sections/${sections.indexOf(s)}/points`, 'outline crosses itself'); }
  }
  return m;
}

// Draft f13 (D-90): which ends get a flat cap; an open end shows the inside only through a doubleSided material.
// Draft f17 (D-100): or per end { start, end }: "flat" (default), "dome" (a loft only) or "none". Read as
// { start, end }, or undefined for both flat.
const CAPS = ['both', 'start', 'end', 'none'];
function capsOf(c = 'both', at, domes = false) {
  if (isObj(c)) {
    only(c, ['start', 'end'], at);
    const kinds = domes ? ['flat', 'dome', 'none'] : ['flat', 'none'];
    for (const e of ['start', 'end']) need(c[e] === undefined || kinds.includes(c[e]), `${at}/${e}`, `must be one of ${kinds.map((x) => `"${x}"`).join(', ')}`);
    c = { start: c.start ?? 'flat', end: c.end ?? 'flat' };
  } else {
    need(CAPS.includes(c), at, `must be one of ${CAPS.map((x) => `"${x}"`).join(', ')}${domes ? ', or { "start", "end" }' : ', or { "start", "end" } of "flat" or "none"'}`);
    c = { start: ['both', 'start'].includes(c) ? 'flat' : 'none', end: ['both', 'end'].includes(c) ? 'flat' : 'none' };
  }
  return c.start === 'flat' && c.end === 'flat' ? undefined : c;
}
const capKind = (caps, end) => caps?.[end] ?? 'flat';

// Draft f16: the path as points [x, y, z], and their corner radii (D-99) when any point has one. An item is a point,
// a point with a radius [x, y, z, { radius }], or an arc or spiral that stands for its points.
function pathOf(items, closed, scope, at) {
  const path = [], radius = [], from = []; // from: the item each point came from, for errors
  list(items, at).forEach((p, i) => {
    const pat = `${at}/${i}`;
    if (isObj(p)) {
      const q = curvePoints(p, scope, pat);
      if (path.length && dist(q[0], path[path.length - 1]) <= 1e-9) q.shift(); // an arc may start on the point before it
      for (const x of q) { path.push(x); radius.push(undefined); from.push(pat); }
      return;
    }
    need(Array.isArray(p) && (p.length === 3 || p.length === 4), pat, 'must be [x, y, z], [x, y, z, { "radius": r }], an arc or a spiral');
    let r;
    if (p.length === 4) {
      need(isObj(p[3]), `${pat}/3`, 'must be { "radius": r }');
      only(p[3], ['radius'], `${pat}/3`);
      r = num(p[3].radius, scope, `${pat}/3/radius`);
      need(r > 0, `${pat}/3/radius`, `must be > 0, is ${r}`);
    }
    path.push(vec(p.slice(0, 3), 3, scope, pat)); radius.push(r); from.push(pat);
  });
  // A closed path may end on its first point (a whole-circle arc); that point is the first one again.
  if (closed && path.length > 1 && dist(path[0], path[path.length - 1]) <= 1e-9) { path.pop(); radius.pop(); from.pop(); }
  need(path.length >= (closed ? 3 : 2), at, `needs at least ${closed ? 3 : 2} points`);
  path.forEach((p, i) => need(i === 0 || dist(p, path[i - 1]) > 1e-9, from[i], 'repeats the point before it'));
  if (radius.every((r) => r === undefined)) return { path };
  const n = path.length, ends = (i) => !closed && (i === 0 || i === n - 1);
  need(!from.some((f, i) => f !== `${at}/${i}`), at, 'a path with a corner radius takes no arc or spiral (D-99)');
  const lens = path.map((p, i) => {
    if (ends(i)) { need(radius[i] === undefined, `${at}/${i}/3`, 'an end of an open path is no corner'); return 0; }
    const a = norm(sub(path[(i + n - 1) % n], p)), b = norm(sub(path[(i + 1) % n], p)), c = dot(a, b);
    need(c < 1 - 1e-9, `${at}/${i}`, 'turns straight back');
    if (c < -1 + 1e-9) return 0; // straight on: no corner
    need(radius[i] !== undefined, `${at}/${i}`, 'is a corner and needs a radius: a path with one is straight lines with round corners (D-99)');
    return radius[i] * Math.sqrt((1 + c) / (1 - c)); // r / tan(half the corner angle)
  });
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    need(lens[i] + lens[j] <= dist(path[i], path[j]) + 1e-9, `${at}/${radius[j] !== undefined ? j : i}/3/radius`, 'is too large: the round corners overlap');
  }
  return { path, radius: radius.map((r) => r ?? 0) };
}

// Draft f16 (D-99): an arc { center, radius, from, to, plane } or a spiral (radius [r0, r1], growing evenly with the
// angle) as points at most 15 degrees apart, both ends included. Angles in degrees: in plane "xy" from +x toward +y,
// "yz" from +y toward +z, "zx" from +z toward +x.
const PLANES = { xy: [0, 1], yz: [1, 2], zx: [2, 0] };
function curvePoints(g, scope, at) {
  const kind = Object.keys(g).filter((k) => !k.startsWith('//'));
  need(kind.length === 1 && (kind[0] === 'arc' || kind[0] === 'spiral'), at, 'must be { "arc": {...} } or { "spiral": {...} }');
  const a = g[kind[0]], aat = `${at}/${kind[0]}`;
  need(isObj(a), aat, 'must be an object');
  only(a, ['center', 'radius', 'from', 'to', 'plane'], aat);
  const c = vec(a.center, 3, scope, `${aat}/center`);
  const [r0, r1] = kind[0] === 'arc' ? Array(2).fill(num(a.radius, scope, `${aat}/radius`)) : vec(a.radius, 2, scope, `${aat}/radius`);
  need(kind[0] === 'arc' ? r0 > 0 : r0 >= 0 && r1 >= 0 && r0 + r1 > 0, `${aat}/radius`, kind[0] === 'arc' ? `must be > 0, is ${r0}` : 'must be >= 0 and not both 0');
  const f = num(a.from, scope, `${aat}/from`), t = num(a.to, scope, `${aat}/to`);
  need(f !== t, `${aat}/to`, 'must differ from from');
  const plane = a.plane ?? 'xy';
  need(PLANES[plane], `${aat}/plane`, 'must be one of "xy", "yz", "zx"');
  const [i, j] = PLANES[plane], n = Math.ceil(Math.abs(t - f) / 15);
  return Array.from({ length: n + 1 }, (_, k) => {
    const g2 = (f + ((t - f) * k) / n) * (Math.PI / 180), r = r0 + ((r1 - r0) * k) / n, p = [...c];
    p[i] += r * Math.cos(g2); p[j] += r * Math.sin(g2);
    return p;
  });
}

// Draft f13 (D-89): a circle or ellipse section as 4 smooth points (from +u, counter-clockwise) with the standard
// quarter-circle handle, so it meets point k of a 4-point section.
const KAPPA = (4 * (Math.SQRT2 - 1)) / 3;
// Draft f20 (D-105): { "squircle": [rx, ry, n] }, the same 4 points with handles k·r that put each quarter's
// midpoint on the superellipse |u/rx|^n + |v/ry|^n = 1: k = (8·2^(−1/n) − 4) / 3, so n 2 gives KAPPA and n 1 a
// diamond (k 0); k stops at 1 (n ≈ 5.2) so the curve stays inside its box.
function roundSection(x, scope, at) {
  only(x, ['circle', 'ellipse', 'squircle', 'center'], at);
  const keys = Object.keys(x).filter((k) => !k.startsWith('//') && k !== 'center');
  need(keys.length === 1, at, 'must be { "circle": r }, { "ellipse": [rx, ry] } or { "squircle": [rx, ry, n] }');
  let k = KAPPA, rx, ry;
  if (x.squircle !== undefined) {
    let n;
    [rx, ry, n] = vec(x.squircle, 3, scope, `${at}/squircle`);
    need(n >= 1, `${at}/squircle/2`, `must be >= 1, is ${n}`);
    k = Math.min(1, (8 * 2 ** (-1 / n) - 4) / 3);
  } else [rx, ry] = x.circle !== undefined ? Array(2).fill(num(x.circle, scope, `${at}/circle`)) : vec(x.ellipse, 2, scope, `${at}/ellipse`);
  need(rx > 0 && ry > 0, `${at}/${keys[0]}`, `must be > 0, is ${x.circle !== undefined ? rx : [rx, ry]}`);
  const kx = k * rx, ky = k * ry, [cu, cv] = x.center === undefined ? [0, 0] : vec(x.center, 2, scope, `${at}/center`); // draft f21
  return [[cu + rx, cv, 0, ky], [cu, cv + ry, -kx, 0], [cu - rx, cv, 0, -ky], [cu, cv - ry, kx, 0]];
}

// Draft f17 (D-101): { flutes: { count, r, depth } }, a circle of radius r with `count` grooves, 2 points per
// flute from +u, counter-clockwise: an arris [u, v, ou, ov, iu, iv] on the circle, then the groove's bottom, smooth,
// depth in from it, halfway to the next arris. Each groove is the circular arc through its two arrises and its
// bottom (as bezier quarter-arcs), so depth 0 is the circle itself and the arrises stay sharp otherwise.
function flutes(x, scope, at) {
  only(x, ['flutes'], at);
  need(isObj(x.flutes), `${at}/flutes`, 'must be { "count", "r", "depth" }');
  only(x.flutes, ['count', 'r', 'depth'], `${at}/flutes`);
  const count = Math.round(num(x.flutes.count, scope, `${at}/flutes/count`));
  need(count >= 3, `${at}/flutes/count`, `must be >= 3, is ${count}`);
  const r = num(x.flutes.r, scope, `${at}/flutes/r`);
  need(r > 0, `${at}/flutes/r`, `must be > 0, is ${r}`);
  const depth = num(x.flutes.depth, scope, `${at}/flutes/depth`);
  need(depth >= 0 && depth < r, `${at}/flutes/depth`, `must be in 0..r (${r}), less than r, is ${depth}`);
  // One groove with its bottom on +x: arris A = (a, -s), bottom B = (b, 0). The arc's end tangents make equal
  // angles with the chord A→B; handle length (2/3)·c / (1 + cos(half the turn)), cos = s / c.
  const h = Math.PI / count, a = r * Math.cos(h), s = r * Math.sin(h), b = r - depth;
  const c = Math.hypot(b - a, s), L = ((2 / 3) * c * c) / (c + s), ch = [(b - a) / c, s / c];
  const tA = [2 * (s / c) * ch[0], 2 * (s / c) * ch[1] - 1]; // the tangent at B, (0, 1), mirrored in the chord
  const rot = (th, [u, v]) => [u * Math.cos(th) - v * Math.sin(th), u * Math.sin(th) + v * Math.cos(th)];
  return Array.from({ length: count }, (_, i) => {
    const g = (2 * i + 1) * h, A = rot(g, [a, -s]), out = rot(g, [L * tA[0], L * tA[1]]), inn = rot(g - 2 * h, [L * tA[0], -L * tA[1]]);
    return [[...A, ...out, ...inn], [...rot(g, [b, 0]), ...rot(g, [0, L])]];
  }).flat();
}

// A closed outline in loft's point form (D-39): [u, v] corners, [u, v, hu, hv] smooth points and (D-83)
// [u, v, ou, ov, iu, iv] points with free handles.
// Or a round form (D-89, D-101, D-105) standing for its points.
function points(x, scope, at) {
  if (isObj(x)) return x.flutes !== undefined ? flutes(x, scope, at) : roundSection(x, scope, at);
  const pts = pointList(x, scope, at, true);
  need(pts.length >= 3, at, 'needs at least 3 points');
  need(Math.abs(area(outline(pts))) > 1e-12, at, 'must enclose an area');
  return pts;
}

// Points, or (draft f21) an arc item that stands for its points. An arc's end that lands on the point next to it
// (or, closed, on the first or last point round the seam) is one point: the in handle of the earlier, the out
// handle of the later.
// shortcut: errors found later (crossings) name points by their place after arcs are expanded; map back when it confuses.
function pointList(x, scope, at, closed = false) {
  const pts = [], arc = [];
  list(x, at).forEach((p, j) => {
    if (isObj(p)) { const q = arcPoints(p, scope, `${at}/${j}`); pts.push(...q); arc.push(...q.map((_, k) => k === 0 || k === q.length - 1)); return; }
    need(Array.isArray(p) && [2, 4, 6].includes(p.length), `${at}/${j}`, 'must be [u, v], [u, v, hu, hv] or [u, v, ou, ov, iu, iv], or an arc');
    pts.push(p.map((e, k) => num(e, scope, `${at}/${j}/${k}`))); arc.push(false);
  });
  const join = (a, b) => { // a before b, at the same place
    const [ou, ov] = b.length >= 4 ? [b[2], b[3]] : [0, 0], [iu, iv] = inHandle(a);
    return !ou && !ov && !iu && !iv ? a.slice(0, 2) : ou === -iu && ov === -iv ? [a[0], a[1], ou, ov] : [a[0], a[1], ou, ov, iu, iv];
  };
  const same = (a, b) => Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9;
  for (let k = pts.length - 1; k > 0; k--) if ((arc[k] || arc[k - 1]) && same(pts[k - 1], pts[k])) { pts.splice(k - 1, 2, join(pts[k - 1], pts[k])); arc.splice(k, 1); }
  if (closed && pts.length > 1 && (arc[0] || arc[pts.length - 1]) && same(pts[pts.length - 1], pts[0])) pts[0] = join(pts.pop(), pts[0]);
  return pts;
}

// Draft f21: { "arc": { center, radius, from, to } } in an outline: the elliptical arc (u, v) = center +
// (rx cos a, ry sin a) from angle `from` to `to` (degrees, from +u toward +v; to < from runs clockwise), as
// ceil(|to − from| / 90) bezier pieces with handles (4/3)·tan(θ/4) of the tangent: free-handle ends (no handle
// outside the arc), smooth points between.
function arcPoints(p, scope, at) {
  only(p, ['arc'], at);
  const a = p.arc, aat = `${at}/arc`;
  need(isObj(a), aat, 'must be { "center", "radius", "from", "to" }');
  only(a, ['center', 'radius', 'from', 'to'], aat);
  const [cu, cv] = vec(a.center, 2, scope, `${aat}/center`);
  const [rx, ry] = Array.isArray(a.radius) ? vec(a.radius, 2, scope, `${aat}/radius`) : Array(2).fill(num(a.radius, scope, `${aat}/radius`));
  need(rx > 0 && ry > 0, `${aat}/radius`, `must be > 0, is ${Array.isArray(a.radius) ? [rx, ry] : rx}`);
  const f = num(a.from, scope, `${aat}/from`), t = num(a.to, scope, `${aat}/to`);
  need(f !== t && Math.abs(t - f) <= 360, `${aat}/to`, `must differ from from by at most 360, is ${t} (from ${f})`);
  const n = Math.ceil(Math.abs(t - f) / 90 - 1e-9), step = ((t - f) / n) * (Math.PI / 180), k = (4 / 3) * Math.tan(step / 4);
  return Array.from({ length: n + 1 }, (_, i) => {
    const d = f + ((t - f) * i) / n, [c, s] = d % 90 === 0 ? [[1, 0], [0, 1], [-1, 0], [0, -1]][((d / 90) % 4 + 4) % 4] : [Math.cos(d * (Math.PI / 180)), Math.sin(d * (Math.PI / 180))]; // exact on the axes
    const P = [cu + rx * c, cv + ry * s], h = [-k * rx * s || 0, k * ry * c || 0]; // || 0: no -0
    return i === 0 ? [...P, ...h, 0, 0] : i === n ? [...P, 0, 0, -h[0] || 0, -h[1] || 0] : [...P, ...h];
  });
}

// Draft f9: a flat outline with holes, in loft's point form, in the xy plane, pushed along z by depth, centred on
// the origin like a box.
function extrude(e, scope, at) {
  need(isObj(e), at, 'must be an object');
  only(e, ['outline', 'holes', 'depth', 'bevel'], at);
  const out = points(e.outline, scope, `${at}/outline`);
  const holes = e.holes === undefined ? [] : list(e.holes, `${at}/holes`).map((h, i) => points(h, scope, `${at}/holes/${i}`));
  const poly = outline(out);
  // shortcut: checks one point of each hole, not that holes stay clear of the outline and of each other; upgrade
  // when a model needs that error.
  holes.forEach((h, i) => need(inside(h[0], poly), `${at}/holes/${i}`, 'must lie inside the outline'));
  crossings([out, ...holes], at);
  const depth = num(e.depth, scope, `${at}/depth`);
  need(depth > 0, `${at}/depth`, `must be > 0, is ${depth}`);
  // Draft f12 (D-86): a round edge on both rims, its radius at most half the depth.
  const bevel = e.bevel === undefined ? 0 : num(e.bevel, scope, `${at}/bevel`);
  need(bevel >= 0 && bevel <= depth / 2, `${at}/bevel`, `must be in 0..depth / 2 (${depth / 2}), is ${bevel}`);
  const m = { type: 'extrude', outline: out, holes, depth, ...(bevel > 0 && { bevel }) };
  try { extrudeGeometry(m); } catch (err) { need(false, at, err.message.replace(/^\/: /, '')); } // caps that cannot be triangulated (D-66)
  return m;
}
// Names the first two edges of the outline and holes that cross: `…/outline/3: its edge to point 4 crosses the edge
// from point 0 to 1`. Edges are checked as drawn (curves as their samples).
function crossings(loops, at) {
  const name = (i) => (i === 0 ? 'outline' : `holes/${i - 1}`);
  const segs = loops.flatMap((pts, i) => {
    const { poly, starts } = flatten(pts);
    return poly.map((a, q) => ({ a, b: poly[(q + 1) % poly.length], i, k: starts.findLastIndex((s) => s <= q), n: pts.length }));
  });
  for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) {
    const s = segs[x], t = segs[y];
    if (!crossAt(s.a, s.b, t.a, t.b)) continue;
    const other = t.i === s.i ? `the edge from point ${t.k} to ${(t.k + 1) % t.n}` : `${name(t.i)} edge from point ${t.k} to ${(t.k + 1) % t.n}`;
    need(false, `${at}/${name(s.i)}/${s.k}`, `its edge to point ${(s.k + 1) % s.n} crosses ${other}${s.k === t.k && t.i === s.i ? ' (a handle points backwards?)' : ''}`);
  }
}
// The point where segments ab and cd cross, not just touch at an end; else null.
function crossAt(a, b, c, d) {
  const r = sub(b, a), q = sub(d, c), den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-15) return null;
  const ca = sub(c, a), t = (ca[0] * q[1] - ca[1] * q[0]) / den, u = (ca[0] * r[1] - ca[1] * r[0]) / den, e = 1e-9;
  return t > e && t < 1 - e && u > e && u < 1 - e ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}
// An inset ring with its swallowtails cut out: where an edge crosses a later one (an inset deeper than the curve's
// radius there), the points between move to the crossing, so the ring keeps its point count for the walls.
function untangle(ring) {
  const L = ring.length, p = ring.map((v) => [...v]);
  for (let i = 0; i < L; i++) {
    for (let s = 2; s <= L / 2; s++) {
      const j = (i + s) % L, x = crossAt(p[i], p[(i + 1) % L], p[j], p[(j + 1) % L]);
      if (!x) continue;
      for (let k = 1; k <= s; k++) p[(i + k) % L] = [...x];
      i += s - 1;
      break;
    }
  }
  return p;
}
const inside = ([x, y], poly) => poly.reduce((c, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return (p[1] > y) !== (q[1] > y) && x < p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]) ? !c : c;
}, false);

// Caps: ear clipping, holes first bridged to the outline. Walls: a quad per outline edge, smooth normals across
// curve samples and smooth points, split at corners. A bevel (D-86) insets the caps by its radius and joins them to
// the walls by a quarter circle of BEVEL_STEPS rings.
const BEVEL_STEPS = 4;
function extrudeGeometry(m, fit = true) {
  const loops = [m.outline, ...m.holes].map((pts, i) => {
    const { poly, starts } = flatten(pts);
    const hard = new Set(starts.filter((_, k) => corner(pts[k])));
    const keep = (area(poly) > 0) === (i === 0); // outline counter-clockwise, holes clockwise
    const order = keep ? poly.map((_, k) => k) : poly.map((_, k) => (poly.length - k) % poly.length);
    return { poly: order.map((k) => poly[k]), hard: order.map((k) => hard.has(k)) };
  });
  const positions = [], normals = [], uvs = [], indices = [], h = m.depth / 2, r = m.bevel ?? 0;
  // Each loop's outward edge normals and, per point, the miter: the offset that moves both edges by 1.
  for (const l of loops) {
    const L = l.poly.length;
    l.edge = l.poly.map((a, k) => { const b = l.poly[(k + 1) % L]; return norm([b[1] - a[1], a[0] - b[0], 0]); });
    l.miter = l.poly.map((_, k) => {
      const e0 = l.edge[(k + L - 1) % L], e1 = l.edge[k], bis = norm(e0.map((c, q) => c + e1[q]));
      return scale(bis, 1 / Math.max(0.2, dot(bis, e1))); // shortcut: miters capped at 5x; insets of sharp spikes overlap
    });
    l.inset = (d) => (d === 0 ? l.poly : untangle(l.poly.map((p, k) => [p[0] - d * l.miter[k][0], p[1] - d * l.miter[k][1]])));
  }
  const flat = loops.flatMap((l) => l.inset(r));
  const tris = triangulate(loops.map((l) => l.inset(r)));
  for (const [z, s] of [[h, 1], [-h, -1]]) {
    const first = positions.length / 3;
    for (const [x, y] of flat) { positions.push(x, y, z); normals.push(0, 0, s); }
    uvs.push(...planarUv(flat.map(([x, y]) => [s * x, y]), fit).flat()); // seen from outside
    for (let k = 0; k < tris.length; k += 3) {
      const t = s > 0 ? [tris[k], tris[k + 1], tris[k + 2]] : [tris[k], tris[k + 2], tris[k + 1]];
      indices.push(...t.map((i) => first + i));
    }
  }
  // Rings up the side, bottom to top: { z, d: inset, s, c: the normal's share across and along z }.
  const rings = r === 0 ? [{ z: -h, d: 0, s: 1, c: 0 }, { z: h, d: 0, s: 1, c: 0 }] : [-1, 1].flatMap((side) =>
    Array.from({ length: BEVEL_STEPS + 1 }, (_, j) => {
      const th = ((side < 0 ? j : BEVEL_STEPS - j) / BEVEL_STEPS) * (Math.PI / 2); // 0 at the cap's edge
      return { z: side * (h - r * (1 - Math.cos(th))), d: r * (1 - Math.sin(th)), s: Math.sin(th), c: side * Math.cos(th) };
    }));
  for (const l of loops) {
    const { poly, hard, edge } = l, L = poly.length, along = [0], ring = rings.map((g) => l.inset(g.d));
    for (let k = 0; k < L; k++) along.push(along[k] + dist(poly[k], poly[(k + 1) % L]));
    const U = (k) => (fit ? along[k] / along[L] : along[k]), V = (z) => (fit ? (h - z) / m.depth : h - z);
    const at = (k, e) => (hard[k % L] ? edge[e % L] : norm(edge[(k + L - 1) % L].map((c, q) => c + edge[k % L][q])));
    const tilt = (n, g) => (g.c === 0 ? n : norm([n[0] * g.s, n[1] * g.s, g.c]));
    for (let k = 0; k < L; k++) {
      const na = at(k, k), nb = at(k + 1, k);
      for (let j = 0; j + 1 < rings.length; j++) {
        const first = positions.length / 3;
        for (const [i, nn, r, e] of [[k, na, j, k], [(k + 1) % L, nb, j, k + 1], [(k + 1) % L, nb, j + 1, k + 1], [k, na, j + 1, k]]) {
          const g = rings[r];
          positions.push(ring[r][i][0], ring[r][i][1], g.z); normals.push(...tilt(nn, g)); uvs.push(U(e), V(g.z));
        }
        indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

// --- Lathe (draft f13, D-88) ---
// { profile: [[r, y, ...handles], ...], sides, caps }: an open profile in loft's point form, r ≥ 0, revolved about
// the y axis. The solid is the region between the profile and the axis; the surface faces away from it, whichever
// way the profile runs. An end at r = 0 closes to a point; an end at r > 0 gets a flat cap unless `caps` leaves it
// open (D-90). Laid out as a loft up +y with circle sections: point 0 of each ring at +x, then toward −z.

function lathe(l, scope, at) {
  need(isObj(l), at, 'must be an object');
  only(l, ['profile', 'sides', 'caps'], at);
  const profile = pointList(l.profile, scope, `${at}/profile`);
  need(profile.length >= 2, `${at}/profile`, 'needs at least 2 points');
  profile.forEach((p, j) => {
    need(p[0] >= 0, `${at}/profile/${j}/0`, `must be >= 0 (a radius), is ${p[0]}`);
    need(j === 0 || dist(p.slice(0, 2), profile[j - 1].slice(0, 2)) > 1e-9, `${at}/profile/${j}`, 'repeats the point before it');
  });
  const { poly } = profileLine(profile);
  need(poly.every(([r]) => r > -1e-9), `${at}/profile`, 'crosses the axis (r < 0) between its points');
  need(Math.abs(area(closeOnAxis(poly))) > 1e-12, `${at}/profile`, 'must enclose an area with the axis');
  // Rounded, then clamped, as a loft's (D-37).
  const sides = Math.min(256, Math.max(3, Math.round(l.sides === undefined ? 24 : num(l.sides, scope, `${at}/sides`))));
  const caps = capsOf(l.caps, `${at}/caps`);
  return { type: 'lathe', profile, sides, ...(caps && { caps }) };
}

// The open profile as a polyline (the closing edge left out), and the polyline indices of its inner corners.
function profileLine(pts) {
  const { poly, starts } = flatten(pts);
  return { poly: poly.slice(0, starts[starts.length - 1] + 1), hard: starts.filter((_, k) => k > 0 && k < pts.length - 1 && corner(pts[k])) };
}
const closeOnAxis = (poly) => [...poly, [0, poly[poly.length - 1][1]], [0, poly[0][1]]];

// A strip of rings per run of the profile between corners (so normals split there), each ring closed by a seam
// copy of its point 0; normals square to the profile. uv as a loft's (D-80): u round the ring, v along the profile.
function latheGeometry(m, fit = true) {
  const { poly, hard } = profileLine(m.profile), n = m.sides, w = n + 1;
  const out = area(closeOnAxis(poly)) > 0; // counter-clockwise round the solid: quads as listed face out
  const along = [0];
  for (let i = 1; i < poly.length; i++) along.push(along[i - 1] + dist(poly[i], poly[i - 1]));
  const L = along[along.length - 1], ang = (j) => (2 * Math.PI * j) / n;
  const positions = [], normals = [], uvs = [], indices = [];
  const cuts = [0, ...hard, poly.length - 1];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const s = cuts[c], e = cuts[c + 1], first = positions.length / 3;
    for (let i = s; i <= e; i++) {
      const [tr, ty] = sub(poly[Math.min(i + 1, e)], poly[Math.max(i - 1, s)]), [nr, ny] = norm(out ? [ty, -tr] : [-ty, tr]);
      for (let j = 0; j < w; j++) {
        const [r, y] = poly[i], a = ang(j), cs = Math.cos(a), sn = Math.sin(a);
        positions.push(r * cs, y, -r * sn); normals.push(nr * cs, ny, -nr * sn);
        uvs.push(fit ? j / n : r * a, fit ? along[i] / L : along[i]);
      }
    }
    for (let i = 0; i < e - s; i++) for (let j = 0; j < n; j++) {
      const a = first + i * w + j, a1 = a + 1, b = a + w, b1 = a1 + w;
      indices.push(...(out ? [a, a1, b1, a, b1, b] : [a, b1, a1, a, b, b1]));
    }
  }
  // Flat caps at ends off the axis, facing away from the solid; coordinates as a loft cap's.
  for (const [i, end, s] of [[0, 'start', out ? -1 : 1], [poly.length - 1, 'end', out ? 1 : -1]]) {
    const [r, y] = poly[i];
    if (r < 1e-9 || capKind(m.caps, end) !== 'flat') continue;
    const first = positions.length / 3, ring = Array.from({ length: n }, (_, j) => [r * Math.cos(ang(j)), r * Math.sin(ang(j))]);
    for (const [u, v] of ring) { positions.push(u, y, -v); normals.push(0, s, 0); }
    uvs.push(...planarUv(ring.map(([u, v]) => [s * u, v]), fit).flat());
    for (let j = 1; j + 1 < n; j++) indices.push(...(s > 0 ? [0, j, j + 1] : [0, j + 1, j]).map((k) => first + k)); // a fan faces +y
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
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
    need(cut >= 0, '', 'cannot be triangulated (its edges cross)');
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
// without twist. Centripetal Catmull-Rom through the path, its ends extended by reflection; or round the path back
// to its first point when closed, where y is turned evenly along the curve to meet itself (D-93). With corner radii
// (D-99) straight lines between the points with a circular arc at each corner.
export function loftCurve(m) {
  const P = m.path, n = P.length, closed = !!m.closed, spans = closed ? n : n - 1;
  const pts = [], seg = [], tan = []; // tan: the exact tangent where known (straight lines and arcs)
  if (m.radius) {
    P.forEach((p, i) => {
      const r = m.radius[i], prev = P[(i + n - 1) % n], next = P[(i + 1) % n];
      if (!r) { pts.push(p); seg.push(Math.min(i, spans - 1)); tan.push(norm(sub(i === n - 1 && !closed ? p : next, i === n - 1 && !closed ? prev : p))); return; }
      const a = norm(sub(prev, p)), b = norm(sub(next, p)), c = dot(a, b), L = r * Math.sqrt((1 + c) / (1 - c));
      const centre = [0, 1, 2].map((q) => p[q] + norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]])[q] * Math.hypot(L, r));
      const u = sub(sub(p, scale(a, -L)), centre), w = sub(sub(p, scale(b, -L)), centre), turn = Math.acos(Math.max(-1, Math.min(1, -c))); // u, w: centre to the arc's ends
      for (let k = 0; k <= SAMPLES; k++) {
        const f = (k / SAMPLES) * turn, s0 = Math.sin(turn - f) / Math.sin(turn), s1 = Math.sin(f) / Math.sin(turn); // slerp
        const d = [0, 1, 2].map((q) => s0 * u[q] + s1 * w[q]);
        pts.push(centre.map((q, k2) => q + d[k2])); seg.push(Math.min(i, spans - 1));
        tan.push(norm([0, 1, 2].map((q) => (-Math.cos(turn - f) * u[q] + Math.cos(f) * w[q]) / Math.sin(turn))));
      }
    });
    if (closed) { pts.push(pts[0]); seg.push(n - 1); tan.push(tan[0]); }
  } else {
    const ext = closed ? [P[n - 1], ...P, P[0], P[1]] : [sub(scale(P[0], 2), P[1]), ...P, sub(scale(P[n - 1], 2), P[n - 2])];
    for (let i = 0; i < spans; i++) {
      for (let k = 0; k < SAMPLES; k++) { pts.push(catmullRom(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], k / SAMPLES)); seg.push(i); }
    }
    pts.push(closed ? P[0] : P[n - 1]); seg.push(spans - 1);
  }
  const N = pts.length, len = [0];
  for (let i = 1; i < N; i++) len.push(len[i - 1] + dist(pts[i], pts[i - 1]));
  const total = len[N - 1];
  // The tangent by central difference; round the seam of a closed curve, where the last sample is the first.
  const around = (i) => (closed && (i === 0 || i === N - 1) ? [pts[1], pts[N - 2]] : [pts[Math.min(i + 1, N - 1)], pts[Math.max(i - 1, 0)]]);
  let y;
  const out = pts.map((p, i) => {
    const z = tan[i] ?? norm(sub(...around(i)));
    if (!y) y = Math.abs(z[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
    y = norm(sub(y, scale(z, dot(y, z))));
    return { t: len[i] / total, p, y, z, segment: seg[i] };
  });
  // Closed: the angle from where y comes round to where it started, about the tangent, spread evenly along t.
  const z0 = out[0].z, y0 = out[0].y, yN = out[N - 1].y;
  const phi = closed ? Math.atan2(dot(cross(yN, y0), z0), dot(yN, y0)) : 0;
  for (const c of out) {
    if (phi) { const g = phi * c.t, cs = Math.cos(g), sn = Math.sin(g), zy = cross(c.z, c.y); c.y = norm(c.y.map((q, k) => q * cs + zy[k] * sn)); }
    c.x = cross(c.y, c.z);
  }
  return out;
}

export const curveLength = (curve) => curve.reduce((a, c, i) => (i ? a + dist(c.p, curve[i - 1].p) : 0), 0);

// The curve's point and axes at t, between the dense samples.
export function loftFrame(curve, t) {
  let i = 1;
  while (i < curve.length - 1 && curve[i].t < t) i++;
  const a = curve[i - 1], b = curve[i], f = b.t > a.t ? Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1) : 0;
  const lerp = (u, v) => u.map((c, k) => c + (v[k] - c) * f);
  const z = norm(lerp(a.z, b.z)), y0 = lerp(a.y, b.y), y = norm(sub(y0, scale(z, dot(y0, z))));
  return { p: lerp(a.p, b.p), x: cross(y, z), y, z };
}

// Draft f20 (D-106): where `on` puts a node, as { p, x, y, z }. Without u, the curve's frame at t (z the tangent).
// With u (0..1 round the section from point 0, by length, as uv "fit"), the surface point: z the outward normal,
// y along increasing t, x = y × z.
export function loftPlace(m, t, u) {
  const curve = loftCurve(m), f = loftFrame(curve, t);
  if (u === undefined) return f;
  const sorted = [...m.sections].sort((a, b) => a.t - b.t), spans = edgeSpans(sorted, m.sides), ccw = area(outline(sorted[0].points)) > 0;
  const at = (tt, uu) => {
    const { points, twist } = blendAt(sorted, m.blend, tt, m.closed), r = turn(resample(points, spans), twist);
    const ring = ccw ? [...r, r[0]] : [r[0], ...r.slice(1).reverse(), r[0]], len = [0];
    for (let j = 1; j < ring.length; j++) len.push(len[j - 1] + dist(ring[j], ring[j - 1]));
    const want = (((uu % 1) + 1) % 1) * len[len.length - 1];
    let j = 1;
    while (j < len.length - 1 && len[j] < want) j++;
    const g = (want - len[j - 1]) / (len[j] - len[j - 1] || 1), [a, b] = [0, 1].map((q) => ring[j - 1][q] + g * (ring[j][q] - ring[j - 1][q]));
    const { p, x, y } = loftFrame(curve, tt);
    return [0, 1, 2].map((q) => p[q] + a * x[q] + b * y[q]);
  };
  const e = 1e-4, t0 = Math.max(0, t - e), t1 = Math.min(1, t + e);
  const du = sub(at(t, u + e), at(t, u - e)), dt = sub(at(t1, u), at(t0, u));
  const z = norm(cross(du, dt)), y = norm(sub(dt, scale(z, dot(dt, z))));
  return { p: at(t, u), x: cross(y, z), y, z };
}

// A unit quaternion [x, y, z, w] for the rotation whose columns are the axes x, y, z.
function frameQuat([m00, m10, m20], [m01, m11, m21], [m02, m12, m22]) {
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = 2 * Math.sqrt(tr + 1); q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return norm(q);
}
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];

function loftGeometry(m, fit = true) {
  const curve = loftCurve(m), sorted = [...m.sections].sort((a, b) => a.t - b.t);
  const spans = edgeSpans(sorted, m.sides), n = spans.reduce((a, b) => a + b, 0), w = n + 1; // w: ring + seam vertex
  const ccw = area(outline(sorted[0].points)) > 0;
  const ts = [...new Set([...Array.from({ length: m.steps + 1 }, (_, i) => i / m.steps), ...sorted.map((s) => s.t)])].sort((a, b) => a - b);
  const shapeAt = (t) => {
    const { points, twist } = blendAt(sorted, m.blend, t, m.closed), ring = turn(resample(points, spans), twist);
    return ccw ? ring : [ring[0], ...ring.slice(1).reverse()]; // counter-clockwise, so the surface faces out
  };
  const length = curveLength(curve);
  // Each ring is closed by a copy of its point 0 (the seam), so u can run from 0 round to its whole length (D-80).
  const positions = [], uvs = [], indices = [];
  const frames = ts.map((t) => loftFrame(curve, t)), rings = ts.map(shapeAt);
  // Rows of the side: { ring (u, v), frame, along (z offset), v (by length) }. A dome (D-100) adds rows beyond an end:
  // its ring shrunk toward the centroid by cos φ and moved out along the tangent by depth·sin φ, φ in K steps to a
  // pole, depth = capDepth × the ring's mean radius; v runs on by the arc length at the mean radius.
  const K = Math.max(1, Math.round(m.sides / 4));
  const dome = (r, s) => {
    const ring = rings[r], c = centroid(ring), R = ring.reduce((a, q) => a + Math.hypot(q[0] - c[0], q[1] - c[1]), 0) / ring.length;
    const d = m.capDepth * R, rows = [];
    let arc = 0;
    for (let k = 1; k <= K; k++) {
      const f = (k * Math.PI) / 2 / K, g = ((k - 1) * Math.PI) / 2 / K;
      arc += Math.hypot(R * (Math.cos(f) - Math.cos(g)), d * (Math.sin(f) - Math.sin(g)));
      rows.push({ ring: ring.map(([u, v]) => [c[0] + (u - c[0]) * Math.cos(f), c[1] + (v - c[1]) * Math.cos(f)]), round: ring, frame: frames[r], along: s * d * Math.sin(f), arc });
    }
    return rows;
  };
  const startDome = capKind(m.caps, 'start') === 'dome' ? dome(0, -1) : [], endDome = capKind(m.caps, 'end') === 'dome' ? dome(ts.length - 1, 1) : [];
  const a0 = startDome.length ? startDome[startDome.length - 1].arc : 0, total = a0 + length + (endDome.length ? endDome[endDome.length - 1].arc : 0);
  const rows = [
    ...startDome.reverse().map((q) => ({ ...q, v: a0 - q.arc })),
    ...ts.map((t, r) => ({ ring: rings[r], round: rings[r], frame: frames[r], along: 0, v: a0 + t * length, t })),
    ...endDome.map((q) => ({ ...q, v: a0 + length + q.arc })),
  ];
  const r0 = startDome.length, r1 = r0 + ts.length - 1; // the rows of the curve's two ends
  rows.forEach(({ ring: rg, round: rd, frame: { p, x, y, z }, along, v: vv, t }) => {
    const ring = [...rg, rg[0]], ru = [...rd, rd[0]], round = [0]; // u as the end ring's, so u stays put up a dome
    for (let j = 1; j < w; j++) round.push(round[j - 1] + dist(ru[j], ru[j - 1]));
    ring.forEach(([u, v], j) => {
      positions.push(...[0, 1, 2].map((a) => p[a] + u * x[a] + v * y[a] + along * z[a]));
      uvs.push(fit ? round[j] / round[n] : round[j], fit ? (m.capDepth ? vv / total : t) : vv);
    });
  });
  for (let r = 0; r < rows.length - 1; r++) for (let j = 0; j < n; j++) {
    const a = r * w + j, a1 = a + 1, b = a + w, b1 = a1 + w;
    indices.push(a, a1, b1, a, b1, b);
  }
  // Smooth normals on the side: area-weighted face normals summed per vertex, the seam's two copies together, and
  // a closed loft's last ring with its first (D-93).
  const at = (i) => positions.slice(3 * i, 3 * i + 3), last = (ts.length - 1) * w;
  const home = (i) => { const v = i % w === n ? i - n : i; return m.closed && v >= last ? v - last : v; };
  const normals = new Array(positions.length).fill(0);
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]];
    const f = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    for (const i of [a, b, c]) for (let q = 0; q < 3; q++) normals[3 * home(i) + q] += f[q];
  }
  for (let i = 0; i < normals.length; i += 3) normals.splice(i, 3, ...norm(normals.slice(3 * home(i / 3), 3 * home(i / 3) + 3)));
  // A dome's pole: its copies get the tangent, not the one face each sees.
  if (startDome.length) for (let j = 0; j < w; j++) normals.splice(3 * j, 3, ...scale(frames[0].z, -1));
  if (endDome.length) for (let j = 0; j < w; j++) normals.splice(3 * ((rows.length - 1) * w + j), 3, ...frames[ts.length - 1].z);
  // Flat caps, triangulated in the section plane so concave sections stay right (as extrude caps), facing back
  // at the start and forward at the end; coordinates fit to the section's bounds, seen from outside.
  for (const [r, s] of [[0, -1], [ts.length - 1, 1]].filter(([, s]) => capKind(m.caps, s < 0 ? 'start' : 'end') === 'flat')) {
    const first = positions.length / 3, tris = triangulate([rings[r]]), row = r ? r1 : r0;
    for (let j = 0; j < n; j++) { positions.push(...at(row * w + j)); normals.push(...scale(frames[r].z, s)); }
    uvs.push(...planarUv(rings[r].map(([u, v]) => [s * u, v]), fit).flat());
    for (let k = 0; k < tris.length; k += 3) indices.push(...(s < 0 ? [tris[k], tris[k + 2], tris[k + 1]] : tris.slice(k, k + 3)).map((i) => first + i));
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

const CURVE_STEPS = 16; // polygon edges per bezier edge

// A section's closed outline as a polygon, starting at its point 0. A point [u, v] is a corner; [u, v, hu, hv]
// is smooth, with bezier handles at (u, v) ± (hu, hv); [u, v, ou, ov, iu, iv] has its out handle at (u, v) + (ou, ov)
// and its in handle at (u, v) + (iu, iv). An edge with a handle at either end is a cubic bezier.
export const outline = (pts) => flatten(pts).poly;

// The outline, and where each point starts in it.
function flatten(pts) {
  const out = [], starts = [];
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    starts.push(out.length);
    out.push([a[0], a[1]]);
    if (a.length < 4 && b.length < 4) return;
    const c1 = [a[0] + (a[2] ?? 0), a[1] + (a[3] ?? 0)], [iu, iv] = inHandle(b), c2 = [b[0] + iu, b[1] + iv];
    for (let k = 1; k < CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, s = 1 - t;
      out.push([0, 1].map((q) => s * s * s * a[q] + 3 * s * s * t * c1[q] + 3 * s * t * t * c2[q] + t * t * t * b[q]));
    }
  });
  return { poly: out, starts };
}

// Where walls split their normals: a corner, or (draft f21) a free-handle point with no handle on one side, as an arc's end.
const corner = (p) => p.length === 2 || (p.length === 6 && ((!p[2] && !p[3]) || (!p[4] && !p[5])));
// A point's in handle, relative to the point (zero for a corner).
const inHandle = (p) => (p.length === 6 ? [p[4], p[5]] : [-(p[2] ?? 0), -(p[3] ?? 0)]);

// Section points as [u, v, ou, ov, iu, iv] (a corner has zero handles; a point whose handles are opposite comes back
// as [u, v, hu, hv]), and twist, at t: held before the first and after the
// last section; between them blended linearly or by centripetal Catmull-Rom over the sections (D-35, D-41, D-42).
function blendAt(sorted, blend, t, closed) {
  // Closed (D-93): the sections go on round the seam, two before t 0 and two after t 1, so t 0 and t 1 blend alike.
  if (closed && sorted.length > 1) {
    const k = sorted.length, sh = (s, d) => ({ ...s, t: s.t + d });
    sorted = [sh(sorted[(k - 2) % k], -1), sh(sorted[k - 1], -1), ...sorted, sh(sorted[0], 1), sh(sorted[1 % k], 1)];
  }
  const n = sorted.length, j = sorted.findIndex((s) => s.t > t);
  // The in handle is blended as its offset from the mirrored out handle, zero for symmetric points, so it leaves
  // the centripetal knots of 4-number sections as they were.
  const full = (s) => s.points.flatMap((p) => { const [iu, iv] = inHandle(p); return [p[0], p[1], p[2] ?? 0, p[3] ?? 0, iu + (p[2] ?? 0), iv + (p[3] ?? 0)]; }).concat([s.twist]);
  const pt = (p) => (Math.abs(p[4]) + Math.abs(p[5]) < 1e-12 ? p.slice(0, 4) : [...p.slice(0, 4), p[4] - p[2], p[5] - p[3]]);
  const out = (v) => ({ points: Array.from({ length: (v.length - 1) / 6 }, (_, k) => pt(v.slice(6 * k, 6 * k + 6))), twist: v[v.length - 1] });
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
  const { points, twist } = blendAt(sorted, m.blend, t, m.closed);
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
const centroid = (pts) => {
  const A = area(pts);
  return [0, 1].map((q) => pts.reduce((a, p, j) => { const o = pts[(j + 1) % pts.length]; return a + (p[q] + o[q]) * (p[0] * o[1] - o[0] * p[1]); }, 0) / (6 * A));
};
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

// A number, or a string expression over parameters: + - * / ( ), numbers and GLSL functions; its value must be a number.
function num(e, scope, at) {
  if (typeof e === 'number') return e;
  need(typeof e === 'string', at, 'must be a number or an expression string');
  const v = value(e, scope, at);
  need(!Array.isArray(v), at, `"${e}" is a color (vec4); a number is needed here`);
  return v;
}
// An expression's value, a number or a vec4 (D-91), its errors under the JSON path.
function value(e, scope, at) {
  try { return evaluate(e, scope); } catch (err) { throw new Error(`${at}: ${err.message}`); }
}
// A color slot (D-91): an expression giving a vec4, or a list of n linear channels; clamped to 0..1. n = 3 drops alpha.
function color(c, n, scope, at) {
  need(typeof c === 'string' || Array.isArray(c), at, `must be a color expression or a list of ${n} linear channels`);
  const v = typeof c === 'string' ? value(c, scope, at) : vec(c, n, scope, at);
  need(Array.isArray(v), at, `"${c}" is a number; a color (vec4) is needed here`);
  return v.slice(0, n).map((x) => Math.min(1, Math.max(0, x)));
}

// An expression's value: a number, or a vec4 (D-91: a color, linear RGBA, GLSL's vec4) as a list of 4 numbers.
// Operators and built-ins work per component on vec4s, a number standing for every component; each vec4 is clamped to 0..1.
export function evaluate(src, scope) {
  const toks = src.match(/\d+\.?\d*|\.\d+|[a-z_][a-z0-9_]*|[<>=!]=|[-+*/(),.<>]|\S/gi) ?? [];
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  const atom = () => {
    if (peek() === '-') { take(); return each((x) => -x, [atom()]); }
    let v = primary();
    while (peek() === '.') { // a GLSL swizzle: one letter gives a number, four a vec4; letters rgba or xyzw, not both
      take();
      const s = take() ?? '', set = /^[rgba]+$/.test(s) ? 'rgba' : /^[xyzw]+$/.test(s) ? 'xyzw' : null;
      if (!Array.isArray(v) || !set || (s.length !== 1 && s.length !== 4)) throw new Error(`"${src}": ".${s}" needs a color (vec4) and 1 or 4 of the letters rgba or xyzw`);
      const c = [...s].map((l) => v[set.indexOf(l)]);
      v = c.length === 1 ? c[0] : c;
    }
    return v;
  };
  const primary = () => {
    const t = take();
    if (t === undefined) throw new Error(`"${src}": ends too early`);
    if (t === '(') { const v = compare(); if (take() !== ')') throw new Error(`"${src}": missing )`); return v; }
    if (/^\.?\d/.test(t)) return Number(t);
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
    if (peek() !== ')') do args.push(compare()); while (peek() === ',' && take());
    if (take() !== ')') throw new Error(`"${src}": missing ) after ${name}(`);
    const arity = name === 'atan' ? [1, 2] : name === 'hash' ? [1, 2, 3] : [f.length];
    if (!arity.includes(args.length)) throw new Error(`"${src}": ${name} takes ${arity.join(' or ')} arguments, got ${args.length}`);
    if (name === 'vec4' && args.some(Array.isArray)) throw new Error(`"${src}": vec4 takes 4 numbers`);
    if (name === 'hash' && args.some(Array.isArray)) throw new Error(`"${src}": hash takes numbers, not a color (vec4)`); // D-95: scalars only
    return name === 'vec4' || name === 'hash' ? f(...args) : each(f, args);
  };
  const ops = { '*': (a, b) => a * b, '/': (a, b) => a / b, '+': (a, b) => a + b, '-': (a, b) => a - b };
  const product = () => { let v = atom(); while (peek() === '*' || peek() === '/') { const op = ops[take()]; v = each(op, [v, atom()]); } return v; };
  const sum = () => { let v = product(); while (peek() === '+' || peek() === '-') { const op = ops[take()]; v = each(op, [v, product()]); } return v; };
  // Draft f21: a comparison of two numbers is 1 or 0, as a bool parameter (D-47); one per level, as in GLSL.
  const compare = () => {
    const a = sum();
    if (!(peek() in CMP)) return a;
    const op = take(), b = sum();
    if (Array.isArray(a) || Array.isArray(b)) throw new Error(`"${src}": ${op} compares numbers, not a color (vec4)`);
    if (peek() in CMP) throw new Error(`"${src}": a comparison of a comparison needs parentheses`);
    return CMP[op](a, b) ? 1 : 0;
  };
  const v = compare();
  if (i < toks.length) throw new Error(`"${src}": unexpected "${toks[i]}"`);
  if (![v].flat().every(Number.isFinite)) throw new Error(`"${src}": is not a finite number`);
  return v;
}
// f on numbers, or per component when any argument is a vec4, a number argument standing for every component.
// Every vec4 made is clamped to 0..1 (D-91 amended: a color is clamped at every step).
const each = (f, args) => (args.some(Array.isArray) ? clamp01([0, 1, 2, 3].map((k) => f(...args.map((a) => (Array.isArray(a) ? a[k] : a))))) : f(...args));
const clamp01 = (v) => v.map((x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : x)); // not finite stays, for the error

const CMP = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
// GLSL ES built-ins with GLSL's definitions (mod floors, step is edge <= x), per component on vec4s; and vec4.
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
  vec4: (r, g, b, a) => clamp01([r, g, b, a]), // D-91: a color, linear RGBA, clamped
  hash: (x, y, z) => (y === undefined ? pcg(u32(x)) : pcg3d(u32(x), u32(y), u32(z ?? 0))) / 2 ** 32, // D-95
};
// D-95: PCG hashes of Jarzynski & Olano 2020, "Hash Functions for GPU Rendering" (JCGT), in exact uint32 math.
// An argument floored, then wrapped to uint32 (two's complement): -1 is 4294967295. >>> 0 alone truncates toward 0.
const u32 = (a) => Math.floor(a) >>> 0;
function pcg(v) {
  const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
function pcg3d(x, y, z) {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0; y = (Math.imul(y, 1664525) + 1013904223) >>> 0; z = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0; z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  return x; // shortcut: only .x is used, so the last two lines of pcg3d (y, z updates after x) are left out
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// Material slots a recipe may set, and where glTF keeps them (D-6 amended).
const MATERIAL_SLOTS = { baseColorFactor: 'pbr', metallicFactor: 'pbr', roughnessFactor: 'pbr', emissiveFactor: 'top', emissiveStrength: 'ext', transmissionFactor: 'ext', ior: 'ext' };
// Write evaluated material slots into their core glTF places; returns the material.
function slots(core, m) {
  const pbr = Object.fromEntries(Object.entries(m).filter(([k]) => MATERIAL_SLOTS[k] === 'pbr'));
  if (Object.keys(pbr).length) core.pbrMetallicRoughness = { ...pbr, ...core.pbrMetallicRoughness };
  if (m.emissiveFactor) core.emissiveFactor = m.emissiveFactor;
  for (const [k, [e, def]] of Object.entries(EXT_SLOTS)) if (m[k] !== undefined && m[k] !== def) core.extensions = { ...core.extensions, [e]: { [k]: m[k] } };
  for (const [k, place] of Object.entries(TEXTURE_SLOTS)) {
    if (!m[k]) continue;
    const slot = place === 'pbr' ? core.pbrMetallicRoughness[k] : core[k];
    slot.extensions = { ...slot.extensions, [KHR_TT]: m[k] };
  }
  return core;
}
// Draft f11: glTF material texture slots; a recipe twin of the same name sets the slot's KHR_texture_transform.
const TEXTURE_SLOTS = { baseColorTexture: 'pbr', metallicRoughnessTexture: 'pbr', normalTexture: 'top', occlusionTexture: 'top', emissiveTexture: 'top' };
// A material's texture slots that name a texture: { index, ... } objects, to read or renumber in place.
const textureSlots = (mat) => Object.entries(TEXTURE_SLOTS)
  .map(([k, place]) => (place === 'pbr' ? mat?.pbrMetallicRoughness?.[k] : mat?.[k]))
  .filter((slot) => isObj(slot) && Number.isInteger(slot.index));
// A color value: linear [r, g, b, a], numbers 0..1, as glTF's baseColorFactor and Blender's color sockets.
const isColor = (c) => Array.isArray(c) && c.length === 4 && c.every((x) => typeof x === 'number' && x >= 0 && x <= 1);
// A recipe slot that sets core slot k: euler sets rotation.
const twin = (x, k) => x[k] ?? (k === 'rotation' ? x.euler : undefined) ?? (k === 'translation' || k === 'rotation' ? x.on : undefined);
// A number in a name: whole numbers as integers, others to 6 significant digits.
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(+v.toPrecision(6)));
function need(ok, at, msg) { if (!ok) throw new Error(`${at || '/'}: ${msg}`); }
function only(o, keys, at) {
  for (const k of Object.keys(o)) need(keys.includes(k) || k.startsWith('//'), `${at}/${k}`, 'unknown key');
}
