#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Email block preview generator.
 *
 * Renders all 18 block types through the real renderEmailHtml() pipeline
 * and writes standalone HTML files that can be opened in a browser or
 * sent to an email testing tool (Litmus, Email on Acid, etc.).
 *
 * Usage:
 *   bun src/preview/generate.ts          # generate previews
 *   bun src/preview/generate.ts --open   # generate and open in browser
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { renderEmailHtml } from '../renderer';
import { kitchenSinkBlocks, blockFixtures } from './fixtures';
import type { BlockType } from '@owlat/shared';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PKG_ROOT = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
const OUT_DIR = resolve(PKG_ROOT, 'previews');
const BLOCKS_DIR = resolve(OUT_DIR, 'blocks');

// ---------------------------------------------------------------------------
// Ensure output directories exist
// ---------------------------------------------------------------------------

mkdirSync(BLOCKS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Generate kitchen-sink (light)
// ---------------------------------------------------------------------------

const kitchenSinkHtml = renderEmailHtml(kitchenSinkBlocks, {
	title: 'Kitchen Sink — All Email Blocks',
	preheaderText: 'Preview of all 18 email block types',
	inlineCss: true,
});

const kitchenSinkPath = resolve(OUT_DIR, 'kitchen-sink.html');
writeFileSync(kitchenSinkPath, kitchenSinkHtml, 'utf-8');
console.log(`  kitchen-sink.html`);

// ---------------------------------------------------------------------------
// Generate kitchen-sink (dark mode)
// ---------------------------------------------------------------------------

const kitchenSinkDarkHtml = renderEmailHtml(kitchenSinkBlocks, {
	title: 'Kitchen Sink — Dark Mode',
	preheaderText: 'Dark mode preview of all 18 email block types',
	darkMode: true,
	inlineCss: true,
});

const darkPath = resolve(OUT_DIR, 'kitchen-sink-dark.html');
writeFileSync(darkPath, kitchenSinkDarkHtml, 'utf-8');
console.log(`  kitchen-sink-dark.html`);

// ---------------------------------------------------------------------------
// Generate per-block previews
// ---------------------------------------------------------------------------

const blockTypes = Object.keys(blockFixtures) as BlockType[];

for (const blockType of blockTypes) {
	const blocks = blockFixtures[blockType];
	const html = renderEmailHtml(blocks, {
		title: `Block Preview — ${blockType}`,
		preheaderText: `Preview of the ${blockType} block`,
		inlineCss: true,
	});

	const filePath = resolve(BLOCKS_DIR, `${blockType}.html`);
	writeFileSync(filePath, html, 'utf-8');
	console.log(`  blocks/${blockType}.html`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totalFiles = blockTypes.length + 2; // kitchen-sink + dark + per-block
console.log(`\nGenerated ${totalFiles} preview files in ${OUT_DIR}`);

// ---------------------------------------------------------------------------
// Open in browser (--open flag)
// ---------------------------------------------------------------------------

if (process.argv.includes('--open')) {
	try {
		execSync(`open "${kitchenSinkPath}"`);
		console.log('\nOpened kitchen-sink.html in default browser');
	} catch {
		console.log(`\nCould not auto-open. Manually open:\n  ${kitchenSinkPath}`);
	}
}
