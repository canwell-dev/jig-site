// JIG 0.1 reader and baker. Pure: a glTF document with the JIG_recipe extension + parameter values in, a plain
// shape description (read) or the baked glTF (bake) out. No three.js here.

export const VERSION = '0.1';
export const EXT = 'JIG_recipe';
export const UNITS = ['m', 'deg', '%', 's']; // draft f25: a value is stored in its unit; % is a 0..1 fraction shown as 0..100

// Read a document. `values` overrides parameter values by name (over baked_values, over defaults).
// Returns { params, vars, floor, meshes, nodes, instances, tree, skins } or throws an Error whose message starts with
// the JSON path. `meshes` are the evaluated recipe meshes, then those of placed documents (draft f10);
// `instances` are { node, mesh, matrix, rec, model } for every shape drawn in the default scene, matrix = world
// transform, column-major as in glTF; `node` is the node of this document that draws or places it.
// `files` (draft f10): file name -> document, for a model's relative `uri`, as if all were in one folder.
export function read(doc, values = {}, { files = {}, stack = [], rest = false, memo = new Map() } = {}) {
  need(isObj(doc), '', 'document must be an object');
  need(isObj(doc.asset) && doc.asset.version === '2.0', '/asset/version', 'must be "2.0" (a glTF 2.0 document)');
  need(Array.isArray(doc.extensionsUsed) && doc.extensionsUsed.includes(EXT), '/extensionsUsed', `must list "${EXT}"`);
  need(!(Array.isArray(doc.extensionsRequired) && doc.extensionsRequired.includes(EXT)), '/extensionsRequired',
    `must not list "${EXT}", so a baked file loads in every glTF tool`);
  const rat = `/extensions/${EXT}`;
  const r = doc.extensions?.[EXT];
  need(isObj(r), rat, 'must be an object');
  only(r, ['version', 'params', 'sets', 'vars', 'floor', 'meshes', 'models', 'skins', 'character', 'clips', 'poses', 'placement', 'physics', 'baked_values', 'baked_set'], rat);
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
    need(p.type === undefined || ['int', 'bool', 'color', 'choice'].includes(p.type), `${at}/type`, 'must be "int", "bool", "color" or "choice" (leave it out for a number)');
    need(p.doc === undefined || typeof p.doc === 'string', `${at}/doc`, 'must be a string'); // draft f25: hints, no effect on the model
    need(p.live === undefined || p.live === true, `${at}/live`, 'must be true, or left out'); // draft f26 (D-131): checked below
    if (p.type === 'choice') { // draft f21: one of named options, its index 0, 1, ... in expressions
      only(p, ['type', 'options', 'default', 'doc', 'live'], at);
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
      only(p, ['type', 'default', 'doc', 'live'], at);
      need(isColor(p.default), `${at}/default`, 'must be a color: linear [r, g, b, a], numbers 0..1');
      if (baked) need(isColor(baked[name]), `${rat}/baked_values/${name}`, 'must be a color: linear [r, g, b, a], numbers 0..1 (baked_values holds every parameter)');
      const v = values[name] ?? baked?.[name] ?? p.default;
      need(isColor(v), `${rat}/params/${name}`, `value must be a color: linear [r, g, b, a], numbers 0..1, is ${JSON.stringify(v)}`);
      params[name] = { ...p, value: [...v] };
      continue;
    }
    if (p.type === 'bool') { // D-47: true/false, 1/0 in expressions
      only(p, ['type', 'default', 'doc', 'live'], at);
      need(typeof p.default === 'boolean', `${at}/default`, 'must be true or false');
      if (baked) need(typeof baked[name] === 'boolean', `${rat}/baked_values/${name}`, 'must be true or false (baked_values holds every parameter)');
      params[name] = { ...p, value: !!(values[name] ?? baked?.[name] ?? p.default) };
      continue;
    }
    only(p, ['type', 'default', 'min', 'max', 'step', 'unit', 'doc', 'live'], at);
    const int = p.type === 'int'; // draft f25: whole numbers, rounded half away from zero
    for (const k of ['default', 'min', 'max']) need(int ? Number.isInteger(p[k]) : typeof p[k] === 'number', `${at}/${k}`, int ? 'must be a whole number' : 'must be a number');
    need(p.min <= p.default && p.default <= p.max, at, 'needs min <= default <= max');
    need(p.step === undefined || (typeof p.step === 'number' && p.step > 0), `${at}/step`, 'must be a number > 0');
    need(p.unit === undefined || UNITS.includes(p.unit), `${at}/unit`, `must be one of ${JSON.stringify(UNITS)}`);
    if (baked) need(typeof baked[name] === 'number', `${rat}/baked_values/${name}`, 'must be a number (baked_values holds every parameter)');
    const v = values[name] ?? baked?.[name] ?? p.default;
    params[name] = { ...p, value: Math.min(p.max, Math.max(p.min, int ? Math.sign(v) * Math.round(Math.abs(v)) : v)) };
  }
  // D-96: well-known parameters a host may set by name; the reader checks their kind only, not what the model does.
  for (const k of ['seed', 'width', 'height', 'depth', 'wall', 'lod']) { // wall: draft f36, the thickness of the wall a model is mounted on
    const p = params[k], at = `${rat}/params/${k}`;
    if (!p) continue;
    if (k === 'lod') { // draft f25: 0 is full detail, higher is coarser; the model picks max
      need(p.type === 'int', `${at}/type`, 'is a well-known parameter (§3.3): must be an int parameter');
      need(p.min === 0, `${at}/min`, 'is a level of detail (§3.3): must be 0');
    } else if (k === 'seed') need(p.type === undefined || p.type === 'int', `${at}/type`, 'is a well-known parameter (§3.3): must be a number or int parameter');
    else {
      need(p.type === undefined, `${at}/type`, 'is a well-known parameter (§3.3): must be a number parameter');
      need(p.min > 0, `${at}/min`, 'is an extent in metres (§3.3): must be > 0');
    }
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
  const choices = Object.entries(params).filter(([, p]) => p.type === 'choice').map(([k, p]) => [k, p.options]);
  if (choices.length) scope[CHOICES] = Object.fromEntries(choices); // draft f24 (D-115): for `opening == 'window'`

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
    vars[name] = scope[name] = typeof e === 'number' ? e : Array.isArray(e) ? color(e, 4, scope, at) : value(e, scope, at); // a list: linear channels, as a color slot
  }

  // Draft f6: a core glTF material's JIG_recipe sets its color and factor slots; the core slots are the bake's
  // cache. A color is an expression giving a vec4 (D-91) or a list of linear channels, clamped to 0..1.
  need(doc.materials === undefined || Array.isArray(doc.materials), '/materials', 'must be a list');
  const materialAt = (m, i, scope) => {
    const x = m?.extensions?.[EXT], at = `/materials/${i}/extensions/${EXT}`;
    for (const [k, place] of Object.entries(MATERIAL_SLOTS)) { // an expression in a core slot would pass through unbaked
      const [v, kat] = place === 'pbr' ? [m?.pbrMetallicRoughness?.[k], 'pbrMetallicRoughness/'] : place === 'top' ? [m?.[k], ''] : [m?.extensions?.[EXT_SLOTS[k][0]]?.[k], `extensions/${EXT_SLOTS[k][0]}/`];
      need(typeof v !== 'string', `/materials/${i}/${kat}${k}`, `is an expression; it goes in extensions.${EXT}.${k}`);
    }
    if (x === undefined || isBaked(m)) return null;
    need(isObj(x), at, 'must be an object');
    only(x, [...Object.keys(MATERIAL_SLOTS), ...Object.keys(TEXTURE_SLOTS), 'physics'], at); // physics: draft f37, read by physicsOf
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
    // Draft f33 (D-160): KHR_materials_sheen's and KHR_materials_diffuse_transmission's factor twins.
    for (const k of ['sheenColorFactor', 'diffuseTransmissionColorFactor']) if (x[k] !== undefined) o[k] = color(x[k], 3, scope, `${at}/${k}`);
    for (const k of ['sheenRoughnessFactor', 'diffuseTransmissionFactor']) if (x[k] !== undefined) o[k] = unit(num(x[k], scope, `${at}/${k}`));
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
  // Draft f34 (D-162): a stub takes its material from a library document; it draws as a finished material (stubAt).
  const isStub = (m) => isObj(m?.extensions?.[EXT]) && m.extensions[EXT].from !== undefined, stubUsed = new Set();
  const materials = (doc.materials ?? []).map((m, i) => {
    if (isStub(m)) return null;
    try { return materialAt(m, i, scope); } catch (e) { pending.set(i, e); return null; }
  });
  // Draft f15 (D-92): a recipe mesh is evaluated in the scope of each copy that draws it, so it sees that copy's
  // indices and rows. meshes[i] is recipe mesh i at the first copy that draws it (at the parameters when none does);
  // a copy whose evaluated shape differs gets an entry after them. Equal evaluated shapes share one entry.
  const recipeMeshes = r.meshes === undefined ? [] : list(r.meshes, `${rat}/meshes`) /* D-166: a library may have none */, meshes = new Array(recipeMeshes.length), meshKey = new Map();
  const intern = (m, key, slot) => {
    if (!meshKey.has(key)) { meshKey.set(key, slot !== undefined && meshes[slot] === undefined ? (meshes[slot] = m, slot) : meshes.push(m) - 1); SHAPE_KEY.set(m, key); }
    return meshKey.get(key);
  };
  let own;
  const meshAt = (i, s) => {
    const m = mesh(recipeMeshes[i], s, `${rat}/meshes/${i}`, materials.length), j = m.material;
    if (j !== undefined && isStub(doc.materials[j])) { delete m.material; m.placed = stubAt(j, s); m.stub = j; stubUsed.add(j); } // stub: for the bake's variants (D-167)
    else if (j !== undefined && (materials[j] || pending.has(j))) {
      const o = materialAt(doc.materials[j], j, s);
      if (pending.has(j)) { pending.delete(j); materials[j] = o; }
      else if (JSON.stringify(o) !== JSON.stringify(materials[j])) {
        own ??= strip(doc);
        const { extensions: { [EXT]: _, ...ext } = {}, ...rest } = structuredClone(own.materials[j]);
        const mat = slots({ ...rest, ...(Object.keys(ext).length && { extensions: ext }) }, o);
        delete m.material;
        m.placed = addPlaced(lift(mat, ownTexture(own), '', `${rat}/meshes/${i}/material`), physMaterial(doc.materials[j], j, s));
      }
    }
    return intern(m, `${i} ${JSON.stringify(m)}`, i);
  };

  // Draft f10 (D-72..D-74): other JIG documents, placed by nodes with their own parameter values. Embedded as
  // `document`, or a `uri` as glTF's: a data: URI or a file name looked up in `files`.
  need(r.models === undefined || Array.isArray(r.models), `${rat}/models`, 'must be a list');
  const valueSinks = new Map(); // draft f26: placed values that reach a bake slot of the placed document, path -> expression
  const skinnedPlaced = new Set(); // draft f26 (D-134): nodes placing a document with skins
  const placed = [], placedKey = new Map(); // draft f10 (D-78): materials of placed documents, as finished glTF materials
  const placedPhys = []; // draft f37: each placed material's physical material (library or placed document's), or null
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
  const addPlaced = (mat, phys = null) => {
    const key = JSON.stringify([mat, phys]);
    if (!placedKey.has(key)) { placedKey.set(key, placed.push(mat) - 1); placedPhys.push(phys); }
    return placedKey.get(key);
  };
  // Draft f23 (D-113): the document's own KHR_lights_punctual lights (static glTF values), then those of placed
  // documents, equal ones shared. A node's recipe `light` picks one of its own.
  const lx = doc.extensions?.[KHR_LIGHTS], lat = `/extensions/${KHR_LIGHTS}`;
  need(lx === undefined || (isObj(lx) && Array.isArray(lx.lights)), lat, 'must be { "lights": [...] }');
  const lights = (lx?.lights ?? []).filter((l, k) => {
    need(isObj(l) && ['point', 'spot', 'directional'].includes(l.type), `${lat}/lights/${k}`, 'must be a light with type "point", "spot" or "directional"');
    return !isBaked(l);
  }), ownLights = lights.length, lightKey = new Map();
  const addLight = (l) => {
    const key = JSON.stringify(l);
    if (!lightKey.has(key)) lightKey.set(key, lights.push(l) - 1);
    return lightKey.get(key);
  };
  // Draft f24 (D-119): a light's recipe `color`, `intensity`, `range`, evaluated in the scope of the node that picks
  // it; the evaluated light is a baked one, equal ones shared.
  const lightOf = (k, s, at) => {
    const l = lights[k], x = l.extensions?.[EXT], xat = `${lat}/lights/${k}/extensions/${EXT}`;
    if (x === undefined) return k;
    need(isObj(x), xat, 'must be an object');
    only(x, ['color', 'intensity', 'range'], xat);
    const { [EXT]: _, ...ext } = l.extensions, o = { ...l, extensions: ext };
    if (!Object.keys(ext).length) delete o.extensions;
    if (x.color !== undefined) o.color = color(x.color, 3, s, `${xat}/color`);
    if (x.intensity !== undefined) { o.intensity = num(x.intensity, s, `${xat}/intensity`); need(o.intensity >= 0, `${xat}/intensity`, `must be >= 0, is ${o.intensity} (at ${at})`); }
    if (x.range !== undefined) { o.range = num(x.range, s, `${xat}/range`); need(o.range > 0, `${xat}/range`, `must be > 0, is ${o.range} (at ${at})`); }
    return addLight(o);
  };
  // A document by `uri` as glTF's: a data: URI holding the JSON, or a file name looked up in `files`.
  const resolve = (uri, at, label) => {
    need(typeof uri === 'string' && uri !== '', at, 'must be a non-empty string');
    const data = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
    if (data) {
      try { return { doc: JSON.parse(data[1] ? atob(data[2]) : decodeURIComponent(data[2])), label }; }
      catch (e) { need(false, at, `is not a JSON document: ${e.message}`); }
    }
    need(Object.hasOwn(files, uri), at, `no file "${uri}" next to this document`);
    return { doc: files[uri], label: uri, dir: uri.slice(0, uri.lastIndexOf('/') + 1) };
  };
  // A placed or library document, read once per values within the outermost read: 6820 reads of one library in the
  // station scene. The result is shared, so a caller that changes its records copies them first.
  const readOnce = (d, vals, opts) => {
    const byDoc = memo.get(d) ?? memo.set(d, new Map()).get(d), key = `${opts.stack.length} ${!!opts.rest} ${JSON.stringify(vals)}`;
    if (!byDoc.has(key)) byDoc.set(key, read(d, vals, { ...opts, memo }));
    return byDoc.get(key);
  };
  // Draft f34 (D-162..D-166): stub material j, in scope s, as the index of a finished material in `placed`: the
  // library's material named `from.material`, whole, read at the stub's `values` over the library's defaults.
  const stubAt = (j, s) => {
    const x = doc.materials[j].extensions[EXT], at = `/materials/${j}/extensions/${EXT}`, fat = `${at}/from`;
    only(x, ['from', 'values'], at);
    need(isObj(x.from), fat, 'must be { "uri": …, "material": … }');
    only(x.from, ['uri', 'material'], fat);
    const lib = resolve(x.from.uri, `${fat}/uri`, `${fat}/uri`), name = x.from.material;
    need(lib.doc !== doc && !stack.includes(lib.doc) && stack.length < 16, `${fat}/uri`, 'refers to itself, or nests deeper than 16');
    need(typeof name === 'string' && name !== '', `${fat}/material`, 'must be a material name');
    const names = Array.isArray(lib.doc?.materials) ? lib.doc.materials.map((m) => m?.name) : [], k = names.indexOf(name);
    need(k >= 0, `${fat}/material`, `no material "${name}" in ${lib.label}`);
    need(names.indexOf(name, k + 1) < 0, `${fat}/material`, `more than one material "${name}" in ${lib.label}`);
    const vals = valuesOf(lib, x.values, s, `${at}/values`);
    let sub;
    try { sub = readOnce(lib.doc, vals, { files, stack: [...stack, doc] }); } catch (e) { need(false, fat, `in ${lib.label}: ${e.message}`); }
    return addPlaced(lift(sub.finished(k), (i) => sub.placedTextures[i], lib.dir ?? '', fat), sub.materialPhys(k));
  };
  const models = (r.models ?? []).map((m, k) => {
    const at = `${rat}/models/${k}`;
    need(isObj(m), at, 'must be an object');
    only(m, ['uri', 'document'], at);
    need((m.uri === undefined) !== (m.document === undefined), at, 'needs one of uri or document');
    if (m.document !== undefined) return { doc: m.document, label: `models/${k}` };
    return resolve(m.uri, `${at}/uri`, `models/${k}`);
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
    only(sk, ['joints', 'blend'], at);
    list(sk.joints, `${at}/joints`).forEach((j, m) => {
      need(seen.has(j), `${at}/joints/${m}`, 'must be a node of the default scene');
      need(!jointOf.has(j), `${at}/joints/${m}`, `node ${j} is already a joint`);
      jointOf.set(j, k);
    });
  });
  const skins = (r.skins ?? []).map(() => []);
  // Draft f28 (D-144): a skin's blend width, the default for its shapes; a node's own blend overrides it.
  const skinBlend = (r.skins ?? []).map((sk, k) => {
    if (sk.blend === undefined) return undefined;
    const w = num(sk.blend, scope, `${rat}/skins/${k}/blend`);
    need(w > 0, `${rat}/skins/${k}/blend`, `must be > 0, is ${w}`);
    return w;
  });
  const owner = {}; // marks the records of this document, so a node's blend_joints names its own joints

  // Draft f30 (D-148..D-151): a character's naming scheme and its joints' roles, one role per joint node; under
  // vrm1_humanoid, VRM 1.0's bone names and `meta` for the bake's VRMC_vrm.
  const cat = `${rat}/character`;
  let character;
  if (r.character !== undefined) {
    need(isObj(r.character), cat, 'must be an object');
    only(r.character, ['scheme', 'meta'], cat);
    need(typeof r.character.scheme === 'string' && r.character.scheme !== '', `${cat}/scheme`, 'must be a non-empty string');
    const vrm = r.character.scheme === 'vrm1_humanoid', meta = r.character.meta;
    if (vrm) {
      need(isObj(meta), `${cat}/meta`, 'must be an object: VRM 1.0 meta, with name, authors and licenseUrl');
      need(typeof meta.name === 'string' && meta.name !== '', `${cat}/meta/name`, 'must be a non-empty string');
      need(Array.isArray(meta.authors) && meta.authors.length > 0 && meta.authors.every((a) => typeof a === 'string' && a !== ''), `${cat}/meta/authors`, 'must be a non-empty list of non-empty strings');
      need(meta.licenseUrl === VRM_LICENSE, `${cat}/meta/licenseUrl`, `must be "${VRM_LICENSE}", as VRM 1.0 says; another license goes in otherLicenseUrl`);
    } else need(meta === undefined, `${cat}/meta`, 'is only for scheme "vrm1_humanoid"');
    character = { scheme: r.character.scheme, meta, roles: [] };
  }
  src.forEach((n, i) => {
    const role = n?.extensions?.[EXT]?.role, at = `/nodes/${i}/extensions/${EXT}/role`;
    if (role === undefined || isBaked(n)) return;
    need(character, at, `needs ${rat}/character`);
    need(typeof role === 'string' && role !== '', at, 'must be a non-empty string');
    need(jointOf.has(i), at, 'must be on a joint (a node listed in a skin, §6.3)');
    need(!repeated.has(i), at, 'a repeated node has several copies; give each its own node');
    const twice = character.roles.find((x) => x.role === role);
    need(!twice, at, `"${role}" is already the role of node ${twice?.node}`);
    if (character.scheme === 'vrm1_humanoid') need(VRM_BONES.includes(role), at, `"${role}" is not a VRM 1.0 humanoid bone`);
    character.roles.push({ role, node: i });
  });
  if (character?.scheme === 'vrm1_humanoid') {
    const missing = VRM_REQUIRED.filter((b) => !character.roles.some((x) => x.role === b));
    need(!missing.length, cat, `vrm1_humanoid needs the roles ${missing.join(', ')}`);
  }

  // Draft f32 (D-156, D-158, D-159): poses turn named joints by eulers times a weight, after their own rotation; the sum
  // over poses per node, as one euler. node index -> [x, y, z] degrees.
  const turn = posesOf(r.poses, src, repeated, scope, rat);

  // Evaluate the tree with world matrices. A repeated node is evaluated once per copy, its index and row bound
  // for its subtree (D-44, D-46, D-75). `tree` holds one record per copy: { i, node, rep, shown, kids, world, name,
  // mesh, bound }; a repeat of 0 still evaluates copy 0, unshown, so its errors surface. `nodes[i]` is node i's
  // first copy. `bound` is { rec, skin }: the joint a shape is bound to, the nearest joint at or above its node.
  // A placed document's tree hangs under the placing record, marked `foreign`.
  const nodes = [], instances = [], projections = new Map(); // §5.10: projection mesh -> the copy that draws it
  const clipNames = isObj(r.clips) ? Object.keys(r.clips).filter((k) => !k.startsWith('//')) : [];
  // Draft f20 (D-106): `on` places the node on a loft, taken where the node's parent puts its origin; the node's own
  // transform applies after the placement.
  const nodeAt = (raw, s, at) => {
    const n = node(raw, recipeMeshes.length, s, at), on = n.jig.on, oat = `${at}/extensions/${EXT}/on`;
    need(n.jig.light === undefined || (Number.isInteger(n.jig.light) && n.jig.light >= 0 && n.jig.light < ownLights), `${at}/extensions/${EXT}/light`,
      ownLights ? `must be a light index 0..${ownLights - 1}` : `must be a light index, and the document has no ${KHR_LIGHTS} lights`);
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
  const walk = (i, parent, s, shown, drawn, copy, bone) => {
    const x = src[i].extensions?.[EXT], at = `/nodes/${i}`, xat = `${at}/extensions/${EXT}`;
    const rep = isObj(x) && x.repeat !== undefined ? repeat(x.repeat, s, `${xat}/repeat`) : null;
    return Array.from({ length: rep ? Math.max(1, rep.count) : 1 }, (_, k) => {
      const sk = repeatVars(rep?.vars, rep ? { ...s, [rep.index]: k, ...rep.rows?.[k] } : s, `${xat}/repeat/vars`), c = rep ? [...copy, k] : copy;
      const n = nodeAt(src[i], sk, at);
      if (turn.has(i)) { n.rotation = qmul(n.rotation, eulerQuat(turn.get(i))); n.matrix = compose(n.translation, n.rotation, n.scale); }
      const vis = shown && (!rep || k < rep.count) && n.visible;
      if (n.mesh !== undefined) n.mesh = meshAt(n.mesh, sk);
      if (n.mesh !== undefined && meshes[n.mesh].project) { if (projections.has(n.mesh)) n.mesh = meshes.push({ ...meshes[n.mesh] }) - 1; projections.set(n.mesh, null); } // §5.10: one per copy
      nodes[i] ??= { ...n, repeated: repeated.has(i), scope: sk }; // scope: the first copy's, for editor drags
      const world = mul(parent, n.matrix);
      // drawn: baked, shown or not; hidden: its own visible is 0 (D-130: baked with KHR_node_visibility false)
      const rec = { i, node: n, rep: !!rep, shown: vis, drawn: drawn && (!rep || k < rep.count), hidden: !n.visible, kids: [], world, name: n.name, mesh: n.mesh, light: n.jig.light === undefined ? undefined : lightOf(n.jig.light, sk, `${xat}/light`) };
      let b = bone;
      rec.owner = owner;
      if (jointOf.has(i)) { b = { rec, skin: jointOf.get(i) }; if (vis) skins[b.skin].push(rec); }
      if (n.mesh !== undefined && b) rec.bound = b;
      if (n.jig.blend !== undefined || n.jig.blend_joints !== undefined) rec.blend = blendOf(n.jig, sk, xat, b, rec.bound);
      if (PLACE_KEYS.some((k) => n.jig[k] !== undefined)) rec.place = placeOf(n.jig, sk, xat, clipNames);
      if (PHYS_KEYS.some((k) => n.jig[k] !== undefined)) rec.phys = physOf(n.jig, sk, xat);
      if (projections.has(n.mesh)) projections.set(n.mesh, rec);
      if (vis && n.mesh !== undefined) instances.push({ node: i, mesh: n.mesh, matrix: world, copy: c, rec });
      // Draft f24 (D-118): the placed model first, so the node's children see its bounds.
      const kids = n.children.filter((ch) => !isBaked(src[ch])), p = n.jig.model === undefined ? null : place(n.jig, sk, xat, rec, vis && n.modelVisible, c, b, kids.length > 0);
      rec.kids = kids.flatMap((ch) => walk(ch, world, p?.bounds ? { ...sk, ...p.bounds } : sk, vis, rec.drawn, c, b));
      if (p) { rec.kids.push(...p.tree); instances.push(...p.inst); }
      return rec;
    });
  };
  // Draft f28 (D-143..D-145): a node's blend width (0: rigid) and the joints its shape may follow.
  const blendOf = (x, s, xat, b, bound) => {
    const key = `${xat}/${x.blend !== undefined ? 'blend' : 'blend_joints'}`;
    need(x.mesh !== undefined, key, 'needs mesh');
    need(bound || stack.length > 0, key, 'its shape is bound to no joint (§6.3)'); // a placed document's may be bound by the placing node
    const w = x.blend === undefined ? undefined : num(x.blend, s, `${xat}/blend`);
    need(w === undefined || w >= 0, `${xat}/blend`, `must be >= 0, is ${w}`);
    let only = null;
    if (x.blend_joints !== undefined) {
      only = new Set(list(x.blend_joints, `${xat}/blend_joints`));
      x.blend_joints.forEach((j, m) => {
        need(jointOf.has(j), `${xat}/blend_joints/${m}`, 'must be a joint of a skin (§6.3)');
        need(!b || b.rec.owner !== owner || jointOf.get(j) === b.skin, `${xat}/blend_joints/${m}`, `must be a joint of skin ${b?.skin}, the one its shape is bound to`);
      });
    }
    return { w, only, owner };
  };
  // Draft f10: a node's `model` and `values`. The placed document is read with those values; its shapes, skins
  // and tree join this one under the node. Its skins join the placing node's skin, or are skins of their own.
  const place = (x, s, xat, rec, vis, c, bone, wantBounds) => {
    need(Number.isInteger(x.model) && x.model >= 0 && x.model < models.length, `${xat}/model`, `must be a model index 0..${models.length - 1}`);
    const m = models[x.model];
    need(m.doc !== doc && !stack.includes(m.doc) && stack.length < 16, `${xat}/model`, 'places itself, or nests deeper than 16');
    const vals = valuesOf(m, x.values, s, `${xat}/values`);
    let sub;
    try { sub = readOnce(m.doc, vals, { files, stack: [...stack, doc], rest }); } catch (e) { need(false, `${xat}/model`, `in ${m.label}: ${e.message}`); }
    for (const k of Object.keys(vals)) if (!sub.params[k].live) valueSinks.set(`${xat}/values/${k}`, x.values[k]); // draft f26: reaches a bake slot there
    if (sub.skins.length) skinnedPlaced.add(rec.i);
    // Its materials come along (D-78): each one a shape uses, at this copy's values, as a finished glTF material.
    m.stripped ??= strip(m.doc);
    const dir = m.dir ?? '', sd = m.stripped;
    const own = ownTexture(sd, `${xat}/model`, `in ${m.label}: `); // a texture of the placed document itself
    // Its shapes join this document's, shared with equal shapes placed before (D-92).
    const remap = sub.meshes.map(({ material, placed: pm, stub: _, ...mesh }) => {
      if (pm !== undefined) mesh.placed = addPlaced(lift(structuredClone(sub.placed[pm]), (i) => sub.placedTextures[i], dir, `${xat}/model`), sub.placedPhys[pm]);
      else if (material !== undefined) {
        const { extensions: { [EXT]: _, ...ext } = {}, ...rest } = structuredClone(sd.materials[material]);
        const mat = slots({ ...rest, ...(Object.keys(ext).length && { extensions: ext }) }, sub.materials[material] ?? {});
        mesh.placed = addPlaced(lift(mat, own, dir, `${xat}/model`), sub.materialPhys(material));
      }
      return intern(mesh, `placed ${JSON.stringify(mesh)}`);
    });
    const skinAt = sub.skins.map((_, k) => (bone ? bone.skin : (skinBlend.push(sub.skinBlend[k]), skins.push([]) - 1)));
    const lightAt = sub.lights.map(addLight);
    const copy = structuredClone({ tree: sub.tree, instances: sub.instances, skins: sub.skins }); // the read is shared (readOnce): these records are this copy's
    if (vis) copy.skins.forEach((js, k) => skins[skinAt[k]].push(...js));
    const relink = (r) => {
      r.foreign = true; r.world = mul(rec.world, r.world);
      if (rec.name !== undefined && r.name !== undefined) r.name = `${rec.name}/${r.name}`; // D-79: the placing copy's name first
      if (r.light !== undefined) r.light = lightAt[r.light];
      if (r.mesh !== undefined) { r.mesh = remap[r.mesh]; r.bound = r.bound ? { rec: r.bound.rec, skin: skinAt[r.bound.skin] } : bone ?? undefined; }
      r.kids.forEach(relink);
    };
    copy.tree.forEach(relink);
    if (!vis) copy.tree.forEach(function hide(r) { r.shown = false; r.kids.forEach(hide); }); // model_visible 0 (D-118)
    if (!rec.drawn) copy.tree.forEach(function drop(r) { r.drawn = false; r.kids.forEach(drop); });
    if (!rec.node.modelVisible) copy.tree.forEach((r) => { r.hidden = true; }); // baked hidden (D-130)
    const inst = vis ? copy.instances.map((si) => ({ node: rec.i, mesh: si.rec.mesh, matrix: mul(rec.world, si.matrix), copy: [...c, ...si.copy], rec: si.rec, model: true })) : [];
    return { tree: copy.tree, inst, bounds: wantBounds ? modelBounds(sub) : null };
  };
  const tree = roots.flatMap((i) => walk(i, IDENTITY, scope, true, true, [], null));
  src.forEach((n, i) => { if (!nodes[i] && !isBaked(n)) nodes[i] = nodeAt(n, scope, `/nodes/${i}`); });
  for (let i = 0; i < recipeMeshes.length; i++) if (meshes[i] === undefined) meshAt(i, scope); // drawn by no copy
  for (const e of pending.values()) throw e; // used by no copy, and wrong at the parameters
  // §5.10 (D-195): projected outlines, once every shape is in the tree. Only a shown copy's is worked out (D-197): a
  // hidden one, or one no copy draws, is empty. A rest read (a clip key, a rest or bind pose) draws none either: a clip
  // key bakes no shapes, the poses need frames.
  const pj = new Set(meshes.flatMap((m, j) => (m?.project ? [j] : [])));
  for (const j of pj) need(meshes[j].project.of < src.length, `${meshes[j].project.at}/of`, `must be a node index 0..${src.length - 1}`); // shown or not
  // shortcut: a projection bound to a joint is empty at its bind pose; upgrade when a skinned model projects itself
  for (const j of pj) meshes[j] = rest || !projections.get(j)?.shown ? { type: 'extrude', pieces: [], frame: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], depth: meshes[j].depth } : projectMesh(meshes[j], projections.get(j), tree, meshes, src.length, pj);
  // Draft f34: material i as a finished glTF material whose textures index `placedTextures`, for a referring document.
  const finished = (i) => {
    if (isStub(doc.materials[i])) return structuredClone(placed[stubAt(i, scope)]);
    own ??= strip(doc);
    const { extensions: { [EXT]: _, ...ext } = {}, ...rest } = structuredClone(own.materials[i]);
    return lift(slots({ ...rest, ...(Object.keys(ext).length && { extensions: ext }) }, materials[i] ?? {}), ownTexture(own), '', `/materials/${i}`);
  };
  (doc.materials ?? []).forEach((m, i) => { if (isStub(m) && !stubUsed.has(i)) stubAt(i, scope); }); // used by no copy: checked at the parameters

  // y of the floor in model space; hosts stand the model there. Default: the lowest point on the vertical line
  // through the origin, or 0 when no shape crosses that line. The default builds geometry, so it is worked out
  // only when asked for: a placed document's floor, which is ignored, never is.
  const floor = r.floor === undefined ? undefined : num(r.floor, scope, `${rat}/floor`);
  // Draft f26 (D-129..D-131): a parameter is live unless some value of it can reach a bake slot.
  for (const [k, at] of bakeSlots(r, src, valueSinks, Object.keys(params), jointOf, skinnedPlaced)) {
    params[k].live = false;
    need(!r.params[k].live, `${rat}/params/${k}/live`, `is live, but reaches ${at}, which changes the baked meshes`);
  }
  for (const p of Object.values(params)) p.live ??= true;
  const clips = stack.length ? [] : clipsOf(r.clips, params, scope, rat); // draft f31: the outermost document's
  let low;
  // Draft f36: the model's mounts, tags and wall gap (a placed document's are ignored, as its floor), and the
  // placement items of shown nodes, each with its node's world matrix (feet of a use point at its origin, facing +z).
  const items = [];
  (function all(recs) { for (const x of recs) if (x.shown) { if (x.place) items.push({ node: x.i, name: x.name, world: x.world, foreign: !!x.foreign, ...x.place }); all(x.kids); } })(tree);
  const placement = { ...(stack.length ? {} : modelPlacement(r.placement, scope, `${rat}/placement`)), items };
  // Draft f37: bodies, colliders and joints, when the recipe switches physics on; done by the outermost document.
  let physics;
  if (!stack.length && !rest) {
    if (r.physics !== undefined) {
      const live = Object.entries(params).filter(([, p]) => p.live && JSON.stringify(p.value) !== JSON.stringify(p.default));
      const restTree = live.length ? read(doc, { ...values, ...Object.fromEntries(live.map(([k, p]) => [k, p.default])) }, { files, stack, rest: true, memo }).tree : tree;
      const restWorld = new Map();
      (function pair(a, b) { a.forEach((x, k) => { restWorld.set(x, b[k]?.world ?? x.world); pair(x.kids, b[k]?.kids ?? []); }); })(tree, restTree);
      physics = physicsOf(r.physics, tree, meshes, doc, scope, rat, items, restWorld, placedPhys);
    }
    else (function none(recs) { for (const x of recs) { need(!x.phys || x.foreign, `/nodes/${x.i}/extensions/${EXT}`, `${Object.keys(x.phys ?? {})[0]} needs ${rat}/physics`); none(x.kids); } })(tree);
  }
  const materialPhys = (i) => (isStub(doc.materials[i]) ? placedPhys[stubAt(i, scope)] : physMaterial(doc.materials[i], i, scope));
  const out = { params, sets, vars, placement, physics, materialPhys, placedPhys, get floor() { return floor ?? (low ??= lowestOnAxis(meshes, instances)); }, materials, meshes, nodes, instances, tree, skins, skinBlend, character, clips, placed, placedTextures, lights, finished };
  // Draft f28 (D-146): skinned shapes are built and weighted at the bind pose, every live parameter at its default,
  // and follow their joints from there. Done once, by the outermost document.
  if (!stack.length && !rest && skins.some((js) => js.length)) {
    const live = Object.entries(params).filter(([, p]) => p.live && JSON.stringify(p.value) !== JSON.stringify(p.default));
    skinPose(out, live.length ? read(doc, { ...values, ...Object.fromEntries(live.map(([k, p]) => [k, p.default])) }, { files, stack, rest: true, memo }) : out);
  }
  return out;
}

