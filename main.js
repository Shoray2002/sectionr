// sectionr frontend — display only. All heavy lifting (loading full-res models,
// decimation, edge projection) runs in the Deno sidecar; this just shows a proxy
// to position, and previews the projected line segments the sidecar returns.
//
// Two panes: left = 3D positioning (drag rotates the MODEL, camera is fixed —
// no orbit). Right = flat projection preview, looking straight down the print
// plane. The projection is taken from the left view's camera plane, so what you
// compose is what you get.
import {
	Scene,
	WebGLRenderer,
	OrthographicCamera,
	Group,
	Mesh,
	MeshStandardMaterial,
	BufferGeometry,
	BufferAttribute,
	DirectionalLight,
	AmbientLight,
	Box3,
	Vector3,
	Quaternion,
} from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { sortPlotterCurves } from './plotter.js';
import { buildPolylines, simplifyPoly, fitPolyline, flattenCurves, curvesPath, cleanPlotterCurves } from './linework.js';

const API = 'http://127.0.0.1:8787';

// Maps the camera's view frame into the sidecar's "project down world +Y onto
// XZ" frame: view depth (Z) -> world Y (projection axis), view up (Y) -> world
// -Z. SVG uses +Z downward; the preview camera looks down +Y with -Z up.
// ponytail: if visible & hidden edges come out swapped, negate this angle.
const PROJ_SWAP = new Quaternion().setFromAxisAngle( new Vector3( 1, 0, 0 ), - Math.PI / 2 );

const params = {
	displayDrawThroughProjection: false,
	includeIntersectionEdges: false,
	smoothCurves: true, // fit visible strokes without changing surface visibility
	projectionStyle: 'plotter',
	angleThreshold: 50,
	visibilityCullMeshes: false,
	decimate: false,
	simplifyBudget: 200000,
	visibleColor: '#111111',
	hiddenColor: '#999999',
	strokeWidth: 0.3, // pen width in mm
	previewBg: '#f5f5f5',
	minLineFrac: 0.1,   // drop strokes shorter than this % of the print's longest side
	simplifyFrac: 0.06, // curve tolerance as % of longest side (0.18mm at 300mm)
	smooth: 0,          // Taubin smoothing passes in the sidecar (re-project to apply)
};

let needsRender = false, previewNeedsRender = false;
let renderer, camera, scene, group, model, gizmo, viewSize = 1, modelPath = null;
let rawVis = null, rawHid = null;          // last raw projected segments from the sidecar
let visCurves = [], hidCurves = [];
let visPolys = [], hidPolys = [], printBounds = null, maxDim = 1; // cleaned strokes (XZ)
let previewRenderer, previewCamera, previewScene, projection, drawThrough;
let view, preview, outputContainer;

init();

