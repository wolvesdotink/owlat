/**
 * How a pair shares one presentation: the first run records the theme,
 * viewport, language, account, clock and each `--path` shot's steps, later
 * runs reuse them, and a flag that disagrees is refused.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_VIEWPORT,
	parseManifest,
	settleManifest,
	settleShots,
	type CaptureManifest,
} from '../manifest';
import type { PlannedShot } from '../options';

describe('the pair manifest', () => {
	const now = new Date('2026-10-24T12:00:00.000Z');
	const recorded: CaptureManifest = {
		version: 2,
		clock: '2026-10-20T09:30:00.000Z',
		theme: 'dark',
		viewport: { width: 1280, height: 800 },
		fullPage: false,
		locale: 'de',
		account: 'member',
		shots: {},
	};
	const noFlags = {
		theme: undefined,
		viewport: undefined,
		fullPage: false,
		locale: undefined,
		account: undefined,
	};

	it('is recorded from the flags on the first run, with defaults', () => {
		expect(settleManifest(null, noFlags, now)).toEqual({
			manifest: {
				version: 2,
				clock: now.toISOString(),
				theme: 'light',
				viewport: DEFAULT_VIEWPORT,
				fullPage: false,
				locale: 'en',
				account: 'owner',
				shots: {},
			},
			created: true,
		});
	});

	it('is reused as recorded by later runs, clock, language and account included', () => {
		expect(
			settleManifest(recorded, { ...noFlags, theme: 'dark', locale: 'de', account: 'member' }, now)
		).toEqual({ manifest: recorded, created: false });
		expect(settleManifest(recorded, noFlags, now)).toEqual({ manifest: recorded, created: false });
	});

	it.each([
		[{ theme: 'light' as const }, /--theme light/],
		[{ viewport: { width: 1440, height: 900 } }, /--viewport 1440x900/],
		[{ fullPage: true }, /--full-page/],
		[{ locale: 'en' as const }, /--locale en \(recorded: de\)/],
		[{ account: 'admin' as const }, /--as admin \(recorded: member\)/],
		[{ account: 'signed-out' as const }, /--signed-out \(recorded: member\)/],
	])('refuses a flag that disagrees with the recorded pair (%j)', (flags, message) => {
		expect(() => settleManifest(recorded, { ...noFlags, ...flags }, now)).toThrow(message);
	});

	it('reads only a well-formed manifest', () => {
		expect(parseManifest(JSON.stringify(recorded), 'capture.json')).toEqual(recorded);
		expect(() => parseManifest('{', 'capture.json')).toThrow(/not valid JSON/);
		for (const broken of [
			{ theme: 'blue' },
			{ clock: 'later' },
			{ locale: 'fr' },
			{ account: 'guest' },
			{ shots: { 'path-x': { path: '/x', steps: [{ action: 'hover', target: 'a' }] } } },
		]) {
			expect(() =>
				parseManifest(JSON.stringify({ ...recorded, ...broken }), 'capture.json')
			).toThrow(/not a capture manifest/);
		}
	});

	it('reads a pair recorded before languages and accounts as English, owner, no steps', () => {
		const v1 = {
			version: 1,
			clock: recorded.clock,
			theme: 'light',
			viewport: { width: 1440, height: 900 },
			fullPage: true,
		};
		expect(parseManifest(JSON.stringify(v1), 'capture.json')).toEqual({
			...v1,
			version: 2,
			locale: 'en',
			account: 'owner',
			shots: {},
		});
	});
});

describe('settleShots', () => {
	const manifest: CaptureManifest = {
		version: 2,
		clock: '2026-10-20T09:30:00.000Z',
		theme: 'light',
		viewport: DEFAULT_VIEWPORT,
		fullPage: false,
		locale: 'en',
		account: 'owner',
		shots: {},
	};
	const open = [{ action: 'click' as const, target: 'role=button[name="New"]' }];
	const pathShot = (steps: PlannedShot['steps'], path = '/dashboard/files'): PlannedShot => ({
		name: 'path-new',
		path,
		steps,
		file: '/out/after-path-new.png',
	});

	it('records a new --path shot with its steps', () => {
		const settled = settleShots(manifest, [pathShot(open)]);
		expect(settled.changed).toBe(true);
		expect(settled.manifest.shots).toEqual({
			'path-new': { path: '/dashboard/files', steps: open },
		});
	});

	it('repeats the recorded steps when the second run names the shot without them', () => {
		const pair = settleShots(manifest, [pathShot(open)]).manifest;
		const settled = settleShots(pair, [pathShot([])]);
		expect(settled).toEqual({ manifest: pair, shots: [pathShot(open)], changed: false });
		expect(settleShots(pair, [pathShot(open)]).shots).toEqual([pathShot(open)]);
	});

	it('refuses a recorded shot with other steps or another route', () => {
		const pair = settleShots(manifest, [pathShot(open)]).manifest;
		expect(() => settleShots(pair, [pathShot([{ action: 'press', key: 'Escape' }])])).toThrow(
			/path-new with press \(recorded: click\)/
		);
		expect(() => settleShots(pair, [pathShot([], '/dashboard')])).toThrow(
			/path-new at \/dashboard \(recorded: \/dashboard\/files\)/
		);
	});

	it('refuses named surfaces for a German or a signed-out pair', () => {
		const surface: PlannedShot = { name: 'contacts', file: '/out/before-contacts.png' };
		expect(settleShots(manifest, [surface]).shots).toEqual([surface]);
		expect(() => settleShots({ ...manifest, locale: 'de' }, [surface])).toThrow(
			/contacts cannot be captured in de: they find their controls by English text/
		);
		expect(() => settleShots({ ...manifest, account: 'signed-out' }, [surface])).toThrow(
			/cannot be captured signed out/
		);
		expect(settleShots({ ...manifest, locale: 'de' }, [pathShot([])]).changed).toBe(true);
	});
});
