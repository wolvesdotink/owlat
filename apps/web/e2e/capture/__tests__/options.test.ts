/**
 * The rules `bun run capture` applies before a browser starts: what the
 * command line accepts, which shots and steps a run plans, where the PNGs may
 * go (never into the checkout), and which app it signs in to.
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	composeProjectName,
	DevStackConfigError,
	resolveDevStackConfig,
} from '../../../../../scripts/dev-stack/config';
import {
	appRouteUrl,
	CaptureUsageError,
	parseCaptureArgs,
	parseFill,
	pathShotName,
	planShots,
	resolveAppUrl,
	resolveOutputDir,
	type PathRequest,
} from '../options';
import { SURFACE_NAMES, SURFACES } from '../surfaces';

const KNOWN = ['dashboard', 'postbox', 'contacts'];

const route = (path: string, overrides: Partial<PathRequest> = {}): PathRequest => ({
	path,
	name: undefined,
	steps: [],
	...overrides,
});

function request(overrides: Partial<Parameters<typeof planShots>[0]> = {}) {
	return { label: 'before', surfaces: ['contacts'], paths: [], force: false, ...overrides };
}

describe('parseCaptureArgs', () => {
	it('reads the label, comma-separated and repeated surfaces, and paths', () => {
		const parsed = parseCaptureArgs([
			'before',
			'--surface',
			'postbox, contacts',
			'--surface',
			'dashboard',
			'--path',
			'/dashboard/files',
			'--theme',
			'dark',
			'--viewport',
			'1280x800',
			'--full-page',
		]);
		expect(parsed).toMatchObject({
			label: 'before',
			surfaces: ['postbox', 'contacts', 'dashboard'],
			paths: [route('/dashboard/files')],
			theme: 'dark',
			viewport: { width: 1280, height: 800 },
			fullPage: true,
			force: false,
		});
	});

	it('attaches --name and the steps to the --path before them, in command-line order', () => {
		const parsed = parseCaptureArgs([
			'before',
			'--path',
			'/dashboard/campaigns',
			'--click',
			'role=button[name="New campaign"]',
			'--fill',
			'role=textbox[name="Name"]=Spring sale',
			'--wait-for',
			'role=dialog',
			'--name',
			'new-campaign',
			'--press',
			'Tab',
			'--path',
			'/dashboard/files',
		]);
		expect(parsed.paths).toEqual([
			{
				path: '/dashboard/campaigns',
				name: 'new-campaign',
				steps: [
					{ action: 'click', target: 'role=button[name="New campaign"]' },
					{ action: 'fill', target: 'role=textbox[name="Name"]', value: 'Spring sale' },
					{ action: 'wait-for', target: 'role=dialog' },
					{ action: 'press', key: 'Tab' },
				],
			},
			route('/dashboard/files'),
		]);
	});

	it('reads the language and the account', () => {
		expect(parseCaptureArgs(['before', '--path', '/', '--locale', 'de'])).toMatchObject({
			locale: 'de',
			account: undefined,
		});
		expect(parseCaptureArgs(['before', '--path', '/', '--as', 'member']).account).toBe('member');
		expect(parseCaptureArgs(['before', '--path', '/auth/login', '--signed-out']).account).toBe(
			'signed-out'
		);
	});

	it.each([
		[['before', '--click', 'button', '--path', '/'], /put it after the --path/],
		[['before', '--surface', 'contacts', '--press', 'Escape'], /put it after the --path/],
		[['before', '--path', '/', '--name', 'Big Shot'], /--name must be/],
		[['before', '--path', '/', '--name', 'a', '--name', 'b'], /two --name values/],
		[['before', '--path', '/', '--fill', 'input'], /--fill must be <selector>=<value>/],
		[['before', '--path', '/', '--click', ' '], /--click needs a value/],
		[['before', '--path', '/', '--locale', 'fr'], /--locale must be one of en, de/],
		[['before', '--path', '/', '--as', 'guest'], /--as must be owner, admin or member/],
		[['before', '--path', '/', '--as', 'owner', '--signed-out'], /exclude each other/],
	])('refuses %j', (argv, message) => {
		expect(() => parseCaptureArgs(argv)).toThrow(message);
	});

	it.each([['before-x'], ['Before'], ['']])('refuses the label %j', (label) => {
		expect(() => parseCaptureArgs([label, '--surface', 'contacts'].filter(Boolean))).toThrow(
			CaptureUsageError
		);
	});

	it('needs at least one shot, but not for --list', () => {
		expect(() => parseCaptureArgs(['before'])).toThrow(/at least one --surface or --path/);
		expect(parseCaptureArgs(['--list']).list).toBe(true);
	});

	it.each([
		[['before', '--surface', 'x', '--theme', 'blue']],
		[['before', '--surface', 'x', '--viewport', '1280']],
		[['before', '--surface', 'x', '--viewport', '100x100']],
		[['before', '--surface', 'x', '--bogus']],
		[['before', 'after', '--surface', 'x']],
	])('refuses %j', (argv) => {
		expect(() => parseCaptureArgs(argv)).toThrow(CaptureUsageError);
	});
});

describe('parseFill', () => {
	it.each([
		['role=textbox[name="Search"]=owlat', 'role=textbox[name="Search"]', 'owlat'],
		['input[name=q]=a=b', 'input[name=q]', 'a=b'],
		['role=textbox[name="a=b"]=', 'role=textbox[name="a=b"]', ''],
		['#subject=Hello', '#subject', 'Hello'],
		['#card >> input >> nth=0=Ada', '#card >> input >> nth=0', 'Ada'],
		['#card >> role=textbox[name="Name"]=Ada', '#card >> role=textbox[name="Name"]', 'Ada'],
		[
			'text=Sign up >> role=textbox[name=Email]=a@b',
			'text=Sign up >> role=textbox[name=Email]',
			'a@b',
		],
	])('splits %j at the first = outside the selector', (raw, target, value) => {
		expect(parseFill(raw)).toEqual({ target, value });
	});
});

describe('pathShotName', () => {
	it('turns an app route into a file-safe shot name', () => {
		expect(pathShotName('/dashboard/audience/topics')).toBe('path-dashboard-audience-topics');
		expect(pathShotName('/dashboard/campaigns?status=all')).toBe(
			'path-dashboard-campaigns-status-all'
		);
		expect(pathShotName('/')).toBe('path-root');
	});

	it.each([
		['dashboard'],
		['//evil.example/x'],
		['http://evil.example'],
		['/a\\b'],
		['/\\evil.example'],
		// The URL parser drops tabs and newlines, which turns these into //evil.example.
		['/\t/evil.example'],
		['/\n/evil.example/x'],
		['/dashboard\u0000'],
		['/dashboard\u007f'],
	])('refuses %j, which is not a same-origin app route', (path) => {
		expect(() => pathShotName(path)).toThrow(CaptureUsageError);
		expect(appRouteUrl(path, 'http://localhost:4574')).toBeNull();
	});
});

describe('appRouteUrl', () => {
	it('resolves an app route on the app origin, whatever path the app URL has', () => {
		expect(appRouteUrl('/dashboard/campaigns?status=all', 'http://localhost:4574/x')?.href).toBe(
			'http://localhost:4574/dashboard/campaigns?status=all'
		);
		expect(appRouteUrl('/a/../b', 'http://localhost:4574')?.href).toBe('http://localhost:4574/b');
	});
});

describe('planShots', () => {
	it('names each file <label>-<shot>.png and runs surfaces in registry order', () => {
		const shots = planShots(
			request({ surfaces: ['contacts', 'dashboard'], paths: [route('/dashboard/files')] }),
			'/out',
			KNOWN,
			() => false
		);
		expect(shots).toEqual([
			{ name: 'dashboard', file: '/out/before-dashboard.png' },
			{ name: 'contacts', file: '/out/before-contacts.png' },
			{
				name: 'path-dashboard-files',
				path: '/dashboard/files',
				steps: [],
				file: '/out/before-path-dashboard-files.png',
			},
		]);
	});

	it('names a --path shot after its --name, so one route can be captured twice', () => {
		const steps = [{ action: 'click' as const, target: 'role=button[name="New"]' }];
		const shots = planShots(
			request({
				surfaces: [],
				paths: [route('/dashboard/files'), route('/dashboard/files', { name: 'new', steps })],
			}),
			'/out',
			KNOWN,
			() => false
		);
		expect(shots.map((shot) => [shot.name, shot.steps])).toEqual([
			['path-dashboard-files', []],
			['path-new', steps],
		]);
	});

	it('refuses an unknown surface and a shot requested twice', () => {
		expect(() => planShots(request({ surfaces: ['nope'] }), '/out', KNOWN, () => false)).toThrow(
			/Unknown surface nope/
		);
		expect(() =>
			planShots(request({ surfaces: ['contacts', 'contacts'] }), '/out', KNOWN, () => false)
		).toThrow(/requested twice/);
		expect(() =>
			planShots(
				request({ surfaces: [], paths: [route('/a/b'), route('/a-b')] }),
				'/out',
				KNOWN,
				() => false
			)
		).toThrow(/requested twice/);
	});

	it('refuses to replace an existing capture unless forced', () => {
		const exists = (file: string) => file === '/out/before-contacts.png';
		expect(() => planShots(request(), '/out', KNOWN, exists)).toThrow(
			/Already captured: \/out\/before-contacts\.png/
		);
		expect(planShots(request({ force: true }), '/out', KNOWN, exists)).toHaveLength(1);
	});

	it("keeps the two labels apart: the other label's captures never block or get named", () => {
		const before = new Set(['/out/before-contacts.png']);
		const shots = planShots(request({ label: 'after' }), '/out', KNOWN, (file) => before.has(file));
		expect(shots.map((shot) => shot.file)).toEqual(['/out/after-contacts.png']);
	});
});

describe('the registered surfaces', () => {
	it('have unique names that can never collide with a --path shot', () => {
		expect(new Set(SURFACE_NAMES).size).toBe(SURFACE_NAMES.length);
		for (const name of SURFACE_NAMES) expect(name).toMatch(/^(?!path-)[a-z][a-z-]*$/);
	});

	it('list every surface that changes local data before the ones that only show it', () => {
		const changing = SURFACES.filter((surface) => surface.changes).map((surface) => surface.name);
		expect(changing).toContain('postbox');
		expect(SURFACE_NAMES.slice(0, changing.length)).toEqual(changing);
		// So a pair on fresh seed data never shows the message unread in "before"
		// and read in "after": postbox runs first, whatever order the flags give.
		const shots = planShots(
			request({ surfaces: ['dashboard', 'contacts', 'postbox'] }),
			'/out',
			SURFACE_NAMES,
			() => false
		);
		expect(shots.map((shot) => shot.name)).toEqual(['postbox', 'dashboard', 'contacts']);
	});
});

describe('resolveOutputDir', () => {
	let base: string;
	let root: string;

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), 'capture-out-')));
		root = join(base, 'checkout');
		mkdirSync(join(root, 'apps'), { recursive: true });
	});

	it('accepts a directory outside the checkout, including one that does not exist yet', () => {
		expect(resolveOutputDir(join(base, 'shots', 'new'), root, base, {})).toBe(
			join(base, 'shots', 'new')
		);
		expect(resolveOutputDir('shots', root, base, {})).toBe(join(base, 'shots'));
	});

	it('accepts a sibling whose name merely starts like the checkout', () => {
		expect(resolveOutputDir(join(base, 'checkout-shots'), root, base, {})).toBe(
			join(base, 'checkout-shots')
		);
	});

	it.each([['checkout'], ['checkout/apps/web/shots'], ['checkout/../checkout/x']])(
		'refuses %j inside the checkout',
		(relativeOut) => {
			expect(() => resolveOutputDir(relativeOut, root, base, {})).toThrow(/inside the checkout/);
		}
	);

	it('tells a name that merely starts with two dots from the parent directory', () => {
		expect(() => resolveOutputDir('..shots', root, root, {})).toThrow(/inside the checkout/);
		expect(() => resolveOutputDir('apps/..shots', root, root, {})).toThrow(/inside the checkout/);
		expect(resolveOutputDir('../shots', root, root, {})).toBe(join(base, 'shots'));
	});

	it('refuses a symlink outside that points back into the checkout', () => {
		symlinkSync(join(root, 'apps'), join(base, 'alias'));
		expect(() => resolveOutputDir(join(base, 'alias', 'shots'), root, base, {})).toThrow(
			/inside the checkout/
		);
	});

	it('defaults to the user cache, one directory per checkout', () => {
		expect(resolveOutputDir(undefined, root, base, { XDG_CACHE_HOME: join(base, 'cache') })).toBe(
			join(base, 'cache', 'owlat-captures', composeProjectName(root))
		);
	});
});

describe('resolveAppUrl', () => {
	const root = '/work/owlat-feature';

	it("uses the dev stack's web port for this checkout, OWLAT_PORT_OFFSET included", () => {
		expect(resolveAppUrl(undefined, root, true, { OWLAT_PORT_OFFSET: '1574' })).toBe(
			'http://localhost:4574'
		);
		expect(resolveAppUrl(undefined, root, false, {})).toBe('http://localhost:3000');
		expect(resolveAppUrl(undefined, root, true, {})).toBe(
			resolveDevStackConfig({ explicit: undefined, root, linkedWorktree: true }).urls.web
		);
	});

	it('rejects an invalid offset the way dev:stack does', () => {
		expect(() => resolveAppUrl(undefined, root, true, { OWLAT_PORT_OFFSET: 'abc' })).toThrow(
			DevStackConfigError
		);
	});

	it('accepts --url for a local app only', () => {
		expect(resolveAppUrl('http://localhost:3000/dashboard', root, true, {})).toBe(
			'http://localhost:3000'
		);
		expect(resolveAppUrl('http://127.0.0.1:4000', root, true, {})).toBe('http://127.0.0.1:4000');
		expect(() => resolveAppUrl('https://app.owlat.example', root, true, {})).toThrow(/local app/);
		expect(() => resolveAppUrl('ftp://localhost', root, true, {})).toThrow(/http or https/);
		expect(() => resolveAppUrl('localhost:3000', root, true, {})).toThrow(CaptureUsageError);
	});
});
