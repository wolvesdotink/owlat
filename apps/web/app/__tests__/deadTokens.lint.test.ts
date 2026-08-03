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
 * has to say which roots it actually read.
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
}

/** Run the guard over `roots` (none = the shipped defaults). */
function runLint(...roots: string[]): LintResult {
	try {
		return {
			status: 0,
			output: execFileSync('bash', [scriptPath, ...roots], { encoding: 'utf8' }),
		};
	} catch (err) {
		const failure = err as { status?: number; stdout?: string };
		return {
			status: typeof failure.status === 'number' ? failure.status : 1,
			output: failure.stdout ?? '',
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
});
