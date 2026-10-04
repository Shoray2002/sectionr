import { ProjectionEdge } from "../node_modules/three-edge-projection/src/utils/ProjectionEdge.js";
import { getAllMeshes } from "../node_modules/three-edge-projection/src/utils/getAllMeshes.js";

const MIN_TRIANGLES = 50_000;

function shared(Type, length) {
  return new Type(new SharedArrayBuffer(length * Type.BYTES_PER_ELEMENT));
}

// Keep opposite sides of every edge on the same worker. Splitting the triangle
// list alone would introduce false outlines along the partition boundaries.
function shardGeometry(geometry, count) {
  const position = geometry.getAttribute("position");
  const positions = shared(Float64Array, position.count * 3);
  const vertexIds = shared(Uint32Array, position.count);
  const ids = new Map();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
    // Match generateEdges' weld precision, including duplicated STL vertices.
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    vertexIds[i] = ids.get(key);
  }
  const index = geometry.index;
  const length = index ? index.count : position.count;
  const sizes = new Uint32Array(count);
  const masks = new Uint8Array(count);
  const corners = [0, 0, 0];
  const jobs = [];
  // Count first, then fill typed arrays; no large intermediate JS arrays.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < length; i += 3) {
      for (let j = 0; j < 3; j++) corners[j] = index ? index.getX(i + j) : i + j;
      masks.fill(0);
      for (let j = 0; j < 3; j++) {
        const a = vertexIds[corners[j]], b = vertexIds[corners[(j + 1) % 3]];
        const owner = ((Math.imul(Math.min(a, b), 73856093) ^ Math.imul(Math.max(a, b), 19349663)) >>> 0) % count;
        masks[owner] |= 1 << j;
      }
      for (let owner = 0; owner < count; owner++) {
        if (!masks[owner]) continue;
        const offset = sizes[owner]++;
        if (pass) {
          jobs[owner].index.set(corners, offset * 3);
          jobs[owner].edgeMasks[offset] = masks[owner];
        }
      }
    }
    if (!pass) {
      for (const size of sizes) jobs.push({ positions, vertexIds, index: shared(Uint32Array, size * 3), edgeMasks: shared(Uint8Array, size) });
      sizes.fill(0);
    }
  }
  return jobs;
}

export class ParallelEdges {
  constructor(workerCount = navigator.hardwareConcurrency || 1) {
    this.workerCount = Math.max(1, workerCount);
    this.workers = [];
    this.cache = new WeakMap();
  }

  dispose() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.cache = new WeakMap();
  }

  async getEdges(scene, generator) {
    const edges = [];
    for (const mesh of getAllMeshes(scene)) {
      const geometry = mesh.geometry;
      const triangles = (geometry.index?.count ?? geometry.attributes.position.count) / 3;
      const count = Math.min(this.workerCount, Math.ceil(triangles / MIN_TRIANGLES));
      if (count < 2) {
        generator.getEdges(mesh, edges);
        continue;
      }
      let jobs = this.cache.get(geometry);
      if (!jobs) {
        jobs = shardGeometry(geometry, count);
        this.cache.set(geometry, jobs);
      }
      const results = await Promise.all(jobs.map((job, i) => {
        const worker = this.workers[i] ??= new Worker(new URL("./edges.worker.js", import.meta.url).href, { type: "module" });
        return new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.lines);
          worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message)); };
          worker.postMessage({ ...job, matrix: mesh.matrixWorld.elements, thresholdAngle: generator.thresholdAngle, silhouetteEdges: generator.silhouetteEdges, yOffset: generator.yOffset });
        });
      }));
      for (const lines of results) {
        for (let i = 0; i < lines.length; i += 6) {
          const edge = new ProjectionEdge();
          edge.start.fromArray(lines, i); edge.end.fromArray(lines, i + 3);
          edge.mesh = mesh;
          edges.push(edge);
        }
      }
    }
    return edges;
  }
}