// Draft f32 (D-156, D-158, D-159): `poses`: name -> { weight, joints: { node name: euler } }. A joint is a node of this
// document by its name (recipe template text, else glTF name), once, not repeated, with a recipe euler or rotation
// (its core rotation is then the bake's cache); weight and eulers are expressions over the parameters and variables.
function posesOf(ps, src, repeated, scope, rat) {
  const turn = new Map();
  if (ps === undefined) return turn;
  need(isObj(ps), `${rat}/poses`, 'must be an object: pose name -> { weight, joints }');
  const byName = new Map();
  src.forEach((n, i) => {
    if (isBaked(n)) return;
    const name = n?.extensions?.[EXT]?.name ?? n?.name;
    if (typeof name === 'string') byName.set(name, byName.has(name) ? -1 : i);
  });
  for (const [name, pose] of Object.entries(ps)) {
    if (name.startsWith('//')) continue;
    const at = `${rat}/poses/${name}`;
    need(name !== '' && !name.includes('/'), at, 'a pose name is non-empty text without /');
    need(isObj(pose), at, 'must be an object: { weight, joints }');
    only(pose, ['weight', 'joints'], at);
    need(pose.weight !== undefined, `${at}/weight`, 'is required: an expression over the parameters, 0 for off and 1 for the full pose');
    const w = num(pose.weight, scope, `${at}/weight`);
    need(isObj(pose.joints) && Object.keys(pose.joints).some((k) => !k.startsWith('//')), `${at}/joints`, 'must be an object: node name -> euler [x, y, z] degrees');
    for (const [j, e] of Object.entries(pose.joints)) {
      if (j.startsWith('//')) continue;
      const jat = `${at}/joints/${j}`, i = byName.get(j);
      need(i !== undefined, jat, 'no node has this name');
      need(i !== -1, jat, 'several nodes have this name');
      need(!repeated.has(i), jat, `node ${i} is repeated; a pose turns one node`);
      const x = src[i].extensions?.[EXT];
      need(x?.euler !== undefined || x?.rotation !== undefined, jat, `node ${i} needs a recipe euler or rotation: a pose makes its core rotation the bake's`);
      const v = vec(e, 3, scope, jat), t = turn.get(i) ?? [0, 0, 0];
      turn.set(i, t.map((c, a) => c + w * v[a]));
    }
  }
  return turn;
}

// Draft f31 (D-152, D-153): clips drive live parameters over time. Each clip is sampled here, at `fps` (default 30)
// with keys exactly at 0 and `length`: [{ name, length, loop, fps, times, keys: [{ param: value }] }]; each value an
// expression of t (seconds) and u (t / length) over the parameters and variables.
function clipsOf(c, params, scope, rat) {
  if (c === undefined) return [];
  need(isObj(c), `${rat}/clips`, 'must be an object: clip name -> { length, loop, fps, values }');
  return Object.entries(c).filter(([name]) => !name.startsWith('//')).map(([name, clip]) => {
    const at = `${rat}/clips/${name}`;
    need(name !== '' && !name.includes('/'), at, 'a clip name is non-empty text without /');
    need(isObj(clip), at, 'must be an object');
    only(clip, ['length', 'loop', 'fps', 'values'], at);
    need(!('t' in scope) && !('u' in scope), at, 'a parameter or variable named t or u hides the clip time');
    const length = num(clip.length, scope, `${at}/length`), fps = clip.fps === undefined ? 30 : num(clip.fps, scope, `${at}/fps`);
    need(length > 0, `${at}/length`, `must be > 0 seconds, is ${length}`);
    need(fps > 0, `${at}/fps`, `must be > 0, is ${fps}`);
    need(clip.loop === undefined || typeof clip.loop === 'boolean', `${at}/loop`, 'must be true or false');
    need(isObj(clip.values) && Object.keys(clip.values).some((k) => !k.startsWith('//')), `${at}/values`, 'must be an object: live parameter -> expression of t and u');
    const vals = Object.entries(clip.values).filter(([k]) => !k.startsWith('//'));
    for (const [k] of vals) {
      need(Object.hasOwn(params, k), `${at}/values/${k}`, 'is not a parameter');
      need(params[k].live, `${at}/values/${k}`, 'is a bake parameter: a clip changes no mesh (§3.4)');
      need(params[k].type !== 'choice', `${at}/values/${k}`, 'a choice parameter cannot follow a clip');
    }
    const n = Math.max(1, Math.round(length * fps)), times = Array.from({ length: n + 1 }, (_, k) => (k === n ? length : (k * length) / n));
    const keys = times.map((t) => Object.fromEntries(vals.map(([k, e]) => {
      const sc = { ...scope, t, u: t / length }, kat = `${at}/values/${k}`, p = params[k];
      if (p.type === 'color') return [k, color(e, 4, sc, kat)];
      const v = num(e, sc, kat);
      return [k, p.type === 'bool' ? v !== 0 : v];
    })));
    return { name, length, loop: clip.loop ?? false, fps, times, keys };
  });
}

