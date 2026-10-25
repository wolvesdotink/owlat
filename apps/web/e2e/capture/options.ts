/**
 * Everything `bun run capture` decides before a browser starts: the parsed
 * command line, the app URL, the output directory, the presentation a pair of
 * captures shares, and the files a run will write. Pure apart from the
 * filesystem reads the caller passes in, so the rules are unit tested.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeProjectName, resolveDevStackConfig } from '../../../../scripts/dev-stack/config';

export class CaptureUsageError extends Error {}

export type Theme = 'light' | 'dark';

export interface Viewport {
	readonly width: number;
	readonly height: number;
}

export interface CaptureRequest {
	readonly label: string;
	/** Surface names, in the order given. */
	readonly surfaces: readonly string[];
	/** Extra app routes to capture as they render, e.g. `/dashboard/files`. */
	readonly paths: readonly string[];
	readonly out: string | undefined;
	readonly url: string | undefined;
	readonly theme: Theme | undefined;
	readonly viewport: Viewport | undefined;
	readonly fullPage: boolean;
	readonly force: boolean;
	readonly list: boolean;
	readonly help: boolean;
}

/**
 * Letters and digits only. The file name is `<label>-<shot>.png`, and a dash in
 * the label could make two different label/shot pairs produce the same name.
 */
const LABEL = /^[a-z0-9]{1,24}$/;
const VIEWPORT = /^(\d{3,4})x(\d{3,4})$/;

export function parseCaptureArgs(argv: readonly string[]): CaptureRequest {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				surface: { type: 'string', multiple: true },
				path: { type: 'string', multiple: true },
				out: { type: 'string' },
				url: { type: 'string' },
				theme: { type: 'string' },
				viewport: { type: 'string' },
				'full-page': { type: 'boolean', default: false },
				force: { type: 'boolean', default: false },
				list: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
		});
	} catch (error) {
		throw new CaptureUsageError(error instanceof Error ? error.message : String(error));
	}
	const { values, positionals } = parsed;
	const help = values.help === true;
	const list = values.list === true;
	if (positionals.length > 1) {
		throw new CaptureUsageError(`Expected one label, got ${positionals.join(' ')}.`);
	}
	const label = positionals[0] ?? '';
	const surfaces = (values.surface ?? []).flatMap((value) =>
		value
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean)
	);
	const paths = values.path ?? [];
	if (!help && !list) {
		if (!LABEL.test(label)) {
			throw new CaptureUsageError(
				`The label must be lowercase letters and digits (before, after, after2), got "${label}".`
			);
		}
		if (surfaces.length + paths.length === 0) {
			throw new CaptureUsageError('Name at least one --surface or --path to capture.');
		}
	}
	return {
		label,
		surfaces,
		paths,
		out: values.out,
		url: values.url,
		theme: parseTheme(values.theme),
		viewport: parseViewport(values.viewport),
		fullPage: values['full-page'] === true,
		force: values.force === true,
		list,
		help,
	};
}

function parseTheme(raw: string | undefined): Theme | undefined {
	if (raw === undefined) return undefined;
	if (raw === 'light' || raw === 'dark') return raw;
	throw new CaptureUsageError(`--theme must be light or dark, got "${raw}".`);
}

function parseViewport(raw: string | undefined): Viewport | undefined {
	if (raw === undefined) return undefined;
	const match = VIEWPORT.exec(raw);
	const width = Number(match?.[1]);
	const height = Number(match?.[2]);
	if (!match || width < 320 || height < 320) {
		throw new CaptureUsageError(`--viewport must be WIDTHxHEIGHT, each 320 or more, got "${raw}".`);
	}
	return { width, height };
}

/** One PNG a run writes: the shot's name and the file it lands in. */
export interface PlannedShot {
	readonly name: string;
	/** Set for a `--path` shot; a surface shot names a registered surface instead. */
	readonly path?: string;
	readonly file: string;
}

/** C0 controls and DEL; the URL parser drops tabs and newlines inside a route. */
function hasControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * The absolute URL of an app route, or null unless it stays on the app's
 * origin: the browser is signed in as the seeded owner, and a capture of any
 * other site must never pass for evidence of this app. The origin is checked
 * on the URL as the browser resolves it, because the parser rewrites a route
 * first (`/\t/example.com` becomes `//example.com`, another host). A
 * backslash is refused outright, since browsers read it as a slash.
 */
