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

console.log( 'ok' );
