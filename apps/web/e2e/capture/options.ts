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
import { APP_LOCALES, isAppLocale, type AppLocale } from '@owlat/shared/appLocales';
import { composeProjectName, resolveDevStackConfig } from '../../../../scripts/dev-stack/config';

export class CaptureUsageError extends Error {}

export type Theme = 'light' | 'dark';

export interface Viewport {
	readonly width: number;
	readonly height: number;
}

/**
 * Who the browser is: one of the accounts `bun run dev:seed` creates, or
 * nobody (`--signed-out`).
 */
export const ACCOUNTS = ['owner', 'admin', 'member', 'signed-out'] as const;
export type Account = (typeof ACCOUNTS)[number];

export interface Credentials {
	readonly email: string;
	readonly password: string;
}

/** Mirrors the owner and the two teammates `scripts/dev-seed.ts` creates. */
const SEEDED_ACCOUNTS: Readonly<Record<Exclude<Account, 'signed-out'>, Credentials>> = {
	owner: { email: 'dev@example.com', password: 'devpassword12345' },
	admin: { email: 'taylor@example.com', password: 'devpassword12345' },
	member: { email: 'jordan@example.com', password: 'devpassword12345' },
};

/**
 * The account a pair signs in as, or null for a signed-out pair.
 * OWLAT_CAPTURE_EMAIL and OWLAT_CAPTURE_PASSWORD replace the owner, for a
 * stack whose owner predates the seed; the teammates are always the seeded ones.
 */
export function captureCredentials(env: NodeJS.ProcessEnv, account: Account): Credentials | null {
	if (account === 'signed-out') return null;
	const seeded = SEEDED_ACCOUNTS[account];
	if (account !== 'owner') return seeded;
	return {
		email: env['OWLAT_CAPTURE_EMAIL'] || seeded.email,
		password: env['OWLAT_CAPTURE_PASSWORD'] || seeded.password,
	};
}

/**
 * One step a `--path` shot takes after the route loaded and before the shot,
 * in command-line order. `target` is a Playwright selector: CSS, or
 * `role=button[name="New campaign"]` to find a control by role and
 * accessible name.
 */
export type CaptureStep =
	| { readonly action: 'click'; readonly target: string }
	| { readonly action: 'fill'; readonly target: string; readonly value: string }
	| { readonly action: 'press'; readonly key: string }
	| { readonly action: 'wait-for'; readonly target: string };

/** A `--path` shot as the command line asked for it. */
export interface PathRequest {
	/** The app route, e.g. `/dashboard/files`. */
	readonly path: string;
	/** `--name`: the shot is `path-<name>` instead of a name made from the route. */
	readonly name: string | undefined;
	readonly steps: readonly CaptureStep[];
}

export interface CaptureRequest {
	readonly label: string;
	/** Surface names, in the order given. */
	readonly surfaces: readonly string[];
	/** Extra app routes to capture, each with the steps given after it. */
	readonly paths: readonly PathRequest[];
	readonly out: string | undefined;
	readonly url: string | undefined;
	readonly theme: Theme | undefined;
	readonly viewport: Viewport | undefined;
	readonly fullPage: boolean;
	readonly locale: AppLocale | undefined;
	readonly account: Account | undefined;
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
const SHOT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
/** The options that belong to the `--path` before them. */
const PATH_OPTIONS = new Set(['name', 'click', 'fill', 'press', 'wait-for']);
/**
 * A Playwright selector engine name, at the start of the selector or of a
 * `>>` part. The `=` after it is part of the selector, not the `--fill` split.
 */
const ENGINE_BEFORE =
	/(?:^|>>\s*)(?:css|xpath|text|id|data-testid|data-test-id|data-test|role|nth|visible)$/;

/**
 * `--fill <selector>=<value>`, split at the first `=` outside brackets and
 * quotes that does not follow an engine name, so
 * `role=textbox[name="Search"]=owlat`, `#card >> role=textbox[name=Name]=owlat`
 * and `input[name=q]=owlat` all work and the value may itself contain `=`.
 */
export function parseFill(raw: string): { target: string; value: string } {
	let depth = 0;
	let quote: string | null = null;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (quote) {
			if (char === '\\') index++;
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === '[' || char === '(') depth++;
		else if (char === ']' || char === ')') depth--;
		else if (
			char === '=' &&
			depth === 0 &&
			index > 0 &&
			!ENGINE_BEFORE.test(raw.slice(0, index).trim())
		) {
			return { target: raw.slice(0, index), value: raw.slice(index + 1) };
		}
	}
	throw new CaptureUsageError(`--fill must be <selector>=<value>, got ${JSON.stringify(raw)}.`);
}