export function appRouteUrl(route: string, appUrl: string): URL | null {
	if (!route.startsWith('/') || route.includes('\\') || hasControlCharacter(route)) {
		return null;
	}
	const origin = new URL(appUrl).origin;
	const url = new URL(route, origin);
	return url.origin === origin ? url : null;
}

/** Any origin works: only whether the route keeps it matters. */
const PLACEHOLDER_ORIGIN = 'http://localhost';

/** A `--path` route becomes the shot `path-<slug>`; see {@link appRouteUrl} for which are accepted. */
export function pathShotName(path: string): string {
	if (!appRouteUrl(path, PLACEHOLDER_ORIGIN)) {
		throw new CaptureUsageError(
			`--path must be an app route starting with "/", got ${JSON.stringify(path)}.`
		);
	}
	const slug = path
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return `path-${slug || 'root'}`;
}

/**
 * The files a run will write, in capture order. Refuses unknown surfaces, two
 * shots with one name, and (without `--force`) a file that already exists, so
 * re-running "before" after the edit cannot replace the evidence of the
 * original state. Only this label's files are ever named: the other label's
 * captures in the same directory are never touched.
 *
 * Surfaces run in registry order, whatever order the flags name them in. The
 * registry lists the surfaces that change local data first (opening a message
 * marks it read), so both labels of a pair see that data in the same state.
 */
export function planShots(
	request: Pick<CaptureRequest, 'label' | 'surfaces' | 'paths' | 'force'>,
	outDir: string,
	knownSurfaces: readonly string[],
	exists: (file: string) => boolean
): PlannedShot[] {
	const unknown = request.surfaces.filter((name) => !knownSurfaces.includes(name));
	if (unknown.length > 0) {
		throw new CaptureUsageError(
			`Unknown surface ${unknown.join(', ')}. Known: ${knownSurfaces.join(', ')}.`
		);
	}
	const pathShots = request.paths.map((path) => ({ name: pathShotName(path), path }));
	const seen = new Set<string>();
	for (const name of [...request.surfaces, ...pathShots.map((shot) => shot.name)]) {
		if (seen.has(name)) {
			throw new CaptureUsageError(`The shot "${name}" is requested twice.`);
		}
		seen.add(name);
	}
	const shots: PlannedShot[] = [
		...knownSurfaces.filter((name) => seen.has(name)).map((name) => ({ name })),
		...pathShots,
	].map((shot) => ({ ...shot, file: join(outDir, `${request.label}-${shot.name}.png`) }));
	const existing = shots.filter((shot) => exists(shot.file));
	if (existing.length > 0 && !request.force) {
		throw new CaptureUsageError(
			`Already captured: ${existing.map((shot) => shot.file).join(', ')}. ` +
				'Pass --force to replace them, or use a new --out for a new pair.'
		);
	}
	return shots;
}

/** Symlinks resolved, including for a path whose tail does not exist yet. */
function realpathLoose(path: string): string {
	let current = path;
	const tail: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(current), ...tail.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			tail.push(current.slice(parent.length).replace(/^[/\\]+/, ''));
			current = parent;
		}
	}
}

/**
 * Where a checkout's captures go unless `--out` says otherwise: the user cache,
 * one directory per checkout (the same identity the dev stack's Compose
 * project uses), so two worktrees never mix their pairs.
 */
export function defaultOutputDir(root: string, env: NodeJS.ProcessEnv): string {
	const cache = env['XDG_CACHE_HOME'] || join(homedir(), '.cache');
	return join(cache, 'owlat-captures', composeProjectName(root));
}

/**
 * The absolute output directory. Captures are PR evidence and must never land
 * in the tree, so a directory inside the checkout is refused, also when a
 * symlink outside points back into it.
 */
