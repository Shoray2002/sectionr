// Interpolated occluding contours (Hertzmann & Zorin 2000). The library's
// silhouette test flags whole mesh edges where adjacent face normals straddle
// the projection direction — on a tessellated smooth surface (car bodies) that
// polyline zigzags around the true outline and flickers between visible and
// hidden in the overlap pass, giving jagged, fragmented curves. Instead, take
// a smooth normal field, evaluate g = n·projDir per triangle corner, and
// extract the zero-crossing segments across triangle interiors — those land on
// the true smooth contour.
//
// Normals are crease-split (Freestyle-style smoothing groups): a corner's
// normal averages only adjacent faces within creaseAngle of its own face, so
// contours terminate cleanly at sharp features (tire treads, trim edges)
// instead of wandering across them; the crease itself is drawn by the regular
// dihedral-angle edge pass.
import { Vector3, Matrix4 } from "three";
import { ProjectionEdge } from "three-edge-projection/src/utils/ProjectionEdge.js";

const _inv = new Matrix4();
const _dir = new Vector3();

function dist2(pa, i, j) {
  const dx = pa[i * 3] - pa[j * 3], dy = pa[i * 3 + 1] - pa[j * 3 + 1], dz = pa[i * 3 + 2] - pa[j * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

// per-corner crease-split unit normals, cached on the geometry per creaseAngle
function buildCornerNormals(geo, creaseAngle) {
  const cached = geo.userData.contourCorners;
  if (cached && cached.creaseAngle === creaseAngle) return cached.data;

  const pa = geo.attributes.position.array;
  const idx = geo.index.array;
  const triCount = idx.length / 3;
  const vertCount = pa.length / 3;

  // unit face normals
  const fn = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const abx = pa[b] - pa[a], aby = pa[b + 1] - pa[a + 1], abz = pa[b + 2] - pa[a + 2];
    const acx = pa[c] - pa[a], acy = pa[c + 1] - pa[a + 1], acz = pa[c + 2] - pa[a + 2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
  }

  // vertex -> face adjacency (CSR)
  const counts = new Uint32Array(vertCount + 1);
  for (let i = 0; i < idx.length; i++) counts[idx[i] + 1]++;
  for (let v = 0; v < vertCount; v++) counts[v + 1] += counts[v];
  const adj = new Uint32Array(idx.length);
  const fill = counts.slice(0, vertCount);
  for (let i = 0; i < idx.length; i++) adj[fill[idx[i]]++] = (i / 3) | 0;

  // corner normal = average of the vertex's faces within creaseAngle of this face
  const cosCrease = Math.cos((creaseAngle * Math.PI) / 180);
  const cn = new Float32Array(idx.length * 3);
  for (let t = 0; t < triCount; t++) {
    const tnx = fn[t * 3], tny = fn[t * 3 + 1], tnz = fn[t * 3 + 2];
    for (let c = 0; c < 3; c++) {
      const v = idx[t * 3 + c];
      let sx = 0, sy = 0, sz = 0;
      for (let k = counts[v], ke = counts[v + 1]; k < ke; k++) {
        const f = adj[k] * 3;
        if (fn[f] * tnx + fn[f + 1] * tny + fn[f + 2] * tnz >= cosCrease) {
          sx += fn[f]; sy += fn[f + 1]; sz += fn[f + 2];
        }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      const o = (t * 3 + c) * 3;
      cn[o] = sx / l; cn[o + 1] = sy / l; cn[o + 2] = sz / l;
    }
  }

  geo.userData.contourCorners = { creaseAngle, data: cn };
  return cn;
}

// mesh must have indexed (welded) geometry. Projection direction is world +Y,
// matching the edge-projection pipeline.
//
// liftFactor: contour segments lie on the chord surface, slightly inside the
// true silhouette, so the mesh itself bulges above them by up to ~half the
// local edge length and the visibility pass would wrongly occlude them. Lift
// each segment toward the viewer by liftFactor × the triangle's longest edge.
// ponytail: a lift this size can wrongly reveal contours occluded by geometry
// closer than ~half an edge length; exclude the straddling triangles from the
// occlusion test instead if that ever matters.
export function smoothContourEdges(mesh, { yOffset = 5e-5, creaseAngle = 50, liftFactor = 0.5, target = [] } = {}) {
  const geo = mesh.geometry;
  if (!geo.index) throw new Error("smoothContourEdges requires indexed geometry");
  const pa = geo.attributes.position.array;
  const idx = geo.index.array;
  const cn = buildCornerNormals(geo, creaseAngle);

  // world +Y in local space; only the sign and ratios of n·dir matter, so the
  // normalization in transformDirection is harmless even under scale.
  _dir.set(0, 1, 0).transformDirection(_inv.copy(mesh.matrixWorld).invert());
  const dx = _dir.x, dy = _dir.y, dz = _dir.z;

  // g per corner; biased away from exact zero so every triangle is a clean
  // 0- or 2-crossing case
  const g = new Float32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const o = i * 3;
    const d = cn[o] * dx + cn[o + 1] * dy + cn[o + 2] * dz;
    g[i] = d === 0 ? 1e-10 : d;
  }

  // crossing on the edge between corners ca/cb (vertices va/vb)
  const cross = (ca, cb, va, vb, out) => {
    const t = g[ca] / (g[ca] - g[cb]); // opposite signs -> t in (0,1)
    out.set(
      pa[va * 3] + t * (pa[vb * 3] - pa[va * 3]),
      pa[va * 3 + 1] + t * (pa[vb * 3 + 1] - pa[va * 3 + 1]),
      pa[va * 3 + 2] + t * (pa[vb * 3 + 2] - pa[va * 3 + 2]),
    );
  };

  for (let i = 0; i < idx.length; i += 3) {
    const sa = g[i] > 0, sb = g[i + 1] > 0, sc = g[i + 2] > 0;
    if (sa === sb && sb === sc) continue;
    // o = the odd-signed corner; the contour crosses edges o-e1 and o-e2
    let o = i + 2, e1 = i, e2 = i + 1;
    if (sb === sc) { o = i; e1 = i + 1; e2 = i + 2; }
    else if (sa === sc) { o = i + 1; e1 = i; e2 = i + 2; }
    const line = new ProjectionEdge();
    cross(o, e1, idx[o], idx[e1], line.start);
    cross(o, e2, idx[o], idx[e2], line.end);
    line.applyMatrix4(mesh.matrixWorld);
    const lift = yOffset + liftFactor * Math.sqrt(Math.max(
      dist2(pa, idx[i], idx[i + 1]), dist2(pa, idx[i + 1], idx[i + 2]), dist2(pa, idx[i + 2], idx[i]),
    ));
    line.start.y += lift;
    line.end.y += lift;
    line.mesh = mesh;
    target.push(line);
  }
  return target;
}
