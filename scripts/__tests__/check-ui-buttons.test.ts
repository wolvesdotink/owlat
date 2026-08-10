/**
 * The raw-`.btn` gate's own gate.
 *
 * The script this covers shipped with a per-line matcher —
 * `/class="[^"]*(?:^|\s)btn(?:\s|$)/` — whose two boundaries were both dead:
 * `^` cannot match after `class="` has been consumed, and `(?:\s|$)` never
 * reaches the closing quote. So the two spellings a human actually writes,
 * `class="btn btn-primary"` and `class="foo btn"`, both passed. A gate that
 * only catches a middle-of-string `btn` is indistinguishable from `exit 0` for
 * every real violation, so every boundary is proved by a pair here: the token
 * that must fail and the near-miss beside it that must pass.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-ui-buttons.ts');
const REPO_ROOT = resolve(import.meta.dirname, '../..');

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

type Result = { status: number; output: string };

/**
 * A miniature repository: the real script at scripts/, and whatever component
 * sources the case seeds under the apps/web/app root the script walks.
 */
function run(files: Record<string, string>): Result {
	const root = mkdtempSync(join(tmpdir(), 'owlat-ui-buttons-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-ui-buttons.ts'));
	mkdirSync(join(root, 'apps/web/app'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const absolute = join(root, path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}
	const result = spawnSync('bun', ['scripts/check-ui-buttons.ts'], { cwd: root, encoding: 'utf8' });
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** A component whose whole body is one element carrying `attribute`. */
function component(attribute: string): string {
	return ['<template>', `\t<button ${attribute}>Send</button>`, '</template>', ''].join('\n');
}

describe('the raw-.btn gate, on the repository it guards', () => {
	it('passes', () => {
		const result = spawnSync('bun', ['scripts/check-ui-buttons.ts'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		expect(`${result.stdout}${result.stderr}`).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('the raw-.btn gate, positions of the token', () => {
	it.each([
		// The two the shipped regex could not see, and the reason this test exists.
		['first, with a modifier after it', 'class="btn btn-primary"'],
		['last in the value', 'class="foo btn"'],
		['alone in the value', 'class="btn"'],
		['in the middle', 'class="mt-4 btn gap-2"'],
		['with several classes on both sides', 'class="mt-4 w-full btn btn-sm gap-2"'],
	])('fails on btn %s', (_label, attribute) => {
		const result = run({ 'apps/web/app/components/Send.vue': component(attribute) });

		expect(result.output).toContain('Use <UiButton> instead of raw .btn classes');
		expect(result.output).toContain('apps/web/app/components/Send.vue:2');
		expect(result.status).toBe(1);
	});

	it.each([
		// `btn` is a TOKEN, not a substring. Every one of these is a different
		// class, and flagging them would make the gate something authors route
		// around rather than obey.
		['a word that merely contains no token', 'class="button"'],
		['a component class that ends in -btn', 'class="tb-btn tb-close"'],
		['a component class that starts with btn-', 'class="btn-primary"'],
		['a hyphenated name with btn inside', 'class="titlebar-btn-row"'],
		['an underscored name', 'class="tb_btn"'],
	])('passes %s', (_label, attribute) => {
		const result = run({ 'apps/web/app/components/Send.vue': component(attribute) });

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('the raw-.btn gate, spellings other than a static class', () => {
	it.each([
		['a bound class with a ternary', `:class="isPrimary ? 'btn' : 'link'"`],
		['a bound class in an array', `:class="['btn', size]"`],
		['a bound class as an object key', `:class="{ btn: true }"`],
		['the v-bind: long form', `v-bind:class="'btn'"`],
		['a bound value where btn sits beside another class', `:class="'btn ' + variant"`],
	])('fails on %s', (_label, attribute) => {
		// A bound value ships the same class by a different spelling; a gate blind
		// to it is one refactor away from bypassable.
		const result = run({ 'apps/web/app/components/Send.vue': component(attribute) });

		expect(result.output).toContain('apps/web/app/components/Send.vue:2');
		expect(result.status).toBe(1);
	});

	it('fails on a single-quoted class attribute', () => {
		const result = run({ 'apps/web/app/components/Send.vue': component(`class='btn btn-sm'`) });

		expect(result.output).toContain('apps/web/app/components/Send.vue:2');
		expect(result.status).toBe(1);
	});

	it('fails on a class attribute the formatter wrapped across lines', () => {
		// The predecessor read one line at a time, so a wrapped attribute was a
		// cosmetic reformat away from invisible. Reported on the line the attribute
		// OPENS, which is where a reader looks.
		const result = run({
			'apps/web/app/components/Send.vue': [
				'<template>',
				'\t<button',
				'\t\tclass="inline-flex items-center justify-center gap-2',
				'\t\t\tbtn btn-primary"',
				'\t>',
				'\t\tSend',
				'\t</button>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/components/Send.vue:3');
		expect(result.status).toBe(1);
	});

	it.each([
		['a pass-through prop named *-class', 'wrapper-class="btn"'],
		['a data attribute', 'data-class="btn"'],
	])('passes %s, which is not a class attribute', (_label, attribute) => {
		const result = run({ 'apps/web/app/components/Send.vue': component(attribute) });

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('passes a .btn rule inside a scoped style block', () => {
		// A page that defines its own `.btn-sm` padding is styling, not a raw
		// button; the gate is about the class ATTRIBUTE.
		const result = run({
			'apps/web/app/pages/segments.vue': [
				'<template>',
				'\t<UiButton size="sm">Send</UiButton>',
				'</template>',
				'',
				'<style scoped>',
				'.btn-sm {',
				'\tpadding: 0.375rem 0.75rem;',
				'}',
				'</style>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('the raw-.btn gate, what it reports', () => {
	it('reports every violation, in every file, with its own line', () => {
		const result = run({
			'apps/web/app/components/One.vue': [
				'<template>',
				'\t<button class="btn btn-primary">A</button>',
				'\t<button class="foo btn">B</button>',
				'</template>',
				'',
			].join('\n'),
			'apps/web/app/pages/two.vue': component('class="btn"'),
		});

		expect(result.output).toContain('apps/web/app/components/One.vue:2');
		expect(result.output).toContain('apps/web/app/components/One.vue:3');
		expect(result.output).toContain('apps/web/app/pages/two.vue:2');
		expect(result.status).toBe(1);
	});

	it('walks nested directories', () => {
		const result = run({
			'apps/web/app/components/deep/nest/Send.vue': component('class="btn"'),
		});

		expect(result.output).toContain('apps/web/app/components/deep/nest/Send.vue:2');
		expect(result.status).toBe(1);
	});

	it('ignores non-.vue sources', () => {
		const result = run({
			'apps/web/app/utils/classes.ts': "export const primary = 'btn btn-primary';\n",
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});
});