function init() {

	outputContainer = document.getElementById( 'output' );
	view = document.getElementById( 'view' );
	preview = document.getElementById( 'preview' );

	// --- positioning view (3D) ---
	renderer = new WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( view.clientWidth, view.clientHeight );
	renderer.setClearColor( 0x141414, 1 );
	view.appendChild( renderer.domElement );

	scene = new Scene();
	const light = new DirectionalLight( 0xffffff, 3.5 );
	light.position.set( 1, 2, 3 );
	scene.add( light, new AmbientLight( 0xb0bec5, 0.5 ) );

	group = new Group();
	scene.add( group );

	// camera fixed on +Z looking down -Z (identity orientation) — keeps the
	// arcball axes aligned with screen axes and the projection math trivial.
	// orthographic so the positioning view has no perspective distortion.
	camera = new OrthographicCamera( - 1, 1, 1, - 1, 0.01, 1e6 );
	camera.position.set( 0, 0, 5 );

	// rotation gimbal — attaches to the model group; rings give precise per-axis
	// orientation. Coexists with the arcball (arcball skips grabs on a gizmo ring).
	gizmo = new TransformControls( camera, renderer.domElement );
	gizmo.setMode( 'rotate' );
	gizmo.addEventListener( 'change', () => needsRender = true );
	scene.add( gizmo.getHelper() );

	// --- projection preview (flat, top-down ortho — white = paper) ---
	previewRenderer = new WebGLRenderer( { antialias: true } );
	previewRenderer.setPixelRatio( window.devicePixelRatio );
	previewRenderer.setSize( preview.clientWidth, preview.clientHeight );
	previewRenderer.setClearColor( params.previewBg, 1 );
	preview.appendChild( previewRenderer.domElement );

	previewScene = new Scene();
	projection = makeFatLine( params.visibleColor );
	drawThrough = makeFatLine( params.hiddenColor );
	previewScene.add( projection, drawThrough );

	previewCamera = new OrthographicCamera( - 1, 1, 1, - 1, 0.01, 1e7 );
	previewCamera.up.set( 0, 0, - 1 ); // world -Z is up; SVG +Z points down

	// zoom the projection preview with the wheel
	const pv = previewRenderer.domElement;
	pv.addEventListener( 'wheel', ( e ) => {

		e.preventDefault();
		previewCamera.zoom = Math.max( 0.2, previewCamera.zoom * ( 1 - e.deltaY * 0.001 ) );
		previewCamera.updateProjectionMatrix();
		updateLineWidth();

	}, { passive: false } );

	// drag to pan the preview (along the print plane: world X/Z), scaled by zoom
	let panning = false, px = 0, py = 0;
	pv.addEventListener( 'pointerdown', ( e ) => { panning = true; px = e.clientX; py = e.clientY; pv.setPointerCapture( e.pointerId ); } );
	pv.addEventListener( 'pointermove', ( e ) => {

		if ( ! panning ) return;
		const perPx = ( previewCamera.right - previewCamera.left ) / previewCamera.zoom / pv.clientWidth;
		previewCamera.position.x -= ( e.clientX - px ) * perPx;
		previewCamera.position.z -= ( e.clientY - py ) * perPx; // up=-Z, so screen-down -> +z
		px = e.clientX; py = e.clientY;
		previewNeedsRender = true;

	} );
	const endPan = () => panning = false;
	pv.addEventListener( 'pointerup', endPan );
	pv.addEventListener( 'pointercancel', endPan );

	bindUI();
	attachArcball();
	attachDivider();

	window.addEventListener( 'resize', resize );
	render();

}

function fmtBudget( v ) { return v >= 1e6 ? `${ ( v / 1e6 ).toFixed( 1 ) }M` : `${ ( v / 1000 ) | 0 }k`; }
function $( id ) { return document.getElementById( id ); }

// push every params value into its control + dependent display. Called on
// startup and after loading a config, so the UI always reflects params.
function syncUI() {

	for ( const id of [ 'displayDrawThroughProjection', 'includeIntersectionEdges', 'smoothCurves', 'visibilityCullMeshes', 'decimate' ] ) $( id ).checked = params[ id ];
	$( 'angleThreshold' ).value = params.angleThreshold;
	$( 'angleVal' ).textContent = params.angleThreshold;
	$( 'projectionStyle' ).value = params.projectionStyle;
	$( 'angleThreshold' ).disabled = params.projectionStyle !== 'detailed';
	$( 'includeIntersectionEdges' ).disabled = params.projectionStyle !== 'detailed';
	$( 'smooth' ).value = params.smooth;
	$( 'smoothVal' ).textContent = params.smooth;
	$( 'simplifyBudget' ).value = params.simplifyBudget;
	$( 'budgetVal' ).textContent = fmtBudget( params.simplifyBudget );
	$( 'visibleColor' ).value = params.visibleColor;
	$( 'hiddenColor' ).value = params.hiddenColor;
	projection.material.color.set( params.visibleColor );
	drawThrough.material.color.set( params.hiddenColor );
	$( 'strokeWidth' ).value = params.strokeWidth;
	$( 'widthVal' ).textContent = params.strokeWidth.toFixed( 2 );
	$( 'minLineFrac' ).value = params.minLineFrac;
	$( 'minLineVal' ).textContent = params.minLineFrac.toFixed( 1 );
	$( 'simplifyFrac' ).value = params.simplifyFrac;
	$( 'simplifyVal' ).textContent = params.simplifyFrac.toFixed( 2 );
	$( 'previewBg' ).value = params.previewBg;
	previewRenderer.setClearColor( params.previewBg, 1 );
	needsRender = previewNeedsRender = true;

}

