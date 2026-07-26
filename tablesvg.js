// Pure SVG builders for the assets tab (no DOM, no Tauri — testable in node).
// Space Mono is monospace with a 0.6em advance, so text width is exact
// without measuring: chars * 0.6 * fontSize. All dimensions are mm.
export const MONO_ADVANCE = 0.6;
const FONT = "'Space Mono', ui-monospace, monospace";

const esc = ( s ) => s.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
const f = ( n ) => + n.toFixed( 3 ); // trim float noise from coordinates

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
	for ( let r = 0; r < o.rows; r ++ ) for ( let c = 0, x = 0; c < o.cols; c ++ ) {

		const t = o.cells[ r ]?.[ c ];
		// baseline = row middle + half cap height (~0.35em) — avoids
		// dominant-baseline, which plotter/design tools often ignore
		if ( t ) texts += `<text x="${ f( x + o.pad ) }" y="${ f( r * o.rowHeight + o.rowHeight / 2 + o.fontSize * 0.35 ) }">${ esc( t ) }</text>`;
		x += colW[ c ];

	}

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ f( o.width ) }mm" height="${ f( H ) }mm" viewBox="0 0 ${ f( o.width ) } ${ f( H ) }" font-family="${ FONT }" font-size="${ o.fontSize }" xml:space="preserve">
  <g fill="none" stroke="${ o.color }" stroke-width="${ o.strokeWidth }">${ lines }</g>
  <g fill="${ o.color }">${ texts }</g>
</svg>`;

}

// o: { text, fontSize, lineHeight, color }
export function buildTextSVG( o ) {

	const lines = o.text.split( '\n' );
	const fs = o.fontSize, lh = o.lineHeight * fs;
	const W = Math.max( 1, ...lines.map( l => l.length ) ) * MONO_ADVANCE * fs;
	const H = ( lines.length - 1 ) * lh + fs * 1.05; // 1.05em covers ascent + descent
	const texts = lines.map( ( l, i ) => l.trim() ? `<text x="0" y="${ f( i * lh + fs * 0.8 ) }">${ esc( l ) }</text>` : '' ).join( '' );
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${ f( W ) }mm" height="${ f( H ) }mm" viewBox="0 0 ${ f( W ) } ${ f( H ) }" font-family="${ FONT }" font-size="${ fs }" fill="${ o.color }" xml:space="preserve">${ texts }</svg>`;

}
