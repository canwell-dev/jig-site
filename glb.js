// Named parts of a glTF file (.glb or .gltf), for the loft scanner. Pure, like jig.js: the viewer and tools/ share it.
// A part is { name, kind, positions, indices, guide?, parent? } in world space, holding only the vertices it uses:
// - 'file': every triangle of the default scene;
// - 'mesh': each named mesh node;
// - 'bone': for a skinned mesh, each named joint: the triangles nearest its bone (the segment from the joint to its
//   first child joint; a leaf's runs on half its parent's length), so the bones split the mesh by where things are.
//   A leaf's guide ends at the middle of its triangles (a palm), so a scan leaves out what sticks out past it.
//   Not by skin weight: weights follow how a rig deforms, and an auto-rig may give a shoulder half the chest.
//   guide: the bone's segment, for scanLoft: bone parts are stubby, and a limb's centre runs through its joints.
//   parent: the parent joint's name.
// Skinned meshes are posed by their joints and inverse bind matrices (glTF 2.0 §3.7.3), the node's own transform
// ignored: the bind pose.
// shortcut: triangles only (mode 4), no sparse accessors, no morph targets; add them when a file needs them.
import { compose, mul } from './jig.js?v=eef4c21';

const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GET = { 5120: ['getInt8', 1, 127], 5121: ['getUint8', 1, 255], 5122: ['getInt16', 2, 32767],
  5123: ['getUint16', 2, 65535], 5125: ['getUint32', 4, 0], 5126: ['getFloat32', 4, 0] };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// bytes: a .glb, or a .gltf's text as bytes. load(uri) returns the bytes of an external buffer (Node passes one).
export function parseGltf(bytes, load) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let json, bin;
  if (dv.getUint32(0, true) === 0x46546c67) { // 'glTF'
    const n = dv.getUint32(12, true);
    json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + n)));
    if (b.length > 28 + n) bin = b.subarray(28 + n, 28 + n + dv.getUint32(20 + n, true));
  } else json = JSON.parse(new TextDecoder().decode(b));
  const buffers = (json.buffers ?? []).map((buf, i) => {
    if (buf.uri === undefined) { if (i === 0 && bin) return bin; throw new Error(`/buffers/${i}: no data`); }
    const data = buf.uri.match(/^data:[^,]*;base64,(.*)$/);
    if (data) return Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0));
    if (!load) throw new Error(`/buffers/${i}: external file ${buf.uri}; use a .glb`);
    return load(buf.uri);
  });
  return { json, buffers };
}

// An accessor as a flat array of numbers (normalized integers scaled to 0..1 or -1..1).
function accessor({ json, buffers }, i) {
  const a = json.accessors[i], n = SIZE[a.type], [get, size, max] = GET[a.componentType], out = new Float64Array(a.count * n);
  if (a.bufferView === undefined) return out;
  const v = json.bufferViews[a.bufferView], buf = buffers[v.buffer], stride = v.byteStride || n * size;
  const dv = new DataView(buf.buffer, buf.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0));
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
    const x = dv[get](k * stride + c * size, true);
    out[k * n + c] = a.normalized && max ? Math.max(x / max, -1) : x;
  }
  return out;
}

