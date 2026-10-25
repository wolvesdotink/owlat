import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViteUserConfig } from 'vitest/config';
import vitestConfig from '../../vitest.config';
import { PARALLEL_GATE_TIMEOUT_MS, POPULATION_SUITE_TIMEOUT_MS } from '../../../../vitest.timeouts';

/**
 * The API suite's time budgets live in vitest.config.ts and come from the
 * shared vitest.timeouts.ts; no test sets its own (the owlat lint rule
 * no-test-timeout-or-unreasoned-skip). The rule does not read a config's
 * timeout values, so this reads them: every budget is a shared one, and each
 * suite the config names for the population budget exists and runs only
 * there. A renamed population suite would otherwise drop back to the smaller
 * budget without a word.
 */

interface ProjectTest {
	readonly name?: string;
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
	readonly environment?: string;
	readonly testTimeout?: number;
	readonly hookTimeout?: number;
}

const apiRoot = resolve(import.meta.dirname, '..', '..');
const config = vitestConfig as ViteUserConfig;
const projects = (config.test?.projects ?? []) as ReadonlyArray<{ readonly test?: ProjectTest }>;

function project(name: string): ProjectTest {
	const found = projects.find((entry) => entry.test?.name === name)?.test;
	if (!found) throw new Error(`no vitest project named ${name}`);
	return found;
}

describe('API vitest budgets', () => {
	it('gives every suite the shared parallel-gate budget by default', () => {
		expect(config.test?.testTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
		expect(config.test?.hookTimeout).toBe(PARALLEL_GATE_TIMEOUT_MS);
		for (const name of ['unit', 'integration']) {
			expect(project(name).testTimeout, name).toBeUndefined();
			expect(project(name).hookTimeout, name).toBeUndefined();
		}
	});

	it('gives the population projects the shared population budget, in their suites’ environment', () => {
		for (const [name, environment] of [
			['unit-population', project('unit').environment],
			['integration-population', project('integration').environment],
		] as const) {
			expect(project(name).testTimeout, name).toBe(POPULATION_SUITE_TIMEOUT_MS);
			expect(project(name).hookTimeout, name).toBe(POPULATION_SUITE_TIMEOUT_MS);
			expect(project(name).environment, name).toBe(environment);
		}
	});

	it('runs each named population suite once, in the population project of its kind', () => {
		const unit = project('unit-population').include ?? [];
		const integration = project('integration-population').include ?? [];
		const named = [...unit, ...integration];

		expect(unit.length).toBeGreaterThan(0);
		expect(integration.length).toBeGreaterThan(0);
		expect(new Set(named).size).toBe(named.length);
		expect(unit.filter((path) => path.endsWith('.integration.test.ts'))).toEqual([]);
		expect(integration.every((path) => path.endsWith('.integration.test.ts'))).toBe(true);
		for (const path of named) {
			expect(existsSync(resolve(apiRoot, path)), path).toBe(true);
			expect(project('unit').exclude, path).toContain(path);
			expect(project('integration').exclude, path).toContain(path);
		}
	});
});
