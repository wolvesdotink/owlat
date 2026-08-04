/**
 * Self-test for `scripts/check-dead-tokens.sh`. It guards the guard: the rule is
 * two greps, and a grep that stopped matching is indistinguishable from a
 * codebase that stopped violating it — which is exactly the failure mode the
 * rule exists to catch, since a class with no @theme token emits no CSS and no
 * error either.
 *
 * The boundary cases are why this file exists. `text-primary` is dead while
 * `text-text-primary` is the canonical name, so the denylist entry is written
 * with word boundaries and a regression there would silently ban half the
 * codebase or none of it. And the SCOPE is a rule too: the shared components in
 * packages/ui paint the same screens from the same token block, so a passing run
 * has to say which roots it actually read — and a root that is not there has to
 * fail rather than be named as covered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'scripts',
	'check-dead-tokens.sh'
);

interface LintResult {
	readonly status: number;
	readonly output: string;
	readonly errorOutput: string;
}

/** Run the guard over `roots` (none = the shipped defaults). */
function runLint(...roots: string[]): LintResult {
	try {
		return {
			status: 0,
			output: execFileSync('bash', [scriptPath, ...roots], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
			errorOutput: '',
		};
	} catch (err) {
		const failure = err as { status?: number; stdout?: string; stderr?: string };
		return {
			status: typeof failure.status === 'number' ? failure.status : 1,
			output: failure.stdout ?? '',
			errorOutput: failure.stderr ?? '',
		};
	}
}

let workDir: string;

/** Write one component into its own fixture root and lint that root. */
function lintComponent(name: string, contents: string): LintResult {
	const root = join(workDir, name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'Card.vue'), contents);
	return runLint(root);
}

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'dead-tokens-lint-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe('check-dead-tokens.sh — the denylist', () => {
	it('passes a component painted with declared tokens', () => {
		expect(
			lintComponent('clean', '<template><p class="bg-bg-surface text-text-primary" /></template>\n')
				.status
		).toBe(0);
	});

	it('fails bg-surface-subtle, which declares no token and emits no CSS', () => {
		expect(
			lintComponent('subtle', '<template><p class="bg-surface-subtle" /></template>\n').status
		).toBe(1);
	});

	it('fails a bare text-primary', () => {
		expect(lintComponent('bare', '<template><p class="text-primary" /></template>\n').status).toBe(
			1
		);
	});

	it('does not read the canonical names as hits', () => {
		// `text-text-primary`, `bg-text-primary` and the token declaration itself
		// all contain the dead string; banning them would be the loud direction of
		// the same bug.
		expect(
			lintComponent(
				'canonical',
				'<template><p class="text-text-primary bg-text-primary" /></template>\n' +
					'<style>.x { color: var(--color-text-primary); }</style>\n'
			).status
		).toBe(0);
	});
});

describe('check-dead-tokens.sh — accent-<name>', () => {
	it('fails an accent colour with no --color token behind it', () => {
		expect(
			lintComponent('accent-bad', '<template><input class="accent-lime" /></template>\n').status
		).toBe(1);
	});

	it('passes a declared accent colour and an arbitrary value', () => {
		expect(
			lintComponent(
				'accent-ok',
				'<template><input class="accent-brand" /><input class="accent-[#abc]" /></template>\n'
			).status
		).toBe(0);
	});
});

describe('check-dead-tokens.sh — scope', () => {
	it('scans the shared components, not only the app', () => {
		// packages/ui/components renders on the same screens and is checked by
		// nothing else, so a class dead everywhere would have been invisible there.
		const result = runLint();
		expect(result.status).toBe(0);
		expect(result.output).toContain('packages/ui/components');
		expect(result.output).toContain('app');
	});

	it('fails a root that does not exist instead of reporting it as clean', () => {
		// What makes the assertion above mean anything: the roots line is printed
		// from the array, so without this a moved or renamed directory would keep
		// being named as covered while nothing under it was ever read.
		const missing = join(workDir, 'not-a-directory');
		const result = runLint(missing);
		expect(result.status).toBe(1);
		// Named as absent, not as "nothing to scan here": the two have opposite
		// fixes, and only one of them is the guard's own configuration drifting.
		expect(result.errorOutput).toContain(`scan root does not exist: ${missing}`);
	});

	it('fails when one of several roots is missing, even if the others are clean', () => {
		const clean = join(workDir, 'scope-clean');
		mkdirSync(clean, { recursive: true });
		writeFileSync(join(clean, 'Card.vue'), '<template><p class="bg-bg-surface" /></template>\n');
		expect(runLint(clean).status).toBe(0);
		expect(runLint(clean, join(workDir, 'scope-gone')).status).toBe(1);
	});
});
