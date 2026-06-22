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

init();

document.getElementById( 'file' ).addEventListener( 'change', onUpload );

async function init() {

	outputContainer = document.getElementById( 'output' );
	const view = document.getElementById( 'view' );

	const bgColor = 0xeeeeee;

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
	document.getElementById( 'rotate' ).addEventListener( 'click', params.rotate );
	document.getElementById( 'regenerate' ).addEventListener( 'click', params.regenerate );

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

	abortController = new AbortController();

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

	model.visible = true;
	let input = [ model ];
	if ( params.visibilityCullMeshes ) {

		input = await new MeshVisibilityCuller( renderer, { pixelsPerMeter: 0.1 } ).cull( input );

	}

	let result;
	try {

		result = await generator.generate( input, {
			signal: abortController.signal,
			onProgress: ( p, msg ) => {

				outputContainer.innerText = `${ msg }... ${ ( p * 100 ).toFixed( 2 ) }%`;

			},
		} );

	} catch {

		// cancelled
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
	projection.material.color.set( params.perObjectColors ? 0xffffff : 0x030303 );

	drawThroughProjection.geometry.dispose();
	drawThroughProjection.material.dispose();
	drawThroughProjection.geometry = hidGeom;
	drawThroughProjection.material.vertexColors = params.perObjectColors;
	drawThroughProjection.material.color.set( params.perObjectColors ? 0xffffff : 0xcacaca );

	const elapsed = window.performance.now() - timeStart;
	outputContainer.innerText = `Generation time: ${ elapsed.toFixed( 2 ) }ms`;

	needsRender = true;

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

	if ( model ) model.visible = params.displayModel;
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
		obj.add( new Mesh( geom, new MeshStandardMaterial( { color: 0xbfc4cc, flatShading: true } ) ) );

	}

	return obj;

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

		// frame the camera to the new model's size
		const size = box.getSize( new Vector3() ).length() || 5;
		camera.position.setScalar( size * 0.9 );
		camera.far = Math.max( 1e3, size * 100 );
		camera.updateProjectionMatrix();
		controls.target.set( 0, 0, 0 );

		needsRender = true;
		updateEdges();

	} catch ( err ) {

		console.error( err );
		outputContainer.innerText = `Load failed: ${ err.message }`;

	}

}
