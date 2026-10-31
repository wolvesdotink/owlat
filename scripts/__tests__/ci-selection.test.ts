import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	coverageWorkspaces,
	desktopSpaSelected,
	groupWorkspaces,
	expectedJobs,
	assertJobResults,
	parseExpectedJobs,
	parseJobResults,
	parseTestGroup,
	selectCiWork,
	type Task,
} from '../ci/selection';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
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
		// Every module the inspector imports changes what it checks.
		const inspector = readFileSync(join(REPOSITORY_ROOT, 'scripts/check-desktop-spa.ts'), 'utf8');
		const imported = [...inspector.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((match) =>
			normalize(join('scripts', `${match[1]}.ts`))
		);
		expect(imported).toContain('scripts/json.ts');
		for (const file of imported) expect(desktopSpaSelected(false, false, [file]), file).toBe(true);
		const selection = { groups: [], images: [], api: false, web: false, mta: false, java: false };
		expect(expectedJobs({ ...selection, desktopSpa: true })).toContain('desktop-spa');
		expect(expectedJobs({ ...selection, desktopSpa: false })).not.toContain('desktop-spa');
	});
	it('runs the browser component tests whenever the web suite runs', () => {
		const selection = {
			groups: [],
			images: [],
			api: false,
			mta: false,
			java: false,
			desktopSpa: false,
		};
		expect(expectedJobs({ ...selection, web: true })).toEqual(
			expect.arrayContaining(['test-web', 'test-web-merge', 'test-web-browser'])
		);
		expect(expectedJobs({ ...selection, web: false })).not.toContain('test-web-browser');
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
		// The Java suite checks the SDK against the contract's OpenAPI document.
		expect(
			selectCiWork({
				full: false,
				changed: ['packages/public-contract/src/events.ts'],
				coverage: [],
				affected: ['@owlat/public-contract'],
				images,
			})
		).toMatchObject({ java: true });
	});
});

describe('CI matrix inputs', () => {
	const group = {
		id: 1,
		workspaces: [{ package: '@owlat/shared', name: 'shared', directory: 'packages/shared' }],
	};

	it('read the test group, the expected jobs and the job results as Actions writes them', () => {
		expect(parseTestGroup(JSON.stringify(group))).toEqual(group);
		expect(parseExpectedJobs('["detect","lint"]')).toEqual(['detect', 'lint']);
		expect(parseJobResults('{"detect":{"result":"success","outputs":{"api":"true"}}}')).toEqual({
			detect: { result: 'success', outputs: { api: 'true' } },
		});
		expect(parseJobResults(undefined)).toEqual({});
	});

	it('refuse a group, manifest or result of the wrong shape', () => {
		expect(() => parseTestGroup(undefined)).toThrow('Missing CI test group');
		expect(() => parseTestGroup('null')).toThrow('CI_GROUP must be an object');
		expect(() =>
			parseTestGroup(JSON.stringify({ workspaces: [{ package: '@owlat/shared', name: 'shared' }] }))
		).toThrow('CI_GROUP.workspaces[0].directory must be a string');
		expect(() => parseExpectedJobs(undefined)).toThrow('Missing expected CI job manifest');
		expect(() => parseExpectedJobs('"detect,lint"')).toThrow('CI_EXPECTED must be an array');
		expect(() => parseExpectedJobs('["detect",1]')).toThrow('CI_EXPECTED[1] must be a string');
		// An array would read as jobs "0" and "1"; a bare string as a success.
		expect(() => parseJobResults('[{"result":"success"}]')).toThrow('CI_NEEDS must be an object');
		expect(() => parseJobResults('{"detect":"success"}')).toThrow(
			'CI_NEEDS.detect must be an object'
		);
		expect(() => parseJobResults('{"detect":{"result":true}}')).toThrow(
			'CI_NEEDS.detect.result must be a string'
		);
	});
});
