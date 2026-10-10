import fitCurve from 'fit-curve';

// Work on visibility-tested strokes, never on invented/lifted 3D contours.
// Schneider's fit-curve implementation takes a SQUARED model-space tolerance.

// Subtract only collinear retraces, including partial overlaps. Nearby parallel
// details and crossings are not duplicates; never thin them by the pen width.
export function removeOverlappingSegments( arr, epsilon ) {

	if ( ! arr.length ) return [];
	const segments = [];
	let minX = Infinity, minY = Infinity, maxX = - Infinity, maxY = - Infinity;
	for ( let i = 0; i < arr.length; i += 6 ) {

		const a = [ arr[ i ], arr[ i + 2 ] ], b = [ arr[ i + 3 ], arr[ i + 5 ] ];
		const length = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
		if ( ! length ) continue;
		segments.push( { a, b, length } );
		minX = Math.min( minX, a[ 0 ], b[ 0 ] ); minY = Math.min( minY, a[ 1 ], b[ 1 ] );
		maxX = Math.max( maxX, a[ 0 ], b[ 0 ] ); maxY = Math.max( maxY, a[ 1 ], b[ 1 ] );

	}
	const cell = Math.max( Math.max( maxX - minX, maxY - minY ) / 128, epsilon * 4 );
	const grid = new Map(), kept = [], out = [];
	const cells = ( a, b ) => {

		const keys = new Set();
		const steps = Math.ceil( Math.max( Math.abs( b[ 0 ] - a[ 0 ] ), Math.abs( b[ 1 ] - a[ 1 ] ) ) / cell );
		for ( let i = 0; i <= steps; i ++ ) {

			const t = steps ? i / steps : 0;
			const x = Math.floor( ( a[ 0 ] + t * ( b[ 0 ] - a[ 0 ] ) - minX ) / cell );
			const y = Math.floor( ( a[ 1 ] + t * ( b[ 1 ] - a[ 1 ] ) - minY ) / cell );
			for ( let dx = - 1; dx <= 1; dx ++ ) for ( let dy = - 1; dy <= 1; dy ++ ) keys.add( `${ x + dx },${ y + dy }` );

		}
		return keys;

	};
	// Retain the longest source strokes, avoiding fragmentation by tiny retraces.
	for ( const { a, b, length } of segments.sort( ( a, b ) => b.length - a.length ) ) {

		const ux = ( b[ 0 ] - a[ 0 ] ) / length, uy = ( b[ 1 ] - a[ 1 ] ) / length;
		const candidates = new Set();
		for ( const key of cells( a, b ) ) for ( const i of grid.get( key ) || [] ) candidates.add( i );
		let intervals = [ [ 0, length ] ];
		for ( const i of candidates ) {

			const [ c, d ] = kept[ i ];
			const cross = p => Math.abs( ux * ( p[ 1 ] - a[ 1 ] ) - uy * ( p[ 0 ] - a[ 0 ] ) );
			if ( cross( c ) > epsilon || cross( d ) > epsilon ) continue;
			const otherLength = Math.hypot( d[ 0 ] - c[ 0 ], d[ 1 ] - c[ 1 ] );
			const otherCross = p => Math.abs( ( d[ 0 ] - c[ 0 ] ) * ( p[ 1 ] - c[ 1 ] ) - ( d[ 1 ] - c[ 1 ] ) * ( p[ 0 ] - c[ 0 ] ) ) / otherLength;
			if ( otherCross( a ) > epsilon || otherCross( b ) > epsilon ) continue;
			const t0 = ux * ( c[ 0 ] - a[ 0 ] ) + uy * ( c[ 1 ] - a[ 1 ] );
			const t1 = ux * ( d[ 0 ] - a[ 0 ] ) + uy * ( d[ 1 ] - a[ 1 ] );
			const lo = Math.min( t0, t1 ), hi = Math.max( t0, t1 );
			intervals = intervals.flatMap( ( [ start, end ] ) => {

				if ( hi <= start || lo >= end ) return [ [ start, end ] ];
				const parts = [];
				if ( lo > start ) parts.push( [ start, lo ] );
				if ( hi < end ) parts.push( [ hi, end ] );
				return parts;

			} );
			if ( ! intervals.length ) break;

		}
		for ( const [ start, end ] of intervals ) {

			const c = start === 0 ? a : [ a[ 0 ] + ux * start, a[ 1 ] + uy * start ];
			const d = end === length ? b : [ a[ 0 ] + ux * end, a[ 1 ] + uy * end ];
			const i = kept.length;
			kept.push( [ c, d ] ); out.push( c[ 0 ], 0, c[ 1 ], d[ 0 ], 0, d[ 1 ] );
			for ( const key of cells( c, d ) ) {

				if ( ! grid.has( key ) ) grid.set( key, [] );
				grid.get( key ).push( i );

			}

		}

	}
	return out;

}

