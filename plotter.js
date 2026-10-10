export function projectionSettings( style, angleThreshold, includeIntersectionEdges ) {

	if ( style === 'outline' ) return { angleThreshold: 180, includeIntersectionEdges: false };
	if ( style === 'plotter' ) return { angleThreshold: 70, includeIntersectionEdges: false };
	return { angleThreshold, includeIntersectionEdges };

}

// Index both ends so detailed drawings also get nearest-neighbour ordering.
// Reversing a path changes pen-up travel only, never the geometry.
function sortPaths( paths, endpoints, reverse ) {

	if ( paths.length < 2 ) return paths.slice();
	const ends = paths.map( endpoints );
	let minX = Infinity, minY = Infinity, maxX = - Infinity, maxY = - Infinity;
	for ( const p of ends ) {

		minX = Math.min( minX, p[ 0 ], p[ 2 ] ); minY = Math.min( minY, p[ 1 ], p[ 3 ] );
		maxX = Math.max( maxX, p[ 0 ], p[ 2 ] ); maxY = Math.max( maxY, p[ 1 ], p[ 3 ] );

	}
	const cell = Math.max( maxX - minX, maxY - minY, 1e-9 ) / Math.min( 128, Math.ceil( Math.sqrt( paths.length ) ) );
	const grid = new Map(), used = new Uint8Array( paths.length ), ordered = [];
	ends.forEach( ( p, i ) => {

		for ( const end of [ 0, 2 ] ) {

			const key = `${ Math.floor( ( p[ end ] - minX ) / cell ) },${ Math.floor( ( p[ end + 1 ] - minY ) / cell ) }`;
			if ( ! grid.has( key ) ) grid.set( key, [] );
			grid.get( key ).push( { i, end } );

		}

	} );
	let first = 0;
	for ( let i = 1; i < paths.length; i ++ ) if ( ends[ i ][ 0 ] < ends[ first ][ 0 ] ) first = i;
	ordered.push( paths[ first ] ); used[ first ] = 1;
	let x = ends[ first ][ 2 ], y = ends[ first ][ 3 ];
	while ( ordered.length < paths.length ) {

		const gx = Math.floor( ( x - minX ) / cell ), gy = Math.floor( ( y - minY ) / cell );
		let best = - 1, bestEnd = 0, bestD = Infinity;
		for ( let radius = 0; ; radius ++ ) {

			for ( let dx = - radius; dx <= radius; dx ++ ) for ( let dy = - radius; dy <= radius; dy ++ ) {

				if ( radius && Math.abs( dx ) !== radius && Math.abs( dy ) !== radius ) continue;
				for ( const { i, end } of grid.get( `${ gx + dx },${ gy + dy }` ) || [] ) {

					if ( used[ i ] ) continue;
					const d = ( ends[ i ][ end ] - x ) ** 2 + ( ends[ i ][ end + 1 ] - y ) ** 2;
					if ( d < bestD || d === bestD && ( i < best || i === best && end < bestEnd ) ) { best = i; bestEnd = end; bestD = d; }

				}

			}
			const outside = Math.min( x - minX - ( gx - radius ) * cell, minX + ( gx + radius + 1 ) * cell - x,
				y - minY - ( gy - radius ) * cell, minY + ( gy + radius + 1 ) * cell - y );
			if ( best !== - 1 && outside ** 2 > bestD ) break;

		}
		used[ best ] = 1;
		ordered.push( bestEnd ? reverse( paths[ best ] ) : paths[ best ] );
		const nextEnd = bestEnd ? 0 : 2;
		x = ends[ best ][ nextEnd ]; y = ends[ best ][ nextEnd + 1 ];

	}
	return ordered;

}

export function sortPlotterPolylines( polys ) {

	return sortPaths( polys, p => [ p[ 0 ], p[ 1 ], p.at( - 2 ), p.at( - 1 ) ], p => {

		const reversed = [];
		for ( let i = p.length - 2; i >= 0; i -= 2 ) reversed.push( p[ i ], p[ i + 1 ] );
		return reversed;

	} );

}

export function sortPlotterCurves( paths ) {

	return sortPaths( paths, p => [ ...p[ 0 ][ 0 ], ...p.at( - 1 )[ 3 ] ], p => p.slice().reverse().map( c => c.slice().reverse() ) );

}
