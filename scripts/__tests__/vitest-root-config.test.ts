/**
 * scripts/__tests__ runs from the repository root under the root
 * vitest.config.ts, which gives every test and hook the shared budget from
 * vitest.timeouts.ts: most of these tests run a real tool on the real tree, and
 * vitest's 5000ms default failed them on a loaded runner. No test here sets a
 * budget of its own (owlat/no-test-timeout-or-unreasoned-skip).
 *
 * vitest looks for its config in the working directory and then in each parent,
 * so a workspace without a config of its own would silently run under the root
 * one, which selects no files there.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import rootConfig from '../../vitest.config';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFIG_FILE = /^(?:vitest|vite)\.config\.[cm]?[jt]s$/;

const tracked = execFileSync('git', ['ls-files'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
	.split('\n')
	.filter(Boolean);

describe('root vitest config', () => {
	it('selects only the scripts suite and gives its tests and hooks the shared budget', () => {
		expect(rootConfig.test?.include).toEqual(['scripts/__tests__/**/*.test.ts']);
		expect(rootConfig.test?.testTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
		expect(rootConfig.test?.hookTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
	});

	it('is the config this run loaded', ({ task }) => {
		expect(task.timeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
	});

	it('is never reached from a workspace that runs vitest', () => {
		const configDirectories = new Set(
			tracked
				.filter((file) => CONFIG_FILE.test(file.split('/').at(-1) ?? ''))
				.map((file) => dirname(file))
		);
		const vitestWorkspaces = tracked
			.filter((file) => file.endsWith('/package.json'))
			.filter((file) => {
				const { scripts = {} } = JSON.parse(readFileSync(join(REPOSITORY_ROOT, file), 'utf8')) as {
					scripts?: Record<string, string>;
				};
				return Object.values(scripts).some((command) => /\bvitest\b/.test(command));
			})
			.map((file) => dirname(file));

		expect(vitestWorkspaces).toContain('apps/web');
		expect(vitestWorkspaces.filter((directory) => !configDirectories.has(directory))).toEqual([]);
	});
});
