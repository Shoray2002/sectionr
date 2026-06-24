// Main-thread DRACOLoader shim for the headless Deno sidecar.
//
// three's stock DRACOLoader decodes in a *classic blob Worker*, which Deno
// doesn't support. So we instantiate three's bundled Draco wasm directly on the
// main thread (fed `wasmBinary` so there's no fetch either) and expose the
// preload()/decodeDracoFile() interface GLTFLoader expects.
//
// The decode functions below are copied verbatim from three's DRACOLoader worker
// body (examples/jsm/loaders/DRACOLoader.js) — same code, just run inline.
import * as THREE from "three/webgpu";
import { createRequire } from "node:module";
import process from "node:process";

const DRACO_DIR = new URL("../node_modules/three/examples/jsm/libs/draco/", import.meta.url);

let dracoPromise = null;
function getDraco() {
  if (!dracoPromise) {
    dracoPromise = (async () => {
      const require = createRequire(import.meta.url);
      const src = await Deno.readTextFile(new URL("draco_wasm_wrapper.js", DRACO_DIR));
      const wasmBinary = await Deno.readFile(new URL("draco_decoder.wasm", DRACO_DIR));
      const mod = { exports: {} };
      const factory = new Function("require", "module", "exports", "process", "__dirname", "__filename", src + "\nreturn DracoDecoderModule;");
      const DracoDecoderModule = factory(require, mod, mod.exports, process, ".", "draco_wasm_wrapper.js");
      return await DracoDecoderModule({ wasmBinary });
    })();
  }
  return dracoPromise;
}

export function makeDracoLoader() {
  return {
    preload() { getDraco(); return this; },
    async decodeDracoFile(buffer, callback, attributeIDs, attributeTypes, vertexColorSpace = THREE.LinearSRGBColorSpace, onError = () => {}) {
      try {
        const draco = await getDraco();
        const decoder = new draco.Decoder();
        const taskConfig = {
          attributeIDs,
          attributeTypes,
          useUniqueIDs: !!attributeIDs,
          vertexColorSpace,
        };
        const geometryData = decodeGeometry(draco, decoder, new Int8Array(buffer), taskConfig);
        draco.destroy(decoder);
        callback(createGeometry(geometryData));
      } catch (e) {
        onError(e);
      }
    },
  };
}

// --- below: verbatim from three's DRACOLoader worker body ------------------

function decodeGeometry(draco, decoder, array, taskConfig) {
  const attributeIDs = taskConfig.attributeIDs;
  const attributeTypes = taskConfig.attributeTypes;

  let dracoGeometry;
  let decodingStatus;
  const geometryType = decoder.GetEncodedGeometryType(array);

  if (geometryType === draco.TRIANGULAR_MESH) {
    dracoGeometry = new draco.Mesh();
    decodingStatus = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
  } else if (geometryType === draco.POINT_CLOUD) {
    dracoGeometry = new draco.PointCloud();
    decodingStatus = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
  } else {
    throw new Error("THREE.DRACOLoader: Unexpected geometry type.");
  }

  if (!decodingStatus.ok() || dracoGeometry.ptr === 0) {
    throw new Error("THREE.DRACOLoader: Decoding failed: " + decodingStatus.error_msg());
  }

  const geometry = { index: null, attributes: [] };

  for (const attributeName in attributeIDs) {
    const attributeType = globalThis[attributeTypes[attributeName]];
    let attribute;
    let attributeID;

    if (taskConfig.useUniqueIDs) {
      attributeID = attributeIDs[attributeName];
      attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attributeID);
    } else {
      attributeID = decoder.GetAttributeId(dracoGeometry, draco[attributeIDs[attributeName]]);
      if (attributeID === -1) continue;
      attribute = decoder.GetAttribute(dracoGeometry, attributeID);
    }

    const attributeResult = decodeAttribute(draco, decoder, dracoGeometry, attributeName, attributeType, attribute);
    if (attributeName === "color") attributeResult.vertexColorSpace = taskConfig.vertexColorSpace;
    geometry.attributes.push(attributeResult);
  }

  if (geometryType === draco.TRIANGULAR_MESH) {
    geometry.index = decodeIndex(draco, decoder, dracoGeometry);
  }

  draco.destroy(dracoGeometry);
  return geometry;
}

function decodeIndex(draco, decoder, dracoGeometry) {
  const numFaces = dracoGeometry.num_faces();
  const numIndices = numFaces * 3;
  const byteLength = numIndices * 4;
  const ptr = draco._malloc(byteLength);
  decoder.GetTrianglesUInt32Array(dracoGeometry, byteLength, ptr);
  const index = new Uint32Array(draco.HEAPF32.buffer, ptr, numIndices).slice();
  draco._free(ptr);
  return { array: index, itemSize: 1 };
}

function decodeAttribute(draco, decoder, dracoGeometry, attributeName, TypedArray, attribute) {
  const count = dracoGeometry.num_points();
  const itemSize = attribute.num_components();
  const dracoDataType = getDracoDataType(draco, TypedArray);

  const srcByteStride = itemSize * TypedArray.BYTES_PER_ELEMENT;
  const dstByteStride = Math.ceil(srcByteStride / 4) * 4;
  const dstStride = dstByteStride / TypedArray.BYTES_PER_ELEMENT;
  const srcByteLength = count * srcByteStride;

  const ptr = draco._malloc(srcByteLength);
  decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attribute, dracoDataType, srcByteLength, ptr);
  const srcArray = new TypedArray(draco.HEAPF32.buffer, ptr, srcByteLength / TypedArray.BYTES_PER_ELEMENT);

  let dstArray;
  if (srcByteStride === dstByteStride) {
    dstArray = srcArray.slice();
  } else {
    const dstByteLength = count * dstByteStride;
    dstArray = new TypedArray(dstByteLength / TypedArray.BYTES_PER_ELEMENT);
    let dstOffset = 0;
    for (let i = 0, il = srcArray.length; i < il; i++) {
      for (let j = 0; j < itemSize; j++) dstArray[dstOffset + j] = srcArray[i * itemSize + j];
      dstOffset += dstStride;
    }
  }

  draco._free(ptr);
  return { name: attributeName, count, itemSize, array: dstArray, stride: dstStride };
}

function getDracoDataType(draco, TypedArray) {
  switch (TypedArray) {
    case Float32Array: return draco.DT_FLOAT32;
    case Int8Array: return draco.DT_INT8;
    case Int16Array: return draco.DT_INT16;
    case Int32Array: return draco.DT_INT32;
    case Uint8Array: return draco.DT_UINT8;
    case Uint16Array: return draco.DT_UINT16;
    case Uint32Array: return draco.DT_UINT32;
  }
}

function createGeometry(geometryData) {
  const geometry = new THREE.BufferGeometry();
  if (geometryData.index) geometry.setIndex(new THREE.BufferAttribute(geometryData.index.array, 1));

  for (let i = 0; i < geometryData.attributes.length; i++) {
    const { name, array, itemSize, stride } = geometryData.attributes[i];
    let attribute;
    if (itemSize === stride) {
      attribute = new THREE.BufferAttribute(array, itemSize);
    } else {
      const buffer = new THREE.InterleavedBuffer(array, stride);
      attribute = new THREE.InterleavedBufferAttribute(buffer, itemSize, 0);
    }
    geometry.setAttribute(name, attribute);
  }
  return geometry;
}
