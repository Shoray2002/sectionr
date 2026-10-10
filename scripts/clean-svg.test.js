import assert from 'node:assert/strict';
import { cleanSvg } from './clean-svg.js';

const svg = d => `<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="200mm" viewBox="0 0 30 20"><path d="${ d }" fill="none" stroke="#111111" stroke-width="0.03" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const input = svg( 'M0 0L10 0M5 0L15 0M10 0C10 5 15 5 15 0' );
const { svg: output, report } = cleanSvg( input );
assert( output.includes( 'width="300mm" height="200mm" viewBox="0 0 30 20"' ) );
assert( output.includes( 'fill="none"' ) && output.includes( 'stroke-width="0.03"' ) );
assert( output.includes( 'C10.000000 5.000000 15.000000 5.000000 15.000000 0.000000' ) || output.includes( 'C15.000000 5.000000 10.000000 5.000000 10.000000 0.000000' ) );
assert( Math.abs( report[ 0 ].before.penDownMm - report[ 0 ].after.penDownMm - 50 ) < 1e-7 );
assert.equal( cleanSvg( output ).report[ 0 ].after.penDownMm, report[ 0 ].after.penDownMm );
for ( const bad of [ input.replace( 'fill="none"', 'fill="black"' ), input.replace( '<path ', '<path transform="scale(2)" ' ), input.replace( '</svg>', '<circle r="1"/></svg>' ), svg( 'M0 0Q1 1 2 2' ), svg( 'M0 0L1' ), svg( 'L0 0' ), '<svg' ] ) assert.throws( () => cleanSvg( bad ) );
console.log( 'SVG cleanup: dimensions, cubics, stroke union and rejection of unsafe artwork changes passed' );
