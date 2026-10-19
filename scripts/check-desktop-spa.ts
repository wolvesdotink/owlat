#!/usr/bin/env bun
/**
 * Inspects the real desktop SPA: the static `generate:desktop` build the Tauri
 * app packages (tauri.conf.json `build.frontendDist`).
 *
 * Desktop PR CI compiles the Rust shell against a one-line placeholder
 * index.html, and the real bundle was only ever built inside the signed release
 * job. A build that emitted an index.html pointing at a chunk, stylesheet, font
 * or icon it did not write would ship: the packaged app has no server to fall
 * back to, so the window stays blank or the asset is just missing. This reads a
 * finished build and fails when
 * - a `<script>`, `<link>` or `<img>` in any emitted HTML page, or the import
 *   map, points at a local file that does not exist,
 * - a referenced file's bytes do not match its `integrity` hash (the webview
 *   refuses to run it),
 * - the web app manifest's icons, or Nuxt's app manifest (`builds/latest.json`
 *   and the meta file for the page's `buildId`), are missing,
 * - a JS chunk or stylesheet reached from those pages references a sibling
 *   chunk, stylesheet or font that does not exist (static and lazy imports,
 *   Vite's preload lists, CSS `url()`), or
 * - the build carries what the desktop bundle must never contain: the service
 *   worker (`sw.js`) or precompressed `.gz`/`.br` copies (apps/web/nuxt.config.ts).
 *
 * Usage: bun scripts/check-desktop-spa.ts [path/to/dist]
 *   (defaults to tauri.conf.json's frontendDist; run `bun run generate:desktop`
 *   in apps/web first). CI: the desktop-spa job in .github/workflows/test.yml.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const tauriDir = join(workspace, 'apps/desktop/src-tauri');

function defaultDist(): string {
	const config = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8')) as {
		build?: { frontendDist?: string };
	};
	const dist = config.build?.frontendDist;
	if (!dist) {
		console.error('check-desktop-spa: tauri.conf.json has no build.frontendDist.');
		process.exit(2);
	}
	return resolve(tauriDir, dist);
}

const dist = resolve(process.argv[2] ?? defaultDist());
if (!existsSync(join(dist, 'index.html'))) {
	console.error(
		`check-desktop-spa: no index.html in ${dist}.\n` +
			'Run `bun run generate:desktop` in apps/web first.'
	);
	process.exit(2);
}

const show = (path: string) => relative(dist, path).split(sep).join('/');

/**
 * Findings, each with the files it was found in: 134 route pages share one
 * entry, so a broken entry asset is one finding, not 134.
 */
const problems = new Map<string, Set<string>>();
function problem(message: string, from?: string): void {
	const where = problems.get(message) ?? new Set<string>();
	if (from) where.add(show(from));
	problems.set(message, where);
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else out.push(path);
	}
	return out;
}

const files = walk(dist);

/**
 * The file a reference names, or null when it is not a local file (another
 * origin, data:/blob:, a fragment). `/x` is the dist root, anything else is
 * relative to the referencing file.
 */
function localTarget(ref: string, from: string): string | null {
	const url = ref.trim();
	if (url === '' || url.startsWith('#') || url.startsWith('//')) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
	const path = decodeURI(url.replace(/[?#].*$/, ''));
	const target = path.startsWith('/') ? join(dist, path) : join(dirname(from), path);
	if (!target.startsWith(dist + sep)) {
		problem(`${ref} points outside the bundle`, from);
		return null;
	}
	return target;
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

/** Files to read for further references, each once. */
const queue: string[] = [];
const seen = new Set<string>();
let checked = 0;

function reference(ref: string, from: string): string | null {
	const target = localTarget(ref, from);
	if (target === null) return null;
	checked += 1;
	if (!isFile(target)) {
		problem(`${show(target)} is missing, linked as ${ref}`, from);
		return null;
	}
	if (!seen.has(target)) {
		seen.add(target);
		queue.push(target);
	}
	return target;
}

const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(tag: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const match of tag.matchAll(ATTRIBUTE)) {
		out.set((match[1] as string).toLowerCase(), match[2] ?? match[3] ?? '');
	}
	return out;
}

const digests = new Map<string, string>();

/** Whether the file matches one of the `integrity` attribute's hashes. */
function integrityMatches(integrity: string, file: string): boolean {
	return integrity
		.split(/\s+/)
		.filter(Boolean)
		.some((token) => {
			const [algorithm, expected] = token.split('-', 2) as [string, string | undefined];
			if (!['sha256', 'sha384', 'sha512'].includes(algorithm) || !expected) return false;
			const key = `${algorithm}:${file}`;
			let digest = digests.get(key);
			if (digest === undefined) {
				digest = createHash(algorithm).update(readFileSync(file)).digest('base64');
				digests.set(key, digest);
			}
			return digest === expected.replace(/\?.*$/, '');
		});
}

let entries = 0;
let verifiedIntegrity = 0;
const buildIds = new Map<string, string>();
let buildAssetsDir: string | undefined;
let manifestLink: { ref: string; from: string } | undefined;

const pages = files.filter((file) => file.endsWith('.html'));
for (const page of pages) {
	const html = readFileSync(page, 'utf8');
	for (const match of html.matchAll(/<(script|link|img)\b([^>]*)>/gi)) {
		const tag = (match[1] as string).toLowerCase();
		const attrs = attributes(match[2] as string);
		const ref = tag === 'link' ? attrs.get('href') : attrs.get('src');
		if (ref === undefined) continue;
		const target = reference(ref, page);
		if (tag === 'script' && attrs.get('type') === 'module' && target) entries += 1;
		if (tag === 'link' && attrs.get('rel') === 'manifest') manifestLink ??= { ref, from: page };
		const integrity = attrs.get('integrity');
		if (integrity && target) {
			verifiedIntegrity += 1;
			if (!integrityMatches(integrity, target)) {
				problem(`${show(target)} does not match its integrity hash`, page);
			}
		}
	}
	for (const match of html.matchAll(/<script\b[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/gi)) {
		const map = JSON.parse(match[1] as string) as { imports?: Record<string, string> };
		for (const target of Object.values(map.imports ?? {})) reference(target, page);
	}
	const buildId = /\bbuildId:"([^"]+)"/.exec(html)?.[1];
	if (buildId) buildIds.set(page, buildId);
	buildAssetsDir ??= /\bbuildAssetsDir:"([^"]+)"/.exec(html)?.[1];
}
if (entries === 0) problem('no page loads a module script; the build has no entry');