function bindUI() {

	const bindCheck = ( id, onChange ) => $( id ).addEventListener( 'change', () => { params[ id ] = $( id ).checked; if ( onChange ) onChange(); } );

	bindCheck( 'displayDrawThroughProjection', () => previewNeedsRender = true );
	bindCheck( 'includeIntersectionEdges' );
	bindCheck( 'smoothCurves', () => rebuildLines() );
	bindCheck( 'visibilityCullMeshes' );
	bindCheck( 'decimate' );

	$( 'projectionStyle' ).addEventListener( 'change', ( e ) => {

		params.projectionStyle = e.target.value;
		$( 'angleThreshold' ).disabled = params.projectionStyle !== 'detailed';
		$( 'includeIntersectionEdges' ).disabled = params.projectionStyle !== 'detailed';

	} );
	$( 'angleThreshold' ).addEventListener( 'input', ( e ) => { params.angleThreshold = + e.target.value; $( 'angleVal' ).textContent = e.target.value; } );
	$( 'smooth' ).addEventListener( 'input', ( e ) => { params.smooth = + e.target.value; $( 'smoothVal' ).textContent = e.target.value; } );
	$( 'simplifyBudget' ).addEventListener( 'input', ( e ) => { params.simplifyBudget = + e.target.value; $( 'budgetVal' ).textContent = fmtBudget( params.simplifyBudget ); } );

	const bindColor = ( id, line ) => $( id ).addEventListener( 'input', ( e ) => { params[ id ] = e.target.value; line.material.color.set( e.target.value ); previewNeedsRender = true; } );
	bindColor( 'visibleColor', projection );
	bindColor( 'hiddenColor', drawThrough );

	$( 'strokeWidth' ).addEventListener( 'input', ( e ) => { params.strokeWidth = + e.target.value; $( 'widthVal' ).textContent = params.strokeWidth.toFixed( 2 ); updateLineWidth(); } );
	$( 'minLineFrac' ).addEventListener( 'input', ( e ) => { params.minLineFrac = + e.target.value; $( 'minLineVal' ).textContent = params.minLineFrac.toFixed( 1 ); rebuildLines(); } );
	$( 'simplifyFrac' ).addEventListener( 'input', ( e ) => { params.simplifyFrac = + e.target.value; $( 'simplifyVal' ).textContent = params.simplifyFrac.toFixed( 2 ); rebuildLines(); } );
	$( 'previewBg' ).addEventListener( 'change', ( e ) => { params.previewBg = e.target.value; previewRenderer.setClearColor( params.previewBg, 1 ); previewNeedsRender = true; } );

	$( 'open' ).addEventListener( 'click', openModel );
	$( 'reset' ).addEventListener( 'click', () => { if ( model ) { group.quaternion.identity(); needsRender = true; } } );

	// orientation snaps (absolute view) + flips (relative 180° turn about a world axis)
	const AX = new Vector3( 1, 0, 0 ), AY = new Vector3( 0, 1, 0 ), AZ = new Vector3( 0, 0, 1 ), _q = new Quaternion();
	const snap = ( fn ) => () => { if ( ! model ) return; fn(); needsRender = true; };
	$( 'snapFront' ).addEventListener( 'click', snap( () => group.quaternion.identity() ) );
	$( 'snapBack' ).addEventListener( 'click', snap( () => group.quaternion.setFromAxisAngle( AY, Math.PI ) ) );
	$( 'snapRight' ).addEventListener( 'click', snap( () => group.quaternion.setFromAxisAngle( AY, - Math.PI / 2 ) ) );
	$( 'snapLeft' ).addEventListener( 'click', snap( () => group.quaternion.setFromAxisAngle( AY, Math.PI / 2 ) ) );
	$( 'snapTop' ).addEventListener( 'click', snap( () => group.quaternion.setFromAxisAngle( AX, Math.PI / 2 ) ) );
	$( 'snapDown' ).addEventListener( 'click', snap( () => group.quaternion.setFromAxisAngle( AX, - Math.PI / 2 ) ) );
	const flip = ( axis ) => snap( () => group.quaternion.premultiply( _q.setFromAxisAngle( axis, Math.PI ) ) );
	$( 'flipX' ).addEventListener( 'click', flip( AX ) );
	$( 'flipY' ).addEventListener( 'click', flip( AY ) );
	$( 'flipZ' ).addEventListener( 'click', flip( AZ ) );
	$( 'regenerate' ).addEventListener( 'click', generate );
	$( 'downloadSVG' ).addEventListener( 'click', downloadSVG );
	$( 'saveConfig' ).addEventListener( 'click', saveConfig );
	$( 'loadConfig' ).addEventListener( 'click', loadConfig );

	syncUI();

}

