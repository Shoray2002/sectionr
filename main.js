import {
	Box3,
	Scene,
	DirectionalLight,
	AmbientLight,
	Group,
	BufferGeometry,
	BufferAttribute,
	LineSegments,
	LineBasicMaterial,
	PerspectiveCamera,
	WebGPURenderer,
	Mesh,
	MeshStandardMaterial,
	Vector3,
	Float32BufferAttribute,
} from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { ProjectionGenerator, MeshVisibilityCuller } from 'three-edge-projection/webgpu';
import { Color } from 'three';
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

const params = {
	displayModel: true,
	displayDrawThroughProjection: false,
	includeIntersectionEdges: false,
	visibilityCullMeshes: false,
	perObjectColors: false,
	angleThreshold: 50,
	simplifyBudget: 200000,
	regenerate: () => {

		updateEdges();

	},
	rotate: () => {

		if ( ! model ) return;
		group.quaternion.random();
		group.position.set( 0, 0, 0 );
		group.updateMatrixWorld( true );

		const box = new Box3();
		box.setFromObject( model, true );
		box.getCenter( group.position ).multiplyScalar( - 1 );
		group.position.y = Math.max( 0, - box.min.y ) + 1;
		group.updateMatrixWorld( true );

		needsRender = true;

	},
};

let needsRender = false;
let renderer, camera, scene, controls;
let model, projection, drawThroughProjection, group;
let outputContainer;
let abortController;
let generating = false;

init();

document.getElementById( 'file' ).addEventListener( 'change', onUpload );

async function init() {

	outputContainer = document.getElementById( 'output' );
	const view = document.getElementById( 'view' );

	const bgColor = 0x141414;

	// renderer setup
	renderer = new WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( view.clientWidth, view.clientHeight );
	renderer.setClearColor( bgColor, 1 );
	await renderer.init();
	view.appendChild( renderer.domElement );

	// scene setup
	scene = new Scene();

	// lights
	const light = new DirectionalLight( 0xffffff, 3.5 );
	light.position.set( 1, 2, 3 );
	scene.add( light );

	const ambientLight = new AmbientLight( 0xb0bec5, 0.5 );
	scene.add( ambientLight );

	// model group — starts empty; populated on upload
	group = new Group();
	scene.add( group );

	// create projection display meshes
	projection = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { depthWrite: false } ) );
	drawThroughProjection = new LineSegments( new BufferGeometry(), new LineBasicMaterial( { depthWrite: false } ) );
	drawThroughProjection.renderOrder = - 1;
	scene.add( projection, drawThroughProjection );

	// camera setup
	camera = new PerspectiveCamera( 75, view.clientWidth / view.clientHeight, 0.01, 1e6 );
	camera.position.setScalar( 3.5 );
	camera.updateProjectionMatrix();

	needsRender = true;

	// controls
	controls = new OrbitControls( camera, renderer.domElement );
	controls.addEventListener( 'change', () => {

		needsRender = true;

	} );

	// panel controls bound to the same params object
	const bind = ( id, onChange ) => {

		const el = document.getElementById( id );
		el.checked = params[ id ];
		el.addEventListener( 'change', () => {

			params[ id ] = el.checked;
			if ( onChange ) onChange();

		} );

	};

	bind( 'displayModel', () => needsRender = true );
	bind( 'displayDrawThroughProjection', () => needsRender = true );
	bind( 'includeIntersectionEdges' );
	bind( 'visibilityCullMeshes' );
	bind( 'perObjectColors' );
	const angleEl = document.getElementById( 'angleThreshold' );
	angleEl.value = params.angleThreshold;
	angleEl.addEventListener( 'input', () => {

		params.angleThreshold = + angleEl.value;
		document.getElementById( 'angleVal' ).textContent = angleEl.value;

	} );

	const simplifyEl = document.getElementById( 'simplify' );
	simplifyEl.value = params.simplifyBudget / 1000;
	simplifyEl.addEventListener( 'input', () => {

		params.simplifyBudget = + simplifyEl.value * 1000;
		document.getElementById( 'simplifyVal' ).textContent = simplifyEl.value;

	} );

	document.getElementById( 'rotate' ).addEventListener( 'click', params.rotate );
	document.getElementById( 'regenerate' ).addEventListener( 'click', params.regenerate );
	document.getElementById( 'downloadSVG' ).addEventListener( 'click', downloadSVG );

	render();

	window.addEventListener( 'resize', function () {

		camera.aspect = view.clientWidth / view.clientHeight;
		camera.updateProjectionMatrix();

		renderer.setSize( view.clientWidth, view.clientHeight );

		needsRender = true;

	}, false );

}

