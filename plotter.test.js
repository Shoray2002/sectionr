// node plotter.test.js
import assert from 'node:assert';
import { projectionSettings, sortPlotterPolylines } from './plotter.js';

assert.deepEqual( projectionSettings( 'outline', 50, true ), { angleThreshold: 180, includeIntersectionEdges: false } );
assert.deepEqual( projectionSettings( 'plotter', 50, true ), { angleThreshold: 70, includeIntersectionEdges: false } );
assert.deepEqual( projectionSettings( 'detailed', 42, true ), { angleThreshold: 42, includeIntersectionEdges: true } );

// Nearest-neighbour ordering reverses a path when its end is closer.
const a = [ 0, 0, 1, 0 ], far = [ 20, 0, 21, 0 ], reversed = [ 10, 0, 2, 0 ];
const sorted = sortPlotterPolylines( [ far, reversed, a ] );
assert.deepEqual( sorted, [ a, [ 2, 0, 10, 0 ], far ] );

console.log( 'ok' );
