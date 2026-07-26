// Pure SVG builder for the map tab (no DOM, no Tauri — testable in node).
// Adapted from maptoposter: road classes with per-class width/colour, water &
// parks as filled polygons, themed colours, spaced-caps title + coords footer.
// Output is a 1:√2 (A-series) portrait poster; all dimensions mm.
const f = ( n ) => + n.toFixed( 2 );
const esc = ( s ) => s.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );

export const ROAD_CLASSES = [ 'motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'paths' ];

// web mercator [lon,lat] -> [x,y] mm inside a W×H frame; bbox = [s,w,n,e].
// Matches the Leaflet selection frame exactly (both mercator).
export function projector( bbox, W, H ) {

	const my = ( lat ) => Math.log( Math.tan( Math.PI / 4 + lat * Math.PI / 360 ) );
	const [ s, w, n, e ] = bbox;
	const y0 = my( n ), ky = H / ( my( s ) - y0 ), kx = W / ( e - w );
	return ( lon, lat ) => [ ( lon - w ) * kx, ( my( lat ) - y0 ) * ky ];

}

// Liang-Barsky polyline clip to [0,W]×[0,H]; returns runs (a line may leave
// and re-enter the frame, splitting into several strokes)
export function clipLine( pts, W, H ) {

	const runs = [];
	let run = null;
	for ( let i = 1; i < pts.length; i ++ ) {

		const [ x, y ] = pts[ i - 1 ], dx = pts[ i ][ 0 ] - x, dy = pts[ i ][ 1 ] - y;
		let t0 = 0, t1 = 1, out = false;
		for ( const [ p, q ] of [ [ - dx, x ], [ dx, W - x ], [ - dy, y ], [ dy, H - y ] ] ) {

			if ( p === 0 ) { if ( q < 0 ) { out = true; break; } continue; }
			const r = q / p;
			if ( p < 0 ) { if ( r > t1 ) { out = true; break; } if ( r > t0 ) t0 = r; }
			else { if ( r < t0 ) { out = true; break; } if ( r < t1 ) t1 = r; }

		}

		if ( out ) { run = null; continue; }
		if ( ! ( run && t0 === 0 ) ) runs.push( run = [ [ x + t0 * dx, y + t0 * dy ] ] );
		run.push( [ x + t1 * dx, y + t1 * dy ] );
		if ( t1 < 1 ) run = null;

	}

	return runs;

}

const lerp = ( a, b, t ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ];

// radial-distance point thinning — OSM has nodes every few metres, a plotter
// doesn't need them closer than eps mm. Keeps first & last point.
export function thin( pts, eps ) {

	if ( ! ( eps > 0 ) || pts.length < 3 ) return pts;
	const out = [ pts[ 0 ] ];
	for ( let i = 1; i < pts.length - 1; i ++ ) {

		const a = out[ out.length - 1 ], p = pts[ i ];
		if ( Math.hypot( p[ 0 ] - a[ 0 ], p[ 1 ] - a[ 1 ] ) >= eps ) out.push( p );

	}

	out.push( pts[ pts.length - 1 ] );
	return out;

}

const runLen = ( run ) => {

	let L = 0;
	for ( let i = 1; i < run.length; i ++ ) L += Math.hypot( run[ i ][ 0 ] - run[ i - 1 ][ 0 ], run[ i ][ 1 ] - run[ i - 1 ][ 1 ] );
	return L;

};

// Sutherland-Hodgman polygon clip to [0,W]×[0,H]
export function clipRing( pts, W, H ) {

	let out = pts;
	for ( const [ inside, isect ] of [
		[ p => p[ 0 ] >= 0, ( a, b ) => lerp( a, b, ( 0 - a[ 0 ] ) / ( b[ 0 ] - a[ 0 ] ) ) ],
		[ p => p[ 0 ] <= W, ( a, b ) => lerp( a, b, ( W - a[ 0 ] ) / ( b[ 0 ] - a[ 0 ] ) ) ],
		[ p => p[ 1 ] >= 0, ( a, b ) => lerp( a, b, ( 0 - a[ 1 ] ) / ( b[ 1 ] - a[ 1 ] ) ) ],
		[ p => p[ 1 ] <= H, ( a, b ) => lerp( a, b, ( H - a[ 1 ] ) / ( b[ 1 ] - a[ 1 ] ) ) ],
	] ) {

		const inp = out;
		out = [];
		for ( let i = 0; i < inp.length; i ++ ) {

			const a = inp[ i ], b = inp[ ( i + 1 ) % inp.length ];
			if ( inside( a ) ) { out.push( a ); if ( ! inside( b ) ) out.push( isect( a, b ) ); }
			else if ( inside( b ) ) out.push( isect( a, b ) );

		}

		if ( ! out.length ) return [];

	}

	return out;

}

// chain multipolygon member ways (endpoint-matched fragments) into rings —
// rivers/lakes are almost always relations of open way pieces
export function stitchRings( ways ) {

	const key = ( p ) => p[ 0 ].toFixed( 7 ) + ',' + p[ 1 ].toFixed( 7 );
	const open = ways.filter( w => w.length > 1 ).map( w => [ ...w ] );
	const rings = [];
	while ( open.length ) {

		let ring = open.pop(), grew = true;
		while ( grew && key( ring[ 0 ] ) !== key( ring[ ring.length - 1 ] ) ) {

			grew = false;
			for ( let i = 0; i < open.length; i ++ ) {

				const w = open[ i ], end = key( ring[ ring.length - 1 ] );
				if ( key( w[ 0 ] ) === end ) ring = ring.concat( w.slice( 1 ) );
				else if ( key( w[ w.length - 1 ] ) === end ) ring = ring.concat( w.reverse().slice( 1 ) );
				else continue;
				open.splice( i, 1 );
				grew = true;
				break;

			}

		}

		rings.push( ring ); // unclosed leftovers get closed by the path Z

	}

	return rings;

}

// o: { width, bbox:[s,w,n,e], theme:{bg,text,water,parks,roads{cls}},
//      roads:{cls:[[[lon,lat],...],...]}, roadOn:{cls}, roadWidths:{cls},
//      water:[rings], parks:[rings], showWater, showParks, showBg,
//      minLen (mm, drop shorter residential/service/path strokes), simplify (mm, point thinning),
//      footer:{title,subtitle}|null, textPath?(t,x,y,fs), textWidth?(t,fs) }
export function buildMapSVG( o ) {

	const W = o.width, H = W * Math.SQRT2, t = o.theme;
	const mapH = o.footer ? H * 0.85 : H; // clean band below the map for the footer
	const proj = projector( o.bbox, W, mapH );
	const pt = ( p ) => `${ f( p[ 0 ] ) } ${ f( p[ 1 ] ) }`;
	const ringPath = ( rings ) => rings
		.map( r => thin( clipRing( r.map( p => proj( p[ 0 ], p[ 1 ] ) ), W, mapH ), o.simplify ) )
		.filter( r => r.length > 2 )
		.map( r => 'M' + r.map( pt ).join( 'L' ) + 'Z' )
		.join( '' );
	const linePath = ( lines, minLen ) => lines
		.flatMap( l => clipLine( l.map( p => proj( p[ 0 ], p[ 1 ] ) ), W, mapH ) )
		.map( run => thin( run, o.simplify ) )
		.filter( run => runLen( run ) >= minLen )
		.map( run => 'M' + run.map( pt ).join( 'L' ) )
		.join( '' );

	let body = '';
	if ( o.showBg ) body += `<rect width="${ f( W ) }" height="${ f( H ) }" fill="${ t.bg }"/>`;
	if ( o.showParks ) { const d = ringPath( o.parks ); if ( d ) body += `<path d="${ d }" fill="${ t.parks }" fill-rule="evenodd"/>`; }
	if ( o.showWater ) { const d = ringPath( o.water ); if ( d ) body += `<path d="${ d }" fill="${ t.water }" fill-rule="evenodd"/>`; }
	// minLen prunes stub-heavy minor layers only — majors are chopped into
	// short OSM ways at junctions, pruning those cuts visible gaps in roads
	const MINOR = new Set( [ 'residential', 'service', 'paths' ] );
	for ( const cls of [ ...ROAD_CLASSES ].reverse() ) { // minor first, motorways on top

		if ( ! o.roadOn[ cls ] ) continue;
		const d = linePath( o.roads[ cls ] ?? [], MINOR.has( cls ) ? o.minLen || 0 : 0 );
		if ( d ) body += `<path d="${ d }" fill="none" stroke="${ t.roads[ cls ] }" stroke-width="${ o.roadWidths[ cls ] }" stroke-linecap="round" stroke-linejoin="round"/>`;

	}

	if ( o.footer ) body += footerSVG( o, W, H );
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ f( W ) }mm" height="${ f( H ) }mm" viewBox="0 0 ${ f( W ) } ${ f( H ) }">${ body }</svg>`;

}