// Draft f28 (D-143..D-146): each skinned instance gets `rest`, its matrix at the bind pose; a rigid one is moved by
// its joint's motion from the bind pose, a blended one gets per-vertex `weights` (the 4 nearest bones by distance at
// the bind pose, over its blend width) and `restGeo` / `deformed`: its vertices in model space at the bind pose and
// at the values read. A joint's bone is the segments from its origin to its child joints' origins (a point when it
// has none). `out.restJoints[s]`: the joints' world matrices at the bind pose.
function skinPose(out, rest) {
  const cur = out.instances.filter((x) => x.rec.bound), was = rest.instances.filter((x) => x.rec.bound);
  need(cur.length === was.length && out.skins.every((js, s) => js.length === rest.skins[s].length), '', 'the bind pose has other skinned shapes than the values read');
  out.restJoints = rest.skins.map((js) => js.map((j) => j.world));
  const motion = out.skins.map((js, s) => js.map((j, k) => mul(j.world, invert(out.restJoints[s][k]))));
  const at = (m) => [m[12], m[13], m[14]];
  const bones = rest.skins.map((js) => {
    const idx = new Map(js.map((j, k) => [j, k])), kids = js.map(() => []);
    (function walk(recs, up) { for (const r of recs) { const k = idx.get(r); if (k !== undefined && up !== undefined) kids[up].push(k); walk(r.kids, k ?? up); } })(rest.tree, undefined);
    return js.map((j, k) => ({ o: at(j.world), ends: kids[k].map((c) => at(js[c].world)) }));
  });
  const geoms = new Map();
  cur.forEach((x, n) => {
    const s = x.rec.bound.skin, js = out.skins[s], B = was[n].matrix;
    x.rest = B;
    const w = x.rec.blend?.w ?? out.skinBlend[s] ?? 0;
    if (!(w > 0)) { x.matrix = mul(motion[s][js.indexOf(x.rec.bound.rec)], B); return; }
    if (!geoms.has(x.mesh)) geoms.set(x.mesh, geometry(out.meshes[x.mesh]));
    const g = geoms.get(x.mesh), count = g.positions.length / 3, only = x.rec.blend?.only;
    const ks = js.map((_, k) => k).filter((k) => !only || (js[k].owner === x.rec.blend.owner && only.has(js[k].i)));
    const nm = inverse3([0, 1, 2].map((r) => [0, 1, 2].map((c) => B[c * 4 + r]))) ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const P = new Float32Array(3 * count), N = new Float32Array(3 * count), dp = new Float32Array(3 * count), dn = new Float32Array(3 * count);
    const joints = new Uint16Array(4 * count), weights = new Float32Array(4 * count);
    for (let v = 0; v < count; v++) {
      const [px, py, pz] = g.positions.subarray(3 * v, 3 * v + 3), [qx, qy, qz] = g.normals.subarray(3 * v, 3 * v + 3);
      const p = [0, 1, 2].map((a) => B[a] * px + B[4 + a] * py + B[8 + a] * pz + B[12 + a]);
      const q = [0, 1, 2].map((a) => nm[0][a] * qx + nm[1][a] * qy + nm[2][a] * qz), ql = Math.hypot(...q) || 1;
      const top = blendWeights(p, ks.map((k) => bones[s][k]), w).map((e) => ({ k: ks[e.k], f: e.f }));
      const dv = [0, 0, 0], nv = [0, 0, 0];
      top.forEach((e, m) => {
        joints[4 * v + m] = e.k; weights[4 * v + m] = e.f;
        const M = motion[s][e.k];
        for (let a = 0; a < 3; a++) {
          dv[a] += e.f * (M[a] * p[0] + M[4 + a] * p[1] + M[8 + a] * p[2] + M[12 + a]);
          nv[a] += (e.f * (M[a] * q[0] + M[4 + a] * q[1] + M[8 + a] * q[2])) / ql;
        }
      });
      const nl = Math.hypot(...nv) || 1;
      for (let a = 0; a < 3; a++) { P[3 * v + a] = p[a]; N[3 * v + a] = q[a] / ql; dp[3 * v + a] = dv[a]; dn[3 * v + a] = nv[a] / nl; }
    }
    // D-97: a mirroring bind matrix turns faces inside out once baked into vertices; flip winding back
    const det = B[0] * (B[5] * B[10] - B[9] * B[6]) - B[4] * (B[1] * B[10] - B[9] * B[2]) + B[8] * (B[1] * B[6] - B[5] * B[2]);
    const indices = det < 0 ? Uint32Array.from(g.indices, (_, i) => g.indices[i - (i % 3) + [0, 2, 1][i % 3]]) : g.indices;
    x.weights = { joints, weights };
    x.restGeo = { positions: P, normals: N, uvs: g.uvs, indices };
    x.deformed = { positions: dp, normals: dn, uvs: g.uvs, indices };
    x.matrix = IDENTITY;
  });
}

// Draft f28 (D-143): a point's weights over bones { o, ends } (segments from o to each end; o alone without ends):
// f(x) = 1 − smoothstep(0, 1, x), x = (d − d_min) / w, d the distance to a bone; the largest 4 (ties to the lower
// index), divided by their sum. Returns [{ k, f }].
export function blendWeights(p, bones, w) {
  const d = bones.map(({ o, ends }) => {
    if (!ends.length) return Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
    let best = Infinity;
    for (const e of ends) {
      const a = [e[0] - o[0], e[1] - o[1], e[2] - o[2]], l2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - o[0]) * a[0] + (p[1] - o[1]) * a[1] + (p[2] - o[2]) * a[2]) / l2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - o[0] - t * a[0], p[1] - o[1] - t * a[1], p[2] - o[2] - t * a[2]));
    }
    return best;
  });
  const dmin = Math.min(...d);
  const top = d.map((dk, k) => { const x = Math.min(1, (dk - dmin) / w); return { k, f: 1 - x * x * (3 - 2 * x) }; })
    .filter((e) => e.f > 0).sort((a, b) => b.f - a.f || a.k - b.k).slice(0, 4);
  const sum = top.reduce((a, e) => a + e.f, 0);
  return top.map((e) => ({ k: e.k, f: e.f / sum }));
}

// Draft f26 (D-129, D-130): parameter -> the first bake slot it can reach, worked out from the document alone,
// without evaluating, in every branch. Bake slots: recipe mesh slots, a repeat's count, and a placed document's
// values that reach one there; and (D-134) a visible or model_visible that can hide a shape drawn by a skin's mesh
// (glTF cannot hide one primitive), and any values entry of a document placed under a joint. Everything else is
// live. Local names (vars, repeat vars, rows, model_*) pass on the parameters they read; they are pooled across the
// document, which only errs towards bake (D-134).
function bakeSlots(r, src, valueSinks, params, jointOf, skinnedPlaced) {
  const deps = new Map(params.map((k) => [k, new Set([k])]));
  const reads = (v, text) => (typeof v !== 'string' ? [] : text ? [...v.matchAll(/\{([^}]*)\}/g)].flatMap((m) => namesIn(m[1])) : namesIn(v));
  const from = (names) => new Set(names.flatMap((n) => [...(deps.get(n) ?? [])]));
  const defs = []; // [name, names it reads]
  for (const [k, v] of Object.entries(isObj(r.vars) ? r.vars : {})) defs.push([k, reads(v)]);
  for (const n of src) {
    const x = n?.extensions?.[EXT], rp = x?.repeat;
    if (Array.isArray(rp?.each)) for (const row of rp.each) for (const [k, v] of Object.entries(isObj(row) ? row : {})) defs.push([k, reads(v)]);
    for (const [k, v] of Object.entries(isObj(rp?.vars) ? rp.vars : {})) defs.push([k, reads(v)]);
    for (const v of Object.values(isObj(x?.values) ? x.values : {})) for (const a of 'xyz') for (const e of '01') defs.push([`model_${a}${e}`, reads(v)]);
  }
  for (let changed = true; changed;) { // until nothing new passes on
    changed = false;
    for (const [k, names] of defs) {
      const d = deps.get(k) ?? new Set(), size = d.size;
      for (const p of from(names)) d.add(p);
      deps.set(k, d);
      if (d.size > size) changed = true;
    }
  }
  const out = new Map(), sink = (at, names) => { for (const p of from(names)) if (!out.has(p)) out.set(p, at); };
  const SKIP = ['material', 'uv', 'blend', 'caps', 'plane', 'falloff']; // indices and keywords, not expressions
  const walk = (v, at, text) => {
    if (typeof v === 'string') return sink(at, reads(v, text));
    if (Array.isArray(v)) return v.forEach((e, i) => walk(e, `${at}/${i}`));
    if (isObj(v)) for (const [k, e] of Object.entries(v)) if (!k.startsWith('//') && !SKIP.includes(k)) walk(e, `${at}/${k}`, k === 'text' && typeof e === 'string');
  };
  (r.meshes ?? []).forEach((m, i) => walk(m, `/extensions/${EXT}/meshes/${i}`));
  src.forEach((n, i) => { const c = n?.extensions?.[EXT]?.repeat?.count; if (c !== undefined) sink(`/nodes/${i}/extensions/${EXT}/repeat/count`, reads(c)); });
  for (const [at, v] of valueSinks) sink(at, reads(v));
  const parent = new Map();
  src.forEach((n, i) => (Array.isArray(n?.children) ? n.children : []).forEach((c) => parent.set(c, i)));
  const underJoint = (i) => i !== undefined && (jointOf.has(i) || underJoint(parent.get(i)));
  const skinned = (i, x) => skinnedPlaced.has(i) || (x?.model !== undefined && underJoint(i)); // its placed document
  const carries = (i) => { const x = src[i]?.extensions?.[EXT]; return skinned(i, x) || (x?.mesh !== undefined && underJoint(i)) || (src[i]?.children ?? []).some(carries); };
  // D-197: a projection is worked out only where it is shown, so what shows it changes the baked shape
  const projects = (i) => isObj(r.meshes?.[src[i]?.extensions?.[EXT]?.mesh]?.extrude?.outline?.project) || (src[i]?.children ?? []).some(projects);
  src.forEach((n, i) => {
    const x = n?.extensions?.[EXT], xat = `/nodes/${i}/extensions/${EXT}`;
    if (x?.visible !== undefined && (carries(i) || projects(i))) sink(`${xat}/visible`, reads(x.visible));
    if (x?.model_visible !== undefined && skinned(i, x)) sink(`${xat}/model_visible`, reads(x.model_visible));
    if (x?.model !== undefined && underJoint(i)) for (const [k, v] of Object.entries(isObj(x.values) ? x.values : {})) sink(`${xat}/values/${k}`, reads(v));
    if (x?.blend !== undefined) sink(`${xat}/blend`, reads(x.blend)); // draft f28: weights are baked
  });
  (Array.isArray(r.skins) ? r.skins : []).forEach((sk, k) => { if (sk?.blend !== undefined) sink(`/extensions/${EXT}/skins/${k}/blend`, reads(sk.blend)); });
  return out;
}

// Draft f24 (D-118): a placed document's shown shapes' axis-aligned bounds in the placing node's frame, as the names
// its children see; all 0 when it shows none.
function modelBounds(sub) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], geo = new Map();
  for (const { mesh: mi, matrix: m } of sub.instances) {
    if (!geo.has(mi)) geo.set(mi, geometry(sub.meshes[mi]).positions);
    const p = geo.get(mi);
    for (let v = 0; v < p.length; v += 3) for (let a = 0; a < 3; a++) {
      const w = m[a] * p[v] + m[4 + a] * p[v + 1] + m[8 + a] * p[v + 2] + m[12 + a];
      if (w < lo[a]) lo[a] = w;
      if (w > hi[a]) hi[a] = w;
    }
  }
  const f = (x) => (Number.isFinite(x) ? x : 0);
  return Object.fromEntries(['x', 'y', 'z'].flatMap((a, k) => [[`model_${a}0`, f(lo[k])], [`model_${a}1`, f(hi[k])]]));
}

