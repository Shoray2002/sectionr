// node plotter.test.js
import assert from 'node:assert';
import { filterPlotterPolylines, projectionSettings, sortPlotterPolylines } from './plotter.js';

assert.deepEqual( projectionSettings( 'outline', 50, true ), { angleThreshold: 180, includeIntersectionEdges: false } );
assert.deepEqual( projectionSettings( 'plotter', 50, true ), { angleThreshold: 70, includeIntersectionEdges: false } );
assert.deepEqual( projectionSettings( 'detailed', 42, true ), { angleThreshold: 42, includeIntersectionEdges: true } );

const short = [ 0, 0, 0.5, 0 ];
const long = [ 0, 0, 20, 0 ];
assert.deepEqual( filterPlotterPolylines( [ short, long ], 300 ), [ long ] );

// Six lines occupy the same cells. The five-line local budget drops the shortest.
const crowded = Array.from( { length: 6 }, ( _, i ) => [ 0, i * 0.01, 20 - i, i * 0.01 ] );
const filtered = filterPlotterPolylines( crowded, 300 );
assert.equal( filtered.length, 5 );
assert( ! filtered.includes( crowded[ 5 ] ) );

// Nearest-neighbour ordering reverses a path when its end is closer.
const a = [ 0, 0, 1, 0 ], far = [ 20, 0, 21, 0 ], reversed = [ 10, 0, 2, 0 ];
const sorted = sortPlotterPolylines( [ far, reversed, a ] );
assert.deepEqual( sorted, [ a, [ 2, 0, 10, 0 ], far ] );

console.log( 'ok' );
