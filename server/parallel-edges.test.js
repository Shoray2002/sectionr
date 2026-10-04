// deno run -A server/parallel-edges.test.js
import assert from "node:assert/strict";
import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh, SphereGeometry } from "three";
import { EdgeGenerator } from "../node_modules/three-edge-projection/src/EdgeGenerator.js";
import { ParallelEdges } from "./parallel-edges.js";

function canonical(edges) {
  return edges.map(e => [...e.start, ...e.end].map(n => n.toFixed(9)).join(",")).sort();
}

const parallel = new ParallelEdges(4);
try {
  const generator = new EdgeGenerator();
  // >50k triangles exercises actual workers, both indexed and STL-style data.
  for (const geometry of [new SphereGeometry(1, 180, 180), new BoxGeometry(2, 3, 4, 100, 100, 100).toNonIndexed(), new CylinderGeometry(1, 1, 2, 300, 100)]) {
    const mesh = new Mesh(geometry);
    mesh.rotation.set(0.3, 0.7, 0.2);
    mesh.scale.set(1.3, 0.9, -1.1);
    mesh.position.set(4, 7, 9);
    mesh.updateMatrixWorld(true);
    for (const threshold of [0, 50, 70, 180]) {
      generator.thresholdAngle = threshold;
      for (const silhouettes of [true, false]) {
        generator.silhouetteEdges = silhouettes;
        assert.deepEqual(canonical(await parallel.getEdges(mesh, generator)), canonical(generator.getEdges(mesh)), `${geometry.type}: angle ${threshold}, silhouettes ${silhouettes}`);
      }
    }
    // Rotation changes must use fresh transforms with cached shared geometry.
    mesh.rotation.x += 0.7;
    mesh.updateMatrixWorld(true);
    assert.deepEqual(canonical(await parallel.getEdges(mesh, generator)), canonical(generator.getEdges(mesh)));
  }
  const group = new Group();
  group.add(new Mesh(new BoxGeometry()), new Mesh(new SphereGeometry()));
  group.updateMatrixWorld(true);
  assert.deepEqual(canonical(await parallel.getEdges(group, generator)), canonical(generator.getEdges(group)));
  // Open, duplicated and non-manifold faces, plus vertices within the weld
  // tolerance. Each edge must keep the serial algorithm's triangle order.
  const faces = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0.000001, 0, 0, 0, 0, 0, 0, 1, 0];
  const positions = new Float32Array(60_000 * 9);
  for (let i = 0; i < positions.length; i++) positions[i] = faces[i % faces.length];
  const irregular = new Mesh(new BufferGeometry().setAttribute("position", new BufferAttribute(positions, 3)));
  irregular.updateMatrixWorld(true);
  generator.thresholdAngle = 50;
  generator.silhouetteEdges = true;
  assert.deepEqual(canonical(await parallel.getEdges(irregular, generator)), canonical(generator.getEdges(irregular)));
  console.log("parallel edges: worker results match serial extraction, including cached rotations and small-mesh fallback");
} finally {
  parallel.dispose();
}
