/**
 * `bun run setup:worktree` (scripts/setup-worktree.ts): env links, the
 * install and build steps, and the markers agents wait on, with the steps
 * replaced by fakes.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	linkEnvFiles,
	markerPaths,
	runSetup,
	setupSteps,
	type SetupDeps,
	type Step,
	type StepResult,
} from '../setup-worktree';

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'setup-worktree-test-'));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(
	worktree: string,
	results: Partial<Record<string, StepResult>> = {},
	extra: Partial<SetupDeps> = {}
): SetupDeps & { steps: Step[]; markersDuringSteps: boolean[] } {
	const steps: Step[] = [];
	const markersDuringSteps: boolean[] = [];
	return {
		worktree,
		mainCheckout: null,
		pid: 4242,
		isAlive: () => false,
		runStep: async (step) => {
			steps.push(step);
			markersDuringSteps.push(existsSync(markerPaths(worktree).running));
			return results[step.label] ?? { code: 0, output: '' };
		},
		log: () => {},
		steps,
		markersDuringSteps,
		...extra,
	};
}

describe('runSetup', () => {
	it('installs from the frozen lockfile, builds the web dependencies, then marks done', async () => {
		const worktree = tempDir();
		const d = deps(worktree);
		await expect(runSetup(d)).resolves.toBe('done');
		expect(d.steps.map((step) => [step.command.split('/').at(-1), ...step.args])).toEqual([
			['bun', 'install', '--frozen-lockfile'],
			['turbo', 'run', 'build', '--filter=@owlat/web^...'],
		]);
		expect(d.markersDuringSteps).toEqual([true, true]);
		const markers = markerPaths(worktree);
		expect(existsSync(markers.done)).toBe(true);
		expect(existsSync(markers.running)).toBe(false);
		expect(existsSync(markers.failed)).toBe(false);
	});

	it('never lets the install resolve a new lockfile', () => {
		const install = setupSteps('/w')[0]!;
		expect(install.args).toContain('--frozen-lockfile');
		expect(install.args).not.toContain('--force');
	});

	it('records a failed step with its output tail and skips the rest', async () => {
		const worktree = tempDir();
		const output = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
		const d = deps(worktree, { install: { code: 1, output } });
		await expect(runSetup(d)).resolves.toBe('failed');
		expect(d.steps).toHaveLength(1);
		const failed = readFileSync(markerPaths(worktree).failed, 'utf8');
		expect(failed).toMatch(/^install exited with code 1\./);
		expect(failed).toContain('line 49');
		expect(failed).not.toContain('line 19\n');
		expect(existsSync(markerPaths(worktree).running)).toBe(false);
	});

	it('marks a cancelled run as failed even when the step exited cleanly', async () => {
		const worktree = tempDir();
		const outcome = await runSetup(deps(worktree), () => 'SIGTERM');
		expect(outcome).toBe('failed');
		expect(readFileSync(markerPaths(worktree).failed, 'utf8')).toMatch(/Cancelled by SIGTERM/);
	});

	it('leaves a live run alone', async () => {
		const worktree = tempDir();
		const markers = markerPaths(worktree);
		mkdirSync(markers.dir, { recursive: true });
		writeFileSync(markers.running, '777\n');
		writeFileSync(markers.done, '');
		const d = deps(worktree, {}, { isAlive: (pid) => pid === 777 });
		await expect(runSetup(d)).resolves.toBe('already-running');
		expect(d.steps).toEqual([]);
		expect(readFileSync(markers.running, 'utf8')).toBe('777\n');
		expect(existsSync(markers.done)).toBe(true);
	});

	it('takes over the marker of a run that died, and clears old results on rerun', async () => {
		const worktree = tempDir();
		const markers = markerPaths(worktree);
		mkdirSync(markers.dir, { recursive: true });
		writeFileSync(markers.running, '778\n');
		writeFileSync(markers.failed, 'old failure');
		await expect(runSetup(deps(worktree))).resolves.toBe('done');
		expect(existsSync(markers.failed)).toBe(false);
		expect(existsSync(markers.done)).toBe(true);
		await expect(runSetup(deps(worktree))).resolves.toBe('done');
	});
});

describe('linkEnvFiles', () => {
	it('links missing env files, keeps real ones and re-points stale links', () => {
		const main = tempDir();
		const worktree = tempDir();
		writeFileSync(join(main, '.env'), 'A=1\n');
		writeFileSync(join(main, '.env.local'), 'B=1\n');
		writeFileSync(join(worktree, '.env.local'), 'MINE=1\n');

		linkEnvFiles(worktree, main, () => {});
		expect(lstatSync(join(worktree, '.env')).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(worktree, '.env'))).toBe(join(main, '.env'));
		expect(lstatSync(join(worktree, '.env.local')).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(worktree, '.env.local'), 'utf8')).toBe('MINE=1\n');

		rmSync(join(worktree, '.env'));
		symlinkSync(join(tempDir(), 'gone'), join(worktree, '.env'));
		linkEnvFiles(worktree, main, () => {});
		expect(readlinkSync(join(worktree, '.env'))).toBe(join(main, '.env'));
	});

	it('does nothing in the main checkout itself or without one', () => {
		const main = tempDir();
		writeFileSync(join(main, '.env'), 'A=1\n');
		linkEnvFiles(main, main, () => {});
		expect(lstatSync(join(main, '.env')).isFile()).toBe(true);
		const worktree = tempDir();
		linkEnvFiles(worktree, null, () => {});
		expect(existsSync(join(worktree, '.env'))).toBe(false);
	});

	it('skips an env file the main checkout does not have', () => {
		const main = tempDir();
		const worktree = tempDir();
		linkEnvFiles(worktree, main, () => {});
		expect(existsSync(join(worktree, '.env'))).toBe(false);
	});
});