// Draft f10: `values` for another document's parameters (a placed model's, draft f34 a library material's),
// each a number, expression, color or option of the referring document in scope s.
function valuesOf(m, values, s, at) {
  need(values === undefined || isObj(values), at, 'must be an object');
  const ps = m.doc?.extensions?.[EXT]?.params ?? {}, vals = {};
  for (const [k, e] of Object.entries(values ?? {})) {
    if (k.startsWith('//')) continue;
    const kat = `${at}/${k}`;
    need(isObj(ps) && Object.hasOwn(ps, k), kat, `is not a parameter of ${m.label}`);
    if (ps[k]?.type === 'color') { vals[k] = color(e, 4, s, kat); continue; } // a color expression or linear channels (D-78, D-91)
    const opts = ps[k]?.type === 'choice' && Array.isArray(ps[k].options) ? ps[k].options : null;
    if (opts?.includes(e)) { vals[k] = e; continue; } // draft f21: an option by name, or an expression giving its index
    if (typeof s[e] === 'string') { // draft f23 (D-112): a row's text names the option
      need(opts?.includes(s[e]), kat, `"${e}" is text ("${s[e]}"); ${opts ? `must be one of ${JSON.stringify(opts)}` : 'only a choice parameter takes text'}`);
      vals[k] = s[e]; continue;
    }
    const v = num(e, s, kat);
    if (opts) need(Number.isInteger(v) && v >= 0 && v < opts.length, kat, `must be one of ${JSON.stringify(opts)} or an index 0..${opts.length - 1}, is ${v}`);
    vals[k] = ps[k]?.type === 'bool' ? v !== 0 : opts ? opts[v] : v;
  }
  return vals;
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
  for (const m of Array.isArray(doc?.materials) ? doc.materials : []) { // draft f34: library materials
    const u = m?.extensions?.[EXT]?.from?.uri;
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
  only(r, ['count', 'index', 'each', 'vars'], at);
  const fresh = (name, nat) => {
    need(typeof name === 'string' && /^[a-z_][a-z0-9_]*$/.test(name), nat, 'must be a lower_snake_case name');
    need(!Object.hasOwn(scope, name) && !Object.hasOwn(FUNCS, name), nat, `"${name}" is already a parameter, variable, enclosing name or function`);
  };
  fresh(r.index, `${at}/index`);
  if (r.each === undefined) return { count: Math.min(1024, Math.max(0, Math.round(num(r.count, scope, `${at}/count`)))), index: r.index, vars: r.vars };
  // Draft f10 (D-75): one row of named values per copy; a row's values do not see the rows' names.
  need(r.count === undefined, `${at}/count`, 'cannot stand next to each (the rows are the count)');
  const rows = list(r.each, `${at}/each`), keys = isObj(rows[0]) ? Object.keys(rows[0]).filter((k) => !k.startsWith('//')) : [];
  need(rows.length <= 1024, `${at}/each`, 'has more than 1024 rows');
  keys.forEach((k) => { fresh(k, `${at}/each/0/${k}`); need(k !== r.index, `${at}/each/0/${k}`, 'is the index'); });
  return { count: rows.length, index: r.index, vars: r.vars, rows: rows.map((row, j) => {
    need(isObj(row), `${at}/each/${j}`, 'must be an object');
    const ks = Object.keys(row).filter((k) => !k.startsWith('//'));
    need(ks.length === keys.length && ks.every((k) => keys.includes(k)), `${at}/each/${j}`, `must have the keys of row 0: ${keys.join(', ')}`);
    return Object.fromEntries(ks.map((k) => {
      const kat = `${at}/each/${j}/${k}`;
      if (typeof row[k] !== 'string') return [k, num(row[k], scope, kat)];
      try { return [k, num(row[k], scope, kat)]; } catch { return [k, row[k]]; } // draft f23 (D-112): not an expression, so text
    }));
  }) };
}

// Draft f22 (D-109): a repeat's `vars`, in order, in each copy's scope (after its index and row); seen where the index is.
function repeatVars(v, scope, at) {
  if (v === undefined) return scope;
  need(isObj(v), at, 'must be an object');
  const s = { ...scope };
  for (const [name, e] of Object.entries(v)) {
    if (name.startsWith('//')) continue;
    const nat = `${at}/${name}`;
    need(/^[a-z_][a-z0-9_]*$/.test(name), nat, 'name must be lower_snake_case');
    need(!Object.hasOwn(scope, name) && !Object.hasOwn(FUNCS, name), nat, `"${name}" is already a parameter, variable, enclosing name or function`);
    s[name] = typeof e === 'number' ? e : Array.isArray(e) ? color(e, 4, s, nat) : value(e, s, nat);
  }
  return s;
}

// A glTF node. Its JIG_recipe may set mesh, translation, rotation and scale; the core slots with a twin there
// are the bake's cache (D-14) and are ignored here. Other core slots are plain glTF.
function node(n, meshCount, scope, at) {
  need(isObj(n), at, 'must be an object');
  const xat = `${at}/extensions/${EXT}`;
  const x = n.extensions?.[EXT] ?? {};
  need(isObj(x), xat, 'must be an object');
  only(x, ['name', 'mesh', 'translation', 'rotation', 'euler', 'scale', 'repeat', 'model', 'values', 'on', 'light', 'visible', 'visible_for', 'model_visible', 'blend', 'blend_joints', 'role', ...PLACE_KEYS, ...PHYS_KEYS], xat);
  need(x.values === undefined || x.model !== undefined, `${xat}/values`, 'needs model');
  need(x.model_visible === undefined || x.model !== undefined, `${xat}/model_visible`, 'needs model');
  need(x.visible_for === undefined || (Array.isArray(x.visible_for) && x.visible_for.every((k) => typeof k === 'string' && k !== '')), `${xat}/visible_for`, 'must be a list of projection keys (non-empty strings)');
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
  // Draft f24 (D-116, D-118): 0 hides the node and its subtree (KHR_node_visibility); model_visible the placed model alone.
  const visible = x.visible === undefined || num(x.visible, scope, `${xat}/visible`) !== 0;
  const modelVisible = x.model_visible === undefined || num(x.model_visible, scope, `${xat}/model_visible`) !== 0;
  return { name, mesh: x.mesh, translation, rotation, scale, matrix: n.matrix ?? compose(translation, rotation, scale), children, jig: x, visible, modelVisible };
}

// Draft f36 (sketch): placement and use points, keys on a node, in its frame.
const PLACE_KEYS = ['use', 'clearance', 'opening', 'support'];
const PURPOSES = ['use', 'movement', 'access', 'maintenance'], LEVELS = ['required', 'recommended'], MOUNTS = ['floor', 'wall', 'ceiling', 'surface'];
function placeOf(x, s, xat, clipNames) {
  const o = {}, text = (v, at) => { need(typeof v === 'string' && v !== '', at, 'must be non-empty text'); return v; };
  const box = (v, n, at) => { const b = vec(v, n, s, at); b.forEach((c, a) => need(c > 0, `${at}/${a}`, `must be > 0, is ${c}`)); return b; };
  const pick = (k, keys, f) => {
    const v = x[k], at = `${xat}/${k}`;
    if (v === undefined) return;
    need(isObj(v), at, 'must be an object');
    only(v, keys, at);
    o[k] = f(v, at);
  };
  // A use point: a person's feet at the node's origin, facing its +z (Unreal Smart Object slot, Sims routing slot).
  pick('use', ['role', 'group', 'pose', 'clip', 'seat'], (v, at) => {
    const u = {};
    for (const k of ['role', 'group', 'pose']) if (v[k] !== undefined) u[k] = text(v[k], `${at}/${k}`);
    if (v.clip !== undefined) { u.clip = text(v.clip, `${at}/clip`); need(clipNames.includes(u.clip), `${at}/clip`, `no clip "${u.clip}" in this document's clips`); }
    if (v.seat !== undefined) { // OMI_seat: where the back, knees and feet go, in the node's frame; angle between back and thighs
      const sat = `${at}/seat`;
      need(isObj(v.seat), sat, 'must be { back, knee, foot, angle }');
      only(v.seat, ['back', 'knee', 'foot', 'angle'], sat);
      u.seat = Object.fromEntries(['back', 'knee', 'foot'].map((k) => [k, vec(v.seat[k], 3, s, `${sat}/${k}`)]));
      u.seat.angle = v.seat.angle === undefined ? 90 : num(v.seat.angle, s, `${sat}/angle`);
      need(u.seat.angle > 0 && u.seat.angle < 180, `${sat}/angle`, `must be between 0 and 180 degrees, is ${u.seat.angle}`);
    }
    return u;
  });
  // A clearance: space kept free, a box centred on the node (IFC Clearance); may overlap another model's clearance.
  pick('clearance', ['size', 'purpose', 'level'], (v, at) => {
    need(PURPOSES.includes(v.purpose), `${at}/purpose`, `must be one of ${JSON.stringify(PURPOSES)}`);
    need(v.level === undefined || LEVELS.includes(v.level), `${at}/level`, `must be one of ${JSON.stringify(LEVELS)}`);
    return { size: box(v.size, 3, `${at}/size`), purpose: v.purpose, level: v.level ?? 'required' };
  });
  // An opening: a box the host cuts from the wall the model is mounted on (IFC IfcOpeningElement); a passage lets people through.
  pick('opening', ['size', 'passage'], (v, at) => {
    need(v.passage === undefined || typeof v.passage === 'boolean', `${at}/passage`, 'must be true or false');
    return { size: box(v.size, 3, `${at}/size`), passage: v.passage ?? false };
  });
  // A support: a flat area facing the node's +y that others may stand on, size along x and z.
  pick('support', ['size', 'clear_height'], (v, at) => {
    const h = v.clear_height === undefined ? undefined : num(v.clear_height, s, `${at}/clear_height`);
    need(h === undefined || h > 0, `${at}/clear_height`, `must be > 0, is ${h}`);
    return { size: box(v.size, 2, `${at}/size`), ...(h !== undefined && { clear_height: h }) };
  });
  return o;
}
function modelPlacement(p, s, at) {
  if (p === undefined) return {};
  need(isObj(p), at, 'must be an object');
  only(p, ['mounts', 'tags', 'wall_gap'], at);
  const o = {};
  if (p.mounts !== undefined) {
    list(p.mounts, `${at}/mounts`).forEach((m, k) => need(MOUNTS.includes(m), `${at}/mounts/${k}`, `must be one of ${JSON.stringify(MOUNTS)}`));
    need(new Set(p.mounts).size === p.mounts.length, `${at}/mounts`, 'must not repeat a mount');
    o.mounts = [...p.mounts];
  }
  if (p.tags !== undefined) {
    list(p.tags, `${at}/tags`).forEach((t, k) => need(typeof t === 'string' && t !== '', `${at}/tags/${k}`, 'must be non-empty text'));
    o.tags = [...p.tags];
  }
  if (p.wall_gap !== undefined) { o.wall_gap = num(p.wall_gap, s, `${at}/wall_gap`); need(o.wall_gap >= 0, `${at}/wall_gap`, `must be >= 0, is ${o.wall_gap}`); }
  return o;
}

// Draft f37 (sketch): physics. The recipe's `physics` switches colliders on for every shape (a node opts out with
// `collider: false`); the root is a body, a node with `body` or `joint` starts another, and the colliders below it
// that start none are its (KHR_physics_rigid_bodies' rule). Mass is density × volume, density from the node, else
// its mesh's material, else 600 kg/m³.
const PHYS_KEYS = ['collider', 'body', 'joint', 'density'];
const MOTIONS = ['static', 'dynamic', 'kinematic'], COMBINES = ['average', 'minimum', 'maximum', 'multiply'];
const COLLIDER_SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'capsule'], AXES = ['x', 'y', 'z'];
const PHYS_MATERIAL = { density: 600, static_friction: 0.6, dynamic_friction: 0.6, restitution: 0, friction_combine: 'average', restitution_combine: 'average' };
function filterOf(f, at) {
  need(isObj(f), at, 'must be { systems, collide_with or not_collide_with }');
  only(f, ['systems', 'collide_with', 'not_collide_with'], at);
  need(f.collide_with === undefined || f.not_collide_with === undefined, at, 'takes collide_with or not_collide_with, not both');
  const o = {};
  for (const k of ['systems', 'collide_with', 'not_collide_with']) if (f[k] !== undefined) {
    list(f[k], `${at}/${k}`).forEach((x, i) => need(typeof x === 'string' && x !== '', `${at}/${k}/${i}`, 'must be non-empty text'));
    o[k] = [...f[k]];
  }
  return o;
}
function bodySpec(b, s, at, keys) {
  need(isObj(b), at, `must be an object: { ${keys.join(', ')} }`);
  only(b, keys, at);
  need(b.motion === undefined || MOTIONS.includes(b.motion), `${at}/motion`, `must be one of ${JSON.stringify(MOTIONS)}`);
  const o = { motion: b.motion };
  if (b.mass !== undefined) { o.mass = num(b.mass, s, `${at}/mass`); need(o.mass > 0, `${at}/mass`, `must be > 0 kg, is ${o.mass}`); }
  if (b.filter !== undefined) o.filter = filterOf(b.filter, `${at}/filter`);
  return o;
}
function physOf(x, s, xat) {
  const o = {};
  if (x.density !== undefined) { o.density = num(x.density, s, `${xat}/density`); need(o.density > 0, `${xat}/density`, `must be > 0 kg/m³, is ${o.density}`); }
  if (x.collider !== undefined) {
    const v = x.collider, at = `${xat}/collider`;
    if (v === false || v === 'auto' || v === 'hull' || v === 'box') o.collider = { from: v === false ? 'none' : v };
    else {
      need(isObj(v), at, 'must be false, "auto", "hull", "box", or { box | sphere | cylinder | cone | capsule, trigger, filter }');
      only(v, [...COLLIDER_SHAPES, 'trigger', 'filter'], at);
      const k = COLLIDER_SHAPES.filter((c) => v[c] !== undefined);
      need(k.length <= 1, at, 'has more than one shape');
      need(v.trigger === undefined || typeof v.trigger === 'boolean', `${at}/trigger`, 'must be true or false');
      o.collider = { from: k.length ? 'shape' : 'auto', ...(k.length && { shape: mesh({ [k[0]]: v[k[0]] }, s, at, 0) }), trigger: v.trigger ?? false,
        ...(v.filter !== undefined && { filter: filterOf(v.filter, `${at}/filter`) }) };
    }
  }
  if (x.body !== undefined) o.body = bodySpec(x.body, s, `${xat}/body`, ['motion', 'mass', 'filter']);
  if (x.joint !== undefined) o.joint = jointSpec(x.joint, s, `${xat}/joint`);
  return o;
}
// A joint as per-axis limits: turn (degrees) and slide (metres) about and along the node's x, y, z; each false
// (locked), [min, max] or true (free). hinge, slider, ball and fixed are shorthands for them.
function jointSpec(j, s, at) {
  need(isObj(j), at, 'must be an object: hinge, slider, ball or fixed, or turn and slide');
  only(j, ['hinge', 'slider', 'ball', 'fixed', 'turn', 'slide', 'drive', 'collide'], at);
  const kinds = ['hinge', 'slider', 'ball', 'fixed'].filter((k) => j[k] !== undefined);
  need(kinds.length <= 1 && !(kinds.length && (j.turn !== undefined || j.slide !== undefined)), at, 'takes one of hinge, slider, ball and fixed, or turn and slide');
  const limit = (v, a) => {
    if (v === false || v === true) return v;
    const r = vec(v, 2, s, a);
    need(r[0] <= r[1], a, `needs min <= max, is [${r}]`);
    return r;
  };
  const turn = [false, false, false], slide = [false, false, false], k = kinds[0], kat = `${at}/${k}`;
  if (k === 'fixed') need(j.fixed === true, kat, 'must be true');
  else if (k === 'ball') {
    need(j.ball === true || isObj(j.ball), kat, 'must be true or { limits }');
    if (isObj(j.ball)) only(j.ball, ['limits'], kat);
    turn.fill(j.ball.limits === undefined ? true : limit(j.ball.limits, `${kat}/limits`));
  } else if (k) {
    const h = j[k];
    need(isObj(h), kat, 'must be { axis, limits }');
    only(h, ['axis', 'limits'], kat);
    need(AXES.includes(h.axis), `${kat}/axis`, 'must be "x", "y" or "z"');
    (k === 'hinge' ? turn : slide)[AXES.indexOf(h.axis)] = h.limits === undefined ? true : limit(h.limits, `${kat}/limits`);
  } else for (const [key, arr] of [['turn', turn], ['slide', slide]]) {
    if (j[key] === undefined) continue;
    need(Array.isArray(j[key]) && j[key].length === 3, `${at}/${key}`, 'must be [x, y, z], each false (locked), [min, max] or true (free)');
    j[key].forEach((v, a) => { arr[a] = limit(v, `${at}/${key}/${a}`); });
  }
  // A drive per axis that is not locked (turn_x .. slide_z): pulls it towards target (degrees, metres) or moves it
  // at velocity (degrees or metres per second), with KHR's formula.
  const drives = [];
  if (j.drive !== undefined) {
    const dat = `${at}/drive`, names = ['turn', 'slide'].flatMap((k) => AXES.map((a) => `${k}_${a}`));
    need(isObj(j.drive), dat, `must be an object: axis (${names.join(', ')}) -> { stiffness, damping, target, velocity, max_force, mode }`);
    only(j.drive, names, dat);
    for (const [name, d] of Object.entries(j.drive)) {
      if (name.startsWith('//')) continue;
      const nat = `${dat}/${name}`, [kind, ax] = name.split('_'), a = AXES.indexOf(ax);
      need((kind === 'turn' ? turn : slide)[a] !== false, nat, `the joint locks ${kind} about ${ax}: there is nothing to drive`);
      need(isObj(d), nat, 'must be { stiffness, damping, target, velocity, max_force, mode }');
      only(d, ['stiffness', 'damping', 'target', 'velocity', 'max_force', 'mode'], nat);
      const o = { kind, axis: a };
      for (const key of ['stiffness', 'damping', 'max_force']) if (d[key] !== undefined) { o[key] = num(d[key], s, `${nat}/${key}`); need(o[key] >= 0, `${nat}/${key}`, `must be >= 0, is ${o[key]}`); }
      for (const key of ['target', 'velocity']) if (d[key] !== undefined) o[key] = num(d[key], s, `${nat}/${key}`);
      need(d.mode === undefined || ['force', 'acceleration'].includes(d.mode), `${nat}/mode`, 'must be "force" or "acceleration"');
      o.mode = d.mode ?? 'force';
      drives.push(o);
    }
  }
  need(j.collide === undefined || typeof j.collide === 'boolean', `${at}/collide`, 'must be true or false');
  return { turn, slide, drives, collide: j.collide ?? false };
}
function physMaterial(m, i, scope) {
  const x = m?.extensions?.[EXT]?.physics, at = `/materials/${i}/extensions/${EXT}/physics`;
  if (x === undefined || isBaked(m)) return null;
  need(isObj(x), at, 'must be an object');
  only(x, Object.keys(PHYS_MATERIAL), at);
  const o = {};
  for (const k of ['density', 'static_friction', 'dynamic_friction', 'restitution']) if (x[k] !== undefined) {
    o[k] = num(x[k], scope, `${at}/${k}`);
    need(k === 'density' ? o[k] > 0 : o[k] >= 0, `${at}/${k}`, `must be ${k === 'density' ? '> 0' : '>= 0'}, is ${o[k]}`);
  }
  for (const k of ['friction_combine', 'restitution_combine']) if (x[k] !== undefined) { need(COMBINES.includes(x[k]), `${at}/${k}`, `must be one of ${JSON.stringify(COMBINES)}`); o[k] = x[k]; }
  return o;
}
// The implicit shape a recipe mesh is, or null: box, cylinder (a cone too), sphere, capsule.
function implicitOf(m) {
  if (m.type === 'box') return { type: 'box', size: [...m.size] };
  if (m.type !== 'lathe' || !m.kind) return null;
  const ys = m.profile.map((q) => q[1]), r = Math.max(...m.profile.map((q) => q[0])), h = Math.max(...ys) - Math.min(...ys);
  if (m.kind === 'sphere') return { type: 'sphere', radius: r };
  if (m.kind === 'capsule') return { type: 'capsule', radius: r, height: h };
  return { type: 'cylinder', height: h, radiusBottom: m.profile[0][0], radiusTop: m.profile[1][0] };
}
function physicsOf(p, tree, meshes, doc, scope, rat, items, restWorld, placedPhys) {
  const at = `${rat}/physics`, root = bodySpec(p, scope, at, ['motion', 'mass', 'filter']);
  const mats = (doc.materials ?? []).map((m, i) => physMaterial(m, i, scope));
  root.motion ??= 'static';
  need(root.motion === 'static' || tree.length === 1, `${at}/motion`, 'a moving root body needs the scene to have one root node, which carries it');
  const bodies = [{ node: tree.length === 1 ? tree[0].i : null, rec: tree.length === 1 ? tree[0] : null, parent: null, world: tree.length === 1 ? tree[0].world : IDENTITY, motion: root.motion, mass: root.mass, filter: root.filter, colliders: [], at }];
  (function walk(recs, b, density, up) {
    for (const rec of recs) {
      if (!rec.shown) continue;
      const ph = rec.phys ?? {}, xat = `/nodes/${rec.i}/extensions/${EXT}`;
      let body = b;
      if (ph.body || ph.joint) {
        const motion = ph.body?.motion ?? 'dynamic';
        need(!(motion === 'static' && b.motion !== 'static'), `${xat}/body/motion`, 'a static body cannot sit inside a moving one');
        need(!ph.joint || up, `${xat}/joint`, 'a joint needs a parent node: it joins this body to the one its parent is in');
        body = { node: rec.i, rec, parent: b, up, world: rec.world, motion, mass: ph.body?.mass, filter: ph.body?.filter ?? b.filter, joint: ph.joint, colliders: [], at: `${xat}/${ph.joint ? 'joint' : 'body'}` };
        bodies.push(body);
      }
      const dens = ph.density ?? density, c = ph.collider ?? { from: 'auto' };
      if (c.from === 'shape' || (c.from !== 'none' && rec.mesh !== undefined && !rec.bound)) { // shortcut: a skinned shape infers no collider; declare one on its joint
        const m = c.shape ?? meshes[rec.mesh], g = geometry(m);
        let shape = c.from === 'hull' ? null : implicitOf(m), local = IDENTITY, geo = g;
        if (c.from === 'box') {
          const [lo, hi] = boundsOf(g.positions);
          shape = { type: 'box', size: hi.map((v, a) => v - lo[a]) };
          local = compose(lo.map((v, a) => (v + hi[a]) / 2), [0, 0, 0, 1], [1, 1, 1]);
          geo = geometry({ type: 'box', size: shape.size });
        }
        shape ??= { type: 'hull', mesh: rec.mesh };
        const ms = meshes[rec.mesh], own = ms?.material === undefined ? (ms?.placed === undefined ? null : placedPhys[ms.placed]) : mats[ms.material];
        const mat = { ...PHYS_MATERIAL, ...own, ...(dens !== undefined && { density: dens }) };
        const world = mul(rec.world, local);
        body.colliders.push({ node: rec.i, rec, shape, local, world, matrix: mul(invert(body.world), world), material: mat, trigger: c.trigger ?? false, filter: c.filter ?? body.filter, geo });
      }
      walk(rec.kids, body, dens, rec);
    }
  })(tree, bodies[0], undefined, null);
  for (const b of bodies) {
    Object.assign(b, massOf(b.colliders.filter((c) => !c.trigger)));
    if (b.motion !== 'static') need(b.volume > 1e-12 || b.mass !== undefined, b.at, 'a moving body whose colliders have no volume needs a mass');
    if (b.mass !== undefined && b.weight) { const k = b.mass / b.weight; b.inertia = b.inertia.map((v) => v * k); }
    b.mass ??= b.weight ?? 0;
    delete b.weight;
  }
  // The swing of each joint as a movement clearance on its parent body, unless the node declares one (0.19 G.16).
  const range = (v, deg) => (v === false ? [0] : v === true ? (deg ? Array.from({ length: 12 }, (_, k) => -180 + 30 * k) : [0]) : Array.from({ length: 9 }, (_, k) => v[0] + ((v[1] - v[0]) * k) / 8));
  for (const b of bodies) {
    if (!b.joint || b.rec.place?.clearance?.purpose === 'movement' || [...b.joint.turn, ...b.joint.slide].every((v) => v === false)) continue;
    const pts = b.colliders.filter((c) => !c.trigger).flatMap((c) => cornersOf(c.geo, c.matrix));
    if (!pts.length) continue;
    const rest = (x) => (x.rec ? restWorld.get(x.rec) : x.world), toParent = mul(invert(rest(b.parent)), rest(b)), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const [tx, ty, tz] = b.joint.turn.map((v) => range(v, true)), [sx, sy, sz] = b.joint.slide.map((v) => range(v, false));
    for (const ax of tx) for (const ay of ty) for (const az of tz) for (const lx of sx) for (const ly of sy) for (const lz of sz) {
      const M = mul(toParent, compose([lx, ly, lz], eulerQuat([ax, ay, az]), [1, 1, 1]));
      for (const q of pts) for (let a = 0; a < 3; a++) {
        const v = M[a] * q[0] + M[4 + a] * q[1] + M[8 + a] * q[2] + M[12 + a];
        lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v);
      }
    }
    items.push({ node: b.parent.node, holder: b.parent.rec, jointed: b.rec, name: b.rec.name, world: mul(b.parent.world, compose(lo.map((v, a) => (v + hi[a]) / 2), [0, 0, 0, 1], [1, 1, 1])),
      foreign: !!b.rec.foreign, clearance: { size: hi.map((v, a) => v - lo[a]), purpose: 'movement', level: 'required' }, inferred: true, from: b.node });
  }
  for (const b of bodies) if (b.joint) b.anchor = mul(invert(restWorld.get(b.up)), restWorld.get(b.rec));
  return { bodies: bodies.map((b) => ({ ...b, parent: b.parent ? bodies.indexOf(b.parent) : null })) };
}
const boundsOf = (P) => [[0, 1, 2].map((a) => Math.min(...P.filter((_, i) => i % 3 === a))), [0, 1, 2].map((a) => Math.max(...P.filter((_, i) => i % 3 === a)))];
// The 8 corners of a geometry's bounds, moved by matrix M.
function cornersOf(g, M) {
  const [lo, hi] = boundsOf(g.positions);
  return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
    const q = [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]];
    return [0, 1, 2].map((a) => M[a] * q[0] + M[4 + a] * q[1] + M[8 + a] * q[2] + M[12 + a]);
  });
}
// Mass properties of colliders (each { geo, matrix, material.density }) in the body's frame, by Eberly's polyhedral
// integrals over each closed triangle mesh. shortcut: a hull's volume is its mesh's, not its convex hull's; the same for
// the convex shapes JIG makes, less for a hollow one; an open mesh's integrals depend on its frame (taken as its own);
// upgrade when a model's mass looks wrong. Returns { volume, weight,
// com, inertia (principal moments), orientation (their frame, a quaternion) }.
// A geometry's integrals in its own frame, once per geometry (the station scene repeats one mesh in thousands of
// colliders): [volume, ∫x, ∫y, ∫z, ∫x², ∫y², ∫z², ∫xy, ∫yz, ∫zx], signed as its triangles wind.
const INTEGRALS = new WeakMap();
function integralsOf(g) {
  let q = INTEGRALS.get(g);
  if (q) return q;
  const mult = [1 / 6, 1 / 24, 1 / 24, 1 / 24, 1 / 60, 1 / 60, 1 / 60, 1 / 120, 1 / 120, 1 / 120], { positions: P, indices: T } = g;
  const sub = (w0, w1, w2) => {
    const t0 = w0 + w1, f1 = t0 + w2, t1 = w0 * w0, t2 = t1 + w1 * t0, f2 = t2 + w2 * f1, f3 = w0 * t1 + w1 * t2 + w2 * f2;
    return [f1, f2, f3, f2 + w0 * (f1 + w0), f2 + w1 * (f1 + w1), f2 + w2 * (f1 + w2)];
  };
  q = new Array(10).fill(0);
  for (let t = 0; t < T.length; t += 3) {
    const i0 = 3 * T[t], i1 = 3 * T[t + 1], i2 = 3 * T[t + 2];
    const x0 = P[i0], y0 = P[i0 + 1], z0 = P[i0 + 2], x1 = P[i1], y1 = P[i1 + 1], z1 = P[i1 + 2], x2 = P[i2], y2 = P[i2 + 1], z2 = P[i2 + 2];
    const a1 = x1 - x0, b1 = y1 - y0, c1 = z1 - z0, a2 = x2 - x0, b2 = y2 - y0, c2 = z2 - z0;
    const d0 = b1 * c2 - b2 * c1, d1 = a2 * c1 - a1 * c2, d2 = a1 * b2 - a2 * b1;
    const [f1x, f2x, f3x, g0x, g1x, g2x] = sub(x0, x1, x2), [, f2y, f3y, g0y, g1y, g2y] = sub(y0, y1, y2), [, f2z, f3z, g0z, g1z, g2z] = sub(z0, z1, z2);
    q[0] += d0 * f1x; q[1] += d0 * f2x; q[2] += d1 * f2y; q[3] += d2 * f2z; q[4] += d0 * f3x; q[5] += d1 * f3y; q[6] += d2 * f3z;
    q[7] += d0 * (y0 * g0x + y1 * g1x + y2 * g2x); q[8] += d1 * (z0 * g0y + z1 * g1y + z2 * g2y); q[9] += d2 * (x0 * g0z + x1 * g1z + x2 * g2z);
  }
  q = q.map((v, k) => v * mult[k]);
  INTEGRALS.set(g, q);
  return q;
}
function massOf(colliders) {
  const I = new Array(10).fill(0);
  let volume = 0;
  for (const c of colliders) {
    // The local integrals moved by M (x' = A x + t): V' = |det A| V, m' = |det A| (A m + t V),
    // S' = |det A| (A S Aᵀ + (A m) tᵀ + t (A m)ᵀ + V t tᵀ); |det|, as a mirror turns the mesh inside out.
    const M = c.matrix, q = integralsOf(c.geo), A = [[M[0], M[4], M[8]], [M[1], M[5], M[9]], [M[2], M[6], M[10]]], t = [M[12], M[13], M[14]];
    const k = Math.abs(M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]));
    const V = q[0], m = [q[1], q[2], q[3]], S = [[q[4], q[7], q[9]], [q[7], q[5], q[8]], [q[9], q[8], q[6]]];
    const Am = A.map((r) => r[0] * m[0] + r[1] * m[1] + r[2] * m[2]), AS = A.map((r) => [0, 1, 2].map((j) => r[0] * S[0][j] + r[1] * S[1][j] + r[2] * S[2][j]));
    const s = (a, b) => AS[a][0] * A[b][0] + AS[a][1] * A[b][1] + AS[a][2] * A[b][2] + Am[a] * t[b] + t[a] * Am[b] + V * t[a] * t[b];
    const w = [V, Am[0] + t[0] * V, Am[1] + t[1] * V, Am[2] + t[2] * V, s(0, 0), s(1, 1), s(2, 2), s(0, 1), s(1, 2), s(2, 0)];
    volume += k * V;
    w.forEach((v, j) => { I[j] += k * v * c.material.density; });
  }
  const m = I[0];
  if (!(m > 1e-12)) return { volume, weight: undefined, com: [0, 0, 0], inertia: [0, 0, 0], orientation: [0, 0, 0, 1] };
  const [cx, cy, cz] = [I[1] / m, I[2] / m, I[3] / m];
  const xx = I[5] + I[6] - m * (cy * cy + cz * cz), yy = I[4] + I[6] - m * (cz * cz + cx * cx), zz = I[4] + I[5] - m * (cx * cx + cy * cy);
  const xy = -(I[7] - m * cx * cy), yz = -(I[8] - m * cy * cz), xz = -(I[9] - m * cz * cx);
  const { values, vectors } = eigen3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
  return { volume, weight: m, com: [cx, cy, cz], inertia: values, orientation: frameQuat(...vectors) };
}
// Eigenvalues and right-handed unit eigenvectors (as columns) of a symmetric 3×3 matrix, by Jacobi rotations.
function eigen3(A) {
  const a = A.map((r) => [...r]), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) <= 1e-15 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]))) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (a[p][q] === 0) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = (th < 0 ? -1 : 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
      for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
    }
  }
  const cols = [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]), [x, y] = cols;
  cols[2] = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]; // right-handed
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: cols };
}