// World matrix of every node in the default scene (undefined for nodes outside it). pose: [[joint, toward, [x, y, z]],
// ...] by node name: the joint turns about its origin (shortest arc) so that the line from it to node `toward` points
// along [x, y, z]; nodes below it follow. [joint] turns a skin's joint back to how it turned in the bind pose (its
// inverse bind matrix), where it stands: a head the scene leaves tilted. [node, other] moves the node's subtree with `other` (an IK target). [joint, { turn: [x, y, z, deg] }] then turns it
// about its origin round world axis [x, y, z] (scan.js levelPose: a head turned upright by its mirror plane). Skinned vertices follow through their weights, so a model can be re-posed
// before a scan (a T-pose to match a recipe's bind pose).
export function worldMatrices(gltf, pose = []) {
  const { json } = gltf, world = [], scene = json.scenes?.[json.scene ?? 0], byName = new Map(json.nodes.map((n, i) => [n.name, i]));
  const local = (n) => n.matrix ?? compose(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]);
  const follows = pose.filter((e) => e.length === 2 && typeof e[1] === 'string');
  const turns = new Map(pose.filter((e) => e.length === 2 && e[1]?.turn).map(([j, { turn }]) => {
    if (!byName.has(j)) throw new Error(`pose: no node named ${j}`);
    return [byName.get(j), turn];
  }));
  const aims = new Map(pose.filter((e) => e.length === 3).map(([j, to, d]) => {
    if (!byName.has(j) || !byName.has(to)) throw new Error(`pose: no node named ${byName.has(j) ? to : j}`);
    return [byName.get(j), { path: pathTo(json, byName.get(j), byName.get(to)), d }];
  }));
  const binds = new Map(pose.filter((e) => e.length === 1).map(([j]) => {
    const i = byName.get(j), skin = json.skins?.find((sk) => sk.joints.includes(i) && sk.inverseBindMatrices !== undefined);
    if (!skin) throw new Error(`pose: ${j} is not a joint of a skin with inverse bind matrices`);
    // At the bind pose world × inverse bind = identity (glTF 2.0 §3.7.3), so the joint's bind frame is the inverse of
    // its inverse bind matrix: its axes, without their scale (the joint keeps the scene's).
    const k = skin.joints.indexOf(i), m = affineInverse(Array.from(accessor(gltf, skin.inverseBindMatrices).subarray(16 * k, 16 * k + 16)));
    return [i, [0, 4, 8].map((c) => { const l = Math.hypot(m[c], m[c + 1], m[c + 2]); return [m[c] / l, m[c + 1] / l, m[c + 2] / l]; })];
  }));
  const visit = (i, parent) => {
    world[i] = mul(parent, local(json.nodes[i]));
    const aim = aims.get(i);
    if (aim) {
      if (!aim.path) throw new Error(`pose: ${json.nodes[i].name} is not above its target`);
      const end = aim.path.reduce((m, k) => mul(m, local(json.nodes[k])), world[i]);
      const R = arc(sub3(end.slice(12, 15), world[i].slice(12, 15)), aim.d), o = world[i].slice(12, 15);
      world[i] = mul([...R.slice(0, 12), o[0], o[1], o[2], 1], mul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -o[0], -o[1], -o[2], 1], world[i]));
    }
    if (binds.has(i)) world[i] = [...binds.get(i).flatMap((axis, c) => [...axis.map((x) => x * Math.hypot(...world[i].slice(4 * c, 4 * c + 3))), 0]), ...world[i].slice(12)];
    if (turns.has(i)) {
      const [x, y, z, deg] = turns.get(i), l = Math.hypot(x, y, z), h = (deg * Math.PI) / 360, s = Math.sin(h) / l, o = world[i].slice(12, 15);
      const R = compose([0, 0, 0], [x * s, y * s, z * s, Math.cos(h)], [1, 1, 1]);
      world[i] = mul([...R.slice(0, 12), o[0], o[1], o[2], 1], mul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -o[0], -o[1], -o[2], 1], world[i]));
    }
    for (const c of json.nodes[i].children ?? []) visit(c, world[i]);
  };
  for (const i of scene?.nodes ?? json.nodes.map((_, i) => i)) visit(i, IDENTITY);
  if (!follows.length) return world;
  // [node, follows]: the node and its subtree move rigidly with another node (an IK target with the limb it ends).
  const rest = worldMatrices(gltf);
  for (const [n, f] of follows) {
    if (!byName.has(n) || !byName.has(f)) throw new Error(`pose: no node named ${byName.has(n) ? f : n}`);
    const delta = mul(world[byName.get(f)], affineInverse(rest[byName.get(f)]));
    (function move(k) { world[k] = mul(delta, world[k]); for (const c of json.nodes[k].children ?? []) move(c); })(byName.get(n));
  }
  return world;
}

