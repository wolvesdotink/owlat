import { describe, expect, it } from 'vitest';
import {
	coverageWorkspaces,
	groupWorkspaces,
	expectedJobs,
	assertJobResults,
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
});
