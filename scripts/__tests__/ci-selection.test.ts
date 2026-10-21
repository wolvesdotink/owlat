import { describe, expect, it } from 'vitest';
import {
	coverageWorkspaces,
	desktopSpaSelected,
	groupWorkspaces,
	expectedJobs,
	assertJobResults,
	selectCiWork,
	type Task,
} from '../ci/selection';
const task = (name: string): Task => ({
	task: 'test:coverage',
	package: `@owlat/${name}`,
	directory: `apps/${name}`,
	command: 'vitest run --coverage',
});
describe('CI work selection', () => {
	it('selects real coverage tasks rather than prerequisite builds or root no-ops', () => {
		expect(
			coverageWorkspaces([
				task('web'),
				{ ...task('plugin-kit'), task: 'build' },
				{ task: 'plugins:check', package: '//', directory: '.', command: 'check' },
				{ ...task('empty'), command: '<NONEXISTENT>' },
				task('web'),
			]).map((w) => w.name)
		).toEqual(['web']);
	});
	it('bins every small workspace once and leaves heavy work to dedicated jobs', () => {
		const workspaces = coverageWorkspaces(
			[
				'api',
				'web',
				'mta',
				'desktop',
				'shared',
				'docs',
				'sdk-js',
				'email-builder',
				'mail-auth',
				'imap',
			].map(task)
		);
		const groups = groupWorkspaces(workspaces);
		expect(groups).toHaveLength(4);
		expect(groups.flatMap((g) => g.workspaces.map((w) => w.name)).sort()).toEqual([
			'docs',
			'email-builder',
			'imap',
			'mail-auth',
			'sdk-js',
			'shared',
		]);
		expect(groupWorkspaces([])).toEqual([]);
	});
	it('rejects a selected skip, cancellation, missing job or extra failed job', () => {
		const expected = expectedJobs({
			groups: [],
			images: [],
			api: false,
			web: false,
			mta: false,
			java: false,
			desktopSpa: false,
		});
		const needs = Object.fromEntries(expected.map((job) => [job, { result: 'success' }]));
		expect(() => assertJobResults(expected, needs)).not.toThrow();
		for (const result of ['skipped', 'failure', 'cancelled'])
			expect(() => assertJobResults(expected, { ...needs, lint: { result } })).toThrow();
		const missing = { ...needs };
		delete missing['typecheck'];
		expect(() => assertJobResults(expected, missing)).toThrow();
		expect(() =>
			assertJobResults(expected, { ...needs, 'test-api': { result: 'failure' } })
		).toThrow();
		expect(() =>
			assertJobResults(expected, { ...needs, 'test-api': { result: 'skipped' } })
		).not.toThrow();
	});
	it('builds the desktop SPA on full runs, web changes and the bridge or Tauri config', () => {
		expect(desktopSpaSelected(true, false, [])).toBe(true);
		expect(desktopSpaSelected(false, true, [])).toBe(true);
		for (const file of [
			'apps/desktop/src/window.ts',
			'apps/desktop/package.json',
			'apps/desktop/src-tauri/tauri.conf.json',
			'scripts/check-desktop-spa.ts',
		])
			expect(desktopSpaSelected(false, false, [file])).toBe(true);
		for (const file of [
			'apps/desktop/src-tauri/src/main.rs',
			'apps/desktop/README.md',
			'docs/x.md',
		])
			expect(desktopSpaSelected(false, false, [file])).toBe(false);
		const selection = { groups: [], images: [], api: false, web: false, mta: false, java: false };
		expect(expectedJobs({ ...selection, desktopSpa: true })).toContain('desktop-spa');
		expect(expectedJobs({ ...selection, desktopSpa: false })).not.toContain('desktop-spa');
	});
	it('selects the PR work the detect job and check:changed both report', () => {
		const images = [
			{ name: 'web', package: '@owlat/web', dockerfile: 'apps/web/Dockerfile' },
			{ name: 'mta', package: '@owlat/mta', dockerfile: 'apps/mta/Dockerfile' },
		];
		const coverage = coverageWorkspaces([task('api'), task('shared')]);
		const selection = selectCiWork({
			full: false,
			changed: ['apps/mta/Dockerfile', 'packages/shared/src/a.ts'],
			coverage,
			affected: ['@owlat/api', '@owlat/shared'],
			images,
		});
		expect(selection).toEqual({
			groups: [{ id: 1, workspaces: coverage.filter((w) => w.name === 'shared') }],
			api: true,
			web: false,
			mta: false,
			images: [images[1]],
			java: false,
			desktopSpa: false,
		});
		const all = selectCiWork({ full: true, changed: [], coverage: [], affected: [], images });
		expect(all).toMatchObject({ images, java: true, desktopSpa: true });
		expect(
			selectCiWork({
				full: false,
				changed: ['.github/docker-images.json', 'packages/sdk-java/pom.xml'],
				coverage: [],
				affected: [],
				images,
			})
		).toMatchObject({ images, java: true });
	});
});