// Nodes from below `from` down to `to` (from excluded), or null when `to` is not below it.
function pathTo(json, from, to) {
  if (from === to) return [];
  for (const c of json.nodes[from].children ?? []) { const p = pathTo(json, c, to); if (p) return [c, ...p]; }
  return null;
}
const sub3 = (a, b) => a.map((c, i) => c - b[i]);
// Inverse of an affine column-major 4x4 (3x3 part by cofactors).
export function affineInverse(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m, det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const r = [(e * i - f * h), -(b * i - c * h), (b * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - b * g), (a * e - b * d)].map((x) => x / det);
  const t = m.slice(12, 15), it = [0, 1, 2].map((k) => -(r[k] * t[0] + r[3 + k] * t[1] + r[6 + k] * t[2]));
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, ...it, 1];
}
// The rotation (column-major 4x4) turning direction a onto b by the shortest arc (Rodrigues).
function arc(a, b) {
  const n = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); }, u = n(a), w = n(b);
  const ax = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], s = Math.hypot(...ax), c = u.reduce((t, x, i) => t + x * w[i], 0);
  if (s < 1e-12) return c > 0 ? IDENTITY : (() => { const p = n(Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [-u[2], 0, u[0]]); return [0, 1, 2].flatMap((col) => [...[0, 1, 2].map((r) => 2 * p[r] * p[col] - (r === col ? 1 : 0)), 0]).concat([0, 0, 0, 1]); })();
  const [x, y, z] = ax.map((v) => v / s), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}

const apply = (m, x, y, z) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
const part = (name, kind) => ({ name, kind, positions: [], indices: [] });

// Copy the triangles `list` (indices into world) into part `to`, each vertex once.
function fill(to, world, list) {
  const at = new Map();
  for (const i of list) {
    if (!at.has(i)) { at.set(i, to.positions.length / 3); to.positions.push(...world[i]); }
    to.indices.push(at.get(i));
  }
  return to;
}

// A mesh node's triangles in world space, skinned meshes posed by their joints: { V, tris, skin, weights } (weights:
// per vertex, [[joint node index, weight], ...] for a skinned mesh).
function meshNode(gltf, world, ni) {
  const { json } = gltf, n = json.nodes[ni], skin = n.skin !== undefined ? json.skins[n.skin] : null;
  const ibm = skin && (skin.inverseBindMatrices !== undefined ? accessor(gltf, skin.inverseBindMatrices) : null);
  const joints = skin?.joints.map((j, k) => mul(world[j], ibm ? Array.from(ibm.subarray(16 * k, 16 * k + 16)) : IDENTITY));
  const V = [], tris = [], weights = [];
  for (const p of json.meshes[n.mesh].primitives) {
    if ((p.mode ?? 4) !== 4) continue;
    const pos = accessor(gltf, p.attributes.POSITION), base = V.length, count = pos.length / 3;
    const j = skin && p.attributes.JOINTS_0 !== undefined && accessor(gltf, p.attributes.JOINTS_0);
    const w = skin && p.attributes.WEIGHTS_0 !== undefined && accessor(gltf, p.attributes.WEIGHTS_0);
    for (let k = 0; k < count; k++) {
      const [x, y, z] = pos.subarray(3 * k, 3 * k + 3);
      if (!j || !w) { V.push(apply(world[ni], x, y, z)); continue; }
      const v = [0, 0, 0], vw = [];
      for (let c = 0; c < 4; c++) {
        const wt = w[4 * k + c];
        if (wt) { apply(joints[j[4 * k + c]], x, y, z).forEach((q, a) => { v[a] += wt * q; }); vw.push([skin.joints[j[4 * k + c]], wt]); }
      }
      V.push(v); weights.push(vw);
    }
    const idx = p.indices !== undefined ? accessor(gltf, p.indices) : Array.from({ length: count }, (_, k) => k);
    for (const i of idx) tris.push(base + i);
  }
  return { V, tris, skin, weights };
}