async function updateEdges() {

	if ( ! model ) return;

	if ( abortController ) {

		abortController.abort();

	}

	const myController = new AbortController();
	abortController = myController;

	projection.geometry.dispose();
	projection.material.dispose();
	projection.geometry = new BufferGeometry();

	drawThroughProjection.geometry.dispose();
	drawThroughProjection.material.dispose();
	drawThroughProjection.geometry = new BufferGeometry();

	needsRender = true;

	const timeStart = window.performance.now();
	const generator = new ProjectionGenerator( renderer );
	generator.includeIntersectionEdges = params.includeIntersectionEdges;
	generator.angleThreshold = params.angleThreshold;

	// the generator reads each mesh's .visible flag for the occlusion pass, so the
	// model must stay visible for the whole async generation — guard render() with this.
	model.visible = true;
	generating = true;
	let input = [ model ];
	if ( params.visibilityCullMeshes ) {

		input = await new MeshVisibilityCuller( renderer, { pixelsPerMeter: 0.1 } ).cull( input );

	}

	let result;
	try {

		result = await generator.generate( input, {
			signal: myController.signal,
			onProgress: ( p, msg ) => {

				outputContainer.innerText = `${ msg }... ${ ( p * 100 ).toFixed( 2 ) }%`;

			},
		} );

	} catch {

		// aborted by a newer call, or failed — only reset if we're still the active run
		if ( abortController === myController ) {

			generating = false;
			model.visible = params.displayModel;

		}

		return;

	}

	const visGeom = result.visibleEdges.getLineGeometry();
	const hidGeom = result.hiddenEdges.getLineGeometry();
	if ( params.perObjectColors ) {

		applyPerObjectColors( result.visibleEdges, visGeom );
		applyPerObjectColors( result.hiddenEdges, hidGeom, 0.8 );

	}

	projection.geometry.dispose();
	projection.material.dispose();
	projection.geometry = visGeom;
	projection.material.vertexColors = params.perObjectColors;
	projection.material.color.set( params.perObjectColors ? 0xffffff : 0xf5f5f5 );

	drawThroughProjection.geometry.dispose();
	drawThroughProjection.material.dispose();
	drawThroughProjection.geometry = hidGeom;
	drawThroughProjection.material.vertexColors = params.perObjectColors;
	drawThroughProjection.material.color.set( params.perObjectColors ? 0xffffff : 0xcacaca );

	const elapsed = window.performance.now() - timeStart;
	outputContainer.innerText = `Generation time: ${ elapsed.toFixed( 2 ) }ms`;

	generating = false;
	model.visible = params.displayModel;
	document.getElementById( 'downloadSVG' ).disabled = false;
	needsRender = true;

}

// Export the visible projection as an SVG. Lines lie on the XZ plane (y=0),
// so we use x and z; z is flipped so the top-down view isn't mirrored.
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

	const mm = 300 / Math.max( w, h );      // longest side → 300mm
	const stroke = Math.max( w, h ) / 800;
	const minLen2 = ( Math.max( w, h ) * 1e-4 ) ** 2; // drop degenerate/near-zero segments

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

function applyPerObjectColors( edgeSet, geometry, lightness = 0.5 ) {

	const totalVertices = geometry.attributes.position.count;
	const colorArray = new Float32Array( totalVertices * 3 );
	const color = new Color();

	for ( const mesh of edgeSet.meshToSegments.keys() ) {

		const range = edgeSet.getRangeForMesh( mesh );
		if ( ! range ) continue;

		color.setHSL( Math.random(), 0.75, lightness );


		for ( let i = range.start; i < range.start + range.count; i ++ ) {

			colorArray[ i * 3 + 0 ] = color.r;
			colorArray[ i * 3 + 1 ] = color.g;
			colorArray[ i * 3 + 2 ] = color.b;

		}

	}

	geometry.setAttribute( 'color', new BufferAttribute( colorArray, 3 ) );

}

function render() {

	requestAnimationFrame( render );

	if ( model && ! generating ) model.visible = params.displayModel;
	drawThroughProjection.visible = params.displayDrawThroughProjection;

	if ( needsRender ) {

		renderer.render( scene, camera );
		needsRender = false;

	}

}

// --- model uploading ------------------------------------------------------
// Mesh formats via three.js loaders; CAD (B-rep) via OpenCASCADE (WASM).
const cadReaders = { stp: 'ReadStepFile', step: 'ReadStepFile', igs: 'ReadIgesFile', iges: 'ReadIgesFile' };
let occtPromise = null;
const getOcct = () => ( occtPromise ||= occtimportjs( { locateFile: () => wasmUrl } ) );

async function loadCAD( file, ext ) {

	const occt = await getOcct();
	const res = occt[ cadReaders[ ext ] ]( new Uint8Array( await file.arrayBuffer() ), null );
	if ( ! res.success || ! res.meshes.length ) throw new Error( 'OCCT could not parse this file' );

	const obj = new Group();
	for ( const m of res.meshes ) {

		const geom = new BufferGeometry();
		geom.setAttribute( 'position', new Float32BufferAttribute( m.attributes.position.array, 3 ) );
		if ( m.attributes.normal ) geom.setAttribute( 'normal', new Float32BufferAttribute( m.attributes.normal.array, 3 ) );
		geom.setIndex( m.index.array );
		if ( ! m.attributes.normal ) geom.computeVertexNormals();
		obj.add( new Mesh( geom, new MeshStandardMaterial( { color: 0xbfc4cc, flatShading: true, wireframe: true } ) ) );

	}

	return obj;

}