// The web app manifest (index.html <link rel="manifest">) and its icons.
if (manifestLink) {
	const target = localTarget(manifestLink.ref, manifestLink.from);
	if (target && isFile(target)) {
		const manifest = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
		const images = ['icons', 'screenshots'].flatMap((key) =>
			Array.isArray(manifest[key]) ? (manifest[key] as { src?: string }[]) : []
		);
		for (const image of images) if (image.src) reference(image.src, target);
	}
}

// Nuxt's app manifest: at boot the client fetches builds/meta/<buildId>.json
// for the build id in its page, and builds/latest.json to spot a newer build.
// Both are required, and checked independently of each other.
const assetsDir = `/${(buildAssetsDir ?? '/_nuxt/').replace(/^\/+|\/+$/g, '')}/`;
const pageBuilds = new Set(buildIds.values());
if (pageBuilds.size === 0) problem('no page carries a Nuxt buildId');
if (pageBuilds.size > 1) problem(`the pages carry ${pageBuilds.size} different build ids`);
for (const [page, id] of buildIds) reference(`${assetsDir}builds/meta/${id}.json`, page);
const latest = join(dist, `${assetsDir}builds/latest.json`);
if (!isFile(latest)) {
	problem(`${show(latest)} is missing`);
} else {
	const { id } = JSON.parse(readFileSync(latest, 'utf8')) as { id?: string };
	if (!id || !pageBuilds.has(id)) {
		problem(`${show(latest)} is build ${id}, the pages are ${[...pageBuilds].join(', ')}`);
	}
}

/**
 * Sibling-file references inside a chunk: `import("./x.js")`, `from "./x.js"`,
 * Vite's `__vite__mapDeps` preload lists and build-assets-dir paths. The whole
 * string literal is captured, query and fragment included, and `localTarget`
 * strips those; a literal counts as a file reference when its path ends in an
 * asset extension. Template literals with a `${}` hole are computed, not files.
 */
const assetsDirPattern = assetsDir.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const JS_REFERENCE = new RegExp(
	`["'\`]((?:\\.{1,2}/|${assetsDirPattern})[^"'\`\\s\\\\]*)["'\`]`,
	'g'
);
const ASSET_PATH = /\.(?:m?js|css|json|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|avif)$/;
const CSS_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|@import\s+["']([^"']+)["']/g;

while (queue.length > 0) {
	const file = queue.shift() as string;
	if (/\.m?js$/.test(file)) {
		for (const match of readFileSync(file, 'utf8').matchAll(JS_REFERENCE)) {
			const ref = match[1] as string;
			if (!ref.includes('${') && ASSET_PATH.test(ref.replace(/[?#].*$/, ''))) reference(ref, file);
		}
	} else if (file.endsWith('.css')) {
		for (const match of readFileSync(file, 'utf8').matchAll(CSS_REFERENCE)) {
			const ref = match[1] ?? match[2] ?? match[3] ?? match[4];
			if (ref) reference(ref, file);
		}
	}
}

if (isFile(join(dist, 'sw.js')))
	problem('sw.js is in the desktop bundle; service workers do not apply there');
const precompressed = files.filter((file) => /\.(gz|br)$/.test(file));
if (precompressed.length > 0) {
	problem(`${precompressed.length} precompressed files, e.g. ${show(precompressed[0] as string)}`);
}

if (problems.size > 0) {
	console.error(`The desktop SPA at ${dist} is incomplete:\n`);
	for (const [message, where] of problems) {
		const [first, ...rest] = [...where].sort();
		const from = first ? ` (in ${first}${rest.length > 0 ? ` and ${rest.length} more` : ''})` : '';
		console.error(`  - ${message}${from}`);
	}
	process.exit(1);
}
console.info(
	`Desktop SPA OK: ${pages.length} pages, ${checked} local references to ${seen.size} files, ` +
		`${verifiedIntegrity} integrity hashes verified.`
);