export function namedParts(gltf, pose) {
  const { json } = gltf, world = worldMatrices(gltf, pose), all = part('whole file', 'file'), parts = [all];
  json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined || !world[ni]) return;
    const { V, tris, skin } = meshNode(gltf, world, ni);
    fill(all, V, tris);
    if (n.name) parts.push(fill(part(n.name, 'mesh'), V, tris));
    if (!skin) return;
    const origin = (i) => world[i].slice(12, 15), sub = (a, b) => a.map((c, i) => c - b[i]);
    const bones = skin.joints.map((ji) => {
      const kid = (json.nodes[ji].children ?? []).find((c) => skin.joints.includes(c)), up = json.nodes.findIndex((x) => x.children?.includes(ji));
      const a = origin(ji), b = kid !== undefined ? origin(kid) : skin.joints.includes(up) ? a.map((c, i) => c + (c - origin(up)[i]) / 2) : a;
      return { ji, a, b, leaf: kid === undefined, parent: skin.joints.includes(up) ? json.nodes[up].name : undefined, tris: [] };
    });
    const toSegment = (p, { a, b }) => {
      const ab = sub(b, a), l2 = ab.reduce((s, c) => s + c * c, 0), ap = sub(p, a);
      const f = l2 ? Math.max(0, Math.min(1, ap.reduce((s, c, i) => s + c * ab[i], 0) / l2)) : 0;
      return Math.hypot(...ap.map((c, i) => c - f * ab[i]));
    };
    for (let t = 0; t < tris.length; t += 3) {
      const m = [0, 1, 2].map((c) => (V[tris[t]][c] + V[tris[t + 1]][c] + V[tris[t + 2]][c]) / 3);
      bones.reduce((best, bn) => (toSegment(m, bn) < toSegment(m, best) ? bn : best)).tris.push(tris[t], tris[t + 1], tris[t + 2]);
    }
    for (const bn of bones) {
      const name = json.nodes[bn.ji].name;
      if (!name || !bn.tris.length) continue;
      const p = fill(part(name, 'bone'), V, bn.tris);
      if (bn.parent) p.parent = bn.parent;
      // A leaf (a hand, a toe) runs from its joint to the middle of what it holds: a palm, not the finger tips.
      const mid = [0, 1, 2].map((c) => p.positions.filter((_, i) => i % 3 === c).reduce((s, x) => s + x, 0) / (p.positions.length / 3));
      const b = bn.leaf ? mid : bn.b;
      if (b.some((c, i) => c !== bn.a[i])) p.guide = [bn.a, b];
      parts.push(p);
    }
  });
  return parts;
}

// The world position of every named node in the default scene, by name (joints, for a guide).
export function nodeOrigins(gltf, pose) {
  const { json } = gltf, world = worldMatrices(gltf, pose);
  return Object.fromEntries(json.nodes.flatMap((n, i) => (n.name && world[i] ? [[n.name, world[i].slice(12, 15)]] : [])));
}

// Several parts as one, e.g. a bone and its children. guide: theirs end to end (shared joints once).
export function mergeParts(list, name = list.map((p) => p.name).join('+')) {
  const to = part(name, list[0].kind);
  for (const p of list) {
    const base = to.positions.length / 3;
    to.positions.push(...p.positions);
    for (const i of p.indices) to.indices.push(base + i);
  }
  const same = (a, b) => a && b && a.every((c, i) => Math.abs(c - b[i]) < 1e-9);
  const guide = list.flatMap((p) => p.guide ?? []).filter((q, i, all) => !same(q, all[i - 1]));
  if (guide.length >= 2) to.guide = guide;
  return to;
}

