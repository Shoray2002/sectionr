// sectionr compute sidecar — runs the edge-projection pipeline headless in a
// full-RAM Deno process (the browser tab can't hold 10M-tri models). The Tauri
// frontend talks to this over localhost HTTP.
//
// Run: deno run -A --unstable-webgpu --v8-flags=--max-old-space-size=12000 server/main.js [port]
//
// Endpoints (all CORS-open, local only):
//   GET  /health          -> "ok"
//   POST /load   {path}    -> loads full-res model from disk, keeps it in RAM,
//                             returns a decimated display proxy (binary geometry)
//   POST /project {quaternion:[x,y,z,w], angleThreshold, includeIntersectionEdges}
//                          -> applies orientation, projects, returns line segments (binary)

import * as THREE from "three/webgpu";
import { ProjectionGenerator } from "three-edge-projection/webgpu";
import { GLTFLoader } from "../node_modules/three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "../node_modules/three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "../node_modules/three/examples/jsm/loaders/OBJLoader.js";
import { MeshoptDecoder } from "../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js";
import { mergeVertices, mergeGeometries } from "../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";

// three starts an internal rAF loop on init(); Deno has no rAF / DOM. Stub them.
// Fire ASAP (not at 16ms): the projection's nextFrame() yields between every compute
// job, and the browser is vsync-capped to 16ms per yield — firing immediately here
// makes the headless run *faster* than the browser, esp. on big multi-batch models.
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const PROXY_BUDGET = 200_000; // display proxy triangle budget

if (!navigator.gpu) {
  console.error("FATAL: navigator.gpu unavailable — run with --unstable-webgpu");
  Deno.exit(1);
}

// compute-only renderer: stub canvas so three never reaches for document
const stubCanvas = { setAttribute() {}, getContext: () => null, addEventListener() {}, removeEventListener() {}, style: {}, width: 1, height: 1 };
const renderer = new THREE.WebGPURenderer({ antialias: false, canvas: stubCanvas });
await renderer.init();

let fullRes = null; // currently loaded full-resolution Object3D

function disposeObject(obj) {
  obj?.traverse?.((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
}

// --- loading ---------------------------------------------------------------

async function parseModel(path) {
  if (path.startsWith("sphere:")) {
    // test hook: synthetic mesh, no file needed
    const seg = Number(path.slice(7)) || 200;
    return new THREE.Mesh(new THREE.SphereGeometry(1, seg, seg), new THREE.MeshStandardMaterial());
  }

  const bytes = await Deno.readFile(path);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ext = path.split(".").pop().toLowerCase();

  if (ext === "stl") {
    return new THREE.Mesh(new STLLoader().parse(ab), new THREE.MeshStandardMaterial());
  }
  if (ext === "obj") {
    return new OBJLoader().parse(new TextDecoder().decode(bytes));
  }
  if (ext === "glb" || ext === "gltf") {
    const loader = new GLTFLoader();
    await MeshoptDecoder.ready;
    loader.setMeshoptDecoder(MeshoptDecoder);
    return await new Promise((res, rej) => loader.parse(ab, "", (g) => res(g.scene), rej));
  }
  throw new Error(`unsupported format: .${ext}`);
}

function triangleCount(obj) {
  let n = 0;
  obj.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return n | 0;
}

// merge all meshes into one position-only geometry in world space
function mergedPositions(obj) {
  obj.updateMatrixWorld(true);
  const list = [];
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", g.getAttribute("position").clone());
    list.push(pg);
    g.dispose();
  });
  if (list.length === 0) throw new Error("model has no meshes");
  return list.length === 1 ? list[0] : mergeGeometries(list, false);
}

// build a decimated, welded, indexed proxy for display
async function buildProxy(obj) {
  let geo = mergeVertices(mergedPositions(obj));
  const tris = geo.index.count / 3;
  if (tris > PROXY_BUDGET) {
    await MeshoptSimplifier.ready;
    const verts = geo.attributes.position.array;
    const index = geo.index.array instanceof Uint32Array ? geo.index.array : new Uint32Array(geo.index.array);
    const target = Math.max(3, Math.floor((index.length * (PROXY_BUDGET / tris)) / 3) * 3);
    const [simp] = MeshoptSimplifier.simplify(index, verts, 3, target, 1.0, ["LockBorder"]);
    if (simp.length >= 3 && simp.length < index.length) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(simp), 1));
  }
  geo.computeVertexNormals();
  return geo;
}

