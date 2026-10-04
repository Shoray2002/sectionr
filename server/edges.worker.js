import { BufferGeometry, BufferAttribute, Matrix4 } from "three";
import { generateEdges } from "../node_modules/three-edge-projection/src/utils/generateEdges.js";

self.onmessage = ({ data }) => {
  try {
    const { positions, index, vertexIds, edgeMasks, matrix, thresholdAngle, silhouetteEdges, yOffset } = data;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    const world = new Matrix4().fromArray(matrix);
    const edges = generateEdges(geometry, [], {
      matrix: world, thresholdAngle, silhouetteEdges, vertexIds, edgeMasks, iterationTime: Infinity,
    }).next().value;
    const lines = new Float64Array(edges.length * 6);
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      edge.start.applyMatrix4(world); edge.start.y += yOffset;
      edge.end.applyMatrix4(world); edge.end.y += yOffset;
      edge.start.toArray(lines, i * 6); edge.end.toArray(lines, i * 6 + 3);
    }
    self.postMessage({ lines }, [lines.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