// Decimate meshes whose combined triangle count exceeds `budget` down to it.
// meshopt is WASM — fast even on millions of tris. Output is plotter-scale identical.
// Returns [ beforeTris, afterTris ].
async function simplifyMeshes( obj, budget ) {

	const meshes = [];
	obj.traverse( o => {

		if ( o.isMesh ) meshes.push( o );

	} );

	const triCount = m => ( m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count ) / 3;
	const before = meshes.reduce( ( n, m ) => n + triCount( m ), 0 );
	if ( before <= budget ) return [ before, before ];

	await MeshoptSimplifier.ready;
	const ratio = budget / before;

	for ( const m of meshes ) {

		// weld so meshopt sees shared edges (STL/OBJ soup is non-indexed)
		const src = m.geometry.index ? m.geometry : mergeVertices( m.geometry );
		const posAttr = src.attributes.position;

		// tight, non-interleaved position copy — GLB attributes are often interleaved,
		// which a raw .array + stride-3 read would corrupt
		const verts = new Float32Array( posAttr.count * 3 );
		for ( let i = 0; i < posAttr.count; i ++ ) {

			verts[ i * 3 ] = posAttr.getX( i );
			verts[ i * 3 + 1 ] = posAttr.getY( i );
			verts[ i * 3 + 2 ] = posAttr.getZ( i );

		}

		const index = src.index ? new Uint32Array( src.index.array ) : new Uint32Array( posAttr.count ).map( ( _, i ) => i );
		const target = Math.max( 3, Math.floor( index.length * ratio / 3 ) * 3 );

		const [ simplified ] = MeshoptSimplifier.simplify( index, verts, 3, target, 1.0, [ 'LockBorder' ] );
		if ( simplified.length < 3 || simplified.length >= index.length ) continue; // nothing gained — keep original

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new BufferAttribute( verts, 3 ) );
		geo.setIndex( new BufferAttribute( new Uint32Array( simplified ), 1 ) );
		geo.computeVertexNormals();
		m.geometry = geo;

	}

	const after = meshes.reduce( ( n, m ) => n + triCount( m ), 0 );
	return [ before, after ];

}

async function onUpload( e ) {

	const file = e.target.files[ 0 ];
	if ( ! file ) return;
	const ext = file.name.split( '.' ).pop().toLowerCase();

	outputContainer.innerText = cadReaders[ ext ] ? 'Tessellating CAD model...' : 'Loading...';

	try {

		let obj;
		if ( cadReaders[ ext ] ) {

			obj = await loadCAD( file, ext );

		} else {

			const url = URL.createObjectURL( file );
			if ( ext === 'glb' || ext === 'gltf' ) {

				obj = ( await new GLTFLoader().setMeshoptDecoder( MeshoptDecoder ).loadAsync( url ) ).scene;

			} else if ( ext === 'obj' ) {

				obj = await new OBJLoader().loadAsync( url );

			} else if ( ext === 'stl' ) {

				obj = new Mesh( await new STLLoader().loadAsync( url ), new MeshStandardMaterial( { color: 0xbfc4cc, flatShading: true } ) );

			} else {

				URL.revokeObjectURL( url );
				outputContainer.innerText = `Unsupported format: .${ ext }`;
				return;

			}

			URL.revokeObjectURL( url );

		}

		// decimate before projection — the edge generator is O(triangles) on the CPU
		const [ before, after ] = await simplifyMeshes( obj, params.simplifyBudget );
		if ( after < before ) {

			outputContainer.innerText = `Simplified ${ ( before / 1000 ).toFixed( 0 ) }k → ${ ( after / 1000 ).toFixed( 0 ) }k tris`;

		}

		// swap into the group using the same centering the example uses on load
		group.remove( model );
		model = obj;
		group.quaternion.identity();
		group.position.set( 0, 0, 0 );
		group.updateMatrixWorld( true );

		const box = new Box3();
		box.setFromObject( model, true );
		box.getCenter( group.position ).multiplyScalar( - 1 );
		group.position.y = Math.max( 0, - box.min.y ) + 1;
		group.add( model );
		group.updateMatrixWorld( true );

		// frame the camera to the new model's size. near/far are scaled to the model so
		// the depth-buffer ratio stays tight — a fixed near=0.01 on a large model wrecks
		// depth precision and causes surface z-fighting in the preview.
		const size = box.getSize( new Vector3() ).length() || 5;
		camera.position.setScalar( size * 0.9 );
		camera.near = size / 100;
		camera.far = size * 50;
		camera.updateProjectionMatrix();
		controls.target.set( 0, 0, 0 );

		needsRender = true;
		updateEdges();

	} catch ( err ) {

		console.error( err );
		outputContainer.innerText = `Load failed: ${ err.message }`;

	}

}