export function buildPolylines( arr, eps, minLen ) {

	const q = 1 / eps;
	const vid = new Map(), vx = [], vz = [];
	const id = ( x, z ) => {

		const gx = Math.floor( x * q ), gz = Math.floor( z * q );
		let nearest = - 1, distance = eps * eps;
		// Nearby endpoints can lie on opposite sides of a quantization cell.
		for ( let dx = - 1; dx <= 1; dx ++ ) for ( let dz = - 1; dz <= 1; dz ++ ) {

			for ( const i of vid.get( `${ gx + dx },${ gz + dz }` ) || [] ) {

				const d = ( vx[ i ] - x ) ** 2 + ( vz[ i ] - z ) ** 2;
				if ( d <= distance ) { nearest = i; distance = d; }

			}

		}
		if ( nearest !== - 1 ) return nearest;
		const i = vx.length, key = `${ gx },${ gz }`;
		if ( ! vid.has( key ) ) vid.set( key, [] );
		vid.get( key ).push( i ); vx.push( x ); vz.push( z );
		return i;

	};

	const adj = [];
	const seen = new Set();
	const ek = ( a, b ) => a < b ? a + '_' + b : b + '_' + a;
	for ( let i = 0; i < arr.length; i += 6 ) {

		const a = id( arr[ i ], arr[ i + 2 ] ), b = id( arr[ i + 3 ], arr[ i + 5 ] );
		if ( a === b ) continue;          // degenerate after welding
		const k = ek( a, b );
		if ( seen.has( k ) ) continue;    // duplicate edge — the doubling fix
		seen.add( k );
		( adj[ a ] || ( adj[ a ] = [] ) ).push( b );
		( adj[ b ] || ( adj[ b ] = [] ) ).push( a );

	}

	const used = new Set();
	const walk = ( start ) => {

		const line = [ vx[ start ], vz[ start ] ];
		let cur = start, previous = - 1;
		for ( ;; ) {

			let next = - 1;
			const available = ( adj[ cur ] || [] ).filter( n => ! used.has( ek( cur, n ) ) );
			if ( previous !== - 1 && adj[ cur ].length > 2 ) {

				const dx = vx[ cur ] - vx[ previous ], dz = vz[ cur ] - vz[ previous ];
				const ranked = available.map( n => ( { n, dot: ( dx * ( vx[ n ] - vx[ cur ] ) + dz * ( vz[ n ] - vz[ cur ] ) ) / ( Math.hypot( dx, dz ) * Math.hypot( vx[ n ] - vx[ cur ], vz[ n ] - vz[ cur ] ) ) } ) ).sort( ( a, b ) => b.dot - a.dot );
				// Continue a clear tangent through a T-junction, but stop when two
				// branches are ambiguous. Never choose by GPU/triangle output order.
				if ( ranked[ 0 ]?.dot >= Math.SQRT1_2 && ( ranked.length === 1 || ranked[ 0 ].dot - ranked[ 1 ].dot > 0.1 ) ) next = ranked[ 0 ].n;

			} else next = available[ 0 ] ?? - 1;
			if ( next === - 1 ) break;
			used.add( ek( cur, next ) );
			line.push( vx[ next ], vz[ next ] );
			previous = cur; cur = next;
			if ( cur === start ) break;

		}

		// Keep short connectors between junctions; pruning them opens outlines.
		line.connector = cur !== start && adj[ start ].length > 1 && adj[ cur ].length > 1;
		return line;

	};

	const hasUnused = ( i ) => ( adj[ i ] || [] ).some( n => ! used.has( ek( i, n ) ) );
	const polys = [];
	// Open endpoints first, then junctions, then leftover closed loops.
	for ( let i = 0; i < vx.length; i ++ ) if ( adj[ i ]?.length === 1 && hasUnused( i ) ) polys.push( walk( i ) );
	for ( let i = 0; i < vx.length; i ++ ) if ( adj[ i ]?.length > 2 ) while ( hasUnused( i ) ) polys.push( walk( i ) );
	for ( let i = 0; i < vx.length; i ++ ) while ( hasUnused( i ) ) polys.push( walk( i ) );

	return minLen > 0 ? polys.filter( p => p.connector || polyLen( p ) >= minLen ) : polys;

}

export function polyLen( p ) {

	let L = 0;
	for ( let i = 0; i < p.length - 2; i += 2 ) L += Math.hypot( p[ i + 2 ] - p[ i ], p[ i + 3 ] - p[ i + 1 ] );
	return L;

}

