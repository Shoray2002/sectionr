// Single-line ("centerline") text for pen plotting, from ANY outline font:
// rasterise the glyph outlines, thin the ink to a 1px skeleton (Zhang-Suen),
// trace the skeleton into polylines, map back to mm. The result is stroked at
// pen width — one pass per stem — instead of a filled (double-edged) outline.
// Approximate by nature: junctions can wobble a fraction of a pen width.
// skeletonize() is pure and node-testable; centerlineText() needs a canvas.
import { thin } from './mapsvg.js';

const f = ( n ) => + n.toFixed( 3 );

// glyph-by-glyph with kerning, bypassing opentype's GSUB feature pipeline
// (font.getPath crashes on some fonts' ccmp tables, e.g. Space Mono)
export function outline( font, text, fs, x, y ) {

	const scale = fs / font.unitsPerEm;
	let d = '', prev = null;
	for ( const ch of text ) {

		const g = font.charToGlyph( ch );
		if ( prev ) x += font.getKerningValue( prev, g ) * scale;
		d += g.getPath( x, y, fs ).toPathData( 3 );
		x += g.advanceWidth * scale;
		prev = g;

	}

	return d;

}

export function advance( font, text, fs ) {

	const scale = fs / font.unitsPerEm;
	let w = 0, prev = null;
	for ( const ch of text ) {

		const g = font.charToGlyph( ch );
		if ( prev ) w += font.getKerningValue( prev, g ) * scale;
		w += g.advanceWidth * scale;
		prev = g;

	}

	return w;

}

// Zhang-Suen thinning + skeleton tracing. img: Uint8Array(w*h) of 0/1 ink
// (mutated in place). Returns pixel polylines [[x,y],...] covering every
// skeleton edge exactly once; isolated pixels come back as 2-point dots.
export function skeletonize( img, w, h ) {

	const idx = ( x, y ) => y * w + x;
	const del = [];
	let changed = true;
	while ( changed ) {

		changed = false;
		for ( const step of [ 0, 1 ] ) {

			del.length = 0;
			for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

				if ( ! img[ idx( x, y ) ] ) continue;
				const p2 = img[ idx( x, y - 1 ) ], p3 = img[ idx( x + 1, y - 1 ) ], p4 = img[ idx( x + 1, y ) ], p5 = img[ idx( x + 1, y + 1 ) ],
					p6 = img[ idx( x, y + 1 ) ], p7 = img[ idx( x - 1, y + 1 ) ], p8 = img[ idx( x - 1, y ) ], p9 = img[ idx( x - 1, y - 1 ) ];
				const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
				if ( B < 2 || B > 6 ) continue;
				const seq = [ p2, p3, p4, p5, p6, p7, p8, p9, p2 ];
				let A = 0;
				for ( let i = 0; i < 8; i ++ ) if ( seq[ i ] === 0 && seq[ i + 1 ] === 1 ) A ++;
				if ( A !== 1 ) continue;
				if ( step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8 ) continue;
				del.push( idx( x, y ) );

			}

			if ( del.length ) { changed = true; for ( const i of del ) img[ i ] = 0; }

		}

	}

	// trace: walk unused edges between 8-adjacent pixels, breaking at junctions.
	// Diagonal hops are dropped when an orthogonal ink pixel already links the
	// two — staircase triangles otherwise read as junctions and shred chains
	// into hundreds of 1-edge strokes (a pen lift each).
	const N8 = [ [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ], [ 1, 1 ], [ 1, - 1 ], [ - 1, 1 ], [ - 1, - 1 ] ];
	const nbrs = ( x, y ) => {

		const out = [];
		for ( const [ dx, dy ] of N8 ) {

			const a = x + dx, b = y + dy;
			if ( a < 0 || b < 0 || a >= w || b >= h || ! img[ idx( a, b ) ] ) continue;
			if ( dx && dy && ( img[ idx( a, y ) ] || img[ idx( x, b ) ] ) ) continue;
			out.push( [ a, b ] );

		}

		return out;

	};
	const ekey = ( a, b, c, d ) => a < c || a === c && b < d ? `${ a },${ b },${ c },${ d }` : `${ c },${ d },${ a },${ b }`;
	const used = new Set();
	const pixels = [];
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) if ( img[ idx( x, y ) ] ) pixels.push( [ x, y ] );
	const polys = [];
	// endpoints & junctions first so chains start/stop there; leftover loops after
	const starts = [ ...pixels.filter( ( [ x, y ] ) => nbrs( x, y ).length !== 2 ), ...pixels ];
	for ( const [ sx, sy ] of starts ) {

		for ( ;; ) {

			let cur = [ sx, sy ];
			let nxt = nbrs( sx, sy ).find( ( [ a, b ] ) => ! used.has( ekey( sx, sy, a, b ) ) );
			if ( ! nxt ) break;
			const poly = [ cur ];
			used.add( ekey( sx, sy, nxt[ 0 ], nxt[ 1 ] ) );
			while ( nxt ) {

				poly.push( nxt );
				cur = nxt;
				const open = nbrs( cur[ 0 ], cur[ 1 ] ).filter( ( [ a, b ] ) => ! used.has( ekey( cur[ 0 ], cur[ 1 ], a, b ) ) );
				nxt = open.length === 1 ? open[ 0 ] : null; // stop at junctions & ends
				if ( nxt ) used.add( ekey( cur[ 0 ], cur[ 1 ], nxt[ 0 ], nxt[ 1 ] ) );

			}

			polys.push( poly );

		}

	}

	for ( const [ x, y ] of pixels ) if ( ! nbrs( x, y ).length ) polys.push( [ [ x, y ], [ x, y ] ] ); // i-dots, periods
	return polys;

}

const PX_EM = 96; // raster resolution per em — stems stay ≥3px down to ~2mm text
const cache = new Map(); // previews rebuild per keystroke; skeletons don't change

// centerline path data for text with its baseline at (x, y) in mm
export function centerlineText( font, fontKey, text, fs, x, y ) {

	const key = `${ fontKey }|${ fs }|${ text }`;
	const hit = cache.get( key );
	if ( hit !== undefined ) return shift( hit, x, y );
	const PAD = 4, base = Math.ceil( PX_EM * 1.1 );
	const s = PX_EM / fs; // px per mm
	const w = Math.ceil( advance( font, text, PX_EM ) ) + 2 * PAD;
	const h = Math.ceil( PX_EM * 1.5 ) + 2 * PAD;
	const cv = document.createElement( 'canvas' );
	cv.width = w;
	cv.height = h;
	const ctx = cv.getContext( '2d', { willReadFrequently: true } );
	ctx.fill( new Path2D( outline( font, text, PX_EM, PAD, base ) ) );
	const rgba = ctx.getImageData( 0, 0, w, h ).data;
	const img = new Uint8Array( w * h );
	for ( let i = 0; i < img.length; i ++ ) img[ i ] = rgba[ i * 4 + 3 ] > 127 ? 1 : 0;
	// polylines relative to the text origin, in mm — cacheable across (x, y)
	const runs = skeletonize( img, w, h )
		.map( poly => thin( poly.map( ( [ px, py ] ) => [ ( px - PAD ) / s, ( py - base ) / s ] ), 1 / s ) );
	if ( cache.size > 300 ) cache.clear(); // ponytail: crude cap beats an LRU here
	cache.set( key, runs );
	return shift( runs, x, y );

}

const shift = ( runs, x, y ) => runs
	.map( run => 'M' + run.map( p => `${ f( p[ 0 ] + x ) } ${ f( p[ 1 ] + y ) }` ).join( 'L' ) )
	.join( '' );