export function resolveOutputDir(
	requested: string | undefined,
	root: string,
	cwd: string,
	env: NodeJS.ProcessEnv
): string {
	const absolute = resolve(cwd, requested ?? defaultOutputDir(root, env));
	const real = realpathLoose(absolute);
	const realRoot = realpathLoose(root);
	const inside = relative(realRoot, real);
	// `..` as a whole first segment, not as a prefix: `..shots` is a directory
	// inside the checkout.
	const outside = isAbsolute(inside) || /^\.\.(?:[/\\]|$)/.test(inside);
	if (!outside) {
		throw new CaptureUsageError(
			`The output directory ${absolute} is inside the checkout. Captures are PR evidence ` +
				'and never go into the tree; pick a directory outside it.'
		);
	}
	return absolute;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The app the capture signs in to: `--url`, or this checkout's `dev:stack` web
 * URL (the same port resolution, `OWLAT_PORT_OFFSET` included). Only a local
 * app is accepted, because the capture types the seeded credentials into it.
 */
export function resolveAppUrl(
	explicit: string | undefined,
	root: string,
	linkedWorktree: boolean,
	env: NodeJS.ProcessEnv
): string {
	if (explicit === undefined) {
		return resolveDevStackConfig({
			explicit: env['OWLAT_PORT_OFFSET'],
			root,
			linkedWorktree,
		}).urls.web;
	}
	let url: URL;
	try {
		url = new URL(explicit);
	} catch {
		throw new CaptureUsageError(`--url must be an absolute URL, got "${explicit}".`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new CaptureUsageError(`--url must be http or https, got "${explicit}".`);
	}
	if (!LOOPBACK.has(url.hostname)) {
		throw new CaptureUsageError(
			`--url must point at a local app (localhost), got host "${url.hostname}".`
		);
	}
	return url.origin;
}

/**
 * The presentation every capture in one output directory shares. The first
 * run records it; later runs reuse it, so "before" and "after" have the same
 * viewport and theme and see the same clock (relative times such as "5m ago"
 * would otherwise differ between the two).
 */
export interface CaptureManifest {
	readonly version: 1;
	/** ISO time the app's clock starts at in every run of the pair. */
	readonly clock: string;
	readonly theme: Theme;
	readonly viewport: Viewport;
	readonly fullPage: boolean;
}

export const MANIFEST_FILE = 'capture.json';
export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900 };

export function parseManifest(raw: string, file: string): CaptureManifest {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CaptureUsageError(`${file} is not valid JSON; delete it to start a new pair.`);
	}
	const manifest = value as Partial<CaptureManifest> | null;
	const viewport = manifest?.viewport;
	if (
		manifest?.version !== 1 ||
		typeof manifest.clock !== 'string' ||
		Number.isNaN(Date.parse(manifest.clock)) ||
		(manifest.theme !== 'light' && manifest.theme !== 'dark') ||
		typeof viewport?.width !== 'number' ||
		typeof viewport.height !== 'number' ||
		typeof manifest.fullPage !== 'boolean'
	) {
		throw new CaptureUsageError(
			`${file} is not a capture manifest; delete it to start a new pair.`
		);
	}
	return manifest as CaptureManifest;
}

/**
 * The manifest for this run: the recorded one, or a new one from the flags.
 * A flag that disagrees with the recorded pair is refused instead of silently
 * producing a capture that does not match its partner.
 */
export function settleManifest(
	recorded: CaptureManifest | null,
	request: Pick<CaptureRequest, 'theme' | 'viewport' | 'fullPage'>,
	now: Date
): { manifest: CaptureManifest; created: boolean } {
	if (!recorded) {
		return {
			manifest: {
				version: 1,
				clock: now.toISOString(),
				theme: request.theme ?? 'light',
				viewport: request.viewport ?? DEFAULT_VIEWPORT,
				fullPage: request.fullPage,
			},
			created: true,
		};
	}
	const conflicts: string[] = [];
	if (request.theme !== undefined && request.theme !== recorded.theme) {
		conflicts.push(`--theme ${request.theme} (recorded: ${recorded.theme})`);
	}
	const viewport = request.viewport;
	if (
		viewport !== undefined &&
		(viewport.width !== recorded.viewport.width || viewport.height !== recorded.viewport.height)
	) {
		conflicts.push(
			`--viewport ${viewport.width}x${viewport.height} (recorded: ${recorded.viewport.width}x${recorded.viewport.height})`
		);
	}
	if (request.fullPage && !recorded.fullPage) {
		conflicts.push('--full-page (recorded: viewport only)');
	}
	if (conflicts.length > 0) {
		throw new CaptureUsageError(
			`This directory already holds a pair captured differently: ${conflicts.join(', ')}. ` +
				'Drop the flag, or use a new --out for a new pair.'
		);
	}
	return { manifest: recorded, created: false };
}