// maptoposter footer: spaced-caps title, divider, subtitle, lat/lon — centred.
// Outlined to paths when textPath/textWidth provided, <text> fallback otherwise.
function footerSVG( o, W, H ) {

	const t = o.theme;
	const [ s, w, n, e ] = o.bbox;
	const lat = ( s + n ) / 2, lon = ( w + e ) / 2;
	const coords = `${ Math.abs( lat ).toFixed( 4 ) }° ${ lat < 0 ? 'S' : 'N' } / ${ Math.abs( lon ).toFixed( 4 ) }° ${ lon < 0 ? 'W' : 'E' }`;
	const el = ( txt, y, fs ) => ! txt ? '' : o.textPath && o.textWidth
		? `<path d="${ o.textPath( txt, W / 2 - o.textWidth( txt, fs ) / 2, y, fs ) }" fill="${ t.text }"/>`
		: `<text x="${ f( W / 2 ) }" y="${ f( y ) }" font-size="${ f( fs ) }" text-anchor="middle" fill="${ t.text }" font-family="'Space Mono'" xml:space="preserve">${ esc( txt ) }</text>`;

	return el( ( o.footer.title || '' ).toUpperCase().split( '' ).join( ' ' ), H * 0.90, W / 16 )
		+ `<path d="M${ f( W * 0.4 ) } ${ f( H * 0.915 ) }H${ f( W * 0.6 ) }" stroke="${ t.text }" stroke-width="0.3"/>`
		+ el( o.footer.subtitle || '', H * 0.94, W / 40 )
		+ el( coords, H * 0.965, W / 48 );

}