// Euler angles in degrees about glTF's (Y-up) axes: x, then y, then z, each about the fixed axes (matrix Rz·Ry·Rx), as a
// glTF quaternion. Not Blender's frame, which is Z-up (D-69).
export function eulerQuat(deg) {
  const [cx, cy, cz] = deg.map((d) => Math.cos((d * Math.PI) / 360)), [sx, sy, sz] = deg.map((d) => Math.sin((d * Math.PI) / 360));
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

function mesh(m, scope, at, materialCount) {
  need(isObj(m), at, 'must be an object');
  only(m, ['box', 'loft', 'extrude', 'lathe', 'text', ...ROUND, 'material', 'uv'], at);
  need(Object.keys(m).filter((k) => !k.startsWith('//') && k !== 'material' && k !== 'uv').length === 1, at, `must have one shape: box, loft, extrude, lathe, text, ${ROUND.join(', ')}`);
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
  if (m.text !== undefined) return text(m.text, scope, `${at}/text`);
  const k = ROUND.find((r) => m[r] !== undefined);
  if (k) return round(k, m[k], scope, `${at}/${k}`);
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

const OWNED = ['meshes', 'accessors', 'bufferViews', 'buffers', 'nodes', 'materials', 'skins', 'images', 'samplers', 'textures', 'animations'];
const KHR_TT = 'KHR_texture_transform';
const KHR_VARIANTS = 'KHR_materials_variants';
const KHR_AP = 'KHR_animation_pointer';
// Draft f31 (D-155): what a clip may change in a baked glTF, key -> value with glTF's defaults. Keys: "translation 3"
// (node 3), "pointer /materials/0/..." (a KHR_animation_pointer target), "?<what>" (a change no channel is written for).
function animatable(g, at) {
  const m = new Map(), lights = g.extensions?.KHR_lights_punctual?.lights ?? [];
  m.set('?the number of nodes, materials or lights', [g.nodes?.length, g.materials?.length, lights.length]);
  (g.nodes ?? []).forEach((n, i) => {
    m.set(`translation ${i}`, n.translation ?? [0, 0, 0]); m.set(`rotation ${i}`, n.rotation ?? [0, 0, 0, 1]); m.set(`scale ${i}`, n.scale ?? [1, 1, 1]);
    m.set(`pointer /nodes/${i}/extensions/${KHR_NV}/visible`, n.extensions?.[KHR_NV]?.visible ?? true);
    m.set(`?a node's mesh or children (node ${i})`, [n.mesh, n.children, n.skin]);
  });
  (g.materials ?? []).forEach((mt, i) => {
    const pbr = mt.pbrMetallicRoughness ?? {}, at = `/materials/${i}`;
    m.set(`pointer ${at}/pbrMetallicRoughness/baseColorFactor`, pbr.baseColorFactor ?? [1, 1, 1, 1]);
    m.set(`pointer ${at}/pbrMetallicRoughness/metallicFactor`, pbr.metallicFactor ?? 1);
    m.set(`pointer ${at}/pbrMetallicRoughness/roughnessFactor`, pbr.roughnessFactor ?? 1);
    m.set(`pointer ${at}/emissiveFactor`, mt.emissiveFactor ?? [0, 0, 0]);
    for (const [k, [e, def]] of Object.entries(EXT_SLOTS)) m.set(`pointer ${at}/extensions/${e}/${k}`, mt.extensions?.[e]?.[k] ?? def); // draft f38: twin slots
    const rest = Object.fromEntries(Object.entries(mt.extensions ?? {}).map(([e, v]) => [e, Object.fromEntries(Object.entries(v).filter(([k]) => EXT_SLOTS[k]?.[0] !== e))]).filter(([, v]) => Object.keys(v).length));
    m.set(`?material ${i}'s other extensions or texture transforms`, JSON.stringify([rest, pbr.baseColorTexture, pbr.metallicRoughnessTexture, mt.normalTexture, mt.occlusionTexture, mt.emissiveTexture]));
  });
  lights.forEach((l, i) => {
    m.set(`pointer /extensions/KHR_lights_punctual/lights/${i}/color`, l.color ?? [1, 1, 1]);
    m.set(`pointer /extensions/KHR_lights_punctual/lights/${i}/intensity`, l.intensity ?? 1);
    m.set(`?light ${i}'s range or cone`, JSON.stringify([l.range, l.spot]));
  });
  return m;
}
const VRMC = 'VRMC_vrm', VRM_LICENSE = 'https://vrm.dev/licenses/1.0/';
// VRM 1.0 humanoid bones (draft f30, D-149); the first 15 are required.
export const VRM_REQUIRED = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
export const VRM_BONES = [...VRM_REQUIRED, 'chest', 'upperChest', 'neck', 'leftEye', 'rightEye', 'jaw', 'leftToes', 'rightToes', 'leftShoulder', 'rightShoulder',
  ...['left', 'right'].flatMap((s) => [`${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`,
    ...['Index', 'Middle', 'Ring', 'Little'].flatMap((f) => [`${s}${f}Proximal`, `${s}${f}Intermediate`, `${s}${f}Distal`])])];
const KHR_LIGHTS = 'KHR_lights_punctual';
const JIG_PLACEMENT = 'JIG_placement', OMI_SEAT = 'OMI_seat';
// Draft f37: physics written both as Khronos' drafts and as OMI's, from the same bodies.
const KHR_RB = 'KHR_physics_rigid_bodies', KHR_IS = 'KHR_implicit_shapes', OMI_BODY = 'OMI_physics_body', OMI_SHAPE = 'OMI_physics_shape', OMI_JOINT = 'OMI_physics_joint';
const PHYS_EXTS = [KHR_RB, KHR_IS, OMI_BODY, OMI_SHAPE, OMI_JOINT];
// A rigid matrix's translation and unit quaternion, rounded so a rebake writes the same bytes.
const trs = (m) => [[m[12], m[13], m[14]].map((v) => +v.toFixed(9)), frameQuat([m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]).map((v) => +v.toFixed(9))];
function writePhysics(d, phys, nodeAt, meshAt, add) {
  const khrShapes = [], omiShapes = [], mats = [], filters = [], joints = [];
  const index = (list, o) => { const k = JSON.stringify(o), i = list.findIndex((x) => JSON.stringify(x) === k); return i >= 0 ? i : list.push(o) - 1; };
  const ext = (i, e, v) => { const n = d.nodes[i]; n.extensions = { ...n.extensions, [e]: { ...n.extensions?.[e], ...v } }; };
  const filterAt = (f) => f && index(filters, { ...(f.systems && { collisionSystems: f.systems }), ...(f.collide_with && { collideWithSystems: f.collide_with }), ...(f.not_collide_with && { notCollideWithSystems: f.not_collide_with }) });
  // a capsule's height between its caps' centres, as OMI's; shortcut: KHR_implicit_shapes does not say yet, check when it is ratified
  const shapeOf = (sh, omi) => sh.type === 'box' ? { type: 'box', box: { size: sh.size } } : sh.type === 'sphere' ? { type: 'sphere', sphere: { radius: sh.radius } }
    : sh.type === 'capsule' ? { type: 'capsule', capsule: { height: sh.height - 2 * sh.radius, radiusTop: sh.radius, radiusBottom: sh.radius } }
    : sh.type === 'cylinder' ? { type: 'cylinder', cylinder: { height: sh.height, radiusTop: sh.radiusTop, radiusBottom: sh.radiusBottom } }
    : omi ? { type: 'convex', convex: { mesh: meshAt[sh.mesh] } } : null;
  const bodyNode = phys.bodies.map((b) => nodeAt(b.rec));
  phys.bodies.forEach((b, k) => {
    const bn = bodyNode[k];
    if (b.motion !== 'static') {
      const motion = { mass: b.mass, centerOfMass: b.com, inertiaDiagonal: b.inertia, inertiaOrientation: b.orientation };
      ext(bn, KHR_RB, { motion: { isKinematic: b.motion === 'kinematic', ...motion } });
      ext(bn, OMI_BODY, { motion: { type: b.motion, ...motion } });
    }
    for (const c of b.colliders) {
      let cn = nodeAt(c.rec);
      if (c.local !== IDENTITY) { // a box round a mesh's bounds sits off the node's origin: a node of its own
        const child = add('nodes', { name: 'collider', translation: [c.local[12], c.local[13], c.local[14]] });
        (d.nodes[cn].children ??= []).push(child);
        cn = child;
      }
      const material = c.trigger ? {} : { physicsMaterial: index(mats, { staticFriction: c.material.static_friction, dynamicFriction: c.material.dynamic_friction, restitution: c.material.restitution,
        frictionCombine: c.material.friction_combine, restitutionCombine: c.material.restitution_combine }) };
      const filter = c.filter ? { collisionFilter: filterAt(c.filter) } : {}, kind = c.trigger ? 'trigger' : 'collider';
      const khr = shapeOf(c.shape, false);
      ext(cn, KHR_RB, { [kind]: { geometry: khr ? { shape: index(khrShapes, khr) } : { mesh: meshAt[c.shape.mesh], convexHull: true }, ...material, ...filter } });
      ext(cn, OMI_BODY, { [kind]: { shape: index(omiShapes, shapeOf(c.shape, true)), ...material, ...filter } });
    }
    if (!b.joint) return;
    // The joint on a node of its own at the body's origin (OMI asks for one), joined to the node above the body.
    const rad = (v) => (v * Math.PI) / 180, limits = [], drives = [];
    for (const [key, angular] of [['turn', true], ['slide', false]]) b.joint[key].forEach((v, a) => {
      if (v === true) return;
      const [lo, hi] = v === false ? [0, 0] : angular ? v.map(rad) : v;
      limits.push({ [angular ? 'angularAxes' : 'linearAxes']: [a], min: lo, max: hi });
    });
    for (const dr of b.joint.drives) {
      const angular = dr.kind === 'turn', u = (v) => (angular ? rad(v) : v);
      drives.push({ type: angular ? 'angular' : 'linear', mode: dr.mode, axis: dr.axis, ...(dr.max_force !== undefined && { maxForce: dr.max_force }),
        ...(dr.target !== undefined && { positionTarget: u(dr.target) }), ...(dr.velocity !== undefined && { velocityTarget: u(dr.velocity) }),
        stiffness: dr.stiffness ?? 0, damping: dr.damping ?? 0 });
    }
    // The connected side: the joint's frame at rest, fixed under the node above, so limits count from rest (Q-3).
    const [t, q] = trs(b.anchor), up = nodeAt(b.up);
    const anchor = add('nodes', { name: 'joint anchor', ...(String(t) !== '0,0,0' && { translation: t }), ...(String(q) !== '0,0,0,1' && { rotation: q }) });
    (d.nodes[up].children ??= []).push(anchor);
    const joint = index(joints, { limits, ...(drives.length && { drives }) }), link = { connectedNode: anchor, joint, enableCollision: b.joint.collide };
    const jn = add('nodes', { name: 'joint', extensions: { [KHR_RB]: { joint: link }, [OMI_JOINT]: link } });
    (d.nodes[bn].children ??= []).push(jn);
  });
  const root = (e, o) => { const kept = Object.fromEntries(Object.entries(o).filter(([, v]) => v.length)); if (Object.keys(kept).length) d.extensions[e] = kept; };
  const physicsMaterials = mats, collisionFilters = filters;
  root(KHR_IS, { shapes: khrShapes });
  root(KHR_RB, { physicsMaterials, collisionFilters, physicsJoints: joints });
  root(OMI_SHAPE, { shapes: omiShapes });
  root(OMI_BODY, { physicsMaterials, collisionFilters });
  root(OMI_JOINT, { physicsJoints: joints });
  for (const e of PHYS_EXTS) if (JSON.stringify([d.nodes, d.extensions]).includes(`"${e}"`) && !d.extensionsUsed.includes(e)) d.extensionsUsed.push(e);
}
// Draft f36: a node's baked placement, and a seat use point as OMI_seat (angle in radians, as OMI's).
const placeExt = (p) => {
  const { seat, ...use } = p.use ?? {}, o = { [JIG_PLACEMENT]: { ...p, ...(p.use && { use }) } };
  if (seat) o[OMI_SEAT] = { back: seat.back, foot: seat.foot, knee: seat.knee, angle: (seat.angle * Math.PI) / 180 };
  return o;
};
const KHR_NV = 'KHR_node_visibility';
const KHR_ES = 'KHR_materials_emissive_strength';
// Recipe slots kept in a material extension: [extension, default]; the bake writes the extension only off the default.
const EXT_SLOTS = { emissiveStrength: [KHR_ES, 1], transmissionFactor: ['KHR_materials_transmission', 0], ior: ['KHR_materials_ior', 1.5],
  sheenColorFactor: ['KHR_materials_sheen', [0, 0, 0]], sheenRoughnessFactor: ['KHR_materials_sheen', 0],
  diffuseTransmissionFactor: ['KHR_materials_diffuse_transmission', 0], diffuseTransmissionColorFactor: ['KHR_materials_diffuse_transmission', [1, 1, 1]] };
const MATERIAL_EXTS = [KHR_TT, ...new Set(Object.values(EXT_SLOTS).map(([e]) => e))];
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
  if (d.extensions?.[EXT]?.clips !== undefined && Array.isArray(d.extensionsUsed)) d.extensionsUsed = d.extensionsUsed.filter((e) => e !== KHR_AP); // draft f31: cache of the clips
  if (d.extensions?.[EXT]?.character !== undefined && d.extensions[VRMC] !== undefined) { // VRMC_vrm comes from the character (draft f30)
    delete d.extensions[VRMC];
    if (Array.isArray(d.extensionsUsed)) d.extensionsUsed = d.extensionsUsed.filter((e) => e !== VRMC);
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
    if (x?.light !== undefined && isObj(n.extensions)) delete n.extensions[KHR_LIGHTS]; // its twin (D-113)
    if (x?.visible !== undefined && isObj(n.extensions)) delete n.extensions[KHR_NV]; // its twin (D-130)
    if (isObj(x) && PLACE_KEYS.some((k) => x[k] !== undefined) && isObj(n.extensions)) { delete n.extensions[JIG_PLACEMENT]; delete n.extensions[OMI_SEAT]; } // draft f36
  }
  if (d.extensions?.[EXT]?.placement !== undefined) delete d.extensions[JIG_PLACEMENT];
  if (d.extensions?.[EXT]?.physics !== undefined) { // draft f37: all physics comes from the recipe
    for (const n of Array.isArray(d.nodes) ? d.nodes : []) if (isObj(n?.extensions)) for (const e of PHYS_EXTS) delete n.extensions[e];
    for (const e of PHYS_EXTS) delete d.extensions[e];
    if (Array.isArray(d.extensionsUsed)) d.extensionsUsed = d.extensionsUsed.filter((e) => !PHYS_EXTS.includes(e));
  }
  for (const e of [JIG_PLACEMENT, OMI_SEAT]) if (Array.isArray(d.extensionsUsed) && !JSON.stringify([d.nodes, d.extensions]).includes(`"${e}"`)) d.extensionsUsed = d.extensionsUsed.filter((u) => u !== e);
  if (Array.isArray(d.extensionsUsed) && !(d.nodes ?? []).some((n) => n?.extensions?.[KHR_NV])) d.extensionsUsed = d.extensionsUsed.filter((e) => e !== KHR_NV);
  const lx = d.extensions?.[KHR_LIGHTS];
  if (Array.isArray(lx?.lights)) { // the lights of placed documents (D-113)
    lx.lights = lx.lights.filter((l) => !isBaked(l));
    if (!lx.lights.length) {
      delete d.extensions[KHR_LIGHTS];
      if (Array.isArray(d.extensionsUsed)) d.extensionsUsed = d.extensionsUsed.filter((e) => e !== KHR_LIGHTS);
    }
  }
  return d;
}

// Draft f23 (D-111): nodes and materials added after a baked file's cache move in front of it, their references
// renumbered, so strip and bake take them. The reader still asks baked items to come last (D-17).
// shortcut: nodes and materials only (the items added by hand); other arrays keep D-17's error.
export function hoist(doc) {
  const d = structuredClone(doc), r = d.extensions?.[EXT];
  const order = (k) => {
    if (!Array.isArray(d[k])) return null;
    const idx = d[k].map((_, i) => i), keep = idx.filter((i) => !isBaked(d[k][i])), baked = idx.filter((i) => isBaked(d[k][i]));
    const now = [...keep, ...baked];
    if (now.every((i, j) => i === j)) return null;
    const map = new Map(now.map((i, j) => [i, j]));
    d[k] = now.map((i) => d[k][i]);
    return (i) => (Number.isInteger(i) && map.has(i) ? map.get(i) : i);
  };
  const n = order('nodes');
  if (n) {
    for (const sc of Array.isArray(d.scenes) ? d.scenes : []) if (Array.isArray(sc?.nodes)) sc.nodes = sc.nodes.map(n);
    for (const x of d.nodes) if (Array.isArray(x?.children)) x.children = x.children.map(n);
    for (const s of [...(Array.isArray(d.skins) ? d.skins : []), ...(Array.isArray(r?.skins) ? r.skins : [])]) {
      if (Array.isArray(s?.joints)) s.joints = s.joints.map(n);
      if (s?.skeleton !== undefined) s.skeleton = n(s.skeleton);
    }
  }
  const m = order('materials');
  if (m) {
    for (const x of Array.isArray(r?.meshes) ? r.meshes : []) if (x?.material !== undefined) x.material = m(x.material);
    for (const x of Array.isArray(d.meshes) ? d.meshes : []) for (const p of x?.primitives ?? []) if (p.material !== undefined) p.material = m(p.material);
  }
  return d;
}

// Bake at `values` (over baked_values, over defaults). Returns { gltf, bin }: gltf is the document with a fresh
// cache and baked_values; bin is the buffer's bytes. The buffer is embedded as a data URI unless `uri` names a
// separate file (D-23). The same document and values give the same bytes (D-15).
// `set` names a set to bake with (its values under `values`) and records it as baked_set; null drops baked_set;
// left out, baked_set stays as it is.
export function bake(doc, values = {}, { uri, set, files, quick = false } = {}) {
  const d = strip(hoist(doc));
  const r = d.extensions?.[EXT];
  if (typeof set === 'string') {
    need(isObj(r?.sets?.[set]), `/extensions/${EXT}/sets`, `has no set named "${set}"`);
    values = { ...r.sets[set], ...values };
  }
  const out = read(d, values, { files, rest: quick }); // quick (draft f31): a clip key, no shapes and no bind pose
  const shapeGeo = quick ? () => NO_GEOMETRY : geometry;
  d.asset.generator = `JIG ${VERSION} reference baker`;
  r.baked_values = Object.fromEntries(Object.entries(out.params).map(([k, p]) => [k, p.value]));
  if (set !== undefined) { delete r.baked_set; if (set !== null) r.baked_set = set; }

  const base = Object.fromEntries(OWNED.map((k) => [k, d[k]?.length ?? 0]));
  const add = (k, item) => (d[k] ??= []).push({ ...item, extensions: { ...item.extensions, [EXT]: { baked: true } } }) - 1;
  const authored = structuredClone(d.materials ?? []); // before the cache: the base of variant materials

  // Sets as KHR_materials_variants (draft f8): each set is a variant; a material whose recipe slots differ at a set's
  // values (over this bake's) gets a baked copy with them, mapped on every primitive that uses the material.
  const names = Object.keys(out.sets), mapping = {}, stubSets = {};
  // A finished material with each texture index replaced by its { texture, image, sampler }, to compare across reads.
  const full = (o, p) => {
    const mat = structuredClone(o.placed[p]);
    for (const slot of textureSlots(mat)) slot.index = o.placedTextures[slot.index];
    return mat;
  };
  const shapes = (o) => { // every node drawing a shape, in tree order
    const l = [];
    (function all(recs) { for (const x of recs) { if (x.mesh !== undefined) l.push(x); all(x.kids ?? []); } })(o.tree);
    return l;
  };
  names.forEach((name, v) => {
    const so = read(d, { ...r.baked_values, ...out.sets[name] }, { files, rest: true }), mats = so.materials; // materials only: no projections, physics or skin pose
    // Draft f34 (D-167): a stub's material at the set's values, per baked mesh, matched node by node in tree order.
    const a = shapes(out), b = shapes(so), sat = `/extensions/${EXT}/sets/${name}`;
    a.forEach((x, k) => {
      const m = out.meshes[x.mesh];
      if (m.stub === undefined) return;
      need(b.length === a.length && so.meshes[b[k].mesh].stub === m.stub, sat, 'changes which shapes are drawn, so a stub material cannot take its variant');
      const want = full(so, so.meshes[b[k].mesh].placed), had = (stubSets[x.mesh] ??= {})[v];
      if (JSON.stringify(want) === JSON.stringify(full(out, m.placed))) return;
      need(had === undefined || JSON.stringify(had) === JSON.stringify(want), sat, 'gives copies that share a mesh different stub materials');
      stubSets[x.mesh][v] = want;
    });
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
  const placedAt = {}, texAt = {}, stubVariantAt = {};
  const texOf = (e) => { // draft f11: a placed material's texture, with its image and sampler, as baked items
    const { texture, image, sampler } = e;
    return (texAt[JSON.stringify(e)] ??= add('textures', { ...texture, source: add('images', image), ...(sampler && { sampler: add('samplers', sampler) }) }));
  };
  const finishedMaterial = (mat) => { // textures as entries (`full`) -> a baked material
    for (const [k, place] of Object.entries(TEXTURE_SLOTS)) { const slot = place === 'pbr' ? mat.pbrMetallicRoughness?.[k] : mat[k]; if (isObj(slot?.index)) slot.index = texOf(slot.index); }
    return add('materials', mat);
  };
  const matIndex = (m) => (m.placed === undefined ? m.material : (placedAt[m.placed] ??= finishedMaterial(full(out, m.placed))));
  // A baked mesh's KHR_materials_variants mappings: its own material's (draft f8), or its stub's (D-167).
  const variantsOf = (mi) => {
    const m = out.meshes[mi];
    if (m.stub === undefined) return mapping[m.material];
    const list = Object.entries(stubSets[mi] ?? {}).map(([v, mat]) => {
      const named = mat.name === undefined ? mat : { ...mat, name: `${mat.name} (${names[v]})` }, key = JSON.stringify(named);
      return { material: (stubVariantAt[key] ??= finishedMaterial(structuredClone(named))), variants: [+v] };
    });
    return list.length ? list : undefined;
  };
  // Only meshes a drawn node draws unskinned are baked, hidden ones too (D-130), in recipe order; meshAt maps recipe
  // mesh to core mesh. A hidden shape bound to a joint is left out of its skin's mesh; its visible is bake (D-134).
  const drawn = [];
  (function all(recs) { for (const rec of recs) if (rec.drawn) { drawn.push(rec); all(rec.kids); } })(out.tree);
  const used = new Set(drawn.filter((rec) => rec.mesh !== undefined && !rec.bound).map((rec) => rec.mesh)), meshAt = {};
  for (const [mi, m] of out.meshes.entries()) {
    if (!used.has(mi)) continue;
    meshAt[mi] = base.meshes + Object.keys(meshAt).length;
    const { positions, normals, uvs, indices: all } = shapeGeo(m);
    const short = positions.length / 3 <= 65535; // glTF reserves 65535 in 16-bit indices
    const indices = short ? Uint16Array.from(all) : all;
    const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)));
    const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
    const pos = add('accessors', { bufferView: view(positions, 34962), componentType: 5126, count: positions.length / 3,
      type: 'VEC3', min, max });
    const nor = add('accessors', { bufferView: view(normals, 34962), componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const tex = add('accessors', { bufferView: view(uvs, 34962), componentType: 5126, count: uvs.length / 2, type: 'VEC2' });
    const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
    const mat = matIndex(m), maps = variantsOf(mi);
    add('meshes', { primitives: [{ attributes: { POSITION: pos, NORMAL: nor, TEXCOORD_0: tex }, indices: idx, ...(mat !== undefined && { material: mat }),
      ...(maps && { extensions: { [KHR_VARIANTS]: { mappings: maps } } }) }] });
  }
  out.materials.forEach((m, i) => { if (m) slots(d.materials[i], m); }); // the material cache (D-57)
  for (const e of MATERIAL_EXTS) if (JSON.stringify(d.materials ?? []).includes(`"${e}"`) && !d.extensionsUsed.includes(e)) d.extensionsUsed.push(e);

  // Nodes outside any repeat get their cache in place; each shown copy of a repeated node becomes a baked node,
  // with baked copies of its subtree, appended to the repeated node's children (D-45); so does each shown node of
  // a placed document (draft f10). A shape bound to a joint is drawn by its skin's mesh, not by its node.
  const nodeOf = new Map();
  const copyOf = (rec) => {
    const kids = rec.kids.filter((r) => r.drawn).map(copyOf), n = rec.node, b = {};
    if (rec.name !== undefined) b.name = rec.name;
    if (rec.mesh !== undefined && !rec.bound) b.mesh = meshAt[rec.mesh];
    if (rec.light !== undefined) b.extensions = { [KHR_LIGHTS]: { light: rec.light } };
    if (rec.hidden) b.extensions = { ...b.extensions, [KHR_NV]: { visible: false } };
    if (rec.place) b.extensions = { ...b.extensions, ...placeExt(rec.place) };
    for (const [k, id] of [['translation', '0,0,0'], ['rotation', '0,0,0,1'], ['scale', '1,1,1']]) if (String(n[k]) !== id) b[k] = n[k];
    if (kids.length) b.children = kids;
    const i = add('nodes', b);
    nodeOf.set(rec, i);
    return i;
  };
  const bound = new Set(drawn.filter((rec) => !rec.foreign && rec.mesh !== undefined && rec.bound).map((rec) => rec.i));
  for (const [i, n] of out.nodes.entries()) {
    if (!n || n.repeated) continue;
    if (n.mesh !== undefined && !bound.has(i)) d.nodes[i].mesh = meshAt[n.mesh];
    for (const k of ['name', 'translation', 'rotation', 'scale']) if (twin(n.jig, k) !== undefined) d.nodes[i][k] = n[k];
    if (n.jig.light !== undefined) d.nodes[i].extensions[KHR_LIGHTS] = { light: n.jig.light };
    if (!n.visible) d.nodes[i].extensions[KHR_NV] = { visible: false }; // D-130: the twin of visible
  }
  // Draft f23 (D-113): placed documents' lights join the document's own, marked baked.
  if (out.lights.length) {
    const own = d.extensions[KHR_LIGHTS]?.lights ?? [];
    d.extensions[KHR_LIGHTS] = { ...d.extensions[KHR_LIGHTS], lights: [...own, ...out.lights.slice(own.length).map((l) => ({ ...l, extensions: { ...l.extensions, [EXT]: { baked: true } } }))] };
    if (!d.extensionsUsed.includes(KHR_LIGHTS)) d.extensionsUsed.push(KHR_LIGHTS);
  }
  const place = (recs) => recs.forEach((rec) => {
    if (!rec.rep && !rec.foreign) {
      nodeOf.set(rec, rec.i);
      if (rec.place && rec.drawn) Object.assign(d.nodes[rec.i].extensions, placeExt(rec.place)); // draft f36
      return place(rec.kids);
    }
    if (rec.drawn) (d.nodes[nodeOf.get(rec.parent) ?? rec.i].children ??= []).push(copyOf(rec));
  });
  const parents = (recs, parent) => recs.forEach((rec) => { if (rec.foreign && !parent?.foreign) rec.parent = parent; parents(rec.kids, rec); });
  parents(out.tree, null);
  place(out.tree);
  if (drawn.some((rec) => rec.hidden) && !d.extensionsUsed.includes(KHR_NV)) d.extensionsUsed.push(KHR_NV);
  if (out.physics) writePhysics(d, out.physics, (rec) => (rec ? nodeOf.get(rec) : undefined), meshAt, add);
  // Draft f36 (sketch): placement as evaluated values, so a host that runs no JIG reader has them.
  // Draft f37 (Q-5): an inferred swing clearance on a baked node under its parent body's node (or a scene root).
  for (const it of out.placement.items) {
    if (!it.inferred) continue;
    const local = it.holder ? mul(invert(it.holder.world), it.world) : it.world;
    const n = add('nodes', { name: `swing of ${it.name ?? `node ${it.from}`}`, translation: [local[12], local[13], local[14]].map((v) => +v.toFixed(9)),
      extensions: { [JIG_PLACEMENT]: { clearance: it.clearance, inferred: true, from: nodeOf.get(it.jointed) } } });
    if (it.holder) (d.nodes[nodeOf.get(it.holder)].children ??= []).push(n); else d.scenes[d.scene].nodes.push(n);
  }
  const { items: _, ...model } = out.placement;
  if (Object.keys(model).length) d.extensions[JIG_PLACEMENT] = model;
  for (const e of [JIG_PLACEMENT, OMI_SEAT]) if (JSON.stringify([d.nodes, d.extensions]).includes(`"${e}"`) && !d.extensionsUsed.includes(e)) d.extensionsUsed.push(e);

  // Skins (draft f10, D-77): glTF skins with the joints' baked nodes and inverse bind matrices at this pose. The
  // shapes bound to a skin are one baked mesh, a primitive per shape, in model space at the bind pose, each vertex
  // bound to its joint with weight 1, drawn by a baked root node of the default scene.
  const geoms = {};
  out.skins.forEach((joints, s) => {
    if (!joints.length) return;
    const shapes = out.instances.filter((x) => x.rec.bound?.skin === s);
    const ibm = new Float32Array(joints.flatMap((j, k) => invert(out.restJoints?.[s][k] ?? j.world))); // at the bind pose (D-146)
    const inverseBindMatrices = add('accessors', { bufferView: view(ibm), componentType: 5126, count: joints.length, type: 'MAT4' });
    const skin = add('skins', { inverseBindMatrices, joints: joints.map((j) => nodeOf.get(j)) });
    if (!shapes.length) return;
    const primitives = shapes.map((x) => {
      const g = x.restGeo ?? (geoms[x.mesh] ??= shapeGeo(out.meshes[x.mesh])), n = g.positions.length / 3, m = x.restGeo ? IDENTITY : x.rest ?? x.matrix;
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
        JOINTS_0: acc(x.weights?.joints ?? new Uint16Array(4 * n).map((_, i) => (i % 4 ? 0 : joint)), 5123, 'VEC4'),
        WEIGHTS_0: acc(x.weights?.weights ?? new Float32Array(4 * n).map((_, i) => (i % 4 ? 0 : 1)), 5126, 'VEC4') };
      const idx = add('accessors', { bufferView: view(indices, 34963), componentType: short ? 5123 : 5125, count: indices.length, type: 'SCALAR' });
      const mat = matIndex(out.meshes[x.mesh]), maps = variantsOf(x.mesh);
      return { attributes, indices: idx, ...(mat !== undefined && { material: mat }),
        ...(maps && { extensions: { [KHR_VARIANTS]: { mappings: maps } } }) };
    });
    const mesh = add('meshes', { primitives });
    d.scenes[d.scene].nodes.push(add('nodes', { name: `skin ${s}`, mesh, skin }));
  });

  // Draft f30 (D-151): a vrm1_humanoid character as VRM 1.0, its humanoid bones the joint nodes.
  if (out.character?.scheme === 'vrm1_humanoid') {
    d.extensions[VRMC] = { specVersion: '1.0', meta: structuredClone(out.character.meta),
      humanoid: { humanBones: Object.fromEntries(out.character.roles.toSorted((a, b) => VRM_BONES.indexOf(a.role) - VRM_BONES.indexOf(b.role)).map(({ role, node: i }) => [role, { node: i }])) } };
    if (!d.extensionsUsed.includes(VRMC)) d.extensionsUsed.push(VRMC);
  }

  // Draft f31 (D-153, D-155): each clip as a glTF animation. The document is baked quickly at every key; a node
  // whose translation, rotation or scale changes gets a LINEAR channel, and a material colour or factor, a light's
  // colour or intensity, or a node's visibility that changes gets a KHR_animation_pointer channel.
  if (!quick) for (const clip of out.clips) {
    const cat = `/extensions/${EXT}/clips/${clip.name}`;
    const states = clip.keys.map((k) => animatable(bake(doc, { ...r.baked_values, ...k }, { set: null, files, quick: true }).gltf, cat));
    const s0 = states[0], samplers = [], channels = [];
    const input = add('accessors', { bufferView: view(new Float32Array(clip.times)), componentType: 5126, count: clip.times.length, type: 'SCALAR', min: [0], max: [clip.length] });
    for (const [key, v0] of s0) {
      const series = states.map((st) => st.get(key));
      if (series.every((v) => JSON.stringify(v) === JSON.stringify(v0))) continue;
      need(!key.startsWith('?'), cat, `changes ${key.slice(1)}, which no animation channel is written for`);
      const [kind, path] = key.split(' ');
      if (kind === 'rotation') for (let i = 1; i < series.length; i++) { // the short way between keys
        const a = series[i - 1], b = series[i];
        if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) series[i] = b.map((c) => -c);
      }
      const bool = typeof v0 === 'boolean', size = bool || typeof v0 === 'number' ? 1 : v0.length;
      const data = bool ? Uint8Array.from(series, (v) => (v ? 1 : 0)) : new Float32Array(series.flat());
      const output = add('accessors', { bufferView: view(data), componentType: bool ? 5121 : 5126, count: series.length, type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][size - 1] });
      samplers.push({ input, output, interpolation: bool ? 'STEP' : 'LINEAR' });
      const sampler = samplers.length - 1;
      if (kind === 'pointer') {
        channels.push({ sampler, target: { path: 'pointer', extensions: { [KHR_AP]: { pointer: path } } } });
        const nv = path.match(/^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/); // the pointer needs the property there
        if (nv) { const n = d.nodes[+nv[1]]; n.extensions = { ...n.extensions, [KHR_NV]: { visible: n.extensions?.[KHR_NV]?.visible ?? true } }; }
        const mx = path.match(/^\/materials\/(\d+)\/extensions\/([^/]+)\/([^/]+)$/); // draft f38: a twin slot's extension, written even at its default
        if (mx) {
          const mt = d.materials[+mx[1]], [e, k] = [mx[2], mx[3]];
          mt.extensions = { ...mt.extensions, [e]: { ...mt.extensions?.[e], [k]: mt.extensions?.[e]?.[k] ?? EXT_SLOTS[k][1] } };
          if (!d.extensionsUsed.includes(e)) d.extensionsUsed.push(e);
        }
      } else channels.push({ sampler, target: { node: +path, path: kind } });
    }
    if (!channels.length) continue; // a clip that changes nothing writes no animation
    add('animations', { name: clip.name, samplers, channels, extras: { loop: clip.loop } });
    const pointers = channels.map((c) => c.target.extensions?.[KHR_AP]?.pointer).filter(Boolean);
    if (pointers.length && !d.extensionsUsed.includes(KHR_AP)) d.extensionsUsed.push(KHR_AP);
    if (pointers.some((q) => q.includes(KHR_NV)) && !d.extensionsUsed.includes(KHR_NV)) d.extensionsUsed.push(KHR_NV);
  }

  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.byteLength; }
  add('buffers', { byteLength: bin.byteLength, uri: uri ?? `data:application/octet-stream;base64,${base64(bin)}` });
  // Draft f23 (D-110): the cache-only arrays go last in the file, so the recipe reads first.
  const last = ['meshes', 'accessors', 'bufferViews', 'buffers'];
  const gltf = Object.fromEntries([...Object.entries(d).filter(([k]) => !last.includes(k)), ...last.filter((k) => d[k]).map((k) => [k, d[k]])]);
  return { gltf, bin };
}