// drag the middle divider to resize the two panes
function attachDivider() {

	const divider = document.getElementById( 'divider' );
	const app = document.getElementById( 'app' );
	let dragging = false;

	divider.addEventListener( 'pointerdown', ( e ) => { dragging = true; divider.setPointerCapture( e.pointerId ); e.preventDefault(); } );
	divider.addEventListener( 'pointermove', ( e ) => {

		if ( ! dragging ) return;
		const rect = app.getBoundingClientRect();
		const panelW = document.getElementById( 'panel' ).offsetWidth;
		const w = Math.max( 200, Math.min( e.clientX - rect.left, rect.width - panelW - 200 ) );
		view.style.flex = `0 0 ${ w }px`;
		resize();

	} );
	const stop = () => dragging = false;
	divider.addEventListener( 'pointerup', stop );
	divider.addEventListener( 'pointercancel', stop );

}

// --- arcball: drag rotates the model, camera stays put ----------------------

function attachArcball() {

	const el = renderer.domElement;
	let dragging = false;
	const startVec = new Vector3(), baseQuat = new Quaternion(), dq = new Quaternion();

	const sphere = ( e ) => {

		const r = el.getBoundingClientRect();
		const x = ( ( e.clientX - r.left ) / r.width ) * 2 - 1;
		const y = - ( ( ( e.clientY - r.top ) / r.height ) * 2 - 1 );
		const l2 = x * x + y * y;
		return new Vector3( x, y, l2 <= 1 ? Math.sqrt( 1 - l2 ) : 0 ).normalize();

	};

	el.addEventListener( 'pointerdown', ( e ) => {

		if ( ! model || gizmo.axis ) return; // gizmo.axis set => pointer is over a rotation ring
		dragging = true;
		startVec.copy( sphere( e ) );
		baseQuat.copy( group.quaternion );
		el.setPointerCapture( e.pointerId );

	} );
	el.addEventListener( 'pointermove', ( e ) => {

		if ( ! dragging ) return;
		dq.setFromUnitVectors( startVec, sphere( e ) );
		group.quaternion.copy( dq ).multiply( baseQuat );
		needsRender = true;

	} );
	const stop = () => dragging = false;
	el.addEventListener( 'pointerup', stop );
	el.addEventListener( 'pointercancel', stop );

	el.addEventListener( 'wheel', ( e ) => {

		e.preventDefault();
		camera.zoom = Math.max( 0.05, camera.zoom * ( 1 - e.deltaY * 0.001 ) );
		camera.updateProjectionMatrix();
		needsRender = true;

	}, { passive: false } );

}

