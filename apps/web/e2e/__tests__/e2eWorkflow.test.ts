// @vitest-environment node
/**
 * The shape of the E2E workflow and Playwright config that keeps the run's
 * credentials out of the public report and ends the run's sessions (#1222):
 *
 * - CI records no trace, in any project;
 * - the test deployment is reset when the run ends, whatever happened;
 * - the report is scanned for the URL secrets, the saved session cookies, JWTs
 *   and traces, and the only upload waits for that scan to succeed.
 *
 * The workflow is read as text with a parser for exactly the subset of YAML a
 * step list uses here; apps/web has no YAML dependency to lean on.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESET_DEADLINE_MS } from '../resetDeployment';
import { STORAGE_STATE } from '../storage-state';

const WEB = resolve(__dirname, '../..');
const WORKFLOW = resolve(WEB, '../../.github/workflows/e2e.yml');

interface Step {
	name?: string;
	id?: string;
	if?: string;
	uses?: string;
	run?: string;
	'timeout-minutes'?: string;
	'working-directory'?: string;
	env: Record<string, string>;
	with: Record<string, string>;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The steps of the workflow's single job, each with its top-level keys. */
function workflowSteps(text: string): Step[] {
	const lines = text.split('\n');
	const start = lines.findIndex((line) => line === '    steps:');
	const steps: string[][] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^ {6}- /.test(line)) steps.push([line.replace('- ', '  ')]);
		else if (steps.length > 0 && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
		else if (indentOf(line) > 6) steps.at(-1)?.push(line);
		else if (line.trim() !== '') break;
	}
	return steps.map((block) => {
		const step: Step = { env: {}, with: {} };
		for (let index = 0; index < block.length; index++) {
			const match = /^ {8}([\w-]+):\s?(.*)$/.exec(block[index]!);
			if (!match) continue;
			const [, key, value] = match as unknown as [string, string, string];
			const nested: string[] = [];
			while (index + 1 < block.length && indentOf(block[index + 1]!) > 8) {
				nested.push(block[++index]!.trim());
			}
			if (key === 'env' || key === 'with') {
				for (const entry of nested) {
					const pair = /^([\w-]+):\s*(.*)$/.exec(entry);
					if (pair) step[key][pair[1]!] = pair[2]!;
				}
			} else if (value === '|' || value === '>-') {
				(step as unknown as Record<string, string>)[key] = nested.join(value === '|' ? '\n' : ' ');
			} else {
				(step as unknown as Record<string, string>)[key] = value;
			}
		}
		return step;
	});
}

const steps = workflowSteps(readFileSync(WORKFLOW, 'utf8'));
const stepIndex = (predicate: (step: Step) => boolean) => {
	const index = steps.findIndex(predicate);
	expect(index, 'step not found').toBeGreaterThanOrEqual(0);
	return index;
};
const named = (name: string) => (step: Step) => step.name === name;

const RESET = 'bun e2e/reset-deployment.ts';
const SECRET_NAMES = [
	'CONVEX_TEST_INSTANCE_SECRET',
	'CONVEX_TEST_ADMIN_KEY',
	'CONVEX_TEST_URL',
	'CONVEX_TEST_SITE_URL',
];

