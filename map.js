// map tab — pick an area under a fixed 1:√2 frame, fetch OSM data from
// Overpass, style it maptoposter-style, export as a print-ready poster SVG.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { buildMapSVG, stitchRings, ROAD_CLASSES } from './mapsvg.js';
import { outline, advance, centerlineText } from './centerline.js';
import { otFonts } from './assets.js';

const $ = ( id ) => document.getElementById( id );
const API = 'http://127.0.0.1:8787';
const status = ( m ) => $( 'mapStatus' ).innerText = m;

// colour keys per maptoposter's theme JSON (bg/text/water/parks/road_*)
const THEMES = {
	noir: { bg: '#0d0d0d', text: '#f2f2f2', water: '#1e2430', parks: '#151a15', roads: { motorway: '#f2f2f2', primary: '#d9d9d9', secondary: '#b3b3b3', tertiary: '#8c8c8c', residential: '#595959', service: '#404040', paths: '#333333' } },
	paper: { bg: '#f8f5f0', text: '#1a1a1a', water: '#c9dbe6', parks: '#dce8d8', roads: { motorway: '#1a1a1a', primary: '#2e2e2e', secondary: '#4d4d4d', tertiary: '#707070', residential: '#9e9e9e', service: '#bdbdbd', paths: '#c9c9c9' } },
	blueprint: { bg: '#15396b', text: '#eaf1f8', water: '#0f2c54', parks: '#1b4179', roads: { motorway: '#eaf1f8', primary: '#d3e0ee', secondary: '#b7c9dd', tertiary: '#93accc', residential: '#6f8fb8', service: '#5578a3', paths: '#476b96' } },
};
// [label, default stroke mm, default on] — service/paths are the clutter that
// slows a plot to a crawl, so they start off
const ROAD_UI = { motorway: [ 'Motorways', 0.9, true ], primary: [ 'Primary', 0.7, true ], secondary: [ 'Secondary', 0.5, true ], tertiary: [ 'Tertiary', 0.35, true ], residential: [ 'Residential', 0.2, true ], service: [ 'Service / driveways', 0.15, false ], paths: [ 'Foot & cycle paths', 0.15, false ] };

$( 'mapLayers' ).innerHTML = ROAD_CLASSES.map( ( k ) => `
	<div class="row">
		<span class="check" style="margin:0"><input id="mr_${ k }" type="checkbox" ${ ROAD_UI[ k ][ 2 ] ? 'checked' : '' }><label for="mr_${ k }">${ ROAD_UI[ k ][ 0 ] }</label></span>
		<input id="mw_${ k }" type="number" value="${ ROAD_UI[ k ][ 1 ] }" step="0.05" min="0.05" title="stroke width (mm)">
	</div>` ).join( '' );

