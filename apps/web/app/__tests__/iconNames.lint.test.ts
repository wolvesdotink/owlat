/**
 * Self-test for `scripts/check-icon-names.sh`. It guards the guard: both rules
 * are a grep away from matching nothing, and "no violations" is exactly what a
 * broken rule looks like — which is the failure this guard exists to catch,
 * since an icon the client bundle missed renders as an empty box with no build
 * error and no console error inside the Tauri webview.
 *
 * The boundary cases are why this file exists. `lucide:alert-triangle` is an
 * ALIAS, not an icon, and a resolver that only reads the `icons` map would ban
 * dozens of names that render perfectly well today; `.js` is the reachability
 * case, where the name is spelled correctly and still never ships. And the
 * SCOPE is a rule too: packages/ui sits outside the Nuxt rootDir that @nuxt/icon
 * scans by default, so a root that is not there has to fail rather than be
 * named as covered.
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
	'check-icon-names.sh'
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

/** Write one file into its own fixture root and lint that root. */
function lintFile(name: string, fileName: string, contents: string): LintResult {
	const root = join(workDir, name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, fileName), contents);
	return runLint(root);
}

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'icon-names-lint-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe('check-icon-names.sh — the name must exist', () => {
	it('passes an icon that is in the collection', () => {
		expect(
			lintFile('real', 'Card.vue', '<template><Icon name="lucide:mail" /></template>\n').status
		).toBe(0);
	});

	it('fails a name no lucide icon has', () => {
		// `lucide:key-round-x` shipped for months: plausible, wrong, and blank.
		const result = lintFile(
			'typo',
			'Card.vue',
			'<template><Icon name="lucide:key-round-x" /></template>\n'
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain('lucide:key-round-x');
	});

	it('accepts an alias, which renders like any other name', () => {
		// `alert-triangle` is an alias of `triangle-alert`. Reading `icons` alone
		// would fail these, and the loud direction of the bug is just as wrong.
		expect(
			lintFile('alias', 'Card.vue', '<template><Icon name="lucide:alert-triangle" /></template>\n')
				.status
		).toBe(0);
	});
});

describe('check-icon-names.sh — the file must be scanned', () => {
	it('fails a correct name in a file the bundle scan cannot read', () => {
		const result = lintFile('unreachable', 'icons.js', 'export const i = "lucide:mail";\n');
		expect(result.status).toBe(1);
		expect(result.output).toContain('icons.js');
	});

	it('passes the same name in a .ts module', () => {
		// The gap this guard was written for: icon names in plain modules were
		// outside @nuxt/icon's default globs, so they never reached the bundle.
		expect(lintFile('reachable', 'icons.ts', 'export const i = "lucide:mail";\n').status).toBe(0);
	});
});

describe('check-icon-names.sh — scope', () => {
	it('scans the shared components, not only the app', () => {
		const result = runLint();
		expect(result.status).toBe(0);
		expect(result.output).toContain('packages/ui');
		expect(result.output).toContain('app');
	});

	it('fails a root that does not exist instead of reporting it as clean', () => {
		const missing = join(workDir, 'not-a-directory');
		const result = runLint(missing);
		expect(result.status).toBe(1);
		expect(result.errorOutput).toContain(`scan root does not exist: ${missing}`);
	});
});
