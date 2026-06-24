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
	Float32BufferAttribute,
	LineSegments,
	LineBasicMaterial,
	DirectionalLight,
	AmbientLight,
	Box3,
	Vector3,
	Quaternion,
} from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { open, save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const API = 'http://127.0.0.1:8787';

// Maps the camera's view frame into the sidecar's "project down world +Y onto
// XZ" frame: view depth (Z) -> world Y (projection axis), view up (Y) -> world
// -Z. With the SVG export / preview flipping Z back, the print matches the view.
// ponytail: if visible & hidden edges come out swapped, negate this angle.
const PROJ_SWAP = new Quaternion().setFromAxisAngle( new Vector3( 1, 0, 0 ), - Math.PI / 2 );

const params = {
	displayModel: true,
	displayDrawThroughProjection: false,
	includeIntersectionEdges: false,
	angleThreshold: 50,
	visibilityCullMeshes: false,
	decimate: false,
	simplifyBudget: 200000,
	visibleColor: '#111111',
	hiddenColor: '#999999',
	strokeWidth: 0.3, // pen width in mm
	previewBg: '#f5f5f5',
};

let needsRender = false, previewNeedsRender = false;
let renderer, camera, scene, group, model, gizmo, viewSize = 1, modelPath = null;
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
	projection = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { color: params.visibleColor } ) );
	drawThrough = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { color: params.hiddenColor } ) );
	previewScene.add( projection, drawThrough );

	previewCamera = new OrthographicCamera( - 1, 1, 1, - 1, 0.01, 1e7 );
	previewCamera.up.set( 0, 0, - 1 ); // world -Z is "up" in the print, matching the SVG y = -z

	// zoom the projection preview with the wheel
	const pv = previewRenderer.domElement;
	pv.addEventListener( 'wheel', ( e ) => {

		e.preventDefault();
		previewCamera.zoom = Math.max( 0.2, previewCamera.zoom * ( 1 - e.deltaY * 0.001 ) );
		previewCamera.updateProjectionMatrix();
		previewNeedsRender = true;

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

	window.addEventListener( 'resize', resize );
	render();

}

function fmtBudget( v ) { return v >= 1e6 ? `${ ( v / 1e6 ).toFixed( 1 ) }M` : `${ ( v / 1000 ) | 0 }k`; }
function $( id ) { return document.getElementById( id ); }

// push every params value into its control + dependent display. Called on
// startup and after loading a config, so the UI always reflects params.
function syncUI() {

	for ( const id of [ 'displayModel', 'displayDrawThroughProjection', 'includeIntersectionEdges', 'visibilityCullMeshes', 'decimate' ] ) $( id ).checked = params[ id ];
	$( 'angleThreshold' ).value = params.angleThreshold;
	$( 'angleVal' ).textContent = params.angleThreshold;
	$( 'simplifyBudget' ).value = params.simplifyBudget;
	$( 'budgetVal' ).textContent = fmtBudget( params.simplifyBudget );
	$( 'visibleColor' ).value = params.visibleColor;
	$( 'hiddenColor' ).value = params.hiddenColor;
	projection.material.color.set( params.visibleColor );
	drawThrough.material.color.set( params.hiddenColor );
	$( 'strokeWidth' ).value = params.strokeWidth;
	$( 'widthVal' ).textContent = params.strokeWidth.toFixed( 2 );
	$( 'previewBg' ).value = params.previewBg;
	previewRenderer.setClearColor( params.previewBg, 1 );
	needsRender = previewNeedsRender = true;

}

function bindUI() {

	const bindCheck = ( id, onChange ) => $( id ).addEventListener( 'change', () => { params[ id ] = $( id ).checked; if ( onChange ) onChange(); } );

	bindCheck( 'displayModel', () => needsRender = true );
	bindCheck( 'displayDrawThroughProjection', () => previewNeedsRender = true );
	bindCheck( 'includeIntersectionEdges' );
	bindCheck( 'visibilityCullMeshes' );
	bindCheck( 'decimate' );

	$( 'angleThreshold' ).addEventListener( 'input', ( e ) => { params.angleThreshold = + e.target.value; $( 'angleVal' ).textContent = e.target.value; } );
	$( 'simplifyBudget' ).addEventListener( 'input', ( e ) => { params.simplifyBudget = + e.target.value; $( 'budgetVal' ).textContent = fmtBudget( params.simplifyBudget ); } );

	const bindColor = ( id, line ) => $( id ).addEventListener( 'input', ( e ) => { params[ id ] = e.target.value; line.material.color.set( e.target.value ); previewNeedsRender = true; } );
	bindColor( 'visibleColor', projection );
	bindColor( 'hiddenColor', drawThrough );

	$( 'strokeWidth' ).addEventListener( 'input', ( e ) => { params.strokeWidth = + e.target.value; $( 'widthVal' ).textContent = params.strokeWidth.toFixed( 2 ); } );
	$( 'previewBg' ).addEventListener( 'change', ( e ) => { params.previewBg = e.target.value; previewRenderer.setClearColor( params.previewBg, 1 ); previewNeedsRender = true; } );

	$( 'open' ).addEventListener( 'click', openModel );
	$( 'reset' ).addEventListener( 'click', () => { if ( model ) { group.quaternion.identity(); needsRender = true; } } );
	$( 'regenerate' ).addEventListener( 'click', generate );
	$( 'downloadSVG' ).addEventListener( 'click', downloadSVG );
	$( 'saveConfig' ).addEventListener( 'click', saveConfig );
	$( 'loadConfig' ).addEventListener( 'click', loadConfig );

	syncUI();

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

	outputContainer.innerText = 'Loading…';
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
	modelPath = path;
	$( 'downloadSVG' ).disabled = true;
	outputContainer.innerText = `Loaded ${ fullTris.toLocaleString() } tris — position, then Generate projection`;
	return true;

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
	outputContainer.innerText = 'Projecting…';

	const q = viewportQuaternion();
	try {

		const res = await fetch( `${ API }/project`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( {
				quaternion: [ q.x, q.y, q.z, q.w ],
				angleThreshold: params.angleThreshold,
				includeIntersectionEdges: params.includeIntersectionEdges,
				visibilityCull: params.visibilityCullMeshes,
				simplifyBudget: params.decimate ? params.simplifyBudget : 0,
			} ),
		} );

		if ( ! res.ok ) { outputContainer.innerText = `Projection failed: ${ await res.text() }`; return; }

		const { vis, hid } = decodeProject( await res.arrayBuffer() );
		setLines( projection, vis );
		setLines( drawThrough, hid );
		framePreview();
		document.getElementById( 'downloadSVG' ).disabled = vis.length === 0;
		outputContainer.innerText = `${ vis.length / 6 | 0 } visible + ${ hid.length / 6 | 0 } hidden segments`;

	} catch ( e ) {

		outputContainer.innerText = `Projection error: ${ e.message }`;

	} finally {

		btn.disabled = false;

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

function setLines( obj, arr ) {

	obj.geometry.dispose();
	const g = new BufferGeometry();
	g.setAttribute( 'position', new Float32BufferAttribute( arr, 3 ) );
	obj.geometry = g;

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

// fit the ortho preview camera to the projected line bounds (in the XZ print plane)
function framePreview() {

	const p = projection.geometry.attributes.position;
	previewNeedsRender = true;
	if ( ! p || p.count === 0 ) return;

	let minX = Infinity, minZ = Infinity, maxX = - Infinity, maxZ = - Infinity;
	for ( let i = 0; i < p.count; i ++ ) {

		const x = p.getX( i ), z = p.getZ( i );
		if ( x < minX ) minX = x; if ( z < minZ ) minZ = z;
		if ( x > maxX ) maxX = x; if ( z > maxZ ) maxZ = z;

	}

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
	framePreview();
	needsRender = true;

}

// accumulate the XZ-plane bounds of a line position attribute (z flipped so the
// top-down print isn't mirrored). b = { minX, minY, maxX, maxY }.
function accumulateBounds( p, b ) {

	for ( let i = 0; i < p.count; i ++ ) {

		const x = p.getX( i ), y = - p.getZ( i );
		if ( x < b.minX ) b.minX = x; if ( y < b.minY ) b.minY = y;
		if ( x > b.maxX ) b.maxX = x; if ( y > b.maxY ) b.maxY = y;

	}

}

function pathData( p, minX, minY, minLen2 ) {

	let d = '';
	for ( let i = 0; i < p.count; i += 2 ) {

		const ax = p.getX( i ) - minX, ay = - p.getZ( i ) - minY;
		const bx = p.getX( i + 1 ) - minX, by = - p.getZ( i + 1 ) - minY;
		if ( ( bx - ax ) ** 2 + ( by - ay ) ** 2 < minLen2 ) continue;
		d += `M${ ax.toFixed( 4 ) } ${ ay.toFixed( 4 ) }L${ bx.toFixed( 4 ) } ${ by.toFixed( 4 ) }`;

	}

	return d;

}

// --- SVG export (lines lie on XZ plane, y=0; flip z so top-down isn't mirrored) ---
async function downloadSVG() {

	const vis = projection.geometry.attributes.position;
	if ( ! vis || vis.count === 0 ) return;
	const hid = drawThrough.geometry.attributes.position;
	const exportHidden = params.displayDrawThroughProjection && hid && hid.count > 0;

	const b = { minX: Infinity, minY: Infinity, maxX: - Infinity, maxY: - Infinity };
	accumulateBounds( vis, b );
	if ( exportHidden ) accumulateBounds( hid, b );

	const w = b.maxX - b.minX, h = b.maxY - b.minY;
	if ( ! isFinite( w ) || w <= 0 || h <= 0 ) return;

	const mm = 300 / Math.max( w, h );        // model units -> mm on paper
	const stroke = params.strokeWidth / mm;    // pen width (mm) -> viewBox units
	const minLen2 = ( Math.max( w, h ) * 1e-4 ) ** 2;

	const visPath = `<path d="${ pathData( vis, b.minX, b.minY, minLen2 ) }" fill="none" stroke="${ params.visibleColor }" stroke-width="${ stroke.toFixed( 5 ) }" stroke-linecap="butt"/>`;
	const hidPath = exportHidden ? `\n  <path d="${ pathData( hid, b.minX, b.minY, minLen2 ) }" fill="none" stroke="${ params.hiddenColor }" stroke-width="${ stroke.toFixed( 5 ) }" stroke-linecap="butt"/>` : '';

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

	if ( model ) model.visible = params.displayModel;
	if ( needsRender ) { renderer.render( scene, camera ); needsRender = false; }

	drawThrough.visible = params.displayDrawThroughProjection;
	if ( previewNeedsRender ) { previewRenderer.render( previewScene, previewCamera ); previewNeedsRender = false; }

}