// Parts by name: "A" or "A+B+C" merged; "A*" is A and every bone below it. "...@J1>J2>J3" sets the guide to those
// nodes' positions (origins: nodeOrigins), for a merged piece whose own guides do not run end to end, like a torso;
// a ">" before the first or after the last name sets reach: that end goes on to the piece's end (scanLoft).
export function pickPart(parts, spec, origins = {}) {
  const [what, via] = spec.split('@');
  const byName = (n) => parts.find((p) => p.name === n && p.kind !== 'file') ?? parts.find((p) => p.name === n);
  const below = (n) => [n, ...parts.filter((p) => p.parent === n).flatMap((p) => below(p.name))];
  const names = what.split('+').flatMap((s) => (s.endsWith('*') ? below(s.slice(0, -1)) : [s]));
  const list = names.map((n) => byName(n) ?? (() => { throw new Error(`no part named ${n}`); })());
  const p = list.length === 1 ? list[0] : mergeParts(list, what);
  if (!via) return p;
  const names2 = via.split('>'), reach = [names2[0] === '', names2[names2.length - 1] === ''];
  const guide = names2.filter(Boolean).map((n) => origins[n] ?? (() => { throw new Error(`no node named ${n}`); })());
  return { ...p, name: spec, guide, reach };
}

// ---------- The deforming skeleton, for tools/autoscan.mjs ----------

// Joints that carry weight, each under the nearest such joint above it. The root is the one with the most below it;
// another without one above (a hand under an IK target) hangs from the joint owning the node of the root's branch that
// stands nearest it (`attach`, the forearm's end), and its topmost node of its own branch (`float`, the IK target)
// moves with that node (a pose's [node, other]). A joint shorter than minBone (to its farthest node below) folds into
// the joint it hangs from, with its triangles (fingers); so does a leaf whose joint holds other kept joints too (a
// face's bones, a tie: one node per chain end, not per side branch). Returns { root, joints: { name: { node,
// parent, children, attach?, float? } }, owner: Map(joint node index -> kept joint's name) }.
export function skeleton(gltf, minBone = 0) {
  const { json } = gltf, world = worldMatrices(gltf), at = (i) => world[i].slice(12, 15), name = (i) => json.nodes[i].name;
  const up = new Map();
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => up.set(c, i)));
  const weighted = new Set();
  json.nodes.forEach((n, ni) => {
    if (n.skin === undefined || n.mesh === undefined || !world[ni]) return;
    for (const vw of meshNode(gltf, world, ni).weights) for (const [j, w] of vw) if (w > 0.01) weighted.add(j);
  });
  if (!weighted.size) throw new Error('skeleton: no skinned mesh with weights');
  const below = (i) => [i, ...(json.nodes[i].children ?? []).flatMap(below)];
  const above = (i) => { const a = []; for (let k = up.get(i); k !== undefined; k = up.get(k)) a.push(k); return a; };
  const parent = new Map([...weighted].map((j) => [j, above(j).find((a) => weighted.has(a))]));
  const tops = [...weighted].filter((j) => parent.get(j) === undefined), size = (j) => below(j).filter((k) => weighted.has(k)).length;
  const root = tops.reduce((a, b) => (size(b) > size(a) ? b : a)), branch = below(root), attach = new Map(), float = new Map();
  const ownerOf = (k) => (weighted.has(k) ? k : above(k).find((a) => weighted.has(a)));
  for (const t of tops) if (t !== root) {
    const near = branch.reduce((a, b) => (dist3(at(b), at(t)) < dist3(at(a), at(t)) ? b : a));
    attach.set(t, near); parent.set(t, ownerOf(near));
    const rootUp = new Set([root, ...above(root)]);
    float.set(t, [t, ...above(t)].find((a) => rootUp.has(up.get(a))) ?? t);
  }
  const kept = new Set([...weighted].filter((j) => j === root || Math.max(0, ...below(j).map((k) => dist3(at(k), at(j)))) >= minBone));
  const keptUp = (j) => { let k = parent.get(j); while (!kept.has(k)) k = parent.get(k); return k; };
  for (let again = true; again;) { // side branches that end in a leaf (a face's bones, a tie, a pelvis) fold, until none is left
    again = false;
    const kids = new Map();
    for (const j of kept) if (j !== root) kids.set(keptUp(j), [...(kids.get(keptUp(j)) ?? []), j]);
    for (const j of kept) if (j !== root && !kids.has(j) && kids.get(keptUp(j)).length > 1) { kept.delete(j); again = true; }
  }
  const long = (j) => kept.has(j), owner = new Map(), keptOf = (j) => (long(j) ? j : keptOf(parent.get(j)));
  for (const j of weighted) owner.set(j, name(keptOf(j)));
  const joints = {};
  for (const j of weighted) if (long(j)) {
    joints[name(j)] = { node: j, parent: j === root ? undefined : owner.get(parent.get(j)), children: [] };
    if (attach.has(j)) Object.assign(joints[name(j)], { attach: name(attach.get(j)), float: name(float.get(j)) });
  }
  for (const [n, j] of Object.entries(joints)) if (j.parent) joints[j.parent].children.push(n);
  return { root: name(root), joints, owner };
}