const lmap = L.map( 'map', { zoomControl: false } ).setView( [ 51.5072, - 0.1276 ], 13 );
L.tileLayer( 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' } ).addTo( lmap );

async function geocode() {

	const q = $( 'mapPlace' ).value.trim();
	if ( ! q ) return;
	status( 'Searching…' );
	try {

		const res = await fetch( `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${ encodeURIComponent( q ) }` );
		const hit = ( await res.json() )[ 0 ];
		if ( ! hit ) return status( 'Place not found' );
		lmap.setView( [ + hit.lat, + hit.lon ], 13 );
		const parts = hit.display_name.split( ',' );
		$( 'mapTitle' ).value = parts[ 0 ].trim();
		$( 'mapSubtitle' ).value = parts[ parts.length - 1 ].trim();
		status( '' );

	} catch ( e ) { status( `Search failed: ${ e.message }` ); }

}

$( 'mapSearch' ).addEventListener( 'click', geocode );
$( 'mapPlace' ).addEventListener( 'keydown', ( e ) => e.key === 'Enter' && geocode() );

// geographic bbox [s,w,n,e] of the on-screen frame
function frameBBox() {

	const r = $( 'mapFrame' ).getBoundingClientRect(), m = $( 'map' ).getBoundingClientRect();
	const nw = lmap.containerPointToLatLng( [ r.left - m.left, r.top - m.top ] );
	const se = lmap.containerPointToLatLng( [ r.right - m.left, r.bottom - m.top ] );
	// ~11m rounding: a hair of pan doesn't bust the sidecar's disk cache
	return [ se.lat, nw.lng, nw.lat, se.lng ].map( n => + n.toFixed( 4 ) );

}

const roadClass = ( h ) =>
	/^motorway/.test( h ) ? 'motorway' :
	/^(trunk|primary)/.test( h ) ? 'primary' :
	/^secondary/.test( h ) ? 'secondary' :
	/^tertiary/.test( h ) ? 'tertiary' :
	/^(service|raceway|busway)/.test( h ) ? 'service' :
	/^(footway|path|cycleway|pedestrian|steps|track|bridleway|corridor)/.test( h ) ? 'paths' : 'residential';

// same feature set maptoposter pulls via osmnx: all highways, water
// (natural=water/bay/strait + riverbank), parks (leisure=park, landuse=grass)
function classify( elements ) {

	const d = { roads: Object.fromEntries( ROAD_CLASSES.map( k => [ k, [] ] ) ), water: [], parks: [] };
	for ( const el of elements ) {

		const tags = el.tags ?? {};
		const pts = el.geometry?.map( g => [ g.lon, g.lat ] );
		if ( tags.highway ) { if ( pts ) d.roads[ roadClass( tags.highway ) ].push( pts ); continue; }
		const bucket = tags.leisure === 'park' || tags.landuse === 'grass' ? d.parks : d.water;
		if ( el.type === 'way' && pts ) bucket.push( pts );
		else if ( el.type === 'relation' ) bucket.push( ...stitchRings( ( el.members ?? [] ).filter( m => m.geometry ).map( m => m.geometry.map( g => [ g.lon, g.lat ] ) ) ) );

	}

	return d;

}

let data = null, bbox = null;

async function fetchArea() {

	bbox = frameBBox();
	const bb = bbox.join( ',' );
	const q = `[out:json][timeout:90];(
way[highway](${ bb });
way[natural~"^(water|bay|strait)$"](${ bb });relation[natural~"^(water|bay|strait)$"](${ bb });
way[waterway=riverbank](${ bb });relation[waterway=riverbank](${ bb });
way[leisure=park](${ bb });relation[leisure=park](${ bb });
way[landuse=grass](${ bb });
);out geom;`;
	status( 'Fetching OSM data… public Overpass servers can take a minute or two' );
	$( 'mapFetch' ).disabled = true;
	try {

		// via the sidecar: overpass-api.de 406s browser fetches intermittently,
		// and the sidecar cycles mirrors. Always 200 — errors arrive in the body.
		const res = await fetch( `${ API }/overpass`, { method: 'POST', body: q } );
		if ( ! res.ok ) throw new Error( await res.text() );
		const json = await res.json();
		if ( json.error ) throw new Error( json.error );
		data = classify( json.elements );
		status( `${ json.elements.length } features loaded${ res.headers.get( 'X-Cache' ) === 'hit' ? ' (cache)' : '' }` );
		render();

	} catch ( e ) { status( `Fetch failed: ${ e.message }` ); }
	$( 'mapFetch' ).disabled = false;

}

function opts() {

	const roadOn = {}, roadWidths = {};
	for ( const k of ROAD_CLASSES ) { roadOn[ k ] = $( 'mr_' + k ).checked; roadWidths[ k ] = + $( 'mw_' + k ).value || 0.2; }
	const font = otFonts[ 'Space Mono' ];
	return {
		width: + $( 'mapWidth' ).value || 210,
		bbox,
		theme: THEMES[ $( 'mapTheme' ).value ],
		...data,
		roadOn, roadWidths,
		showWater: $( 'mWater' ).checked,
		showParks: $( 'mParks' ).checked,
		showBg: $( 'mBg' ).checked,
		minLen: + $( 'mMinLen' ).value || 0,
		simplify: + $( 'mSimplify' ).value || 0,
		footer: $( 'mFooter' ).checked ? { title: $( 'mapTitle' ).value, subtitle: $( 'mapSubtitle' ).value } : null,
		textPath: font && ( $( 'mSingle' ).checked
			? ( t, x, y, fs ) => centerlineText( font, 'Space Mono', t, fs, x, y )
			: ( t, x, y, fs ) => outline( font, t, fs, x, y ) ),
		textWidth: font && ( ( t, fs ) => advance( font, t, fs ) ),
		textStroke: $( 'mSingle' ).checked ? 0.3 : 0, // matches the divider stroke
	};

}

function render() { if ( data ) $( 'mapPreview' ).innerHTML = buildMapSVG( opts() ); }

// one svg per active layer (separate pen passes) plus the combined poster —
// every file shares the same viewBox/projection, so they stack in register.
// Per-layer files skip the background; the combined one keeps it.
function layerSVGs() {

	const o = opts();
	const off = Object.fromEntries( ROAD_CLASSES.map( k => [ k, false ] ) );
	const bare = { ...o, roadOn: off, showWater: false, showParks: false, showBg: false, footer: null, footerSpace: !! o.footer };
	const files = [];
	if ( o.showParks ) files.push( [ 'parks', buildMapSVG( { ...bare, showParks: true } ) ] );
	if ( o.showWater ) files.push( [ 'water', buildMapSVG( { ...bare, showWater: true } ) ] );
	for ( const k of [ ...ROAD_CLASSES ].reverse() ) if ( o.roadOn[ k ] ) files.push( [ k, buildMapSVG( { ...bare, roadOn: { ...off, [ k ]: true } } ) ] );
	if ( o.footer ) files.push( [ 'footer', buildMapSVG( { ...bare, footer: o.footer } ) ] );
	files.push( [ 'combined', buildMapSVG( o ) ] );
	return files;

}

async function exportLayers() {

	if ( ! data ) return status( 'Fetch an area first' );
	const path = await save( { defaultPath: 'map', filters: [ { name: 'SVG set', extensions: [ 'svg' ] } ] } );
	if ( ! path ) return;
	const dir = path.replace( /\.svg$/i, '' ); // dialog name becomes the folder
	try {

		const files = layerSVGs();
		for ( const [ name, svg ] of files ) await invoke( 'save_svg', { path: `${ dir }/${ name }.svg`, content: svg } );
		status( `Saved ${ files.length } SVGs to ${ dir }` );

	} catch ( e ) { status( `Save failed: ${ e }` ); }

}

$( 'mapPanel' ).addEventListener( 'input', render );
$( 'mapFetch' ).addEventListener( 'click', fetchArea );
$( 'mapExport' ).addEventListener( 'click', exportLayers );
