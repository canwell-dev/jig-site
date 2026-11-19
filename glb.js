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
import { compose, mul } from './jig.js?v=fb98969';

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

// World matrix of every node in the default scene (undefined for nodes outside it).
function worldMatrices(json) {
  const world = [], scene = json.scenes?.[json.scene ?? 0];
  const visit = (i, parent) => {
    const n = json.nodes[i];
    world[i] = mul(parent, n.matrix ?? compose(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]));
    for (const c of n.children ?? []) visit(c, world[i]);
  };
  for (const i of scene?.nodes ?? json.nodes.map((_, i) => i)) visit(i, IDENTITY);
  return world;
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

export function namedParts(gltf) {
  const { json } = gltf, world = worldMatrices(json), all = part('whole file', 'file'), parts = [all];
  json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined || !world[ni]) return;
    const skin = n.skin !== undefined ? json.skins[n.skin] : null;
    const ibm = skin && (skin.inverseBindMatrices !== undefined ? accessor(gltf, skin.inverseBindMatrices) : null);
    const joints = skin?.joints.map((j, k) => mul(world[j], ibm ? Array.from(ibm.subarray(16 * k, 16 * k + 16)) : IDENTITY));
    const V = [], tris = [];
    for (const p of json.meshes[n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const pos = accessor(gltf, p.attributes.POSITION), base = V.length, count = pos.length / 3;
      const j = skin && p.attributes.JOINTS_0 !== undefined && accessor(gltf, p.attributes.JOINTS_0);
      const w = skin && p.attributes.WEIGHTS_0 !== undefined && accessor(gltf, p.attributes.WEIGHTS_0);
      for (let k = 0; k < count; k++) {
        const [x, y, z] = pos.subarray(3 * k, 3 * k + 3);
        if (!j || !w) { V.push(apply(world[ni], x, y, z)); continue; }
        const v = [0, 0, 0];
        for (let c = 0; c < 4; c++) {
          const wt = w[4 * k + c];
          if (wt) apply(joints[j[4 * k + c]], x, y, z).forEach((q, a) => { v[a] += wt * q; });
        }
        V.push(v);
      }
      const idx = p.indices !== undefined ? accessor(gltf, p.indices) : Array.from({ length: count }, (_, k) => k);
      for (const i of idx) tris.push(base + i);
    }
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
export function nodeOrigins({ json }) {
  const world = worldMatrices(json);
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
