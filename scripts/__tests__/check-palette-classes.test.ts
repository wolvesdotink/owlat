/**
 * The raw-palette gate's own gate.
 *
 * The rules this covers are all boundaries — which spellings of a banned class
 * count, which comment is prose and which is an escape hatch, which lines a
 * hatch covers — and every one of them fails silently in the safe-looking
 * direction: a gate that misses `hover:bg-white` or that treats a paragraph
 * about `bg-white` as markup is indistinguishable from `exit 0` for the leaks it
 * exists to stop. So each boundary is proved by a pair: the spelling that must
 * fail and the near-miss beside it that must pass.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-palette-classes.ts');
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
 * A miniature repository: the real script at scripts/, and whatever sources the
 * case seeds under the apps/web/app root it walks.
 */
function run(files: Record<string, string>, options: { seedRoot?: boolean } = {}): Result {
	const root = mkdtempSync(join(tmpdir(), 'owlat-palette-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-palette-classes.ts'));
	if (options.seedRoot !== false) mkdirSync(join(root, 'apps/web/app'), { recursive: true });
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
function component(attribute: string): string {
	return ['<template>', `\t<div ${attribute}>Body</div>`, '</template>', ''].join('\n');
}

describe('the raw-palette gate, on the repository it guards', () => {
	it('passes', () => {
		const result = spawnSync('bun', ['scripts/check-palette-classes.ts'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		expect(`${result.stdout}${result.stderr}`).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('the raw-palette gate, spellings of a banned class', () => {
	it.each([
		['bg-white', 'class="bg-white"'],
		['text-white', 'class="text-white"'],
		['text-gray-500', 'class="text-gray-500"'],
		['bg-gray-50', 'class="bg-gray-50"'],
		['border-gray-200', 'class="border-gray-200"'],
		// A variant prefix is the same opt-out with a condition on it.
		['hover:bg-white', 'class="rounded hover:bg-white"'],
		['dark:text-gray-400', 'class="dark:text-gray-400"'],
		['group-hover:bg-gray-100', 'class="group-hover:bg-gray-100"'],
		// So is an opacity suffix.
		['bg-white/10', 'class="bg-white/10"'],
		['text-white/70', 'class="text-white/70"'],
		['bg-gray-900/50', 'class="bg-gray-900/50"'],
		// A bound value ships the same class by a different spelling.
		['a bound ternary', `:class="on ? 'bg-white' : 'bg-bg-surface'"`],
		['a bound array', `:class="['bg-white', size]"`],
	])('fails on %s', (_label, attribute) => {
		const result = run({ 'apps/web/app/components/Card.vue': component(attribute) });

		expect(result.output).toContain('Raw palette classes in apps/web/app');
		expect(result.output).toContain('apps/web/app/components/Card.vue:2');
		expect(result.status).toBe(1);
	});

	it.each([
		// The tokens the app is supposed to use.
		['a background token', 'class="bg-bg-surface"'],
		['a text token', 'class="text-text-secondary"'],
		['a border token', 'class="border-border-subtle"'],
		// `white` and `gray` as SUBSTRINGS are different classes; flagging them
		// would make the gate something authors route around rather than obey.
		['whitespace-nowrap', 'class="whitespace-nowrap"'],
		['a longer class that ends in the token', 'class="bg-bg-white"'],
		['a longer class that starts with it', 'class="text-white-ish"'],
		['a gray shade with no number', 'class="text-grayscale"'],
		// Only the named families are banned; the rest is the sweep's business.
		['another palette family', 'class="text-red-400"'],
	])('passes %s', (_label, attribute) => {
		const result = run({ 'apps/web/app/components/Card.vue': component(attribute) });

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('fails on a class attribute the formatter wrapped across lines', () => {
		const result = run({
			'apps/web/app/components/Card.vue': [
				'<template>',
				'\t<div',
				'\t\tclass="inline-flex items-center',
				'\t\t\tbg-white"',
				'\t>',
				'\t\tBody',
				'\t</div>',
				'</template>',
				'',
			].join('\n'),
		});

		// Reported on the line the CLASS sits on, which is the line to edit.
		expect(result.output).toContain('apps/web/app/components/Card.vue:4');
		expect(result.status).toBe(1);
	});

	it('fails on an @apply inside a style block', () => {
		// A scoped rule ships the same colour; moving the leak from the template
		// into CSS must not launder it.
		const result = run({
			'apps/web/app/pages/report.vue': [
				'<template>',
				'\t<div class="paper">Body</div>',
				'</template>',
				'',
				'<style scoped>',
				'.paper {',
				'\t@apply bg-white;',
				'}',
				'</style>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/pages/report.vue:7');
		expect(result.status).toBe(1);
	});
});

describe('the raw-palette gate, what it reads', () => {
	it('reads .ts sources, where class strings also live', () => {
		const result = run({
			'apps/web/app/composables/useTone.ts': "export const paper = 'bg-white p-4';\n",
		});

		expect(result.output).toContain('apps/web/app/composables/useTone.ts:1');
		expect(result.status).toBe(1);
	});

	it.each([
		['a spec file', 'apps/web/app/components/Card.test.ts'],
		['a file under __tests__', 'apps/web/app/components/__tests__/card.ts'],
	])('ignores %s, where a class name is never compiled', (_label, path) => {
		const result = run({ [path]: "expect(html).toContain('bg-white');\n" });

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('ignores files that are neither .vue nor .ts', () => {
		const result = run({ 'apps/web/app/README.md': 'Never write `bg-white` here.\n' });

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it.each([
		['an HTML comment', '<!-- The paper is bg-white on purpose elsewhere. -->'],
		['a block comment', '/* Prose about bg-white. */'],
		['a line comment at the start of a line', '// Prose about bg-white.'],
	])('does not read %s as markup', (_label, comment) => {
		const result = run({
			'apps/web/app/components/Card.vue': ['<template>', `\t${comment}`, '</template>', ''].join(
				'\n'
			),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('still reads a class that sits before a trailing // on the same line', () => {
		// Blanking a trailing `//` would blank the rest of ITS line too, and a `//`
		// is indistinguishable from the one inside a URL — so the mask takes only
		// comments that own their line. Anything else is a false negative.
		const result = run({
			'apps/web/app/components/Card.vue': [
				'<template>',
				'\t<img src="https://cdn.example/a.png" class="bg-white" />',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/components/Card.vue:2');
		expect(result.status).toBe(1);
	});

	it('walks nested directories and reports every hit with its own line', () => {
		const result = run({
			'apps/web/app/components/deep/nest/One.vue': [
				'<template>',
				'\t<div class="bg-white">A</div>',
				'\t<div class="text-gray-500">B</div>',
				'</template>',
				'',
			].join('\n'),
			'apps/web/app/pages/two.vue': component('class="bg-gray-100"'),
		});

		expect(result.output).toContain('apps/web/app/components/deep/nest/One.vue:2');
		expect(result.output).toContain('apps/web/app/components/deep/nest/One.vue:3');
		expect(result.output).toContain('apps/web/app/pages/two.vue:2');
		expect(result.status).toBe(1);
	});

	it('fails when the scan root has moved', () => {
		// A root that is not there must be a build failure, not an empty scan that
		// keeps reporting a clean surface it never read.
		const result = run({}, { seedRoot: false });

		expect(result.output).toContain('Cannot scan apps/web/app');
		expect(result.status).toBe(1);
	});
});

describe('the raw-palette gate, the escape hatch', () => {
	it('accepts a marker on its own line above the element', () => {
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				'\t<!-- palette-ok: email paper ships its own light palette -->',
				'\t<div class="bg-white">Body</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('accepts a marker trailing the line it excuses', () => {
		const result = run({
			'apps/web/app/composables/usePaper.ts': [
				"export const paper = 'bg-white'; // palette-ok: email paper, not an app surface",
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('reaches a class attribute several lines inside a multi-line start tag', () => {
		// HTML forbids a comment inside a start tag, so a marker that only covered
		// the NEXT line would be out of reach of exactly the elements that need it
		// most — every iframe would have to spend two lines on a region instead.
		const result = run({
			'apps/web/app/components/Preview.vue': [
				'<template>',
				'\t<!-- palette-ok: the rendered document paints its own light paper -->',
				'\t<iframe',
				'\t\t:srcdoc="html"',
				'\t\tsandbox=""',
				'\t\tclass="w-full bg-white"',
				'\t/>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('stops at the line that closes the start tag', () => {
		const result = run({
			'apps/web/app/components/Preview.vue': [
				'<template>',
				'\t<!-- palette-ok: the rendered document paints its own light paper -->',
				'\t<iframe',
				'\t\tclass="w-full bg-white"',
				'\t/>',
				'\t<p class="text-gray-500">Caption</p>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/components/Preview.vue:6');
		expect(result.output).not.toContain('Preview.vue:4');
		expect(result.status).toBe(1);
	});

	it('steps over blank lines and prose comments to reach the element', () => {
		// A marker often shares a comment block with the prose that explains the
		// element; the two must not have to be adjacent.
		const result = run({
			'apps/web/app/components/Preview.vue': [
				'<template>',
				'\t<!-- palette-ok: the rendered document paints its own light paper -->',
				'',
				'\t<!-- Sandboxed: no scripts, no app origin. -->',
				'\t<iframe class="bg-white" />',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('accepts a region around a whole surface', () => {
		// The wider case one element cannot state: every colour under the scrim is
		// literal for the same one reason.
		const result = run({
			'apps/web/app/components/Lightbox.vue': [
				'<template>',
				'\t<!-- palette-ok-start: chrome drawn on the fixed black scrim below -->',
				'\t<div class="fixed inset-0 bg-black/85">',
				'\t\t<p class="text-white/90">Name</p>',
				'\t\t<button class="hover:bg-white/10">Close</button>',
				'\t</div>',
				'\t<!-- palette-ok-end -->',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('does not let a marker excuse a line outside its scope', () => {
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				'\t<!-- palette-ok: email paper ships its own light palette -->',
				'\t<div class="bg-white">Body</div>',
				'\t<div class="bg-white">Sidebar</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/components/Paper.vue:4');
		expect(result.output).not.toContain('Paper.vue:3');
		expect(result.status).toBe(1);
	});

	it.each([
		['a bare marker with no reason', '<!-- palette-ok -->', 'needs a reason'],
		['a marker whose colon has nothing after it', '<!-- palette-ok: -->', 'needs a reason'],
	])('rejects %s', (_label, marker, message) => {
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				`\t${marker}`,
				'\t<div class="bg-white">Body</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain(message);
		expect(result.status).toBe(1);
	});

	it.each([
		[
			'a region that is never closed',
			['\t<!-- palette-ok-start: paper -->', '\t<div class="bg-white">Body</div>'],
			'never closed',
		],
		[
			'an end with no start',
			['\t<div class="bg-white">Body</div>', '\t<!-- palette-ok-end -->'],
			'without a palette-ok-start',
		],
	])('rejects %s', (_label, body, message) => {
		const result = run({
			'apps/web/app/components/Paper.vue': ['<template>', ...body, '</template>', ''].join('\n'),
		});

		expect(result.output).toContain(message);
		expect(result.status).toBe(1);
	});

	it.each([
		[
			'a single marker',
			['\t<!-- palette-ok: paper -->', '\t<div class="bg-bg-surface">Body</div>'],
		],
		[
			'a region',
			[
				'\t<!-- palette-ok-start: paper -->',
				'\t<div class="bg-bg-surface">Body</div>',
				'\t<!-- palette-ok-end -->',
			],
		],
	])('rejects %s that excuses nothing', (_label, body) => {
		// Strict in BOTH directions, like the member-jargon and provider-identity
		// baselines: an exemption whose element has since been re-tokenised excuses
		// nothing today and silently pre-approves the regression that puts the
		// palette class back tomorrow.
		const result = run({
			'apps/web/app/components/Paper.vue': ['<template>', ...body, '</template>', ''].join('\n'),
		});

		expect(result.output).toContain('Unused palette-ok exemption');
		expect(result.output).toContain('apps/web/app/components/Paper.vue:2');
		expect(result.status).toBe(1);
	});

	it('reports an unused exemption alongside a real violation, not instead of it', () => {
		// Both verdicts come out of the same completed scan and are independent
		// edits; hiding one behind the other turns a single fix into two round trips.
		const result = run({
			'apps/web/app/components/Paper.vue': [
				'<template>',
				'\t<!-- palette-ok: paper -->',
				'\t<div class="bg-bg-surface">Body</div>',
				'\t<div class="text-gray-500">Caption</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain('Raw palette classes in apps/web/app');
		expect(result.output).toContain('apps/web/app/components/Paper.vue:4');
		expect(result.output).toContain('Unused palette-ok exemption');
		expect(result.status).toBe(1);
	});
});
