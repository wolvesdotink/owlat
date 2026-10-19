/**
 * The desktop SPA artifact gate's own tests.
 *
 * Each case writes a miniature `generate:desktop` output (route pages with SRI
 * hashes and an import map, an entry chunk with a lazy chunk in Vite's preload
 * list, a stylesheet with a font, the web and Nuxt app manifests) and runs the
 * real script against it, with one asset broken the way a bad build breaks it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-desktop-spa.ts');

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const sri = (source: string) => `sha384-${createHash('sha384').update(source).digest('base64')}`;

const ENTRY =
	'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./lazy.js","./page.css"])))=>i.map(i=>d[i]);\n' +
	'import{a}from"./shared.js";const p=()=>import("./lazy.js");\n';
const CSS =
	'@font-face{src:url(../_fonts/inter.woff2) format("woff2")}body{background:url("data:image/png;base64,AA")}';

type Files = Record<string, string | null>;

function page(files: Files): string {
	const entry = files['_nuxt/entry.js'] ?? '';
	const css = files['_nuxt/entry.css'] ?? '';
	return (
		'<!DOCTYPE html><html><head>' +
		`<script type="importmap">{"imports":{"#entry":"/_nuxt/entry.js"}}</script>` +
		`<link integrity="${sri(css)}" rel="stylesheet" href="/_nuxt/entry.css" crossorigin>` +
		`<link integrity="${sri(entry)}" rel="modulepreload" as="script" href="/_nuxt/entry.js">` +
		'<link rel="prefetch" as="script" href="/_nuxt/lazy.js">' +
		'<link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest">' +
		'<link rel="preconnect" href="https://fonts.example.com">' +
		`<script integrity="${sri(entry)}" type="module" src="/_nuxt/entry.js" crossorigin></script>` +
		'<script>window.__NUXT__={config:{app:{buildId:"b1",buildAssetsDir:"/_nuxt/"}}}</script>' +
		'</head><body><div id="__nuxt"></div></body></html>'
	);
}

/** A good build, with `overrides` applied (null deletes a file). */
function build(overrides: Files = {}, pages?: (files: Files) => Files): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-desktop-spa-'));
	sandboxes.push(root);
	const files: Files = {
		'_nuxt/entry.js': ENTRY,
		'_nuxt/shared.js': 'export const a=1;\n',
		'_nuxt/lazy.js': 'export default "lazy";\n',
		'_nuxt/page.css': '.x{}',
		'_nuxt/entry.css': CSS,
		'_fonts/inter.woff2': 'font',
		'_nuxt/builds/latest.json': '{"id":"b1","timestamp":1}',
		'_nuxt/builds/meta/b1.json': '{"id":"b1"}',
		'favicon.svg': '<svg/>',
		'icons/icon-192.png': 'png',
		'manifest.webmanifest': JSON.stringify({ icons: [{ src: '/icons/icon-192.png' }] }),
		...overrides,
	};
	const html = pages?.(files) ?? { 'index.html': page(files), 'dashboard/index.html': page(files) };
	for (const [path, contents] of Object.entries({ ...files, ...html })) {
		if (contents === null) continue;
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

function run(dist: string) {
	const result = spawnSync('bun', [SCRIPT, dist], { encoding: 'utf8' });
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

describe('the desktop SPA gate', () => {
	it('passes a complete build', () => {
		const result = run(build());
		expect(result.output).toContain('Desktop SPA OK: 2 pages');
		expect(result.output).toContain('6 integrity hashes verified');
		expect(result.status).toBe(0);
	});

	it('fails on a chunk the pages preload that was not emitted, once for all pages', () => {
		const result = run(build({ '_nuxt/lazy.js': null }));
		expect(result.output).toContain(
			'_nuxt/lazy.js is missing, linked as /_nuxt/lazy.js (in dashboard/index.html and 1 more)'
		);
		expect(result.output).toContain(
			'_nuxt/lazy.js is missing, linked as ./lazy.js (in _nuxt/entry.js)'
		);
		expect(result.status).toBe(1);
	});

	it('fails on a missing static import, font, icon or app manifest', () => {
		const result = run(
			build({
				'_nuxt/shared.js': null,
				'_fonts/inter.woff2': null,
				'icons/icon-192.png': null,
				'_nuxt/builds/meta/b1.json': null,
			})
		);
		expect(result.output).toContain(
			'_nuxt/shared.js is missing, linked as ./shared.js (in _nuxt/entry.js)'
		);
		expect(result.output).toContain(
			'_fonts/inter.woff2 is missing, linked as ../_fonts/inter.woff2'
		);
		expect(result.output).toContain('icons/icon-192.png is missing, linked as /icons/icon-192.png');
		expect(result.output).toContain('_nuxt/builds/meta/b1.json is missing');
		expect(result.status).toBe(1);
	});

	it('fails when an asset does not match the integrity hash the page carries', () => {
		const result = run(
			build({}, (files) => ({
				'index.html': page({ ...files, '_nuxt/entry.js': 'stale build' }),
			}))
		);
		expect(result.output).toContain(
			'_nuxt/entry.js does not match its integrity hash (in index.html)'
		);
		expect(result.status).toBe(1);
	});

	it('fails on a build id the app manifest does not know', () => {
		const result = run(build({ '_nuxt/builds/latest.json': '{"id":"b0"}' }));
		expect(result.output).toContain('_nuxt/builds/latest.json is build b0, the pages are b1');
		expect(result.status).toBe(1);
	});

	it('fails on references that escape the bundle, and on a page with no entry', () => {
		const result = run(
			build({}, () => ({
				'index.html': '<html><head><link rel="icon" href="../../secret.svg"></head></html>',
			}))
		);
		expect(result.output).toContain('../../secret.svg points outside the bundle');
		expect(result.output).toContain('no page loads a module script');
		expect(result.status).toBe(1);
	});

	it('fails when the bundle carries the service worker or precompressed copies', () => {
		const result = run(build({ 'sw.js': 'self.skipWaiting()', '_nuxt/entry.js.br': 'x' }));
		expect(result.output).toContain('sw.js is in the desktop bundle');
		expect(result.output).toContain('1 precompressed files, e.g. _nuxt/entry.js.br');
		expect(result.status).toBe(1);
	});

	it('exits 2 when there is no build to read', () => {
		const empty = mkdtempSync(join(tmpdir(), 'owlat-desktop-spa-empty-'));
		sandboxes.push(empty);
		const result = run(empty);
		expect(result.output).toContain('Run `bun run generate:desktop` in apps/web first');
		expect(result.status).toBe(2);
	});
});