// Each skinned mesh's triangles by the kept joint holding most of their weight (owner: skeleton's), in the pose:
// [{ joint, mesh, positions, indices }], mesh the mesh node's name.
export function jointParts(gltf, pose, owner) {
  const { json } = gltf, world = worldMatrices(gltf, pose), out = [];
  json.nodes.forEach((n, ni) => {
    if (n.skin === undefined || n.mesh === undefined || !world[ni]) return;
    const { V, tris, weights } = meshNode(gltf, world, ni), mesh = n.name ?? `mesh ${ni}`, lists = new Map();
    for (let t = 0; t < tris.length; t += 3) {
      const score = new Map();
      for (const v of tris.slice(t, t + 3)) for (const [j, w] of weights[v]) if (owner.has(j)) score.set(owner.get(j), (score.get(owner.get(j)) ?? 0) + w);
      if (!score.size) continue;
      const joint = [...score].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
      if (!lists.has(joint)) lists.set(joint, []);
      lists.get(joint).push(...tris.slice(t, t + 3));
    }
    for (const [joint, list] of lists) out.push({ ...fill(part(`${joint}|${mesh}`, 'piece'), V, list), joint, mesh });
  });
  return out;
}

// A straightened pose for skeleton sk, as pose entries, top down. A chain goes on straight: a joint aims at its one
// kept child, or of several the one nearest the way the joint comes in (the chest at the neck), along that way when
// it bends less than 135 degrees from it (a knee, an elbow bent up to the chest, a hunched neck). A chain's first joint (from the hips or
// the chest: a leg, an arm) aims at the axis nearest where it points now. The root keeps its turn, a joint without
// kept children too (a foot stays forward, relative to its shin); a floating branch follows its attach node.
export function straightPose(gltf, sk) {
  const pose = [], into = new Map(), unit = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
  const node = (c) => sk.joints[c].attach ?? c, dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const visit = (n) => {
    const j = sk.joints[n], now = nodeOrigins(gltf, pose), way = into.get(n);
    if (j.float) pose.push([j.float, j.attach]);
    const cur = (c) => unit(sub3(now[node(c)], now[n]));
    const next = j.children.length === 1 ? j.children[0] : way && j.children.length > 1 && j.children.reduce((a, b) => (dot(cur(b), way) > dot(cur(a), way) ? b : a));
    if (next) {
      const c = cur(next), big = c.reduce((b, x, i) => (Math.abs(x) > Math.abs(c[b]) ? i : b), 0);
      const d = way && dot(c, way) > -0.7 ? way : [0, 1, 2].map((i) => (i === big ? Math.sign(c[i]) : 0));
      pose.push([n, node(next), d]); into.set(next, d);
    }
    j.children.forEach(visit);
  };
  visit(sk.root);
  return pose;
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