function pathStep(option: string, raw: string): CaptureStep {
	if (raw.trim() === '') throw new CaptureUsageError(`--${option} needs a value.`);
	switch (option) {
		case 'click':
			return { action: 'click', target: raw };
		case 'fill':
			return { action: 'fill', ...parseFill(raw) };
		case 'press':
			return { action: 'press', key: raw };
		default:
			return { action: 'wait-for', target: raw };
	}
}

/**
 * The `--path` shots in command-line order, each with the `--name` and steps
 * that follow it up to the next `--path`. parseArgs groups repeated options by
 * name, so the order comes from its tokens.
 */
function readPaths(
	tokens: ReadonlyArray<{ kind: string; name?: string; value?: string | undefined }>
): PathRequest[] {
	const paths: Array<{ path: string; name: string | undefined; steps: CaptureStep[] }> = [];
	for (const token of tokens) {
		if (token.kind !== 'option' || token.name === undefined) continue;
		const value = token.value ?? '';
		if (token.name === 'path') {
			paths.push({ path: value, name: undefined, steps: [] });
			continue;
		}
		if (!PATH_OPTIONS.has(token.name)) continue;
		const current = paths.at(-1);
		if (!current) {
			throw new CaptureUsageError(
				`--${token.name} belongs to a --path shot; put it after the --path it acts on.`
			);
		}
		if (token.name === 'name') {
			if (current.name !== undefined) {
				throw new CaptureUsageError(`--path ${current.path} has two --name values.`);
			}
			if (!SHOT_NAME.test(value)) {
				throw new CaptureUsageError(
					`--name must be lowercase letters, digits and dashes, got "${value}".`
				);
			}
			current.name = value;
		} else {
			current.steps.push(pathStep(token.name, value));
		}
	}
	return paths;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureRequest {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			tokens: true,
			options: {
				surface: { type: 'string', multiple: true },
				path: { type: 'string', multiple: true },
				out: { type: 'string' },
				url: { type: 'string' },
				theme: { type: 'string' },
				viewport: { type: 'string' },
				'full-page': { type: 'boolean', default: false },
				locale: { type: 'string' },
				as: { type: 'string' },
				'signed-out': { type: 'boolean', default: false },
				name: { type: 'string', multiple: true },
				click: { type: 'string', multiple: true },
				fill: { type: 'string', multiple: true },
				press: { type: 'string', multiple: true },
				'wait-for': { type: 'string', multiple: true },
				force: { type: 'boolean', default: false },
				list: { type: 'boolean', default: false },
				help: { type: 'boolean', short: 'h', default: false },
			},
		});
	} catch (error) {
		throw new CaptureUsageError(error instanceof Error ? error.message : String(error));
	}
	const { values, positionals, tokens } = parsed;
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
	const paths = readPaths(tokens);
	const account = parseAccount(values.as, values['signed-out'] === true);
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
		locale: parseLocale(values.locale),
		account,
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

function parseLocale(raw: string | undefined): AppLocale | undefined {
	if (raw === undefined) return undefined;
	if (isAppLocale(raw)) return raw;
	throw new CaptureUsageError(`--locale must be one of ${APP_LOCALES.join(', ')}, got "${raw}".`);
}

function parseAccount(raw: string | undefined, signedOut: boolean): Account | undefined {
	if (signedOut) {
		if (raw !== undefined) throw new CaptureUsageError('--as and --signed-out exclude each other.');
		return 'signed-out';
	}
	if (raw === undefined) return undefined;
	if (raw === 'owner' || raw === 'admin' || raw === 'member') return raw;
	throw new CaptureUsageError(`--as must be owner, admin or member, got "${raw}".`);
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
	/** A `--path` shot's steps before the screenshot. */
	readonly steps?: readonly CaptureStep[];
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
	const pathShots = request.paths.map(({ path, name, steps }) => {
		const derived = pathShotName(path);
		return { name: name === undefined ? derived : `path-${name}`, path, steps };
	});
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