export function simplifyPoly( p, tol2 ) {

	const n = p.length / 2;
	if ( n < 3 ) return p;
	const keep = new Uint8Array( n );
	keep[ 0 ] = keep[ n - 1 ] = 1;
	const stack = [ [ 0, n - 1 ] ];
	while ( stack.length ) {

		const [ s, e ] = stack.pop();
		const ax = p[ s * 2 ], az = p[ s * 2 + 1 ], dx = p[ e * 2 ] - ax, dz = p[ e * 2 + 1 ] - az;
		const len2 = dx * dx + dz * dz || 1e-12;
		let maxD = - 1, idx = - 1;
		for ( let i = s + 1; i < e; i ++ ) {

			const px = p[ i * 2 ], pz = p[ i * 2 + 1 ];
			const t = Math.max( 0, Math.min( 1, ( ( px - ax ) * dx + ( pz - az ) * dz ) / len2 ) );
			const cx = ax + t * dx, cz = az + t * dz;
			const d = ( px - cx ) ** 2 + ( pz - cz ) ** 2;
			if ( d > maxD ) { maxD = d; idx = i; }

		}

		if ( maxD > tol2 ) { keep[ idx ] = 1; stack.push( [ s, idx ], [ idx, e ] ); }

	}

	const out = [];
	for ( let i = 0; i < n; i ++ ) if ( keep[ i ] ) out.push( p[ i * 2 ], p[ i * 2 + 1 ] );
	return out;

}

function distanceToSegment2( p, a, b ) {

	const dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ];
	const t = Math.max( 0, Math.min( 1, ( ( p[ 0 ] - a[ 0 ] ) * dx + ( p[ 1 ] - a[ 1 ] ) * dy ) / ( dx * dx + dy * dy || 1 ) ) );
	return ( p[ 0 ] - a[ 0 ] - t * dx ) ** 2 + ( p[ 1 ] - a[ 1 ] - t * dy ) ** 2;

}

