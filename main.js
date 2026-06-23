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
	PerspectiveCamera,
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
};

let needsRender = false, previewNeedsRender = false;
let renderer, camera, scene, group, model;
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
	camera = new PerspectiveCamera( 75, view.clientWidth / view.clientHeight, 0.01, 1e6 );
	camera.position.set( 0, 0, 5 );

	// --- projection preview (flat, top-down ortho) ---
	previewRenderer = new WebGLRenderer( { antialias: true } );
	previewRenderer.setPixelRatio( window.devicePixelRatio );
	previewRenderer.setSize( preview.clientWidth, preview.clientHeight );
	previewRenderer.setClearColor( 0x0d0d0d, 1 );
	preview.appendChild( previewRenderer.domElement );

	previewScene = new Scene();
	projection = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { color: 0xf5f5f5 } ) );
	drawThrough = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { color: 0x6b7280 } ) );
	previewScene.add( projection, drawThrough );

	previewCamera = new OrthographicCamera( - 1, 1, 1, - 1, 0.01, 1e7 );
	previewCamera.up.set( 0, 0, - 1 ); // world -Z is "up" in the print, matching the SVG y = -z

	bindUI();
	attachArcball();

	window.addEventListener( 'resize', resize );
	render();

}

function bindUI() {

	const bindCheck = ( id, onChange ) => {

		const el = document.getElementById( id );
		el.checked = params[ id ];
		el.addEventListener( 'change', () => { params[ id ] = el.checked; if ( onChange ) onChange(); } );

	};

	bindCheck( 'displayModel', () => needsRender = true );
	bindCheck( 'displayDrawThroughProjection', () => previewNeedsRender = true );
	bindCheck( 'includeIntersectionEdges' );
	bindCheck( 'visibilityCullMeshes' );
	bindCheck( 'decimate' );

	const angleEl = document.getElementById( 'angleThreshold' );
	angleEl.value = params.angleThreshold;
	angleEl.addEventListener( 'input', () => {

		params.angleThreshold = + angleEl.value;
		document.getElementById( 'angleVal' ).textContent = angleEl.value;

	} );

	const budgetEl = document.getElementById( 'simplifyBudget' );
	budgetEl.value = params.simplifyBudget;
	budgetEl.addEventListener( 'input', () => {

		params.simplifyBudget = + budgetEl.value;
		const v = params.simplifyBudget;
		document.getElementById( 'budgetVal' ).textContent = v >= 1e6 ? `${ ( v / 1e6 ).toFixed( 1 ) }M` : `${ ( v / 1000 ) | 0 }k`;

	} );

	document.getElementById( 'open' ).addEventListener( 'click', openModel );
	document.getElementById( 'reset' ).addEventListener( 'click', () => {

		if ( ! model ) return;
		group.quaternion.identity();
		needsRender = true;

	} );
	document.getElementById( 'regenerate' ).addEventListener( 'click', generate );
	document.getElementById( 'downloadSVG' ).addEventListener( 'click', downloadSVG );

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

		if ( ! model ) return;
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
		camera.position.z = Math.max( 0.05, camera.position.z * ( 1 + e.deltaY * 0.001 ) );
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
	if ( ! path ) return;

	outputContainer.innerText = 'Loading…';
	let res;
	try {

		res = await fetch( `${ API }/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { path } ) } );

	} catch ( e ) {

		outputContainer.innerText = `Sidecar unreachable — is it running? (${ e.message })`;
		return;

	}

	if ( ! res.ok ) { outputContainer.innerText = `Load failed: ${ await res.text() }`; return; }

	const fullTris = Number( res.headers.get( 'X-Full-Tris' ) ) || 0;
	setModel( decodeProxy( await res.arrayBuffer() ) );
	document.getElementById( 'downloadSVG' ).disabled = true;
	outputContainer.innerText = `Loaded ${ fullTris.toLocaleString() } tris — position, then Generate projection`;

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

	// model is already centered server-side; frame the camera to its size
	const size = new Box3().setFromObject( model ).getSize( new Vector3() ).length() || 5;
	camera.position.set( 0, 0, size * 0.9 );
	camera.near = size / 100;
	camera.far = size * 50;
	camera.updateProjectionMatrix();
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
	previewCamera.position.set( cx, Math.max( w, h ) * 2 + 10, cz );
	previewCamera.lookAt( cx, 0, cz );
	previewCamera.updateProjectionMatrix();

}

function resize() {

	camera.aspect = view.clientWidth / view.clientHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( view.clientWidth, view.clientHeight );
	previewRenderer.setSize( preview.clientWidth, preview.clientHeight );
	framePreview();
	needsRender = true;

}

// --- SVG export (lines lie on XZ plane, y=0; flip z so top-down isn't mirrored) ---
async function downloadSVG() {

	const p = projection.geometry.attributes.position;
	if ( ! p || p.count === 0 ) return;

	let minX = Infinity, minY = Infinity, maxX = - Infinity, maxY = - Infinity;
	for ( let i = 0; i < p.count; i ++ ) {

		const x = p.getX( i ), y = - p.getZ( i );
		if ( x < minX ) minX = x; if ( y < minY ) minY = y;
		if ( x > maxX ) maxX = x; if ( y > maxY ) maxY = y;

	}

	const w = maxX - minX, h = maxY - minY;
	if ( ! isFinite( w ) || w <= 0 || h <= 0 ) return;

	const mm = 300 / Math.max( w, h );
	const stroke = Math.max( w, h ) / 800;
	const minLen2 = ( Math.max( w, h ) * 1e-4 ) ** 2;

	let d = '';
	for ( let i = 0; i < p.count; i += 2 ) {

		const ax = p.getX( i ) - minX, ay = - p.getZ( i ) - minY;
		const bx = p.getX( i + 1 ) - minX, by = - p.getZ( i + 1 ) - minY;
		if ( ( bx - ax ) ** 2 + ( by - ay ) ** 2 < minLen2 ) continue;
		d += `M${ ax.toFixed( 4 ) } ${ ay.toFixed( 4 ) }L${ bx.toFixed( 4 ) } ${ by.toFixed( 4 ) }`;

	}

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ ( w * mm ).toFixed( 2 ) }mm" height="${ ( h * mm ).toFixed( 2 ) }mm" viewBox="0 0 ${ w.toFixed( 4 ) } ${ h.toFixed( 4 ) }">
  <path d="${ d }" fill="none" stroke="#000" stroke-width="${ stroke.toFixed( 5 ) }" stroke-linecap="butt"/>
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
