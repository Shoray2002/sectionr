// assets tab — table & text → SVG generators, saved through the same native
// dialog path the projection export uses. Text is outlined into filled paths
// via opentype.js so exports render identically anywhere (no font needed).
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import * as opentypeNS from 'opentype.js';
import { buildTableSVG, buildTextSVG } from './tablesvg.js';

const opentype = opentypeNS.default ?? opentypeNS;
const API = 'http://127.0.0.1:8787';
const $ = ( id ) => document.getElementById( id );

// --- tabs ---
const tabs = document.querySelectorAll( '#tabs button' );
tabs.forEach( ( btn ) => btn.addEventListener( 'click', () => {

	tabs.forEach( b => b.classList.toggle( 'on', b === btn ) );
	[ 'app', 'assets', 'maptab' ].forEach( id => $( id ).style.display = id === btn.dataset.tab ? 'flex' : 'none' );
	window.dispatchEvent( new Event( 'resize' ) ); // canvases + leaflet re-fit on return

} ) );

// --- fonts: dropdown shared by both generators; Google Fonts via the sidecar
// (browsers only get subsetted woff2 — the sidecar fetches the full TTF), or a
// local ttf/otf/woff file. Parsed with opentype.js for outlining + metrics. ---
const fontSel = $( 'fontSel' );
export const otFonts = {}; // family -> opentype.Font (map tab reads Space Mono from here)

// glyph-by-glyph with kerning, bypassing opentype's GSUB feature pipeline
// (font.getPath crashes on some fonts' ccmp tables, e.g. Space Mono)
export function outline( font, text, fs, x, y ) {

	const scale = fs / font.unitsPerEm;
	let d = '', prev = null;
	for ( const ch of text ) {

		const g = font.charToGlyph( ch );
		if ( prev ) x += font.getKerningValue( prev, g ) * scale;
		d += g.getPath( x, y, fs ).toPathData( 3 );
		x += g.advanceWidth * scale;
		prev = g;

	}

	return d;

}

export function advance( font, text, fs ) {

	const scale = fs / font.unitsPerEm;
	let w = 0, prev = null;
	for ( const ch of text ) {

		const g = font.charToGlyph( ch );
		if ( prev ) w += font.getKerningValue( prev, g ) * scale;
		w += g.advanceWidth * scale;
		prev = g;

	}

	return w;

}

// per-call pathify/measure closures for the builders (undefined until the
// selected family has loaded — builders then fall back to <text>)
function pathify( fs ) {

	const font = otFonts[ fontSel.value ];
	return font && ( ( t, x, y ) => outline( font, t, fs, x, y ) );

}

function measure( fs ) {

	const font = otFonts[ fontSel.value ];
	return font && ( ( l ) => advance( font, l, fs ) );

}

function addFont( name, font ) {

	otFonts[ name ] = font;
	if ( ! [ ...fontSel.options ].some( o => o.value === name ) ) fontSel.add( new Option( name, name ) );
	fontSel.value = name;
	$( 'assetsStatus' ).innerText = `Loaded ${ name }`;
	renderPreviews();

}

async function loadGoogleFont( fam ) {

	const res = await fetch( `${ API }/gfont?family=${ encodeURIComponent( fam ) }` );
	if ( ! res.ok ) throw new Error( await res.text() );
	addFont( fam, opentype.parse( await res.arrayBuffer() ) );

}

$( 'gfLoad' ).addEventListener( 'click', async () => {

	const fam = $( 'gfName' ).value.trim();
	if ( ! fam ) return;
	$( 'assetsStatus' ).innerText = `Loading ${ fam }…`;
	try {

		await loadGoogleFont( fam );

	} catch ( e ) {

		$( 'assetsStatus' ).innerText = `Font load failed: ${ e.message }`;

	}

} );

$( 'fontUpload' ).addEventListener( 'click', () => $( 'fontFile' ).click() );
$( 'fontFile' ).addEventListener( 'change', async ( e ) => {

	const file = e.target.files[ 0 ];
	if ( ! file ) return;
	try {

		const font = opentype.parse( await file.arrayBuffer() );
		const names = font.names.windows ?? font.names.macintosh ?? font.names;
		addFont( names.fontFamily?.en ?? file.name.replace( /\.[^.]+$/, '' ), font );

	} catch ( err ) {

		$( 'assetsStatus' ).innerText = `Font load failed: ${ err.message }`;

	}
	e.target.value = ''; // allow re-uploading the same file

} );

function tableOpts() {

	const fontSize = + $( 'tblFont' ).value || 3;
	return {
		font: fontSel.value,
		fontSize,
		pathify: pathify( fontSize ),
		width: + $( 'tblWidth' ).value || 100,
		rows: Math.max( 1, + $( 'tblRows' ).value || 1 ),
		cols: Math.max( 1, + $( 'tblCols' ).value || 1 ),
		rowHeight: + $( 'tblRowH' ).value || 8,
		pad: + $( 'tblPad' ).value || 0,
		weights: $( 'tblColW' ).value.split( ',' ).map( Number ),
		cells: $( 'tblText' ).value.split( '\n' ).map( l => l.split( '|' ).map( s => s.trim() ) ),
		horizontal: $( 'tblH' ).checked,
		vertical: $( 'tblV' ).checked,
		border: $( 'tblBorder' ).checked,
		color: $( 'tblColor' ).value,
		strokeWidth: + $( 'tblStroke' ).value || 0.3,
	};

}

function textOpts() {

	const fontSize = + $( 'txtFont' ).value || 8;
	return {
		text: $( 'txtText' ).value,
		fontSize,
		lineHeight: + $( 'txtLH' ).value || 1.2,
		color: $( 'txtColor' ).value,
		font: fontSel.value,
		pathify: pathify( fontSize ),
		measure: measure( fontSize ),
	};

}

function renderPreviews() {

	$( 'tablePreview' ).innerHTML = buildTableSVG( tableOpts() );
	$( 'textPreview' ).innerHTML = buildTextSVG( textOpts() );

}

export async function exportSVG( svg, name, statusEl = 'assetsStatus' ) {

	const path = await save( { defaultPath: name, filters: [ { name: 'SVG', extensions: [ 'svg' ] } ] } );
	if ( ! path ) return;
	try {

		await invoke( 'save_svg', { path, content: svg } );
		$( statusEl ).innerText = `Saved ${ path }`;

	} catch ( e ) {

		$( statusEl ).innerText = `Save failed: ${ e }`;

	}

}

$( 'assetsPanel' ).addEventListener( 'input', renderPreviews );
$( 'tblExport' ).addEventListener( 'click', () => exportSVG( buildTableSVG( tableOpts() ), 'table.svg' ) );
$( 'txtExport' ).addEventListener( 'click', () => exportSVG( buildTextSVG( textOpts() ), 'text.svg' ) );

renderPreviews();
// default font arrives through the same loader as any other Google font
loadGoogleFont( 'Space Mono' ).catch( ( e ) => $( 'assetsStatus' ).innerText = `Space Mono load failed (sidecar running?): ${ e.message }` );
