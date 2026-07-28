// node tablesvg.test.js
import assert from 'node:assert';
import { buildTableSVG, buildTextSVG } from './tablesvg.js';

const svg = buildTableSVG( {
	width: 100, rows: 2, cols: 2, rowHeight: 10, fontSize: 3, pad: 2,
	weights: [ 1, 3 ], cells: [ [ 'a', 'b&c' ] ],
	horizontal: true, vertical: true, border: true, color: '#fff', strokeWidth: 0.3,
} );
assert( svg.includes( 'viewBox="0 0 100 20"' ) );
assert( svg.includes( 'M25 0V20' ) );              // vertical divider at weight 1/4
assert( svg.includes( 'M0 10H100' ) );             // horizontal divider between rows
assert( svg.includes( 'b&amp;c' ) );               // XML escaping
assert( svg.match( /<text/g ).length === 2 );      // empty row 2 emits no text

const txt = buildTextSVG( { text: 'ab\ncdef', fontSize: 10, lineHeight: 1.2, color: '#fff' } );
assert( txt.includes( 'width="24mm"' ) );          // 4 chars * 0.6em * 10mm
assert( txt.includes( 'height="22.5mm"' ) );       // 1 gap * 12 + 10.5
assert( txt.match( /<text/g ).length === 2 );
assert( txt.includes( `font-family="'Space Mono'"` ) );

// custom font + proportional measure override
const inter = buildTextSVG( { text: 'ab', fontSize: 10, lineHeight: 1.2, color: '#fff', font: 'Inter', measure: () => 42 } );
assert( inter.includes( `font-family="'Inter'"` ) );
assert( inter.includes( 'width="42mm"' ) );

// pathify: text becomes outlined paths, no <text> elements
const outlined = buildTextSVG( { text: 'ab', fontSize: 10, lineHeight: 1.2, color: '#fff', measure: () => 42, pathify: ( t, x, y ) => `M${ x } ${ y }h5` } );
assert( outlined.includes( '<path d="M0 8h5"' ) );      // baseline at 0.8em
assert( ! outlined.includes( '<text' ) );
const outTbl = buildTableSVG( {
	width: 100, rows: 1, cols: 1, rowHeight: 10, fontSize: 3, pad: 2,
	weights: [ 1 ], cells: [ [ 'a' ] ], horizontal: false, vertical: false, border: false,
	color: '#fff', strokeWidth: 0.3, pathify: ( t, x, y ) => `M${ x } ${ y }h5`,
} );
assert( outTbl.includes( '<path d="M2 6.05h5"' ) );     // x=pad, y=rowMid+0.35em
assert( ! outTbl.includes( '<text' ) );

// textStroke: centerline text is stroked at pen width, not filled
const strokedTxt = buildTextSVG( { text: 'ab', fontSize: 10, lineHeight: 1.2, color: '#fff', measure: () => 42, pathify: () => 'M0 0h5', textStroke: 0.35 } );
assert( strokedTxt.includes( 'fill="none" stroke="#fff" stroke-width="0.35" stroke-linecap="round"' ) );
const strokedTbl = buildTableSVG( {
	width: 100, rows: 1, cols: 1, rowHeight: 10, fontSize: 3, pad: 2,
	weights: [ 1 ], cells: [ [ 'a' ] ], horizontal: false, vertical: false, border: false,
	color: '#fff', strokeWidth: 0.3, pathify: () => 'M0 0h5', textStroke: 0.3,
} );
assert( strokedTbl.includes( '<g fill="none" stroke="#fff" stroke-width="0.3" stroke-linecap="round"' ) );

console.log( 'ok' );
