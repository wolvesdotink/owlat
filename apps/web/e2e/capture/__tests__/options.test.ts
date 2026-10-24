/**
 * The rules `bun run capture` applies before a browser starts: what the
 * command line accepts, where the PNGs may go (never into the checkout), which
 * app it signs in to, and how a pair shares one presentation.
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
	CaptureUsageError,
	DEFAULT_VIEWPORT,
	parseCaptureArgs,
	parseManifest,
	pathShotName,
	planShots,
	resolveAppUrl,
	resolveOutputDir,
	settleManifest,
	type CaptureManifest,
} from '../options';
import { SURFACE_NAMES } from '../surfaces';

const KNOWN = ['dashboard', 'postbox', 'contacts'];

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
			paths: ['/dashboard/files'],
			theme: 'dark',
			viewport: { width: 1280, height: 800 },
			fullPage: true,
			force: false,
		});
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

describe('pathShotName', () => {
	it('turns an app route into a file-safe shot name', () => {
		expect(pathShotName('/dashboard/audience/topics')).toBe('path-dashboard-audience-topics');
		expect(pathShotName('/dashboard/campaigns?status=all')).toBe(
			'path-dashboard-campaigns-status-all'
		);
		expect(pathShotName('/')).toBe('path-root');
	});

	it.each([['dashboard'], ['//evil.example/x'], ['http://evil.example'], ['/a\\b']])(
		'refuses %j, which is not a same-origin app route',
		(path) => {
			expect(() => pathShotName(path)).toThrow(CaptureUsageError);
		}
	);
});

describe('planShots', () => {
	it('names each file <label>-<shot>.png and runs surfaces in registry order', () => {
		const shots = planShots(
			request({ surfaces: ['contacts', 'dashboard'], paths: ['/dashboard/files'] }),
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
				file: '/out/before-path-dashboard-files.png',
			},
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
			planShots(request({ surfaces: [], paths: ['/a/b', '/a-b'] }), '/out', KNOWN, () => false)
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

describe('the pair manifest', () => {
	const now = new Date('2026-10-24T12:00:00.000Z');
	const recorded: CaptureManifest = {
		version: 1,
		clock: '2026-10-20T09:30:00.000Z',
		theme: 'dark',
		viewport: { width: 1280, height: 800 },
		fullPage: false,
	};

	it('is recorded from the flags on the first run, with defaults', () => {
		expect(
			settleManifest(null, { theme: undefined, viewport: undefined, fullPage: false }, now)
		).toEqual({
			manifest: {
				version: 1,
				clock: now.toISOString(),
				theme: 'light',
				viewport: DEFAULT_VIEWPORT,
				fullPage: false,
			},
			created: true,
		});
	});

	it('is reused as recorded by later runs, clock included', () => {
		expect(
			settleManifest(recorded, { theme: 'dark', viewport: undefined, fullPage: false }, now)
		).toEqual({ manifest: recorded, created: false });
	});

	it.each([
		[{ theme: 'light' as const, viewport: undefined, fullPage: false }, /--theme light/],
		[
			{ theme: undefined, viewport: { width: 1440, height: 900 }, fullPage: false },
			/--viewport 1440x900/,
		],
		[{ theme: undefined, viewport: undefined, fullPage: true }, /--full-page/],
	])('refuses a flag that disagrees with the recorded pair (%j)', (flags, message) => {
		expect(() => settleManifest(recorded, flags, now)).toThrow(message);
	});

	it('reads only a well-formed manifest', () => {
		expect(parseManifest(JSON.stringify(recorded), 'capture.json')).toEqual(recorded);
		expect(() => parseManifest('{', 'capture.json')).toThrow(/not valid JSON/);
		expect(() =>
			parseManifest(JSON.stringify({ ...recorded, theme: 'blue' }), 'capture.json')
		).toThrow(/not a capture manifest/);
		expect(() =>
			parseManifest(JSON.stringify({ ...recorded, clock: 'later' }), 'capture.json')
		).toThrow(/not a capture manifest/);
	});
});
