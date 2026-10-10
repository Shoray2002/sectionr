// node plotter.test.js
import assert from 'node:assert';
import { projectionSettings, sortPlotterPolylines, sortPlotterCurves } from './plotter.js';

assert.deepEqual( projectionSettings( 'outline', 50, true ), { angleThreshold: 180, includeIntersectionEdges: false } );
assert.deepEqual( projectionSettings( 'plotter', 50, true ), { angleThreshold: 70, includeIntersectionEdges: false } );
assert.deepEqual( projectionSettings( 'detailed', 42, true ), { angleThreshold: 42, includeIntersectionEdges: true } );

// Nearest-neighbour ordering reverses a path when its end is closer.
const a = [ 0, 0, 1, 0 ], far = [ 20, 0, 21, 0 ], reversed = [ 10, 0, 2, 0 ];
const sorted = sortPlotterPolylines( [ far, reversed, a ] );
assert.deepEqual( sorted, [ a, [ 2, 0, 10, 0 ], far ] );

// Check the spatial search against an exhaustive nearest-endpoint search.
const samples = Array.from( { length: 120 }, ( _, i ) => [ ( i * 17 ) % 101, ( i * 31 ) % 97, ( i * 11 ) % 89, ( i * 19 ) % 83 ] );
const ordered = sortPlotterPolylines( samples );
const available = samples.slice();
available.splice( available.findIndex( p => p === ordered[ 0 ] ), 1 );
for ( let i = 1; i < ordered.length; i ++ ) {

	const prev = ordered[ i - 1 ], current = ordered[ i ];
	const distance = ( x, y ) => ( x - prev.at( - 2 ) ) ** 2 + ( y - prev.at( - 1 ) ) ** 2;
	const best = Math.min( ...available.flatMap( p => [ distance( p[ 0 ], p[ 1 ] ), distance( p.at( - 2 ), p.at( - 1 ) ) ] ) );
	assert.equal( distance( current[ 0 ], current[ 1 ] ), best );
	const at = available.findIndex( p => JSON.stringify( p ) === JSON.stringify( current ) || JSON.stringify( [ p[ 2 ], p[ 3 ], p[ 0 ], p[ 1 ] ] ) === JSON.stringify( current ) );
	assert( at >= 0 ); available.splice( at, 1 );

}
const many = Array.from( { length: 4000 }, ( _, i ) => [ i % 100, Math.floor( i / 100 ), i % 100 + 0.25, Math.floor( i / 100 ) ] );
assert.equal( sortPlotterPolylines( many ).length, many.length, 'large drawings must keep every stroke' );
const curve = [ [ 10, 0 ], [ 9, 5 ], [ 3, 5 ], [ 2, 0 ] ];
assert.deepEqual( sortPlotterCurves( [ [ curve ], [ [ [ 0, 0 ], [ 0, 0 ], [ 1, 0 ], [ 1, 0 ] ] ] ] )[ 1 ], [ curve.slice().reverse() ] );

console.log( 'ok' );
