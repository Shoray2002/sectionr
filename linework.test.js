// node --test linework.test.js
import assert from 'node:assert/strict';
import { buildPolylines, simplifyPoly, fitPolyline, flattenCurves, curvesPath } from './linework.js';

const segment = ( x, z, x2, z2 ) => [ x, 0, z, x2, 0, z2 ];
// Endpoints across neighboring grid cells must join; visible gaps must not.
assert.equal( buildPolylines( [ ...segment( 0, 0, 0.99, 0 ), ...segment( 1.01, 0, 2, 0 ) ], 0.03, 0 ).length, 1 );
assert.equal( buildPolylines( [ ...segment( 0, 0, 0.9, 0 ), ...segment( 1.1, 0, 2, 0 ) ], 0.03, 0 ).length, 2 );
// Duplicate edges are drawn once. A clear tangent continues through a junction
// instead of randomly bending through another feature.
const junction = [ ...segment( 0, 0, 1, 0 ), ...segment( 1, 0, 2, 0 ), ...segment( 1, 0, 1, 1 ), ...segment( 1, 0, 0, 0 ) ];
assert.equal( buildPolylines( junction, 0.01, 0 ).length, 2 );
const bridge = [ ...segment( -1, 0, 0, 0 ), ...segment( 0, 0, 1, 0 ), ...segment( -1, 0.05, 0, 0.05 ), ...segment( 0, 0.05, 1, 0.05 ), ...segment( 0, 0, 0, 0.05 ) ];
assert( buildPolylines( bridge, 0.001, 0.1 ).some( p => p.length === 4 && p[ 0 ] === 0 && p[ 2 ] === 0 && Math.abs( p[ 3 ] - p[ 1 ] ) === 0.05 ), 'preserve a short connector between junctions' );
assert.deepEqual( simplifyPoly( [ 0, 0, 2, 0, 1, 0 ], 0.01 ), [ 0, 0, 2, 0, 1, 0 ], 'do not simplify past an endpoint' );

// Curves remain closed and tangent-continuous, with error below print tolerance.
const ring = [];
for ( let i = 0; i < 64; i ++ ) ring.push( 20 * Math.cos( i * Math.PI / 32 ), 20 * Math.sin( i * Math.PI / 32 ) );
ring.push( ring[ 0 ], ring[ 1 ] );
const curves = fitPolyline( ring, 0.1 );
const flat = flattenCurves( curves, 0.005 );
assert( curves.length < 64, 'replace facets with fitted cubics' );
assert.deepEqual( flat.slice( 0, 2 ), flat.slice( - 2 ) );
for ( let i = 0; i < flat.length; i += 2 ) assert( Math.abs( Math.hypot( flat[ i ], flat[ i + 1 ] ) - 20 ) < 0.1 );
const first = curves[ 0 ], last = curves.at( - 1 );
const startT = [ first[ 1 ][ 0 ] - first[ 0 ][ 0 ], first[ 1 ][ 1 ] - first[ 0 ][ 1 ] ];
const endT = [ last[ 3 ][ 0 ] - last[ 2 ][ 0 ], last[ 3 ][ 1 ] - last[ 2 ][ 1 ] ];
assert( Math.abs( startT[ 0 ] * endT[ 1 ] - startT[ 1 ] * endT[ 0 ] ) < 1e-8 );
// Sharp panel corners stay sharp, even with a deliberately generous tolerance.
const square = [ 0, 0, 10, 0, 10, 10, 0, 10, 0, 0 ];
assert.deepEqual( flattenCurves( fitPolyline( square, 0.5 ), 0.005 ), square );
assert.deepEqual( flattenCurves( fitPolyline( square, 0 ), 0.005 ), square );
// Check between source samples too: fitting must not bow away from a wavy stroke.
const wave = [];
for ( let x = 0; x <= 10; x += 0.5 ) wave.push( x, Math.sin( x ) );
const waveFlat = flattenCurves( fitPolyline( wave, 0.1 ), 0.001 );
for ( let i = 0; i < waveFlat.length; i += 2 ) {

	let distance = Infinity;
	for ( let j = 0; j < wave.length - 2; j += 2 ) {

		const dx = wave[ j + 2 ] - wave[ j ], dy = wave[ j + 3 ] - wave[ j + 1 ];
		const t = Math.max( 0, Math.min( 1, ( ( waveFlat[ i ] - wave[ j ] ) * dx + ( waveFlat[ i + 1 ] - wave[ j + 1 ] ) * dy ) / ( dx * dx + dy * dy ) ) );
		distance = Math.min( distance, Math.hypot( waveFlat[ i ] - wave[ j ] - t * dx, waveFlat[ i + 1 ] - wave[ j + 1 ] - t * dy ) );

	}
	assert( distance <= 0.1, 'fitted curves stay within the source-stroke tolerance' );

}
const svg = curvesPath( [ fitPolyline( [ 0, -2, 0, 2 ], 0 ) ], 0, -2 );
assert.equal( svg, 'M0.000000 0.000000L0.000000 4.000000', 'view up (-Z) belongs at the top of the SVG' );
console.log( 'linework: stitching, visibility gaps, sharp corners, smooth closed curves and SVG orientation passed' );
