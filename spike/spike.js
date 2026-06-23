// Route-1 de-risking spike: can Deno run the existing WebGPU edge-projection
// generator HEADLESS, with full process RAM, on a heavy mesh?
//
// Usage: deno run -A --unstable-webgpu spike.js [sphereSegments] [angleThreshold]
//   segments ~2236 -> ~10M triangles. angleThreshold 1 -> keep ~every edge (worst case).

import * as THREE from "three/webgpu";
import { ProjectionGenerator } from "three-edge-projection/webgpu";

// three's renderer starts an internal rAF loop on init(); Deno has no rAF. Stub it —
// we drive compute manually, so the loop just needs to not throw.
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const seg = Number(Deno.args[0] ?? 500);
const angle = Number(Deno.args[1] ?? 50);

if (!navigator.gpu) {
  console.error("FAIL: navigator.gpu is undefined — Deno WebGPU not available");
  Deno.exit(1);
}

// compute-only: stub the canvas so three doesn't reach for document. The swapchain
// getContext/configure path only fires on present(), which we never call.
const stubCanvas = { setAttribute() {}, getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {}, width: 1, height: 1 };
const renderer = new THREE.WebGPURenderer({ antialias: false, canvas: stubCanvas });
await renderer.init();
console.log("ok: WebGPURenderer initialized headless");

// heavy mesh. A high-res sphere is smooth (few hard edges), so we also drive the
// edge count up via a low angleThreshold to simulate a faceted "heavy" CAD/scan model.
const geo = new THREE.SphereGeometry(1, seg, seg);
const tris = (geo.index.count / 3) | 0;
const verts = geo.attributes.position.count;
const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
mesh.updateMatrixWorld(true);
console.log(`mesh: ${tris.toLocaleString()} tris, ${verts.toLocaleString()} verts, angleThreshold=${angle}`);

const gen = new ProjectionGenerator(renderer);
gen.includeIntersectionEdges = false;
gen.angleThreshold = angle;

const t0 = performance.now();
const result = await gen.generate(mesh, {
  onProgress: (p, m) => Deno.stdout.writeSync(new TextEncoder().encode(`\r${m} ${(p * 100).toFixed(0)}%   `)),
});
const secs = ((performance.now() - t0) / 1000).toFixed(1);

const vis = result.visibleEdges.getLineGeometry().attributes.position.count / 2;
const hid = result.hiddenEdges.getLineGeometry().attributes.position.count / 2;
const rss = (Deno.memoryUsage().rss / 1e6).toFixed(0);

console.log(`\nok: projected in ${secs}s`);
console.log(`    ${vis.toLocaleString()} visible + ${hid.toLocaleString()} hidden segments`);
console.log(`    peak RSS ~${rss} MB`);
Deno.exit(0);
