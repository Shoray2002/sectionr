export function projectionSettings( style, angleThreshold, includeIntersectionEdges ) {

	if ( style === 'outline' ) return { angleThreshold: 180, includeIntersectionEdges: false };
	if ( style === 'plotter' ) return { angleThreshold: 70, includeIntersectionEdges: false };
	return { angleThreshold, includeIntersectionEdges };

}

// Greedy nearest-neighbour ordering with path reversal. This changes only pen-up
// travel; path geometry and the rendered image remain identical.
export function sortPlotterPolylines( polys ) {

	if ( polys.length < 2 ) return polys.slice();
	if ( polys.length > 3000 ) {

		// Avoid quadratic export time for unfiltered detailed drawings.
		return polys.slice().sort( ( a, b ) => a[ 1 ] - b[ 1 ] || a[ 0 ] - b[ 0 ] );

	}
	const remaining = polys.slice();
	let first = 0;
	for ( let i = 1; i < remaining.length; i ++ ) {

		if ( remaining[ i ][ 0 ] < remaining[ first ][ 0 ] ) first = i;

	}
	const ordered = [ remaining.splice( first, 1 )[ 0 ] ];
	while ( remaining.length ) {

		const current = ordered[ ordered.length - 1 ];
		const x = current[ current.length - 2 ], y = current[ current.length - 1 ];
		let best = 0, reverse = false, bestD = Infinity;
		for ( let i = 0; i < remaining.length; i ++ ) {

			const p = remaining[ i ];
			const startD = ( p[ 0 ] - x ) ** 2 + ( p[ 1 ] - y ) ** 2;
			const endD = ( p[ p.length - 2 ] - x ) ** 2 + ( p[ p.length - 1 ] - y ) ** 2;
			if ( startD < bestD ) { best = i; reverse = false; bestD = startD; }
			if ( endD < bestD ) { best = i; reverse = true; bestD = endD; }

		}
		const next = remaining.splice( best, 1 )[ 0 ];
		if ( reverse ) {

			const reversed = [];
			for ( let i = next.length - 2; i >= 0; i -= 2 ) reversed.push( next[ i ], next[ i + 1 ] );
			ordered.push( reversed );

		} else ordered.push( next );

	}
	return ordered;

}
