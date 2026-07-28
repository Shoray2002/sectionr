// node centerline.test.js — pure skeleton parts (canvas rasterising is browser-only)
import assert from 'node:assert';
import { skeletonize } from './centerline.js';

const bitmap = ( w, h, on ) => {

	const img = new Uint8Array( w * h );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) if ( on( x, y ) ) img[ y * w + x ] = 1;
	return img;

};

// 3px-thick horizontal bar thins to a single centerline chain
{
	const w = 24, h = 9;
	const polys = skeletonize( bitmap( w, h, ( x, y ) => x >= 2 && x <= 21 && y >= 3 && y <= 5 ), w, h );
	assert.equal( polys.length, 1 );
	const xs = polys[ 0 ].map( p => p[ 0 ] ), ys = polys[ 0 ].map( p => p[ 1 ] );
	assert( Math.min( ...xs ) <= 4 && Math.max( ...xs ) >= 19 ); // spans the bar
	assert( ys.every( y => y >= 3 && y <= 5 ) );                 // stays on the centerline
}

// plus sign keeps all four arms, each edge drawn exactly once
{
	const w = 21, h = 21;
	const polys = skeletonize( bitmap( w, h, ( x, y ) => ( x >= 9 && x <= 11 && y >= 2 && y <= 18 ) || ( y >= 9 && y <= 11 && x >= 2 && x <= 18 ) ), w, h );
	const pts = polys.flat();
	assert( pts.some( ( [ x ] ) => x <= 4 ) && pts.some( ( [ x ] ) => x >= 16 ) );
	assert( pts.some( ( [ , y ] ) => y <= 4 ) && pts.some( ( [ , y ] ) => y >= 16 ) );
	const seen = new Set();
	for ( const poly of polys ) for ( let i = 1; i < poly.length; i ++ ) {

		const k = [ poly[ i - 1 ], poly[ i ] ].sort().join( ';' );
		assert( ! seen.has( k ), 'edge drawn twice: ' + k );
		seen.add( k );

	}
}

// isolated pixel (i-dot) becomes a 2-point dot the round cap can render
{
	const polys = skeletonize( bitmap( 5, 5, ( x, y ) => x === 2 && y === 2 ), 5, 5 );
	assert.deepEqual( polys, [ [ [ 2, 2 ], [ 2, 2 ] ] ] );
}

// closed loop (an 'O') traces as a cycle, no pixels lost
{
	const w = 15, h = 15;
	const ring = ( x, y ) => { const d = Math.hypot( x - 7, y - 7 ); return d >= 3.5 && d <= 6; };
	const polys = skeletonize( bitmap( w, h, ring ), w, h );
	assert( polys.flat().length >= 8 ); // the ring survives thinning
}

console.log( 'ok' );