// --- projection ------------------------------------------------------------

async function project(quat, { angleThreshold = 50, includeIntersectionEdges = false } = {}) {
  if (!fullRes) throw new Error("no model loaded");
  // fullRes is a pivot Group centered on the model; rotating it spins about the center.
  fullRes.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
  fullRes.updateMatrixWorld(true);

  const gen = new ProjectionGenerator(renderer);
  gen.includeIntersectionEdges = includeIntersectionEdges;
  gen.angleThreshold = angleThreshold;
  gen.batchSize = 1_000_000; // fewer GPU jobs/readbacks than the 100k default

  const result = await gen.generate(fullRes, { onProgress: () => {} });
  return {
    vis: result.visibleEdges.getLineGeometry().attributes.position.array,
    hid: result.hiddenEdges.getLineGeometry().attributes.position.array,
  };
}

// --- binary wire format ----------------------------------------------------
// proxy:   [u32 vertCount][u32 indexCount][f32 positions...][u32 index...]
// project: [u32 visFloats][u32 hidFloats][f32 vis...][f32 hid...]

function packProxy(geo) {
  const pos = geo.attributes.position.array;
  const idx = geo.index.array instanceof Uint32Array ? geo.index.array : new Uint32Array(geo.index.array);
  const out = new Uint8Array(8 + pos.byteLength + idx.byteLength);
  new Uint32Array(out.buffer, 0, 2).set([pos.length / 3, idx.length]);
  new Uint8Array(out.buffer, 8, pos.byteLength).set(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength));
  new Uint8Array(out.buffer, 8 + pos.byteLength, idx.byteLength).set(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength));
  return out;
}

function packProject(vis, hid) {
  const out = new Uint8Array(8 + vis.byteLength + hid.byteLength);
  new Uint32Array(out.buffer, 0, 2).set([vis.length, hid.length]);
  new Uint8Array(out.buffer, 8, vis.byteLength).set(new Uint8Array(vis.buffer, vis.byteOffset, vis.byteLength));
  new Uint8Array(out.buffer, 8 + vis.byteLength, hid.byteLength).set(new Uint8Array(hid.buffer, hid.byteOffset, hid.byteLength));
  return out;
}

// --- server ----------------------------------------------------------------

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
const port = Number(Deno.args[0]) || 8787;

Deno.serve({ port, hostname: "127.0.0.1", onListen: () => console.log(`sectionr sidecar on http://127.0.0.1:${port}`) }, async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const { pathname } = new URL(req.url);
  try {
    if (pathname === "/health") return new Response("ok", { headers: CORS });

    if (pathname === "/load" && req.method === "POST") {
      const { path } = await req.json();
      const t0 = performance.now();
      const obj = await parseModel(path);
      // center the model in a pivot Group so frontend rotation spins about its center
      // and the projected lines overlay the displayed proxy.
      obj.updateMatrixWorld(true);
      const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
      obj.position.sub(c);
      const pivot = new THREE.Group();
      pivot.add(obj);
      pivot.updateMatrixWorld(true);
      disposeObject(fullRes);
      fullRes = pivot;
      const tris = triangleCount(fullRes);
      const proxy = await buildProxy(fullRes);
      const ms = (performance.now() - t0).toFixed(0);
      console.log(`loaded ${path} — ${tris.toLocaleString()} tris, proxy ${proxy.index.count / 3 | 0} tris (${ms}ms)`);
      return new Response(packProxy(proxy), { headers: { ...CORS, "Content-Type": "application/octet-stream", "X-Full-Tris": String(tris) } });
    }

    if (pathname === "/project" && req.method === "POST") {
      const body = await req.json();
      const t0 = performance.now();
      const { vis, hid } = await project(body.quaternion ?? [0, 0, 0, 1], body);
      console.log(`projected — ${vis.length / 6 | 0} vis + ${hid.length / 6 | 0} hidden segs (${(performance.now() - t0).toFixed(0)}ms)`);
      return new Response(packProject(vis, hid), { headers: { ...CORS, "Content-Type": "application/octet-stream" } });
    }

    return new Response("not found", { status: 404, headers: CORS });
  } catch (e) {
    console.error(e);
    return new Response(String(e?.stack || e), { status: 500, headers: CORS });
  }
});
