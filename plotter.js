function length( p ) {

	let total = 0;
	for ( let i = 0; i < p.length - 2; i += 2 ) total += Math.hypot( p[ i + 2 ] - p[ i ], p[ i + 3 ] - p[ i + 1 ] );
	return total;

}

export function projectionSettings( style, angleThreshold, includeIntersectionEdges ) {

	if ( style === 'outline' ) return { angleThreshold: 180, includeIntersectionEdges: false };
	if ( style === 'plotter' ) return { angleThreshold: 70, includeIntersectionEdges: false };
	return { angleThreshold, includeIntersectionEdges };

}

function occupiedCells( p, minX, minY, cellSize ) {

	const cells = new Set();
	for ( let i = 0; i < p.length - 2; i += 2 ) {

		const ax = p[ i ], ay = p[ i + 1 ], bx = p[ i + 2 ], by = p[ i + 3 ];
		const steps = Math.max( 1, Math.ceil( Math.hypot( bx - ax, by - ay ) / ( cellSize * 0.5 ) ) );
		for ( let j = 0; j <= steps; j ++ ) {

			const t = j / steps;
			const x = Math.floor( ( ax + ( bx - ax ) * t - minX ) / cellSize );
			const y = Math.floor( ( ay + ( by - ay ) * t - minY ) / cellSize );
			cells.add( `${ x },${ y }` );

		}

	}
	return cells;

}

// Keep long, closed structural strokes first, then admit detail while each
// physical patch of the drawing remains below a local line budget.
export function filterPlotterPolylines( polys, maxDim, {
	minLengthMm = 1,
	cellSizeMm = 8,
	maxLinesPerCell = 5,
	minOpenCellFraction = 0.6,
} = {} ) {

	if ( ! polys.length || ! isFinite( maxDim ) || maxDim <= 0 ) return polys;
	const unitsPerMm = maxDim / 300;
	const minLength = minLengthMm * unitsPerMm;
	const cellSize = cellSizeMm * unitsPerMm;
	let minX = Infinity, minY = Infinity;
	for ( const p of polys ) for ( let i = 0; i < p.length; i += 2 ) {

		if ( p[ i ] < minX ) minX = p[ i ];
		if ( p[ i + 1 ] < minY ) minY = p[ i + 1 ];

	}

	const candidates = [];
	for ( const p of polys ) {

		const lineLength = length( p );
		if ( lineLength < minLength ) continue;
		const closed = Math.hypot( p[ 0 ] - p[ p.length - 2 ], p[ 1 ] - p[ p.length - 1 ] ) <= unitsPerMm * 0.1;
		candidates.push( { p, lineLength, score: lineLength * ( closed ? 1.5 : 1 ), cells: occupiedCells( p, minX, minY, cellSize ) } );

	}
	candidates.sort( ( a, b ) => b.score - a.score );

	const density = new Map();
	const kept = [];
	for ( const candidate of candidates ) {

		let open = 0;
		for ( const cell of candidate.cells ) if ( ( density.get( cell ) || 0 ) < maxLinesPerCell ) open ++;
		if ( kept.length && candidate.cells.size && open / candidate.cells.size < minOpenCellFraction ) continue;
		kept.push( candidate.p );
		for ( const cell of candidate.cells ) density.set( cell, ( density.get( cell ) || 0 ) + 1 );

	}
	return kept;

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