// Triangles of a recipe mesh: { positions, normals, uvs, indices } (Float32Array x 3, Uint32Array). uvs are
// TEXCOORD_0 in glTF's convention (draft f11, D-80): `"uv": "fit"` (default) fractions 0..1 of the shape, "meters"
// the same layout in meters.
const NO_GEOMETRY = { positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) };
// A shape's triangles, built once per shape object (callers only read the arrays), and once per evaluated shape across
// reads: read makes fresh objects each time, so an interned shape also finds its triangles by its JSON (SHAPE_KEY).
const GEOMETRY = new WeakMap(), SHAPE_KEY = new WeakMap(), BY_KEY = new Map();
export function geometry(m) {
  let g = GEOMETRY.get(m);
  if (g) return g;
  const key = SHAPE_KEY.get(m);
  g = (key !== undefined && BY_KEY.get(key)) || buildGeometry(m);
  GEOMETRY.set(m, g);
  if (key !== undefined) { if (BY_KEY.size >= 20000) BY_KEY.clear(); BY_KEY.set(key, g); } // shortcut: dropped all at once when full, not LRU; upgrade if editing a big scene re-builds often
  return g;
}
function buildGeometry(m) {
  const fit = (m.uv ?? 'fit') === 'fit';
  if (m.type === 'loft' || m.type === 'lathe') {
    const { tu, length, ...g } = (m.type === 'loft' ? loftGeometry : latheGeometry)(m, fit);
    return shell(m.dents ? dent(g, m.dents, tu, length) : g, m.thickness);
  }
  if (m.type === 'extrude') return extrudeGeometry(m, fit);
  if (m.type === 'text') return textGeometry(m, fit);
  const g = m.radius ? roundedBoxGeometry(m.size, m.radius, fit) : boxGeometry(m.size, fit);
  return { ...g, indices: Uint32Array.from(g.indices) };
}
const UV = ['fit', 'meters'];

// A flat face's coordinates: (u, v) in its own plane, seen from outside with +v up; fit to its bounds or in meters.
function planarUv(pts, fit) {
  const lo = [0, 1].map((a) => Math.min(...pts.map((p) => p[a]))), hi = [0, 1].map((a) => Math.max(...pts.map((p) => p[a])));
  return pts.map(([u, v]) => (fit ? [(u - lo[0]) / (hi[0] - lo[0] || 1), (hi[1] - v) / (hi[1] - lo[1] || 1)] : [u, -v]));
}

