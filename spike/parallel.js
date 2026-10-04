// Correctness + timing on the actual GPU, with no model file or app required:
// deno run -A --unstable-webgpu spike/parallel.js [sphereSegments=500]
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { ProjectionGenerator } from "three-edge-projection/webgpu";
import { ParallelEdges } from "../server/parallel-edges.js";

globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const renderer = new THREE.WebGPURenderer({ canvas: { setAttribute() {}, getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {}, width: 1, height: 1 } });
await renderer.init();
const parallel = new ParallelEdges();
const seg = Number(Deno.args[0] || 500);
const scene = new THREE.Group();
const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, seg, seg), new THREE.MeshStandardMaterial());
sphere.rotation.set(0.31, 0.62, 0.19);
const occluder = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 3), new THREE.MeshStandardMaterial());
occluder.position.set(0.75, 2, 0);
scene.add(sphere, occluder);
scene.updateMatrixWorld(true);

function canonical(segments) {
  const array = segments.getLineGeometry().attributes.position.array;
  const lines = [];
  // BVH construction can reorder triangles and reverse segment directions.
  // Compare undirected geometry; path direction does not change the drawing.
  for (let i = 0; i < array.length; i += 6) {
    const a = Array.from(array.subarray(i, i + 3), n => n.toFixed(5)).join(",");
    const b = Array.from(array.subarray(i + 3, i + 6), n => n.toFixed(5)).join(",");
    lines.push([a, b].sort().join(";"));
  }
  return lines.sort();
}

try {
  for (const angle of [70, 180]) {
    let reference;
    for (const mode of ["serial", "parallel", "parallel-cached"]) {
      const gen = new ProjectionGenerator(renderer);
      gen.includeIntersectionEdges = false;
      gen.angleThreshold = angle;
      gen.batchSize = 1_000_000;
      const started = performance.now();
      const result = await gen.generate(scene, {
        onProgress: () => {},
        getEdges: mode === "serial" ? null : (scene, generator) => parallel.getEdges(scene, generator),
      });
      const ms = performance.now() - started;
      const lines = { visible: canonical(result.visibleEdges), hidden: canonical(result.hiddenEdges) };
      assert(lines.visible.length && lines.hidden.length, "fixture must exercise both visible and hidden linework");
      if (reference) assert(JSON.stringify(lines) === JSON.stringify(reference), `${mode} output differs at angle ${angle}`);
      else reference = lines;
      console.log(JSON.stringify({ mode, angle, triangles: sphere.geometry.index.count / 3, ms: Math.round(ms), workers: parallel.workers.length, rssMB: Math.round(Deno.memoryUsage().rss / 1e6), visible: lines.visible.length, hidden: lines.hidden.length }));
    }
  }
} finally {
  parallel.dispose();
  renderer.dispose();
}