// Adaptive subdivision is shared by the preview and the fitting safety check.
// SVG export retains the actual cubics, rather than this display approximation.
export function flattenCurves( curves, tolerance ) {

	if ( ! curves.length ) return [];
	const points = [ ...curves[ 0 ][ 0 ] ];
	const mid = ( a, b ) => [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
	for ( const curve of curves ) {

		const stack = [ curve ];
		while ( stack.length ) {

			const [ a, b, c, d ] = stack.pop();
			if ( Math.max( distanceToSegment2( b, a, d ), distanceToSegment2( c, a, d ) ) <= tolerance * tolerance ) {

				points.push( ...d );
				continue;

			}
			const ab = mid( a, b ), bc = mid( b, c ), cd = mid( c, d );
			const abc = mid( ab, bc ), bcd = mid( bc, cd ), center = mid( abc, bcd );
			stack.push( [ center, bcd, cd, d ], [ a, ab, abc, center ] );

		}

	}
	return points;

}

function straightCurves( points ) {

	return points.slice( 1 ).map( ( p, i ) => [ points[ i ], points[ i ], p, p ] );

}

export function fitPolyline( poly, tolerance ) {

	const points = [];
	for ( let i = 0; i < poly.length; i += 2 ) points.push( [ poly[ i ], poly[ i + 1 ] ] );
	if ( points.length < 3 || tolerance <= 0 ) return straightCurves( points );
	const closed = points[ 0 ][ 0 ] === points.at( - 1 )[ 0 ] && points[ 0 ][ 1 ] === points.at( - 1 )[ 1 ];
	const corner = ( a, b, c ) => {

		const ux = b[ 0 ] - a[ 0 ], uy = b[ 1 ] - a[ 1 ], vx = c[ 0 ] - b[ 0 ], vy = c[ 1 ] - b[ 1 ];
		return ux * vx + uy * vy < Math.cos( Math.PI / 4 ) * Math.hypot( ux, uy ) * Math.hypot( vx, vy );

	};
	// Start a closed polygon at a real corner when one exists. Smooth loops use
	// a shared seam tangent so circles do not acquire a kink at their first point.
	if ( closed ) {

		const ring = points.slice( 0, - 1 );
		const at = ring.findIndex( ( b, i ) => corner( ring[ ( i + ring.length - 1 ) % ring.length ], b, ring[ ( i + 1 ) % ring.length ] ) );
		if ( at >= 0 ) points.splice( 0, points.length, ...ring.slice( at ), ...ring.slice( 0, at ), ring[ at ] );

	}
	const chunks = [];
	let start = 0;
	for ( let i = 1; i < points.length - 1; i ++ ) {

		if ( corner( points[ i - 1 ], points[ i ], points[ i + 1 ] ) ) { chunks.push( points.slice( start, i + 1 ) ); start = i; }

	}
	chunks.push( points.slice( start ) );
	const curves = [];
	for ( const chunk of chunks ) {

		let fitted;
		if ( closed && chunks.length === 1 && ! corner( points.at( - 2 ), points[ 0 ], points[ 1 ] ) ) {

			const dx = points[ 1 ][ 0 ] - points.at( - 2 )[ 0 ], dy = points[ 1 ][ 1 ] - points.at( - 2 )[ 1 ];
			const len = Math.hypot( dx, dy );
			fitted = len ? fitCurve.fitCubic( chunk, [ dx / len, dy / len ], [ - dx / len, - dy / len ], tolerance ** 2 / 4 ) : straightCurves( chunk );

		} else fitted = fitCurve( chunk, tolerance ** 2 / 4 );
		// Point fitting alone can overshoot BETWEEN samples. Check the resulting
		// curve against the source stroke too; fall back locally when it deviates.
		const samples = flattenCurves( fitted, tolerance / 8 );
		let valid = true;
		for ( let i = 0; i < samples.length && valid; i += 2 ) {

			const p = [ samples[ i ], samples[ i + 1 ] ];
			valid = chunk.some( ( b, j ) => j > 0 && distanceToSegment2( p, chunk[ j - 1 ], b ) <= ( tolerance * 0.75 ) ** 2 );

		}
		curves.push( ...( valid ? fitted : straightCurves( chunk ) ) );

	}
	return curves;

}

export function curvesPath( paths, minX, minZ ) {

	// +Z is down on paper after PROJ_SWAP. Negating Z here flips the print.
	const point = p => `${ ( p[ 0 ] - minX ).toFixed( 6 ) } ${ ( p[ 1 ] - minZ ).toFixed( 6 ) }`;
	return paths.map( curves => {

		if ( ! curves.length ) return '';
		return `M${ point( curves[ 0 ][ 0 ] ) }` + curves.map( c =>
			c[ 0 ] === c[ 1 ] && c[ 2 ] === c[ 3 ] ? `L${ point( c[ 3 ] ) }` : `C${ point( c[ 1 ] ) } ${ point( c[ 2 ] ) } ${ point( c[ 3 ] ) }`
		).join( '' );

	} ).join( '' );

}

// Keep actual cubics: raster skeletons and curve refitting would change the art.
export function cleanPlotterCurves( paths, epsilon ) {

	const lines = [], curves = [], seen = new Set();
	for ( const path of paths ) for ( const c of path ) {

		const [ a, , , b ] = c;
		const dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ], length = Math.hypot( dx, dy );
		const length2 = dx * dx + dy * dy;
		if ( length && c.slice( 1, 3 ).every( p => {

			const dot = ( p[ 0 ] - a[ 0 ] ) * dx + ( p[ 1 ] - a[ 1 ] ) * dy;
			return Math.abs( dx * ( p[ 1 ] - a[ 1 ] ) - dy * ( p[ 0 ] - a[ 0 ] ) ) <= epsilon * length && dot >= 0 && dot <= length2;

		} ) ) {

			lines.push( a[ 0 ], 0, a[ 1 ], b[ 0 ], 0, b[ 1 ] );
			continue;

		}
		const key = JSON.stringify( c ), reverse = JSON.stringify( c.slice().reverse() );
		if ( seen.has( key ) || seen.has( reverse ) ) continue;
		seen.add( key ); curves.push( c );

	}
	const unique = removeOverlappingSegments( lines, epsilon );
	for ( let i = 0; i < unique.length; i += 6 ) {

		const a = [ unique[ i ], unique[ i + 2 ] ], b = [ unique[ i + 3 ], unique[ i + 5 ] ];
		curves.push( [ a, a, b, b ] );

	}
	// Exact shared endpoints can be plotted continuously, even at junctions.
	const key = p => `${ p[ 0 ].toFixed( 6 ) },${ p[ 1 ].toFixed( 6 ) }`;
	const adjacent = new Map();
	curves.forEach( ( c, i ) => {

		for ( const p of [ c[ 0 ], c[ 3 ] ] ) {

			const k = key( p );
			if ( ! adjacent.has( k ) ) adjacent.set( k, [] );
			adjacent.get( k ).push( i );

		}

	} );
	const used = new Set(), result = [];
	const walk = start => {

		let at = start;
		const path = [];
		for ( ;; ) {

			const next = adjacent.get( at ).find( i => ! used.has( i ) );
			if ( next === undefined ) break;
			used.add( next );
			const c = curves[ next ];
			const directed = key( c[ 0 ] ) === at ? c : c.slice().reverse();
			path.push( directed ); at = key( directed[ 3 ] );

		}
		if ( path.length ) result.push( path );

	};
	for ( const [ k, edges ] of adjacent ) if ( edges.length % 2 ) walk( k );
	for ( const k of adjacent.keys() ) walk( k );
	return result;

}
