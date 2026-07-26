// node mapsvg.test.js
import assert from 'node:assert';
import { projector, clipLine, clipRing, stitchRings, thin, buildMapSVG } from './mapsvg.js';

const near = ( a, b ) => Math.abs( a - b ) < 1e-6;

// projector: bbox corners land on frame corners (mercator y grows south)
const proj = projector( [ 51, - 1, 52, 1 ], 100, 140 );
assert( near( proj( - 1, 52 )[ 0 ], 0 ) && near( proj( - 1, 52 )[ 1 ], 0 ) );
assert( near( proj( 1, 51 )[ 0 ], 100 ) && near( proj( 1, 51 )[ 1 ], 140 ) );

// clipLine: inside untouched; crossing clipped at edge; re-entry splits runs
assert.deepEqual( clipLine( [ [ 1, 1 ], [ 5, 5 ] ], 10, 10 ), [ [ [ 1, 1 ], [ 5, 5 ] ] ] );
assert.deepEqual( clipLine( [ [ 5, 5 ], [ 15, 5 ] ], 10, 10 ), [ [ [ 5, 5 ], [ 10, 5 ] ] ] );
assert.equal( clipLine( [ [ - 5, - 5 ], [ - 1, - 1 ] ], 10, 10 ).length, 0 );
const runs = clipLine( [ [ 1, 5 ], [ 15, 5 ], [ 15, 6 ], [ 1, 6 ] ], 10, 10 );
assert.equal( runs.length, 2 ); // leaves right edge, comes back
// contiguous inside segments merge into one run
assert.equal( clipLine( [ [ 1, 1 ], [ 2, 2 ], [ 3, 3 ] ], 10, 10 ).length, 1 );

// clipRing: square straddling the right edge loses its outside half
const ring = clipRing( [ [ 5, 2 ], [ 15, 2 ], [ 15, 8 ], [ 5, 8 ] ], 10, 10 );
assert( ring.every( p => p[ 0 ] <= 10 ) && ring.some( p => p[ 0 ] === 10 ) );
assert.equal( clipRing( [ [ 20, 20 ], [ 30, 20 ], [ 30, 30 ] ], 10, 10 ).length, 0 );

// stitchRings: two open fragments chain into one closed ring
const stitched = stitchRings( [ [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ] ], [ [ 1, 1 ], [ 0, 1 ], [ 0, 0 ] ] ] );
assert.equal( stitched.length, 1 );
assert.equal( stitched[ 0 ].length, 5 ); // closed: first point repeated at end

// thin: drops points within eps of the last kept one, endpoints survive
assert.deepEqual( thin( [ [ 0, 0 ], [ 0.1, 0 ], [ 0.2, 0 ], [ 5, 0 ], [ 10, 0 ] ], 1 ), [ [ 0, 0 ], [ 5, 0 ], [ 10, 0 ] ] );
assert.deepEqual( thin( [ [ 0, 0 ], [ 5, 5 ] ], 1 ), [ [ 0, 0 ], [ 5, 5 ] ] );
assert.deepEqual( thin( [ [ 0, 0 ], [ 3, 0 ], [ 6, 0 ] ], 0 ), [ [ 0, 0 ], [ 3, 0 ], [ 6, 0 ] ] ); // eps 0 = off

const base = {
	width: 100, bbox: [ 51, - 1, 52, 1 ],
	theme: { bg: '#000', text: '#fff', water: '#00f', parks: '#0f0', roads: { motorway: '#fff', primary: '#eee', secondary: '#ddd', tertiary: '#ccc', residential: '#bbb' } },
	roads: { motorway: [ [ [ - 1, 52 ], [ 1, 51 ] ] ], primary: [], secondary: [], tertiary: [], residential: [] },
	roadOn: { motorway: true, primary: true, secondary: true, tertiary: true, residential: true },
	roadWidths: { motorway: 0.9, primary: 0.7, secondary: 0.5, tertiary: 0.35, residential: 0.2 },
	water: [ [ [ - 1, 52 ], [ 0, 52 ], [ 0, 51.5 ], [ - 1, 51.5 ] ] ], parks: [],
	showWater: true, showParks: true, showBg: true, footer: null,
};
const svg = buildMapSVG( base );
assert( svg.includes( 'width="100mm"' ) && svg.includes( 'height="141.42mm"' ) ); // 1:√2
assert( svg.includes( 'viewBox="0 0 100 141.42"' ) );
assert( svg.includes( 'stroke="#fff" stroke-width="0.9"' ) ); // motorway styled per theme
assert( svg.includes( 'fill="#00f"' ) );                      // water polygon
assert( svg.includes( '<rect width="100" height="141.42" fill="#000"' ) );
assert( ! svg.includes( '<text' ) );

// layer toggle removes the road
const off = buildMapSVG( { ...base, roadOn: { ...base.roadOn, motorway: false } } );
assert( ! off.includes( 'stroke-width="0.9"' ) );

// minLen prunes minor classes only: residential dropped, motorway immune
const pruned = buildMapSVG( { ...base, roads: { ...base.roads, residential: [ [ [ - 1, 52 ], [ 1, 51 ] ] ] }, minLen: 500 } );
assert( pruned.includes( 'stroke-width="0.9"' ) );   // motorway survives (diagonal ~172mm < 500)
assert( ! pruned.includes( 'stroke-width="0.2"' ) ); // residential pruned

// simplify thins interior points: a node 0.05mm along the road drops at eps 1
const wiggly = { ...base, roads: { ...base.roads, motorway: [ [ [ - 1, 52 ], [ - 0.999, 51.9995 ], [ 1, 51 ] ] ] } };
const countL = ( svg ) => ( svg.match( /L/g ) ?? [] ).length;
assert( countL( buildMapSVG( { ...wiggly, simplify: 1 } ) ) < countL( buildMapSVG( { ...wiggly, simplify: 0 } ) ) );

// footer: <text> fallback without textPath, outlined paths with it
const foot = buildMapSVG( { ...base, footer: { title: 'London', subtitle: 'UK' } } );
assert( foot.includes( 'L O N D O N' ) && foot.includes( 'text-anchor="middle"' ) );
assert( foot.includes( '51.5000° N / 0.0000° E' ) ); // bbox centre coords
const outlined = buildMapSVG( { ...base, footer: { title: 'London', subtitle: 'UK' }, textPath: ( t, x, y ) => `M${ x } ${ y }h5`, textWidth: () => 10 } );
assert( ! outlined.includes( '<text' ) && outlined.includes( 'h5' ) );

console.log( 'ok' );