// orientation to send the sidecar: the model as the camera sees it, remapped
// into the projection frame. camera is fixed, but read live so this still holds
// if the camera ever moves.
function viewportQuaternion() {

	const camInv = camera.quaternion.clone().invert();
	return PROJ_SWAP.clone().multiply( camInv ).multiply( group.quaternion );

}

// --- sidecar client --------------------------------------------------------

async function openModel() {

	const path = await open( { multiple: false, filters: [ { name: '3D model', extensions: [ 'glb', 'gltf', 'stl', 'obj' ] } ] } );
	if ( path ) await loadModelFromPath( path );

}

// load a model into the sidecar by path, show its proxy. Returns true on success.
async function loadModelFromPath( path ) {

	$( 'viewLoader' ).classList.add( 'on' );
	outputContainer.innerText = 'Loading…';
	try {

		let res;
		try {

			res = await fetch( `${ API }/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { path } ) } );

		} catch ( e ) {

			outputContainer.innerText = `Sidecar unreachable — is it running? (${ e.message })`;
			return false;

		}

		if ( ! res.ok ) { outputContainer.innerText = `Load failed: ${ await res.text() }`; return false; }

		const fullTris = Number( res.headers.get( 'X-Full-Tris' ) ) || 0;
		setModel( decodeProxy( await res.arrayBuffer() ) );
		rawVis = rawHid = null;
		modelPath = path;
		$( 'downloadSVG' ).disabled = true;
		outputContainer.innerText = `Loaded ${ fullTris.toLocaleString() } tris — position, then Generate projection`;
		return true;

	} finally {

		$( 'viewLoader' ).classList.remove( 'on' );

	}

}

// --- config: save/restore the full setup (model + orientation + all dials) ---

async function saveConfig() {

	if ( ! model || ! modelPath ) { outputContainer.innerText = 'Load a model first'; return; }

	const config = { modelPath, quaternion: group.quaternion.toArray(), params };
	const path = await save( { defaultPath: 'sectionr-config.json', filters: [ { name: 'Config', extensions: [ 'json' ] } ] } );
	if ( ! path ) return;
	try {

		await invoke( 'save_svg', { path, content: JSON.stringify( config, null, 2 ) } );
		outputContainer.innerText = `Saved config ${ path }`;

	} catch ( e ) {

		outputContainer.innerText = `Save failed: ${ e }`;

	}

}

async function loadConfig() {

	const path = await open( { multiple: false, filters: [ { name: 'Config', extensions: [ 'json' ] } ] } );
	if ( ! path ) return;

	let config;
	try {

		config = JSON.parse( await invoke( 'read_file', { path } ) );

	} catch ( e ) {

		outputContainer.innerText = `Bad config: ${ e }`;
		return;

	}

	if ( ! await loadModelFromPath( config.modelPath ) ) return; // resets group.quaternion to identity

	Object.assign( params, config.params || {} );
	syncUI();
	if ( config.quaternion ) group.quaternion.fromArray( config.quaternion );
	needsRender = true;
	generate(); // recreate the projection from the restored setup

}

async function generate() {

	if ( ! model ) return;

	const btn = document.getElementById( 'regenerate' );
	btn.disabled = true;
	$( 'previewLoader' ).classList.add( 'on' );
	outputContainer.innerText = 'Projecting…';

	const q = viewportQuaternion();
	try {

		const res = await fetch( `${ API }/project`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( {
				quaternion: [ q.x, q.y, q.z, q.w ],
				projectionStyle: params.projectionStyle,
				angleThreshold: params.angleThreshold,
				includeIntersectionEdges: params.includeIntersectionEdges,
				visibilityCull: params.visibilityCullMeshes,
				simplifyBudget: params.decimate ? params.simplifyBudget : 0,
				smooth: params.smooth,
			} ),
		} );

		if ( ! res.ok ) { outputContainer.innerText = `Projection failed: ${ await res.text() }`; return; }

		const fitPreview = rawVis === null;
		const { vis, hid } = decodeProject( await res.arrayBuffer() );
		rawVis = vis; rawHid = hid;
		rebuildLines( fitPreview ); // dedupe + stitch + speckle-filter, then draw
		outputContainer.innerText = `${ visPolys.length } visible + ${ hidPolys.length } hidden strokes`;

	} catch ( e ) {

		outputContainer.innerText = `Projection error: ${ e.message }`;

	} finally {

		btn.disabled = false;
		$( 'previewLoader' ).classList.remove( 'on' );

	}

}

// proxy: [u32 vertCount][u32 indexCount][f32 positions][u32 index]
function decodeProxy( buf ) {

	const dv = new DataView( buf );
	const vertCount = dv.getUint32( 0, true );
	const indexCount = dv.getUint32( 4, true );
	const pos = new Float32Array( buf, 8, vertCount * 3 ).slice();
	const idx = new Uint32Array( buf, 8 + vertCount * 12, indexCount ).slice();
	const g = new BufferGeometry();
	g.setAttribute( 'position', new BufferAttribute( pos, 3 ) );
	g.setIndex( new BufferAttribute( idx, 1 ) );
	g.computeVertexNormals();
	return g;

}

// project: [u32 visFloats][u32 hidFloats][f32 vis][f32 hid]
function decodeProject( buf ) {

	const dv = new DataView( buf );
	const visLen = dv.getUint32( 0, true );
	const hidLen = dv.getUint32( 4, true );
	return {
		vis: new Float32Array( buf, 8, visLen ).slice(),
		hid: new Float32Array( buf, 8 + visLen * 4, hidLen ).slice(),
	};

}

// --- line cleanup: dedupe duplicate edges, stitch into polylines, drop specks ---

function makeFatLine( color ) {

	const mat = new LineMaterial( { linewidth: 1, alphaToCoverage: true } );
	mat.color.set( color );
	mat.resolution.set( preview.clientWidth, preview.clientHeight );
	return new LineSegments2( new LineSegmentsGeometry(), mat );

}

// XZ bounds of a raw segment array (points are (x,y,z), step 3)
function rawBoundsXZ( arr ) {

	let minX = Infinity, minZ = Infinity, maxX = - Infinity, maxZ = - Infinity;
	for ( let i = 0; i < arr.length; i += 3 ) {

		const x = arr[ i ], z = arr[ i + 2 ];
		if ( x < minX ) minX = x; if ( z < minZ ) minZ = z;
		if ( x > maxX ) maxX = x; if ( z > maxZ ) maxZ = z;

	}

	return { minX, minZ, maxX, maxZ };

}

function polyBoundsXZ( polys ) {

	let minX = Infinity, minZ = Infinity, maxX = - Infinity, maxZ = - Infinity;
	for ( const p of polys ) for ( let i = 0; i < p.length; i += 2 ) {

		if ( p[ i ] < minX ) minX = p[ i ]; if ( p[ i ] > maxX ) maxX = p[ i ];
		if ( p[ i + 1 ] < minZ ) minZ = p[ i + 1 ]; if ( p[ i + 1 ] > maxZ ) maxZ = p[ i + 1 ];

	}

	return isFinite( minX ) ? { minX, minZ, maxX, maxZ } : null;

}

// flatten polylines to segment endpoint pairs in the XZ plane: [x,0,z, x,0,z, ...]
function polysToSegments( polys ) {

	const out = [];
	for ( const p of polys ) for ( let i = 0; i < p.length - 2; i += 2 ) out.push( p[ i ], 0, p[ i + 1 ], p[ i + 2 ], 0, p[ i + 3 ] );
	return out;

}

function setFatLines( obj, polys ) {

	const seg = polysToSegments( polys );
	const g = new LineSegmentsGeometry();
	if ( seg.length ) g.setPositions( seg );
	obj.geometry.dispose();
	obj.geometry = g;

}

// Screen-space strokes avoid world-unit shader precision artifacts on thin lines.
// Convert the physical pen width through the orthographic camera, including zoom.
function updateLineWidth() {

	const pixelsPerUnit = preview.clientHeight * previewCamera.zoom / ( previewCamera.top - previewCamera.bottom );
	const lw = params.strokeWidth * maxDim / 300 * pixelsPerUnit;
	projection.material.linewidth = lw;
	drawThrough.material.linewidth = lw;
	previewNeedsRender = true;

}

// reprocess the last raw projection with the current cleanup params (no server round-trip)
function rebuildLines( fitPreview = true ) {

	if ( ! rawVis ) return;
	const b = rawBoundsXZ( rawVis );
	const rawMaxDim = Math.max( b.maxX - b.minX, b.maxZ - b.minZ ) || 1;
	const eps = rawMaxDim * 1e-4; // 0.03mm at the standard 300mm print size
	const minLen = rawMaxDim * params.minLineFrac / 100;
	const tolerance = rawMaxDim * params.simplifyFrac / 100;
	const prepare = raw => sortPlotterCurves( cleanPlotterCurves( buildPolylines( raw, eps, minLen ).map( p =>
		simplifyPoly( p, ( tolerance * ( params.smoothCurves ? 0.25 : 1 ) ) ** 2 )
	).map( p => fitPolyline( p, params.smoothCurves ? tolerance * 0.75 : 0 ) ), rawMaxDim * 1e-9 ) );
	visCurves = prepare( rawVis );
	hidCurves = prepare( rawHid );
	visPolys = visCurves.map( c => flattenCurves( c, rawMaxDim / 300 * 0.01 ) );
	hidPolys = hidCurves.map( c => flattenCurves( c, rawMaxDim / 300 * 0.01 ) );
	setFatLines( projection, visPolys );
	setFatLines( drawThrough, hidPolys );
	printBounds = polyBoundsXZ( visPolys.length ? visPolys : hidPolys );
	maxDim = printBounds ? Math.max( printBounds.maxX - printBounds.minX, printBounds.maxZ - printBounds.minZ ) || 1 : 1;
	updateLineWidth();
	if ( fitPreview ) framePreview();
	$( 'downloadSVG' ).disabled = visPolys.length === 0;

}

function setModel( geo ) {

	if ( model ) { group.remove( model ); model.geometry.dispose(); }
	model = new Mesh( geo, new MeshStandardMaterial( { color: 0xbfc4cc, flatShading: true } ) );
	group.quaternion.identity();
	group.add( model );
	gizmo.attach( group );

	// model is already centered server-side; frame the ortho camera to its size
	const size = new Box3().setFromObject( model ).getSize( new Vector3() ).length() || 5;
	viewSize = size * 0.6;
	camera.position.set( 0, 0, size * 2 );
	camera.near = 0.01;
	camera.far = size * 10;
	camera.zoom = 1;
	frameMainCamera();
	needsRender = true;

}

// fit the ortho preview camera to the cleaned stroke bounds (in the XZ print plane)
function framePreview() {

	previewNeedsRender = true;
	if ( ! printBounds ) return;
	const { minX, minZ, maxX, maxZ } = printBounds;

	const cx = ( minX + maxX ) / 2, cz = ( minZ + maxZ ) / 2;
	const w = ( maxX - minX ) || 1, h = ( maxZ - minZ ) || 1;
	const aspect = previewRenderer.domElement.clientWidth / previewRenderer.domElement.clientHeight || 1;
	let halfW = w / 2 * 1.1, halfH = h / 2 * 1.1;
	if ( halfW / halfH < aspect ) halfW = halfH * aspect; else halfH = halfW / aspect;

	previewCamera.left = - halfW; previewCamera.right = halfW;
	previewCamera.top = halfH; previewCamera.bottom = - halfH;
	previewCamera.zoom = 1; // a fresh fit resets any wheel zoom
	previewCamera.position.set( cx, Math.max( w, h ) * 2 + 10, cz );
	previewCamera.lookAt( cx, 0, cz );
	previewCamera.updateProjectionMatrix();
	updateLineWidth();

}

// fit the main ortho frustum to viewSize and the current view aspect
function frameMainCamera() {

	const aspect = view.clientWidth / view.clientHeight || 1;
	camera.left = - viewSize * aspect; camera.right = viewSize * aspect;
	camera.top = viewSize; camera.bottom = - viewSize;
	camera.updateProjectionMatrix();

}

function resize() {

	frameMainCamera();
	renderer.setSize( view.clientWidth, view.clientHeight );
	previewRenderer.setSize( preview.clientWidth, preview.clientHeight );
	projection.material.resolution.set( preview.clientWidth, preview.clientHeight );
	drawThrough.material.resolution.set( preview.clientWidth, preview.clientHeight );
	framePreview();
	needsRender = true;

}

// --- SVG export (the same fitted curves shown in the preview) ---
async function downloadSVG() {

	if ( ! visPolys.length ) return;
	const exportHidden = params.displayDrawThroughProjection && hidPolys.length > 0;

	// paper-space bounds: sx = x, sy = z (matches the preview)
	const all = exportHidden ? visPolys.concat( hidPolys ) : visPolys;
	let minSx = Infinity, minSy = Infinity, maxSx = - Infinity, maxSy = - Infinity;
	for ( const p of all ) for ( let i = 0; i < p.length; i += 2 ) {

		const sx = p[ i ], sy = p[ i + 1 ];
		if ( sx < minSx ) minSx = sx; if ( sx > maxSx ) maxSx = sx;
		if ( sy < minSy ) minSy = sy; if ( sy > maxSy ) maxSy = sy;

	}

	const w = maxSx - minSx, h = maxSy - minSy;
	if ( ! isFinite( w ) || w <= 0 || h <= 0 ) return;

	const mm = 300 / Math.max( w, h );        // model units -> mm on paper
	const stroke = params.strokeWidth / mm;    // pen width (mm) -> viewBox units
	const cap = ' stroke-linecap="round" stroke-linejoin="round"';

	const visPath = `<path d="${ curvesPath( visCurves, minSx, minSy ) }" fill="none" stroke="${ params.visibleColor }" stroke-width="${ stroke.toFixed( 5 ) }"${ cap }/>`;
	const hidPath = exportHidden ? `\n  <path d="${ curvesPath( hidCurves, minSx, minSy ) }" fill="none" stroke="${ params.hiddenColor }" stroke-width="${ stroke.toFixed( 5 ) }"${ cap }/>` : '';

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ ( w * mm ).toFixed( 2 ) }mm" height="${ ( h * mm ).toFixed( 2 ) }mm" viewBox="0 0 ${ w.toFixed( 4 ) } ${ h.toFixed( 4 ) }">
  ${ visPath }${ hidPath }
</svg>`;

	// WKWebView ignores <a download> blob saves — use Tauri's native save dialog + write.
	const path = await save( { defaultPath: 'projection.svg', filters: [ { name: 'SVG', extensions: [ 'svg' ] } ] } );
	if ( ! path ) return;
	try {

		await invoke( 'save_svg', { path, content: svg } );
		outputContainer.innerText = `Saved ${ path }`;

	} catch ( e ) {

		outputContainer.innerText = `Save failed: ${ e }`;

	}

}

function render() {

	requestAnimationFrame( render );

	if ( needsRender ) { renderer.render( scene, camera ); needsRender = false; }

	drawThrough.visible = params.displayDrawThroughProjection;
	if ( previewNeedsRender ) { previewRenderer.render( previewScene, previewCamera ); previewNeedsRender = false; }

}