// Draft f24 (D-120): lettering in a built-in single-stroke font. A glyph is its advance width and strokes, polylines on
// a grid with cap height 6 and the baseline at 0. `ea(cx, cy, rx, ry, from, to)` is an elliptic arc, degrees, ≤ 10° steps.
const ea = (cx, cy, rx, ry, a0, a1) => {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 10));
  return Array.from({ length: n + 1 }, (_, k) => { const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
};
const GLYPHS = {
  A: [4, [[0, 0], [2, 6], [4, 0]], [[0.7, 2], [3.3, 2]]],
  B: [4, [[0, 3], [0, 6], [2.5, 6], ...ea(2.5, 4.5, 1.5, 1.5, 90, -90), [0, 3], [2.5, 3], ...ea(2.5, 1.5, 1.5, 1.5, 90, -90), [0, 0], [0, 3]]],
  C: [4, ea(2, 3, 2, 3, 45, 315)],
  D: [4, [[1, 0], [0, 0], [0, 6], [1, 6], ...ea(1, 3, 3, 3, 90, -90)]],
  E: [4, [[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [4, [[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [4, [...ea(2, 3, 2, 3, 45, 360), [2.2, 3]]],
  H: [4, [[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [0, [[0, 0], [0, 6]]],
  J: [4, [[4, 6], [4, 2], ...ea(2, 2, 2, 2, 0, -180)]],
  K: [4, [[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.4, 3.4], [4, 0]]],
  L: [3.5, [[0, 6], [0, 0], [3.5, 0]]],
  M: [5, [[0, 0], [0, 6], [2.5, 1.5], [5, 6], [5, 0]]],
  N: [4, [[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [4, ea(2, 3, 2, 3, 0, 360)],
  P: [4, [[0, 0], [0, 6], [2.5, 6], ...ea(2.5, 4.5, 1.5, 1.5, 90, -90), [0, 3]]],
  Q: [4, ea(2, 3, 2, 3, 0, 360), [[2.5, 1.5], [4.2, -0.3]]],
  R: [4, [[0, 0], [0, 6], [2.5, 6], ...ea(2.5, 4.5, 1.5, 1.5, 90, -90), [0, 3]], [[2, 3], [4, 0]]],
  S: [4, [...ea(2, 4.5, 2, 1.5, 20, 270), ...ea(2, 1.5, 2, 1.5, 90, -200)]],
  T: [4, [[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [4, [[0, 6], [0, 2], ...ea(2, 2, 2, 2, 180, 360), [4, 6]]],
  V: [4, [[0, 6], [2, 0], [4, 6]]],
  W: [5, [[0, 6], [1.25, 0], [2.5, 4], [3.75, 0], [5, 6]]],
  X: [4, [[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [4, [[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [4, [[0, 6], [4, 6], [0, 0], [4, 0]]],
  0: [4, ea(2, 3, 2, 3, 0, 360)],
  1: [4, [[0.8, 4.8], [2, 6], [2, 0]], [[0.8, 0], [3.2, 0]]],
  2: [4, [...ea(2, 4.5, 2, 1.5, 160, -40), [0, 0], [4, 0]]],
  3: [4, [...ea(2, 4.5, 2, 1.5, 150, -90), ...ea(2, 1.5, 2, 1.5, 90, -150)]],
  4: [4, [[3, 0], [3, 6], [0, 1.8], [4, 1.8]]],
  5: [4, [[3.8, 6], [0.5, 6], [0.3, 3.4], ...ea(2, 1.9, 2, 1.9, 130, -150)]],
  6: [4, [...ea(2, 3, 2, 3, 50, 180), [0, 1.8]], ea(2, 1.8, 2, 1.8, 0, 360)],
  7: [4, [[0, 6], [4, 6], [1.5, 0]]],
  8: [4, ea(2, 4.6, 1.7, 1.4, 0, 360), ea(2, 1.6, 2, 1.6, 0, 360)],
  9: [4, ea(2, 4.2, 2, 1.8, 0, 360), [[4, 4.2], ...ea(2, 3, 2, 3, 0, -130)]],
  '.': [0, [[0, 0], [0, 0.01]]],
  ',': [0.3, [[0.3, 0.3], [0, -0.8]]],
  ':': [0, [[0, 0], [0, 0.01]], [[0, 3.5], [0, 3.51]]],
  '-': [2.5, [[0, 3], [2.5, 3]]],
  "'": [0.2, [[0.2, 6], [0, 4.6]]],
  '&': [4, [[4, 0], [1, 4.3], [0.8, 5.2], [1.4, 6], [2.3, 6], [2.8, 5.3], [2.6, 4.5], [0.6, 2.8], [0.1, 1.6], [0.5, 0.4], [1.6, 0], [2.8, 0.4], [3.9, 2.2]]],
  ' ': [2],
};
function text(t, scope, at) {
  need(isObj(t), at, 'must be an object');
  only(t, ['text', 'size', 'depth', 'stroke'], at);
  need(typeof t.text === 'string', `${at}/text`, 'must be a string');
  // {expression} is replaced by its value, as in a node's name template (D-79); letters are drawn as capitals.
  const str = t.text.replace(/\{([^{}]*)\}/g, (_, e) => fmt(num(e, scope, `${at}/text`))).toUpperCase();
  need(/\S/.test(str), `${at}/text`, 'must hold a character to draw');
  for (const ch of str) need(Object.hasOwn(GLYPHS, ch), `${at}/text`, `"${ch}" is not in the font (A-Z, 0-9, space and . , : - ' &)`);
  const size = num(t.size, scope, `${at}/size`), depth = num(t.depth, scope, `${at}/depth`);
  const stroke = t.stroke === undefined ? size / 8 : num(t.stroke, scope, `${at}/stroke`);
  need(size > 0, `${at}/size`, `must be > 0, is ${size}`);
  need(depth > 0, `${at}/depth`, `must be > 0, is ${depth}`);
  need(stroke > 0 && stroke <= size / 2, `${at}/stroke`, `must be > 0 and at most size / 2, is ${stroke}`);
  return { type: 'text', text: str, size, depth, stroke };
}
// Strokes laid out left to right and centred on the origin; each segment a bar and each point a disc, `stroke` wide and
// `depth` deep along z, so strokes have round ends and joints.
function textGeometry(m, fit = true) {
  const u = m.size / 6, gap = 1.2 * u + m.stroke, strokes = [];
  let x = 0;
  for (const ch of m.text) {
    const [w, ...ss] = GLYPHS[ch];
    for (const st of ss) strokes.push(st.map(([a, b]) => [x + a * u, b * u]));
    x += w * u + gap;
  }
  const r = m.stroke / 2, cx = (x - gap) / 2, cy = 3 * u, z = m.depth / 2;
  const positions = [], normals = [], indices = [];
  const unit2 = (o) => { const d = Math.hypot(o[0], o[1]); return [o[0] / d, o[1] / d, 0]; };
  const prism = (pts, centre) => { // a convex polygon, counter-clockwise seen from +z, as a closed prism; round sides when centre is given
    const n = pts.length;
    for (const s of [1, -1]) {
      const b = positions.length / 3;
      for (const [a, c] of pts) { positions.push(a - cx, c - cy, s * z); normals.push(0, 0, s); }
      for (let k = 1; k < n - 1; k++) indices.push(...(s > 0 ? [b, b + k, b + k + 1] : [b, b + k + 1, b + k]));
    }
    for (let k = 0; k < n; k++) {
      const p = pts[k], q = pts[(k + 1) % n], b = positions.length / 3, flat = unit2([q[1] - p[1], p[0] - q[0]]);
      const np = centre ? unit2([p[0] - centre[0], p[1] - centre[1]]) : flat, nq = centre ? unit2([q[0] - centre[0], q[1] - centre[1]]) : flat;
      for (const [[a, c], nn, s] of [[p, np, 1], [p, np, -1], [q, nq, -1], [q, nq, 1]]) { positions.push(a - cx, c - cy, s * z); normals.push(...nn); }
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
  };
  const seen = new Set();
  for (const st of strokes) {
    for (const [a, c] of st) {
      const key = `${a.toFixed(6)},${c.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prism(Array.from({ length: 12 }, (_, k) => [a + r * Math.cos((k * Math.PI) / 6), c + r * Math.sin((k * Math.PI) / 6)]), [a, c]);
    }
    for (let k = 0; k + 1 < st.length; k++) {
      const p = st[k], q = st[k + 1], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < 1e-9) continue;
      const o = [((p[1] - q[1]) / d) * r, ((q[0] - p[0]) / d) * r]; // left of p→q
      prism([[p[0] - o[0], p[1] - o[1]], [q[0] - o[0], q[1] - o[1]], [q[0] + o[0], q[1] + o[1]], [p[0] + o[0], p[1] + o[1]]], null);
    }
  }
  // uv projected on the xy plane, over the text's bounds (fit) or in meters (D-80)
  const w = x - gap + m.stroke, h = 6 * u + m.stroke, uvs = [];
  for (let k = 0; k < positions.length; k += 3) uvs.push(fit ? (positions[k] + w / 2) / w : positions[k], fit ? (h / 2 - positions[k + 1]) / h : -positions[k + 1]);
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
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
  const geo = new Map(); // copies share their mesh's geometry
  for (const { mesh: mi, matrix: m, deformed } of instances) {
    if (deformed) { low = Math.min(low, lowestOnTriangles(deformed, m)); continue; } // draft f28: a blended shape
    if (meshes[mi].type !== 'box' || meshes[mi].radius) {
      if (!geo.has(mi)) geo.set(mi, geometry(meshes[mi]));
      low = Math.min(low, lowestOnTriangles(geo.get(mi), m));
      continue;
    }
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
  only(l, ['path', 'sections', 'sides', 'steps', 'blend', 'caps', 'cap_depth', 'closed', 'dents', 'thickness'], at);
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
    ...(radius && { radius }), ...(closed && { closed }), ...dentsOf(l, scope, at, length) };
  need(!m.thickness || capKind(caps, 'start') === 'none' || capKind(caps, 'end') === 'none', `${at}/thickness`, 'needs an open end (caps "none")');
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

// Draft f27 (D-139..D-142): a loft's or lathe's `dents` and `thickness`, as { dents, thickness } when given. A dent
// sits at (t or d, u) as `on` does; d is metres along the curve (a lathe: its profile) of the given length. An item's
// `repeat` is a node's (§6.1): one dent per copy, in that copy's scope.
const FALLOFF = ['smooth', 'sphere', 'linear'];
function dentsOf(l, scope, at, length) {
  const out = {};
  if (l.thickness !== undefined) {
    out.thickness = num(l.thickness, scope, `${at}/thickness`);
    need(out.thickness > 0, `${at}/thickness`, `must be > 0, is ${out.thickness}`);
  }
  if (l.dents === undefined) return out;
  out.dents = list(l.dents, `${at}/dents`).flatMap((d, i) => {
    const dat = `${at}/dents/${i}`;
    need(isObj(d), dat, 'must be an object');
    only(d, ['t', 'd', 'u', 'radius', 'depth', 'falloff', 'repeat'], dat);
    need((d.t === undefined) !== (d.d === undefined), dat, 'needs t or d, not both');
    need(d.falloff === undefined || FALLOFF.includes(d.falloff), `${dat}/falloff`, `must be one of ${FALLOFF.map((x) => `"${x}"`).join(', ')}`);
    const rep = d.repeat === undefined ? null : repeat(d.repeat, scope, `${dat}/repeat`);
    return Array.from({ length: rep ? rep.count : 1 }, (_, k) => {
      const s = rep ? repeatVars(rep.vars, { ...scope, [rep.index]: k, ...rep.rows?.[k] }, `${dat}/repeat/vars`) : scope;
      let t;
      if (d.t !== undefined) { t = num(d.t, s, `${dat}/t`); need(t >= 0 && t <= 1, `${dat}/t`, `must be in 0..1, is ${t}`); }
      else { const dd = num(d.d, s, `${dat}/d`); t = Math.min(1, Math.max(0, (dd < 0 ? length + dd : dd) / length)); }
      const r = Array.isArray(d.radius) ? vec(d.radius, 2, s, `${dat}/radius`) : [num(d.radius, s, `${dat}/radius`)];
      r.forEach((x, q) => need(x > 0, `${dat}/radius${r.length > 1 ? `/${q}` : ''}`, `must be > 0, is ${x}`));
      return { t, u: num(d.u, s, `${dat}/u`), radius: [r[0], r[r.length - 1]], depth: num(d.depth, s, `${dat}/depth`), falloff: d.falloff ?? 'smooth' };
    });
  });
  return out;
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
export function roundSection(x, scope = {}, at = '') {
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
  need(pts.length >= 2, at, 'needs at least 2 points'); // 2 with a curved edge (an arc piece) can enclose a D shape
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
  if (isObj(e.outline) && e.outline.project !== undefined) return projected(e, scope, at);
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
  try { geometry(m); } catch (err) { need(false, at, err.message.replace(/^\/: /, '')); } // caps that cannot be triangulated (D-66)
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
  const r0 = b[0] - a[0], r1 = b[1] - a[1], q0 = d[0] - c[0], q1 = d[1] - c[1], den = r0 * q1 - r1 * q0; // no arrays: called O(n²) times
  if (Math.abs(den) < 1e-15) return null;
  const c0 = c[0] - a[0], c1 = c[1] - a[1], t = (c0 * q1 - c1 * q0) / den, u = (c0 * r1 - c1 * r0) / den, e = 1e-9;
  return t > e && t < 1 - e && u > e && u < 1 - e ? [a[0] + t * r0, a[1] + t * r1] : null;
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
  if (m.pieces) return framed(joinGeometry(m.pieces.map((p) => extrudeGeometry({ depth: m.depth, bevel: m.bevel, outline: p.outline, holes: p.holes }, fit))), m.frame);
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
    const insets = new Map(); // the bevel's rings come in pairs, top and bottom
    l.inset = (d) => (d === 0 ? l.poly : insets.get(d) ?? insets.set(d, untangle(l.poly.map((p, k) => [p[0] - d * l.miter[k][0], p[1] - d * l.miter[k][1]]))).get(d));
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

// --- Projection (§5.10, D-186..D-195) ---
// An extrude outline `{ "project": { of, direction, key, cut, fill, line, cell, gap } }`: the region node `of`'s
// subtree covers seen along `direction` (the silhouette), or with `cut` where the plane that far back against the
// rays slices it. Read here, worked out by projectMesh once the whole tree is read. The extrude lies across the
// rays, its depth back toward where they come from.
function projected(e, scope, at) {
  const oat = `${at}/outline`, pat = `${oat}/project`, p = e.outline.project;
  only(e.outline, ['project'], oat);
  need(isObj(p), pat, 'must be an object');
  only(p, ['of', 'direction', 'key', 'cut', 'fill', 'line', 'cell', 'gap'], pat);
  need(Number.isInteger(p.of) && p.of >= 0, `${pat}/of`, 'must be a node index');
  need(Array.isArray(p.direction) && p.direction.length === 3, `${pat}/direction`, 'must be [x, y, z]');
  const direction = p.direction.map((c, a) => num(c, scope, `${pat}/direction/${a}`));
  need(Math.hypot(...direction) > 1e-12, `${pat}/direction`, 'must not be all zero');
  need(p.key === undefined || (typeof p.key === 'string' && p.key !== ''), `${pat}/key`, 'must be a non-empty string');
  need(p.fill === undefined || typeof p.fill === 'boolean', `${pat}/fill`, 'must be true or false');
  const opt = (k, ok, what) => {
    if (p[k] === undefined) return undefined;
    const v = num(p[k], scope, `${pat}/${k}`);
    need(ok(v), `${pat}/${k}`, `must be ${what}, is ${v}`);
    return v;
  };
  const cut = opt('cut', () => true, 'a number'), line = opt('line', (v) => v > 0, '> 0'), cell = opt('cell', (v) => v > 0, '> 0');
  const gap = opt('gap', (v) => v >= 0, '>= 0') ?? 0;
  need(e.holes === undefined, `${at}/holes`, 'cannot stand next to a projected outline');
  const depth = num(e.depth, scope, `${at}/depth`);
  need(depth > 0, `${at}/depth`, `must be > 0, is ${depth}`);
  const bevel = e.bevel === undefined ? 0 : num(e.bevel, scope, `${at}/bevel`);
  need(bevel >= 0 && bevel <= depth / 2, `${at}/bevel`, `must be in 0..depth / 2 (${depth / 2}), is ${bevel}`);
  return { type: 'extrude', project: { of: p.of, direction, key: p.key, cut, fill: !!p.fill, line, cell, gap, at: pat }, depth, ...(bevel > 0 && { bevel }) };
}

// A projection's extrude, from the read tree: the shapes under every drawn copy of node `of` (placed models too),
// in the frame of the copy that draws the projection (`rec`; none: the model's). Shown shapes count; under a node with
// `visible_for`, shapes count, shown or hidden, exactly when it names the projection's key (D-196). Copies a repeat
// leaves out never count, nor do other projections.
function projectMesh(m, rec, tree, meshes, nodeCount, skip) {
  const p = m.project;
  need(p.of < nodeCount, `${p.at}/of`, `must be a node index 0..${nodeCount - 1}`);
  const inv = invert(rec ? rec.world : IDENTITY), d = norm(p.direction), w = scale(d, -1);
  let u = sub([1, 0, 0], scale(w, w[0]));
  if (Math.hypot(...u) < 1e-6) u = sub([0, 0, -1], scale(w, -w[2])); // looking along x: u is −z
  u = norm(u);
  const v = cross(w, u), tris = [], geo = new Map();
  // forced: what the nearest `visible_for` above says for this key (D-196); without one, shown shapes count
  const take = (r, forced, shown) => {
    if (!r.drawn) return;
    const vf = r.node.jig?.visible_for;
    if (vf) forced = vf.includes(p.key);
    const own = shown && !r.hidden, here = forced ?? own;
    if (here && r.mesh !== undefined && !skip.has(r.mesh)) {
      if (!geo.has(r.mesh)) geo.set(r.mesh, geometry(meshes[r.mesh]));
      const { positions: q, indices: ix } = geo.get(r.mesh), M = mul(inv, r.world);
      const at = (k) => {
        const x = q[3 * k], y = q[3 * k + 1], z = q[3 * k + 2];
        const s = [0, 1, 2].map((a) => M[a] * x + M[4 + a] * y + M[8 + a] * z + M[12 + a]);
        return [dot(s, u), dot(s, v), dot(s, w)];
      };
      for (let t = 0; t < ix.length; t += 3) tris.push([at(ix[t]), at(ix[t + 1]), at(ix[t + 2])]);
    }
    for (const k of r.kids) take(k, forced, k.owner !== r.owner ? own && r.node.modelVisible !== false : own); // a placed model's records have its owner
  };
  (function find(recs) { for (const r of recs) { if (r.i === p.of && !r.foreign) take(r, undefined, true); else find(r.kids); } })(tree);
  const pieces = tris.length ? traceRegion(tris, p) : [];
  const out = { type: 'extrude', pieces, frame: [u, v, w], depth: m.depth, ...(m.bevel && { bevel: m.bevel }) };
  try { geometry(out); } catch (err) { need(false, p.at, `its outline can't be built (${err.message.replace(/^\/: /, '')}); try a larger cell or line`); }
  return out;
}

// The covered region of triangles [[u, v, w] × 3] on a grid: a cell counts when its centre is inside a triangle
// (silhouette), or when an odd number of triangles lie above the cut plane w = cut there (inside the solid, which
// needs closed shapes). Then: gaps up to `gap` closed, holes filled (`fill`), only a band `line` wide along the edges
// kept (`line`); traced along cell edges and simplified to a cell. Returns [{ outline, holes }].
function traceRegion(tris, { cut, fill, line, cell, gap, at }) {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const t of tris) for (const q of t) for (const a of [0, 1]) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
  const c = cell ?? Math.max(1e-4, Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 256);
  const pad = 2 + Math.ceil(gap / c), W = Math.ceil((hi[0] - lo[0]) / c) + 2 * pad, H = Math.ceil((hi[1] - lo[1]) / c) + 2 * pad;
  need(W * H <= 4e6, `${at}/cell`, `makes a grid of ${W} x ${H} cells; give a larger cell (now ${c})`);
  const U = (i) => lo[0] + (i - pad + 0.5) * c, V = (j) => lo[1] + (j - pad + 0.5) * c;
  let mask = new Uint8Array(W * H);
  for (const [a, b, e] of tris) {
    const ar = (b[0] - a[0]) * (e[1] - a[1]) - (b[1] - a[1]) * (e[0] - a[0]);
    if (Math.abs(ar) < 1e-14) { // edge-on (a sheet seen along its plane): its edges mark a silhouette, never a cut
      if (cut !== undefined) continue;
      for (const [s, f] of [[a, b], [b, e], [e, a]]) {
        const n = Math.ceil(Math.hypot(f[0] - s[0], f[1] - s[1]) / (c / 2)) + 1;
        for (let k = 0; k <= n; k++) mask[(Math.floor((s[1] + (f[1] - s[1]) * k / n - lo[1]) / c) + pad) * W + Math.floor((s[0] + (f[0] - s[0]) * k / n - lo[0]) / c) + pad] = 1;
      }
      continue;
    }
    const i0 = Math.floor((Math.min(a[0], b[0], e[0]) - lo[0]) / c) + pad, i1 = Math.ceil((Math.max(a[0], b[0], e[0]) - lo[0]) / c) + pad;
    const j0 = Math.floor((Math.min(a[1], b[1], e[1]) - lo[1]) / c) + pad, j1 = Math.ceil((Math.max(a[1], b[1], e[1]) - lo[1]) / c) + pad;
    for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
      const x = U(i), y = V(j);
      const l1 = ((b[0] - x) * (e[1] - y) - (b[1] - y) * (e[0] - x)) / ar, l2 = ((e[0] - x) * (a[1] - y) - (e[1] - y) * (a[0] - x)) / ar, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      if (cut === undefined) mask[j * W + i] = 1;
      else if (l1 * a[2] + l2 * b[2] + l3 * e[2] > cut) mask[j * W + i] ^= 1;
    }
  }
  const grow = (m, r, val) => { // dilate (val 1) or erode (val 0) by a disc of r cells; outside the grid counts as 0
    const out = val === 0 ? 0 : Infinity, g = new Float64Array(W * H); // g: cells along the row to the nearest val
    for (let j = 0; j < H; j++) {
      for (let i = 0, d = out; i < W; i++) { d = m[j * W + i] === val ? 0 : d + 1; g[j * W + i] = d; }
      for (let i = W - 1, d = out; i >= 0; i--) { d = m[j * W + i] === val ? 0 : d + 1; if (d < g[j * W + i]) g[j * W + i] = d; }
    }
    const o = m.slice();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (m[j * W + i] === val) continue;
      for (let dj = -r; dj <= r; dj++) {
        const jj = j + dj, h = jj < 0 || jj >= H ? out : g[jj * W + i];
        if (h * h + dj * dj <= r * r) { o[j * W + i] = val; break; }
      }
    }
    return o;
  };
  const rg = Math.round(gap / c);
  if (rg > 0) mask = grow(grow(mask, rg, 1), rg, 0);
  if (fill) { // what a flood from the border does not reach is inside
    const seen = new Uint8Array(W * H), st = [0];
    seen[0] = 1;
    while (st.length) {
      const k = st.pop(), i = k % W, j = (k - i) / W;
      for (const [ii, jj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        const kk = jj * W + ii;
        if (ii >= 0 && jj >= 0 && ii < W && jj < H && !seen[kk] && !mask[kk]) { seen[kk] = 1; st.push(kk); }
      }
    }
    for (let k = 0; k < W * H; k++) if (!seen[k]) mask[k] = 1;
  }
  unpinch(mask, W, H);
  if (line !== undefined) {
    const inner = grow(mask, Math.max(1, Math.round(line / c)), 0);
    for (let k = 0; k < W * H; k++) if (inner[k]) mask[k] = 0;
    unpinch(mask, W, H);
  }
  const label = new Int32Array(W * H).fill(-1);
  let n = 0;
  for (let k0 = 0; k0 < W * H; k0++) {
    if (!mask[k0] || label[k0] >= 0) continue;
    const st = [k0];
    label[k0] = n;
    while (st.length) {
      const k = st.pop(), i = k % W, j = (k - i) / W;
      for (const [ii, jj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        const kk = jj * W + ii;
        if (ii >= 0 && jj >= 0 && ii < W && jj < H && mask[kk] && label[kk] < 0) { label[kk] = n; st.push(kk); }
      }
    }
    n++;
  }
  const pieces = Array.from({ length: n }, () => ({ outline: null, holes: [] }));
  const metres = (pts) => simplifyLoop(pts.map(([i, j]) => [lo[0] + (i - pad) * c, lo[1] + (j - pad) * c]), c);
  for (const { cell: k, pts } of cellLoops(mask, W, H)) {
    const piece = pieces[label[k]], a = area(pts);
    if (a > 0) piece.outline = metres(pts); // counter-clockwise: the outer edge; clockwise: a hole
    else if (a < 0) piece.holes.push(metres(pts));
  }
  return pieces.filter((q) => q.outline && q.outline.length >= 3).map((q) => ({ outline: q.outline, holes: q.holes.filter((h) => h.length >= 3) }));
}
// cells that touch only at a corner would make two loops share it: join them
function unpinch(m, W, H) {
  for (let again = true; again;) {
    again = false;
    for (let j = 0; j + 1 < H; j++) for (let i = 0; i + 1 < W; i++) {
      const a = m[j * W + i], b = m[j * W + i + 1], c = m[(j + 1) * W + i], d = m[(j + 1) * W + i + 1];
      if (a === d && b === c && a !== b) { m[j * W + i] = m[j * W + i + 1] = m[(j + 1) * W + i] = m[(j + 1) * W + i + 1] = 1; again = true; }
    }
  }
}
// The boundary loops of a 0/1 grid along cell edges, the region on the left (outer edges counter-clockwise), each
// with one of its region's cells.
function cellLoops(m, W, H) {
  const on = (i, j) => i >= 0 && j >= 0 && i < W && j < H && m[j * W + i] === 1;
  const next = new Map(), cellOf = new Map(), key = (i, j) => j * (W + 1) + i;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!on(i, j)) continue;
    const add = (a, b) => { next.set(key(...a), b); cellOf.set(key(...a), j * W + i); };
    if (!on(i, j - 1)) add([i, j], [i + 1, j]);
    if (!on(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!on(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!on(i - 1, j)) add([i, j + 1], [i, j]);
  }
  const out = [];
  for (const [k0] of next) {
    if (!next.has(k0)) continue;
    const pts = [], cell = cellOf.get(k0);
    let k = k0;
    while (next.has(k)) { const b = next.get(k); next.delete(k); pts.push([k % (W + 1), Math.floor(k / (W + 1))]); k = key(...b); }
    out.push({ cell, pts });
  }
  return out;
}
// Douglas-Peucker on a closed loop, split at the point farthest from its first.
function simplifyLoop(p, tol) {
  const dp = (a) => {
    if (a.length < 3) return a;
    const [x0, y0] = a[0], [x1, y1] = a[a.length - 1], L = Math.hypot(x1 - x0, y1 - y0) || 1e-12;
    let best = 0, bi = 0;
    for (let i = 1; i < a.length - 1; i++) { const dd = Math.abs((x1 - x0) * (y0 - a[i][1]) - (x0 - a[i][0]) * (y1 - y0)) / L; if (dd > best) { best = dd; bi = i; } }
    return best <= tol ? [a[0], a[a.length - 1]] : [...dp(a.slice(0, bi + 1)).slice(0, -1), ...dp(a.slice(bi))];
  };
  let far = 0;
  for (let i = 1; i < p.length; i++) if (Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]) > Math.hypot(p[far][0] - p[0][0], p[far][1] - p[0][1])) far = i;
  const r = [...dp(p.slice(0, far + 1)).slice(0, -1), ...dp([...p.slice(far), p[0]]).slice(0, -1)];
  return r.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
}
// Shapes joined into one, and turned by a frame [u, v, w] (the columns: where x, y and z go).
function joinGeometry(gs) {
  const cat = (k, T) => { const o = new T(gs.reduce((s, g) => s + g[k].length, 0)); let at = 0; for (const g of gs) { o.set(g[k], at); at += g[k].length; } return o; };
  const indices = new Uint32Array(gs.reduce((s, g) => s + g.indices.length, 0));
  let at = 0, base = 0;
  for (const g of gs) { for (let k = 0; k < g.indices.length; k++) indices[at + k] = g.indices[k] + base; at += g.indices.length; base += g.positions.length / 3; }
  return { positions: cat('positions', Float32Array), normals: cat('normals', Float32Array), uvs: cat('uvs', Float32Array), indices };
}
function framed(g, [u, v, w]) {
  for (const k of ['positions', 'normals']) {
    const a = g[k];
    for (let i = 0; i < a.length; i += 3) { const x = a[i], y = a[i + 1], z = a[i + 2]; for (let c = 0; c < 3; c++) a[i + c] = u[c] * x + v[c] * y + w[c] * z; }
  }
  return g;
}

// --- Lathe (draft f13, D-88) ---
// { profile: [[r, y, ...handles], ...], sides, caps }: an open profile in loft's point form, r ≥ 0, revolved about
// the y axis. The solid is the region between the profile and the axis; the surface faces away from it, whichever
// way the profile runs. An end at r = 0 closes to a point; an end at r > 0 gets a flat cap unless `caps` leaves it
// open (D-90). Laid out as a loft up +y with circle sections: point 0 of each ring at +x, then toward −z.

function lathe(l, scope, at) {
  need(isObj(l), at, 'must be an object');
  only(l, ['profile', 'sides', 'caps', 'dents', 'thickness'], at);
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
  const m = { type: 'lathe', profile, sides, ...(caps && { caps }), ...dentsOf(l, scope, at, poly.reduce((a, q, i) => (i ? a + dist(q, poly[i - 1]) : 0), 0)) };
  const open = (i, end) => poly[i][0] > 1e-9 && capKind(caps, end) === 'none';
  need(!m.thickness || open(0, 'start') || open(poly.length - 1, 'end'), `${at}/thickness`, 'needs an open end (r > 0, caps "none")');
  return m;
}

// Draft f35 (D-168..D-170): cylinder, cone, sphere and capsule, centred on the origin with their axis along +y, built
// as the lathe they stand for (same triangles, uv, sides; caps on cylinder and cone). Sphere and capsule profiles are
// smooth points with no handles ([r, y, 0, 0]): one ring per point, normals smooth across them.
const ROUND = ['cylinder', 'cone', 'sphere', 'capsule'];
function round(kind, o, scope, at) {
  need(isObj(o), at, 'must be an object');
  const flat = kind === 'cylinder' || kind === 'cone';
  only(o, ['radius', ...(kind === 'sphere' ? [] : ['height']), 'sides', ...(flat ? ['caps'] : [])], at);
  const sides = Math.min(256, Math.max(3, Math.round(o.sides === undefined ? 24 : num(o.sides, scope, `${at}/sides`))));
  const [r0, r1] = kind === 'cone' ? vec(o.radius, 2, scope, `${at}/radius`) : Array(2).fill(num(o.radius, scope, `${at}/radius`));
  if (kind === 'cone') need(r0 >= 0 && r1 >= 0 && r0 + r1 > 0, `${at}/radius`, `must be >= 0 and not both 0, is [${r0}, ${r1}]`);
  else need(r0 > 0, `${at}/radius`, `must be > 0, is ${r0}`);
  const h = kind === 'sphere' ? 2 * r0 : num(o.height, scope, `${at}/height`);
  need(h > 0, `${at}/height`, `must be > 0, is ${h}`);
  if (kind === 'capsule') need(h >= 2 * r0 - 1e-9, `${at}/height`, `must be >= 2 radius (${2 * r0}), is ${h}`);
  if (flat) { const caps = capsOf(o.caps, `${at}/caps`); return { type: 'lathe', kind, profile: [[r0, -h / 2], [r1, h / 2]], sides, ...(caps && { caps }) }; }
  // Arcs: a sphere sides/2 steps pole to pole, a capsule's ends sides/4 each, so both are as round as a ring.
  const q = Math.max(1, Math.round(sides / 4)), mid = h / 2 - r0;
  const arc = (y0, from, to) => Array.from({ length: q + 1 }, (_, k) => { const a = from + ((to - from) * k) / q; return [r0 * Math.sin(a), y0 - r0 * Math.cos(a), 0, 0]; });
  const profile = [...arc(-mid, 0, Math.PI / 2), ...arc(mid, Math.PI / 2, Math.PI).slice(mid > 1e-9 ? 0 : 1)];
  return { type: 'lathe', kind, profile: profile.map((p) => p.map((c) => (Math.abs(c) < 1e-12 ? 0 : c))), sides };
}

// The open profile as a polyline (the closing edge left out), the polyline indices of its inner corners, and
// where each point's piece starts in it.
export function profileLine(pts) {
  const { poly, starts } = flatten(pts);
  return { poly: poly.slice(0, starts[starts.length - 1] + 1), hard: starts.filter((_, k) => k > 0 && k < pts.length - 1 && corner(pts[k])), starts };
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
  const positions = [], normals = [], uvs = [], indices = [], tu = [];
  const cuts = [0, ...hard, poly.length - 1];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const s = cuts[c], e = cuts[c + 1], first = positions.length / 3;
    for (let i = s; i <= e; i++) {
      const [tr, ty] = sub(poly[Math.min(i + 1, e)], poly[Math.max(i - 1, s)]), [nr, ny] = norm(out ? [ty, -tr] : [-ty, tr]);
      for (let j = 0; j < w; j++) {
        const [r, y] = poly[i], a = ang(j), cs = Math.cos(a), sn = Math.sin(a);
        positions.push(r * cs, y, -r * sn); normals.push(nr * cs, ny, -nr * sn);
        uvs.push(fit ? j / n : r * a, fit ? along[i] / L : along[i]);
        tu.push([along[i] / L, j / n, 2 * Math.PI * r]);
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
    for (const [u, v] of ring) { positions.push(u, y, -v); normals.push(0, s, 0); tu.push(null); }
    uvs.push(...planarUv(ring.map(([u, v]) => [s * u, v]), fit).flat());
    for (let j = 1; j + 1 < n; j++) indices.push(...(s > 0 ? [0, j, j + 1] : [0, j + 1, j]).map((k) => first + k)); // a fan faces +y
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), tu, length: L };
}

// Draft f27 (D-140): each dent moves the side's vertices against their undented normal by depth·f(s), s the
// distance from the dent's centre along the surface (t by `length`, u by ring length, wrapping round) over its radius.
// A vertex elsewhere at the same place (a cap's rim, the seam copy) moves with it. Normals are then summed from the
// faces again, kept apart where they were split (corners, cap edges).
const FALL = { smooth: (s) => (1 - s * s) ** 2, sphere: (s) => Math.sqrt(1 - s * s), linear: (s) => 1 - s };
const posKey = (p, i) => `${Math.round(p[3 * i] * 1e6)},${Math.round(p[3 * i + 1] * 1e6)},${Math.round(p[3 * i + 2] * 1e6)}`;
function dent({ positions, normals, uvs, indices }, dents, tu, length) {
  const N = positions.length / 3, move = new Map(), pos = Float32Array.from(positions);
  for (let i = 0; i < N; i++) {
    if (!tu[i]) continue;
    const [t, u, ring] = tu[i];
    let d = 0;
    for (const q of dents) {
      const du = ((((u - q.u) % 1) + 1.5) % 1) - 0.5, s = Math.hypot(((t - q.t) * length) / q.radius[0], (du * ring) / q.radius[1]);
      if (s < 1) d += q.depth * FALL[q.falloff](s);
    }
    const k = posKey(positions, i);
    if (d && !move.has(k)) move.set(k, [0, 1, 2].map((a) => -d * normals[3 * i + a]));
  }
  for (let i = 0; i < N; i++) { const v = move.get(posKey(positions, i)); if (v) for (let a = 0; a < 3; a++) pos[3 * i + a] += v[a]; }
  const group = [], sums = new Map(); // a vertex's group: same place, same undented normal
  for (let i = 0; i < N; i++) group.push(`${posKey(positions, i)}|${[0, 1, 2].map((a) => Math.round(normals[3 * i + a] * 1e3)).join(',')}`);
  const at = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k], indices[k + 1], indices[k + 2]], f = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    for (const i of [a, b, c]) { const g = sums.get(group[i]) ?? [0, 0, 0]; sums.set(group[i], g.map((x, q) => x + f[q])); }
  }
  const nrm = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) nrm.set(norm(sums.get(group[i]) ?? [normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]]), 3 * i);
  return { positions: pos, normals: nrm, uvs, indices };
}

// Draft f27 (D-142): a wall w thick. The inner surface is every vertex moved inward: where faces meet at a crease (a
// cap's rim) along the mean of their normals, far enough that each face's wall is w (at most 3w), so the inner floor
// meets the inner side. A rim of flat quads joins the outer and inner surface along every open edge.
function shell(g, w) {
  if (!w) return g;
  const { positions: P, normals: Nm, uvs, indices: I } = g, N = P.length / 3;
  const key = Array.from({ length: N }, (_, i) => posKey(P, i)), dirs = new Map();
  for (let i = 0; i < N; i++) {
    const n = [Nm[3 * i], Nm[3 * i + 1], Nm[3 * i + 2]], d = dirs.get(key[i]) ?? [];
    if (!d.some((m) => dot(m, n) > 0.9999)) d.push(n);
    dirs.set(key[i], d);
  }
  const off = new Map();
  for (const [k, ns] of dirs) {
    const d = norm(ns.reduce((a, n) => a.map((c, q) => c + n[q]), [0, 0, 0])), c = Math.min(...ns.map((n) => dot(d, n)));
    off.set(k, scale(d, -Math.min(3 * w, w / Math.max(c, 1e-9))));
  }
  const positions = [...P], normals = [...Nm], uv = [...uvs], indices = [...I];
  for (let i = 0; i < N; i++) {
    const o = off.get(key[i]);
    positions.push(P[3 * i] + o[0], P[3 * i + 1] + o[1], P[3 * i + 2] + o[2]);
    normals.push(-Nm[3 * i], -Nm[3 * i + 1], -Nm[3 * i + 2]); uv.push(uvs[2 * i], uvs[2 * i + 1]);
  }
  for (let k = 0; k < I.length; k += 3) indices.push(N + I[k], N + I[k + 2], N + I[k + 1]);
  // Open edges: an edge between two places used by one triangle only (seam and corner copies share their places).
  const edges = new Map();
  for (let k = 0; k < I.length; k += 3) for (let e = 0; e < 3; e++) {
    const a = I[k + e], b = I[k + ((e + 1) % 3)], id = key[a] < key[b] ? `${key[a]}/${key[b]}` : `${key[b]}/${key[a]}`;
    const x = edges.get(id);
    if (x) x.n++; else edges.set(id, { a, b, n: 1 });
  }
  const at = (i) => positions.slice(3 * i, 3 * i + 3);
  for (const { a, b, n } of edges.values()) {
    if (n !== 1 || key[a] === key[b]) continue;
    const f = norm(cross(sub(at(a), at(b)), sub(at(N + a), at(b)))), first = positions.length / 3;
    for (const i of [b, a, N + a, N + b]) { positions.push(...at(i)); normals.push(...f); uv.push(uvs[2 * (i % N)], uvs[2 * (i % N) + 1]); }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uv), indices: new Uint32Array(indices) };
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
  const tu = []; // per side vertex of the curve (not a dome): [t, u, ring length], for dents (D-140)
  rows.forEach(({ ring: rg, round: rd, frame: { p, x, y, z }, along, v: vv, t }) => {
    const ring = [...rg, rg[0]], ru = [...rd, rd[0]], round = [0]; // u as the end ring's, so u stays put up a dome
    for (let j = 1; j < w; j++) round.push(round[j - 1] + dist(ru[j], ru[j - 1]));
    ring.forEach(([u, v], j) => {
      tu.push(t === undefined ? null : [t, round[j] / round[n], round[n]]);
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
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices), tu, length };
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
    const [iu, iv] = inHandle(b);
    if (!a[2] && !a[3] && !iu && !iv) return; // straight: samples would bunch at its ends and fold under a bevel
    const c1 = [a[0] + (a[2] ?? 0), a[1] + (a[3] ?? 0)], c2 = [b[0] + iu, b[1] + iv];
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

const TOKENS = /'[^']*'|\d+\.?\d*|\.\d+|[a-z_][a-z0-9_]*|[<>=!]=|[-+*/(),.<>]|\S/gi;
// The names an expression reads: not functions, swizzles or quoted text (draft f26).
const namesIn = (src) => { const t = src.match(TOKENS) ?? []; return t.filter((w, i) => /^[a-z_]/i.test(w) && t[i + 1] !== '(' && t[i - 1] !== '.'); };

// An expression's value: a number, or a vec4 (D-91: a color, linear RGBA, GLSL's vec4) as a list of 4 numbers.
// Operators and built-ins work per component on vec4s, a number standing for every component; each vec4 is clamped to 0..1.
export function evaluate(src, scope) {
  const toks = src.match(TOKENS) ?? [];
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
    if (t[0] === "'") throw new Error(`"${src}": text ${t} can only be compared with == or !=`); // draft f24 (D-115)
    if (/^[a-z_]/i.test(t)) {
      if (peek() === '(') return call(t);
      if (Object.hasOwn(CONSTS, t)) return CONSTS[t]; // D-154: names are lower_snake_case, so these never clash
      if (!(t in scope)) throw new Error(`"${src}": unknown name "${t}"`);
      if (typeof scope[t] === 'string') throw new Error(`"${src}": "${t}" is text ("${scope[t]}"): a placed model's choice value, or compared with == or !=`); // draft f23 (D-112)
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
  // Draft f24 (D-115): a side of == or != may be text: a quoted literal, a row's text, or a lone choice parameter.
  const side = () => {
    const t = peek(), nx = toks[i + 1], lone = (nx === undefined || nx in CMP || nx === ')' || nx === ',') && /^['a-z_]/i.test(t ?? '');
    if (!lone) return sum();
    if (t[0] === "'") { take(); return { text: t.slice(1, -1) }; }
    if (typeof scope[t] === 'string') { take(); return { text: scope[t] }; }
    if (scope[CHOICES]?.[t]) { take(); return { choice: t, options: scope[CHOICES][t], index: scope[t] }; }
    return sum();
  };
  const compare = () => {
    let a = side();
    if (!(peek() in CMP)) {
      if (a.text !== undefined) throw new Error(`"${src}": text "${a.text}" can only be compared with == or !=`);
      return a.choice ? a.index : a;
    }
    const op = take();
    let b = side();
    if (a.text !== undefined || b.text !== undefined) {
      if (op !== '==' && op !== '!=') throw new Error(`"${src}": ${op} compares numbers; text takes == or !=`);
      const name = (x, o) => {
        if (x.text !== undefined) return x.text;
        if (!x.choice) throw new Error(`"${src}": text compares with text or a choice parameter, not a number`);
        if (!x.options.includes(o.text)) throw new Error(`"${src}": "${o.text}" is not an option of ${x.choice} (${JSON.stringify(x.options)})`);
        return x.options[x.index];
      };
      const eq = name(a, b) === name(b, a);
      if (peek() in CMP) throw new Error(`"${src}": a comparison of a comparison needs parentheses`);
      return (op === '==') === eq ? 1 : 0;
    }
    if (a.choice) a = a.index;
    if (b.choice) b = b.index;
    if (Array.isArray(a) || Array.isArray(b)) throw new Error(`"${src}": ${op} compares numbers, not a color (vec4)`);
    if (peek() in CMP) throw new Error(`"${src}": a comparison of a comparison needs parentheses`);
    return CMP[op](a, b) ? 1 : 0;
  };
  const v = compare();
  if (i < toks.length) throw new Error(`"${src}": unexpected "${toks[i]}"`);
  if (![v].flat().every(Number.isFinite)) throw new Error(`"${src}": is not a finite number`);
  return v;
}
// Editor drags (GAPS editor 1): `src` rewritten so it gives `target` in `scope`. The first number literal, left to
// right, that the value depends on is solved for (secant steps: exact when linear); with none, `+ c` is appended.
// Returns the new expression, or null when src is not a number expression in scope.
export function solveFor(src, scope, target, eps = 1e-6) {
  const at = (s) => { try { const v = evaluate(s, scope); return typeof v === 'number' ? v : NaN; } catch { return NaN; } };
  const now = at(src);
  if (!Number.isFinite(now) || !Number.isFinite(target)) return null;
  if (Math.abs(now - target) <= eps) return src;
  const lits = [...src.matchAll(/[a-z_][a-z0-9_]*|\d+\.?\d*|\.\d+/gi)].filter((m) => /^\.?\d/.test(m[0]));
  for (const m of lits) {
    const put = (c) => withLiteral(src, m.index, m[0].length, c), f = (c) => at(put(c)) - target;
    const c0 = Number(m[0]), h = 1e-3 * Math.max(1, Math.abs(c0));
    let a = c0, fa = f(a), b = c0 + h, fb = f(b);
    if (!Number.isFinite(fb) || Math.abs(fb - fa) < 1e-12) continue; // the value does not follow this number
    for (let k = 0; k < 12 && Math.abs(fb) > eps; k++) {
      if (!(Math.abs(fb - fa) > 1e-15)) break;
      [a, fa, b] = [b, fb, b - (fb * (b - a)) / (fb - fa)];
      fb = f(b);
      if (!Number.isFinite(fb)) break;
    }
    if (Math.abs(fb) > 1e-4 * Math.max(1, Math.abs(target))) continue;
    return put(+b.toPrecision(6));
  }
  const c = +(target - now).toPrecision(6), base = /[<>=!]/.test(src) ? `(${src})` : src;
  return `${base} ${c < 0 ? '-' : '+'} ${Math.abs(c)}`;
}
// src with the literal at [i, i + n) replaced by c; a negative c flips a + or - in front, else goes in parentheses.
function withLiteral(src, i, n, c) {
  const after = src.slice(i + n);
  if (c >= 0) return src.slice(0, i) + c + after;
  const pre = src.slice(0, i).trimEnd(), op = pre.at(-1), before = pre.slice(0, -1).trimEnd();
  if (op === '+') return `${before} - ${-c}${after}`;
  if (op === '-') return /^$|[-+*/(,<>=]$/.test(before) ? `${before}${-c}${after}` : `${before} + ${-c}${after}`;
  return `${src.slice(0, i)}(${c})${after}`;
}
// f on numbers, or per component when any argument is a vec4, a number argument standing for every component.
// Every vec4 made is clamped to 0..1 (D-91 amended: a color is clamped at every step).
const each = (f, args) => (args.some(Array.isArray) ? clamp01([0, 1, 2, 3].map((k) => f(...args.map((a) => (Array.isArray(a) ? a[k] : a))))) : f(...args));
const clamp01 = (v) => v.map((x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : x)); // not finite stays, for the error

const CHOICES = Symbol('choices'); // a scope's choice parameters → their options (draft f24)
const CMP = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
// GLSL ES built-ins with GLSL's definitions (mod floors, step is edge <= x), per component on vec4s; and vec4.
const CONSTS = { PI: Math.PI, TAU: 2 * Math.PI };
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
const MATERIAL_SLOTS = { baseColorFactor: 'pbr', metallicFactor: 'pbr', roughnessFactor: 'pbr', emissiveFactor: 'top', emissiveStrength: 'ext', transmissionFactor: 'ext', ior: 'ext',
  sheenColorFactor: 'ext', sheenRoughnessFactor: 'ext', diffuseTransmissionFactor: 'ext', diffuseTransmissionColorFactor: 'ext' };
// Write evaluated material slots into their core glTF places; returns the material.
function slots(core, m) {
  const pbr = Object.fromEntries(Object.entries(m).filter(([k]) => MATERIAL_SLOTS[k] === 'pbr'));
  if (Object.keys(pbr).length) core.pbrMetallicRoughness = { ...pbr, ...core.pbrMetallicRoughness };
  if (m.emissiveFactor) core.emissiveFactor = m.emissiveFactor;
  for (const [k, [e, def]] of Object.entries(EXT_SLOTS)) { // slots sharing an extension (sheen) go in one object
    if (m[k] !== undefined && JSON.stringify(m[k]) !== JSON.stringify(def)) core.extensions = { ...core.extensions, [e]: { ...core.extensions?.[e], [k]: m[k] } };
  }
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