describe('e2e.yml', () => {
	it('parses into the steps it has', () => {
		expect(steps.length).toBeGreaterThan(8);
		expect(steps.find(named('Run E2E tests'))?.run).toBe('bun run --cwd apps/web test:e2e');
	});

	it('resets the test deployment after the tests, whatever happened, before the upload', () => {
		const tests = stepIndex(named('Run E2E tests'));
		const resets = steps.flatMap((step, index) => (step.run === RESET ? [index] : []));
		const end = resets.find((index) => index > tests);
		expect(end, 'no reset after the tests').toBeDefined();
		const step = steps[end!]!;

		expect(step.if).toMatch(/^always\(\)/);
		// Only skipped when the deployment was never configured, so never touched.
		const config = stepIndex((candidate) => candidate.id === 'deployment-config');
		expect(step.if).toContain("steps.deployment-config.outcome == 'success'");
		expect(config).toBeLessThan(tests);
		expect(step['working-directory']).toBe('apps/web');
		expect(step.env).toEqual({
			CONVEX_TEST_SITE_URL: '${{ secrets.CONVEX_TEST_SITE_URL }}',
			CONVEX_TEST_INSTANCE_SECRET: '${{ secrets.CONVEX_TEST_INSTANCE_SECRET }}',
		});
		expect(end!).toBeLessThan(stepIndex((candidate) => candidate.id === 'report-secrets'));
	});

	it('resets before the run through the same script', () => {
		const tests = stepIndex(named('Run E2E tests'));
		expect(steps.findIndex((step) => step.run === RESET)).toBeLessThan(tests);
	});

	it('scans the report for the URL secrets, the saved cookies, JWTs and traces', () => {
		const scan = steps[stepIndex((step) => step.id === 'report-secrets')]!;
		expect(scan.if).toBe('always()');
		expect(scan['working-directory']).toBe('apps/web');

		const [runner, script, dir, flag, state, ...names] = scan.run!.split(/\s+/);
		expect([runner, script, dir]).toEqual([
			'bun',
			'e2e/scan-report-secrets.ts',
			'playwright-report',
		]);
		expect(flag).toBe('--storage-state');
		expect(state).toBe(relative(WEB, STORAGE_STATE));
		expect(names.sort()).toEqual([...SECRET_NAMES].sort());
		for (const name of names) expect(scan.env[name]).toBe(`\${{ secrets.${name} }}`);
	});

	it('uploads only the scanned report, and only after the scan succeeded', () => {
		const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
		expect(uploads).toHaveLength(1);
		const upload = uploads[0]!;
		expect(upload.if).toContain("steps.report-secrets.outcome == 'success'");
		expect(upload.with['path']).toBe('apps/web/playwright-report/');
		expect(steps.indexOf(upload)).toBeGreaterThan(
			stepIndex((step) => step.id === 'report-secrets')
		);
		// test-results/ holds the raw per-test output, traces included.
		expect(JSON.stringify(steps)).not.toContain('test-results');
	});
});

describe('e2e.yml time budget', () => {
	/**
	 * Allowance for what no step cap bounds: job setup and the actions' pre and
	 * post steps, which together take well under a minute on a normal run.
	 */
	const OVERHEAD_MINUTES = 5;
	const job = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(readFileSync(WORKFLOW, 'utf8'))?.[1]);
	const cap = (step: Step) => Number(step['timeout-minutes']);

	it('caps every step', () => {
		const uncapped = steps.filter((step) => !(cap(step) > 0)).map((step) => step.name ?? step.uses);
		expect(uncapped).toEqual([]);
	});

	it('caps the job above the sum of its steps, so a step cap always fires first', () => {
		// Whatever step hangs, it fails on its own cap with every later step's
		// cap still inside the job's, the end-of-run reset included.
		const total = steps.reduce((sum, step) => sum + cap(step), 0);
		expect(job).toBeGreaterThan(0);
		expect(job).toBeGreaterThanOrEqual(total + OVERHEAD_MINUTES);
	});

	it('caps each reset above the script deadline, so the script reports its own failure', () => {
		const resets = steps.filter((step) => step.run === RESET);
		expect(resets).toHaveLength(2);
		for (const reset of resets) expect(cap(reset) * 60_000).toBeGreaterThan(RESET_DEADLINE_MS);
	});
});

describe('playwright.config.ts', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function traceModes(ci: string) {
		vi.stubEnv('CI', ci);
		vi.resetModules();
		const { default: config } = await import('../playwright.config');
		return Object.fromEntries(
			(config.projects ?? []).map((project) => [
				project.name,
				project.use?.trace ?? config.use?.trace,
			])
		);
	}

	it('records no trace in CI, in any project', async () => {
		const modes = await traceModes('true');
		expect(Object.keys(modes).sort()).toEqual(['chromium', 'setup', 'shell']);
		for (const mode of Object.values(modes)) expect(mode).toBe('off');
	});

	it('keeps traces for local runs, whose report never leaves the machine', async () => {
		expect(await traceModes('')).toEqual({
			setup: 'retain-on-failure',
			shell: 'on-first-retry',
			chromium: 'on-first-retry',
		});
	});
});
