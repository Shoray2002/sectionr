// Pure SVG builders for the assets tab (no DOM, no Tauri — testable in node).
// Default font is Space Mono (0.6em advance, so text width is exact without
// measuring); pass o.font to override and o.measure (line -> mm width) for
// proportional fonts. All dimensions are mm.
export const MONO_ADVANCE = 0.6;
const fontAttr = ( o ) => `'${ ( o.font || 'Space Mono' ).replace( /'/g, '' ) }'`;

const esc = ( s ) => s.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
const f = ( n ) => + n.toFixed( 3 ); // trim float noise from coordinates
// with o.pathify (text, x, baselineY) -> svg path data, text exports as filled
// outlines — renders identically everywhere, no font needed. Without it, plain
// <text> referencing the family by name.
const textEl = ( o ) => o.pathify
	? ( t, x, y ) => `<path d="${ o.pathify( t, x, y ) }"/>`
	: ( t, x, y ) => `<text x="${ f( x ) }" y="${ f( y ) }">${ esc( t ) }</text>`;

// o.textStroke (pen width, mm) means pathify yields centerlines: stroke them
// once at pen width instead of filling — plotters can't fill
const textAttrs = ( o ) => o.textStroke
	? `fill="none" stroke="${ o.color }" stroke-width="${ o.textStroke }" stroke-linecap="round" stroke-linejoin="round"`
	: `fill="${ o.color }"`;

// o: { width, rows, cols, rowHeight, fontSize, pad, weights[], cells[][],
//      horizontal, vertical, border, color, strokeWidth }
export function buildTableSVG( o ) {

	const weights = Array.from( { length: o.cols }, ( _, i ) => o.weights[ i ] > 0 ? o.weights[ i ] : 1 );
	const sum = weights.reduce( ( a, b ) => a + b, 0 );
	const colW = weights.map( w => o.width * w / sum );
	const H = o.rows * o.rowHeight;

	let lines = '';
	if ( o.border ) lines += `<rect x="0" y="0" width="${ f( o.width ) }" height="${ f( H ) }"/>`;
	if ( o.horizontal ) for ( let r = 1; r < o.rows; r ++ ) lines += `<path d="M0 ${ f( r * o.rowHeight ) }H${ f( o.width ) }"/>`;
	if ( o.vertical ) for ( let c = 0, x = 0; c < o.cols - 1; c ++ ) { x += colW[ c ]; lines += `<path d="M${ f( x ) } 0V${ f( H ) }"/>`; }

	let texts = '';
	const el = textEl( o );
	for ( let r = 0; r < o.rows; r ++ ) for ( let c = 0, x = 0; c < o.cols; c ++ ) {

		const t = o.cells[ r ]?.[ c ];
		// baseline = row middle + half cap height (~0.35em) — avoids
		// dominant-baseline, which plotter/design tools often ignore
		if ( t ) texts += el( t, x + o.pad, r * o.rowHeight + o.rowHeight / 2 + o.fontSize * 0.35 );
		x += colW[ c ];

	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ f( o.width ) }mm" height="${ f( H ) }mm" viewBox="0 0 ${ f( o.width ) } ${ f( H ) }" font-family="${ fontAttr( o ) }" font-size="${ o.fontSize }" xml:space="preserve">
  <g fill="none" stroke="${ o.color }" stroke-width="${ o.strokeWidth }">${ lines }</g>
  <g ${ textAttrs( o ) }>${ texts }</g>
</svg>`;

}

// o: { text, fontSize, lineHeight, color, font?, measure?, pathify? }
export function buildTextSVG( o ) {

	const lines = o.text.split( '\n' );
	const fs = o.fontSize, lh = o.lineHeight * fs;
	const measure = o.measure || ( ( l ) => l.length * MONO_ADVANCE * fs );
	const W = Math.max( 1, ...lines.map( measure ) );
	const H = ( lines.length - 1 ) * lh + fs * 1.05; // 1.05em covers ascent + descent
	const el = textEl( o );
	const texts = lines.map( ( l, i ) => l.trim() ? el( l, 0, i * lh + fs * 0.8 ) : '' ).join( '' );
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ f( W ) }mm" height="${ f( H ) }mm" viewBox="0 0 ${ f( W ) } ${ f( H ) }" font-family="${ fontAttr( o ) }" font-size="${ fs }" ${ textAttrs( o ) } xml:space="preserve">${ texts }</svg>`;

}
