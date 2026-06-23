// sectionr frontend — display only. All heavy lifting (loading full-res models,
// decimation, edge projection) runs in the Deno sidecar; this just shows a proxy
// for orientation and renders the line segments the sidecar returns.
import {
	Scene,
	WebGLRenderer,
	PerspectiveCamera,
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
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { open } from '@tauri-apps/plugin-dialog';

const API = 'http://127.0.0.1:8787';

const params = {
	displayModel: true,
	displayDrawThroughProjection: false,
	includeIntersectionEdges: false,
	angleThreshold: 50,
};

let needsRender = false;
let renderer, camera, scene, controls, group, model, projection, drawThrough;
let outputContainer;

init();

async function init() {

	outputContainer = document.getElementById( 'output' );
	const view = document.getElementById( 'view' );
	const bgColor = 0x141414;

	renderer = new WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( view.clientWidth, view.clientHeight );
	renderer.setClearColor( bgColor, 1 );
	view.appendChild( renderer.domElement );

	scene = new Scene();

	const light = new DirectionalLight( 0xffffff, 3.5 );
	light.position.set( 1, 2, 3 );
	scene.add( light );
	scene.add( new AmbientLight( 0xb0bec5, 0.5 ) );

	group = new Group();
	scene.add( group );

	projection = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { color: 0xf5f5f5, depthWrite: false } ) );
	drawThrough = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { color: 0xcacaca, depthWrite: false } ) );
	drawThrough.renderOrder = - 1;
	scene.add( projection, drawThrough );

	camera = new PerspectiveCamera( 75, view.clientWidth / view.clientHeight, 0.01, 1e6 );
	camera.position.setScalar( 3.5 );
	camera.updateProjectionMatrix();

	controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => needsRender = true );

	// UI
	const bindCheck = ( id, onChange ) => {

		const el = document.getElementById( id );
		el.checked = params[ id ];
		el.addEventListener( 'change', () => { params[ id ] = el.checked; if ( onChange ) onChange(); } );

	};

	bindCheck( 'displayModel', () => needsRender = true );
	bindCheck( 'displayDrawThroughProjection', () => needsRender = true );
	bindCheck( 'includeIntersectionEdges' );

	const angleEl = document.getElementById( 'angleThreshold' );
	angleEl.value = params.angleThreshold;
	angleEl.addEventListener( 'input', () => {

		params.angleThreshold = + angleEl.value;
		document.getElementById( 'angleVal' ).textContent = angleEl.value;

	} );

	document.getElementById( 'open' ).addEventListener( 'click', openModel );
	document.getElementById( 'rotate' ).addEventListener( 'click', () => {

		if ( ! model ) return;
		group.quaternion.random();
		needsRender = true;

	} );
	document.getElementById( 'regenerate' ).addEventListener( 'click', generate );
	document.getElementById( 'downloadSVG' ).addEventListener( 'click', downloadSVG );

	window.addEventListener( 'resize', () => {

		camera.aspect = view.clientWidth / view.clientHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( view.clientWidth, view.clientHeight );
		needsRender = true;

	} );

	render();

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
	outputContainer.innerText = `Loaded ${ fullTris.toLocaleString() } tris — generating…`;
	generate();

}

async function generate() {

	if ( ! model ) return;

	const btn = document.getElementById( 'regenerate' );
	btn.disabled = true;
	outputContainer.innerText = 'Projecting…';

	const q = group.quaternion;
	try {

		const res = await fetch( `${ API }/project`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( {
				quaternion: [ q.x, q.y, q.z, q.w ],
				angleThreshold: params.angleThreshold,
				includeIntersectionEdges: params.includeIntersectionEdges,
			} ),
		} );

		if ( ! res.ok ) { outputContainer.innerText = `Projection failed: ${ await res.text() }`; return; }

		const { vis, hid } = decodeProject( await res.arrayBuffer() );
		setLines( projection, vis );
		setLines( drawThrough, hid );
		document.getElementById( 'downloadSVG' ).disabled = vis.length === 0;
		outputContainer.innerText = `${ vis.length / 6 | 0 } visible + ${ hid.length / 6 | 0 } hidden segments`;

	} catch ( e ) {

		outputContainer.innerText = `Projection error: ${ e.message }`;

	} finally {

		btn.disabled = false;
		needsRender = true;

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
	camera.position.setScalar( size * 0.9 );
	camera.near = size / 100;
	camera.far = size * 50;
	camera.updateProjectionMatrix();
	controls.target.set( 0, 0, 0 );
	needsRender = true;

}

// --- SVG export (lines lie on XZ plane, y=0; flip z so top-down isn't mirrored) ---
function downloadSVG() {

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

	const a = document.createElement( 'a' );
	a.href = URL.createObjectURL( new Blob( [ svg ], { type: 'image/svg+xml' } ) );
	a.download = 'projection.svg';
	a.click();
	URL.revokeObjectURL( a.href );

}

function render() {

	requestAnimationFrame( render );
	if ( model ) model.visible = params.displayModel;
	drawThrough.visible = params.displayDrawThroughProjection;
	if ( needsRender ) { renderer.render( scene, camera ); needsRender = false; }

}
