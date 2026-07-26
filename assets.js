// assets tab — table & text → SVG generators (Space Mono), saved through the
// same native dialog path the projection export uses.
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { buildTableSVG, buildTextSVG } from './tablesvg.js';

const $ = ( id ) => document.getElementById( id );

// --- tabs ---
const tabs = document.querySelectorAll( '#tabs button' );
tabs.forEach( ( btn ) => btn.addEventListener( 'click', () => {

	tabs.forEach( b => b.classList.toggle( 'on', b === btn ) );
	$( 'app' ).style.display = btn.dataset.tab === 'app' ? 'flex' : 'none';
	$( 'assets' ).style.display = btn.dataset.tab === 'assets' ? 'flex' : 'none';
	window.dispatchEvent( new Event( 'resize' ) ); // canvases re-fit on return

} ) );

function tableOpts() {

	return {
		width: + $( 'tblWidth' ).value || 100,
		rows: Math.max( 1, + $( 'tblRows' ).value || 1 ),
		cols: Math.max( 1, + $( 'tblCols' ).value || 1 ),
		rowHeight: + $( 'tblRowH' ).value || 8,
		fontSize: + $( 'tblFont' ).value || 3,
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

	return {
		text: $( 'txtText' ).value,
		fontSize: + $( 'txtFont' ).value || 8,
		lineHeight: + $( 'txtLH' ).value || 1.2,
		color: $( 'txtColor' ).value,
	};

}

function renderPreviews() {

	$( 'tablePreview' ).innerHTML = buildTableSVG( tableOpts() );
	$( 'textPreview' ).innerHTML = buildTextSVG( textOpts() );

}

async function exportSVG( svg, name ) {

	const path = await save( { defaultPath: name, filters: [ { name: 'SVG', extensions: [ 'svg' ] } ] } );
	if ( ! path ) return;
	try {

		await invoke( 'save_svg', { path, content: svg } );
		$( 'assetsStatus' ).innerText = `Saved ${ path }`;

	} catch ( e ) {

		$( 'assetsStatus' ).innerText = `Save failed: ${ e }`;

	}

}

$( 'assetsPanel' ).addEventListener( 'input', renderPreviews );
$( 'tblExport' ).addEventListener( 'click', () => exportSVG( buildTableSVG( tableOpts() ), 'table.svg' ) );
$( 'txtExport' ).addEventListener( 'click', () => exportSVG( buildTextSVG( textOpts() ), 'text.svg' ) );

renderPreviews();
