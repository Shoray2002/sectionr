import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { cleanPlotterCurves, curvesPath, flattenCurves, polyLen } from '../linework.js';
import { sortPlotterCurves } from '../plotter.js';

function parsePath( d ) {

	const token = /[MLC]|[-+]?(?:\d*\.?\d+)(?:[eE][-+]?\d+)?/g;
	if ( d.replace( token, '' ).replace( /[\s,]/g, '' ) ) throw new Error( 'Only Sectionr M/L/C paths are supported.' );
	const tokens = d.match( token ) || [], paths = [];
	let at;
	for ( let i = 0; i < tokens.length; ) {

		const command = tokens[ i ++ ], count = command === 'C' ? 6 : 2;
		if ( ! [ 'M', 'L', 'C' ].includes( command ) ) throw new Error( 'Missing path command.' );
		const values = tokens.slice( i, i + count ).map( Number ); i += count;
		if ( values.length !== count || ! values.every( Number.isFinite ) ) throw new Error( 'Invalid path coordinates.' );
		const end = values.slice( - 2 );
		if ( command === 'M' ) paths.push( [] );
		else {

			if ( ! at ) throw new Error( 'Path must begin with M.' );
			paths.at( - 1 ).push( command === 'L' ? [ at, at, end, end ] : [ at, values.slice( 0, 2 ), values.slice( 2, 4 ), end ] );

		}
		at = end;

	}
	return paths.filter( p => p.length );

}

function metrics( paths, mm ) {

	let penDown = 0, penUp = 0;
	paths.forEach( ( p, i ) => {

		penDown += polyLen( flattenCurves( p, 0.001 / mm ) ) * mm;
		if ( i ) {

			const a = paths[ i - 1 ].at( - 1 )[ 3 ], b = p[ 0 ][ 0 ];
			penUp += Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] ) * mm;

		}

	} );
	return { strokes: paths.length, penDownMm: penDown, penUpMm: penUp };

}

export function cleanSvg( source ) {

	const doc = new DOMParser( { onError: ( level, message ) => { throw new Error( message ); } } ).parseFromString( source, 'image/svg+xml' );
	const root = doc.documentElement;
	if ( root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || doc.doctype ) throw new Error( 'Expected a Sectionr SVG.' );
	const box = root.getAttribute( 'viewBox' ).trim().split( /[\s,]+/ ).map( Number );
	const width = root.getAttribute( 'width' );
	const height = root.getAttribute( 'height' );
	if ( box.length !== 4 || ! box.every( Number.isFinite ) || box[ 2 ] <= 0 || box[ 3 ] <= 0 || ! [ width, height ].every( d => /^\d+(?:\.\d+)?mm$/.test( d ) && Number.isFinite( parseFloat( d ) ) && parseFloat( d ) > 0 ) ) throw new Error( 'Expected a viewBox and positive millimetre dimensions.' );
	const mm = parseFloat( width ) / box[ 2 ], report = [];
	for ( const el of Array.from( doc.getElementsByTagName( '*' ) ) ) {

		const isRoot = el === root;
		const allowed = isRoot ? [ 'xmlns', 'width', 'height', 'viewBox' ] : [ 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin' ];
		if ( ! isRoot && ( el.localName !== 'path' || el.namespaceURI !== root.namespaceURI || el.parentNode !== root ) || Array.from( el.attributes ).some( a => ! allowed.includes( a.name ) ) ) throw new Error( 'Only plain Sectionr paths are supported; transforms, styles and other elements must not be silently changed.' );
		if ( isRoot ) continue;
		const strokeWidth = Number( el.getAttribute( 'stroke-width' ) );
		if ( el.getAttribute( 'fill' ) !== 'none' || el.getAttribute( 'stroke-linecap' ) !== 'round' || el.getAttribute( 'stroke-linejoin' ) !== 'round' || ! /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test( el.getAttribute( 'stroke' ) ) || ! Number.isFinite( strokeWidth ) || strokeWidth <= 0 ) throw new Error( 'Expected opaque, round, unfilled strokes. Removing real fills would change the artwork.' );
		const before = parsePath( el.getAttribute( 'd' ) );
		// Exported coordinates have six decimals: allow only serialization noise.
		const after = sortPlotterCurves( cleanPlotterCurves( before, 2e-6 ) );
		el.setAttribute( 'd', curvesPath( after, 0, 0 ) );
		report.push( { before: metrics( before, mm ), after: metrics( after, mm ) } );

	}
	return { svg: new XMLSerializer().serializeToString( doc ), report };

}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( resolve( process.argv[ 1 ] ) ).href ) {

	try {

		const [ input, output ] = process.argv.slice( 2 );
		if ( ! input || ! output || resolve( input ) === resolve( output ) ) throw new Error( 'Usage: npm run clean-svg -- input.svg new-output.svg (original is preserved)' );
		const { svg, report } = cleanSvg( readFileSync( input, 'utf8' ) );
		writeFileSync( output, svg, { flag: 'wx' } );
		console.log( JSON.stringify( report, null, 2 ) );

	} catch ( error ) {

		console.error( error.message ); process.exitCode = 1;

	}

}
