// Self-checks for smoothContourEdges. Run: deno run -A server/contours.test.js
//
// 1. Sphere: the occluding contour viewed down +Y is the world-space equator —
//    every endpoint at radius ~1 with world y ~0, for any model rotation.
// 2. Cylinder: with crease-split normals (creaseAngle < 90°) the contour stays
//    on the barrel (local radius ~1); with fully smooth normals (creaseAngle
//    180°) it leaks onto the flat caps — proving the split does something.
import { Mesh, MeshStandardMaterial, SphereGeometry, CylinderGeometry, BufferGeometry } from "three";
import { mergeVertices } from "../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js";
import { smoothContourEdges } from "./contours.js";

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); Deno.exit(1); }
}

// weld to position-only indexed geometry, like the sidecar's buildProjInput
function weld(geo) {
  const pg = new BufferGeometry();
  pg.setAttribute("position", geo.toNonIndexed().getAttribute("position"));
  return mergeVertices(pg);
}

// --- sphere: 31 height segments -> no vertex ring sits exactly on the equator,
// so every contour point is genuinely interpolated across a triangle edge.
for (const rot of [0, 0.7]) {
  const mesh = new Mesh(weld(new SphereGeometry(1, 64, 31)), new MeshStandardMaterial());
  mesh.rotation.x = rot;
  mesh.updateMatrixWorld(true);

  const edges = smoothContourEdges(mesh, { yOffset: 0, liftFactor: 0 }); // raw on-surface geometry
  assert(edges.length > 100, `sphere rot=${rot}: expected a full contour ring, got ${edges.length} segments`);

  let maxR = 0, maxY = 0;
  for (const e of edges) {
    for (const p of [e.start, e.end]) {
      maxR = Math.max(maxR, Math.abs(Math.hypot(p.x, p.y, p.z) - 1));
      maxY = Math.max(maxY, Math.abs(p.y));
    }
  }
  // points lie on chords of the unit sphere between rings ~0.1 apart -> <~2.5e-3 inside
  assert(maxR < 3e-3, `sphere rot=${rot}: contour points off the surface by ${maxR}`);
  // equator in WORLD space even though the mesh is rotated
  assert(maxY < 0.06, `sphere rot=${rot}: contour not on the world equator, |y| up to ${maxY}`);
  console.log(`sphere rot=${rot}: ${edges.length} segments, maxR-1=${maxR.toExponential(1)}, max|y|=${maxY.toExponential(1)} — ok`);
}

// --- cylinder: r=1 h=2, tilted steeply so the top cap grazes the view — the
// regime where blended rim normals drag the contour onto the flat cap
function cylinderMinR(creaseAngle) {
  const mesh = new Mesh(weld(new CylinderGeometry(1, 1, 2, 48, 1)), new MeshStandardMaterial());
  mesh.rotation.x = 1.2;
  mesh.updateMatrixWorld(true);
  const edges = smoothContourEdges(mesh, { yOffset: 0, liftFactor: 0, creaseAngle });
  assert(edges.length > 0, `cylinder creaseAngle=${creaseAngle}: no contour segments`);
  const inv = mesh.matrixWorld.clone().invert();
  let minR = Infinity;
  for (const e of edges) {
    for (const p of [e.start.clone(), e.end.clone()]) {
      p.applyMatrix4(inv); // back to local: barrel points have hypot(x,z)=1, cap points < 1
      minR = Math.min(minR, Math.hypot(p.x, p.z));
    }
  }
  return { minR, count: edges.length };
}

const split = cylinderMinR(50);
const blended = cylinderMinR(180);
assert(split.minR > 0.98, `crease-split contour leaked onto the caps, min local r=${split.minR}`);
assert(blended.minR < 0.98, `expected fully-smooth normals to leak onto the caps (test can't discriminate), min r=${blended.minR}`);
console.log(`cylinder: split minR=${split.minR.toFixed(4)} (${split.count} segs) vs blended minR=${blended.minR.toFixed(4)} (${blended.count} segs) — ok`);

console.log("contours self-check passed");
