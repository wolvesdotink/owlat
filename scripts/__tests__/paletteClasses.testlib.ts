/**
 * Shared fixture for the raw-palette gate's own tests
 * (check-palette-classes*.test.ts).
 *
 * `run()` builds a miniature repository — the real script at scripts/, and
 * whatever sources the case seeds under the roots the script walks — so a case
 * can prove what the gate does with a banned class without touching the
 * repository the gate guards.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SCRIPT = resolve(import.meta.dirname, '../check-palette-classes.ts');
export const REPO_ROOT = resolve(import.meta.dirname, '../..');

const sandboxes: string[] = [];

/** Register with `afterEach` in every file that calls `run()`. */
export function cleanupSandboxes(): void {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

export type Result = { status: number; output: string };

/** The roots the script walks — both have to exist for a case to reach the scan. */
export const ROOTS = ['apps/web/app', 'packages/ui/components'];

/**
 * A miniature repository: the real script at scripts/, and whatever sources the
 * case seeds under the roots it walks.
 */
export function run(files: Record<string, string>, options: { seedRoot?: boolean } = {}): Result {
	const root = mkdtempSync(join(tmpdir(), 'owlat-palette-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-palette-classes.ts'));
	if (options.seedRoot !== false)
		for (const scanned of ROOTS) mkdirSync(join(root, scanned), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const absolute = join(root, path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}
	const result = spawnSync('bun', ['scripts/check-palette-classes.ts'], {
		cwd: root,
		encoding: 'utf8',
	});
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** A component whose whole body is one element carrying `attribute`. */
export function component(attribute: string): string {
	return ['<template>', `\t<div ${attribute}>Body</div>`, '</template>', ''].join('\n');
}
