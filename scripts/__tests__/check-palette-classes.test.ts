/**
 * The raw-palette gate's own gate: which spellings of a banned class count, and
 * which files the scan reads.
 *
 * Both rules fail silently in the safe-looking direction — a gate that misses
 * `hover:bg-white`, or that never opens a `.vue` file, is indistinguishable
 * from `exit 0` for the leaks it exists to stop. So each boundary is proved by
 * a pair: the spelling that must fail and the near-miss beside it that must
 * pass. The escape hatch has its own file,
 * check-palette-classes.hatch.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, ROOTS, cleanupSandboxes, component, run } from './paletteClasses.testlib';

afterEach(cleanupSandboxes);

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
		// The scrim colour, and the two prefixes that paint an edge rather than a face.
		['bg-black/60', 'class="bg-black/60"'],
		['border-white', 'class="border-white"'],
		['ring-white/20', 'class="ring-white/20"'],
		['ring-black/10', 'class="ring-1 ring-inset ring-black/10"'],
		// The other neutral ladders Tailwind ships, which read identically.
		['border-slate-700', 'class="border-slate-700"'],
		['text-zinc-400', 'class="text-zinc-400"'],
		['bg-neutral-100', 'class="bg-neutral-100"'],
		['text-stone-500', 'class="text-stone-500"'],
		// And the chromatic families: a shade is a fixed hex, so it is legible on
		// exactly the one theme it was written against — text-red-300 reads on a dark
		// page and lands at ~1.7:1 on the light one.
		['text-red-300', 'class="text-red-300"'],
		['bg-amber-500/10', 'class="bg-amber-500/10"'],
		['text-emerald-300', 'class="text-emerald-300"'],
		['border-blue-500', 'class="border-blue-500"'],
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
		['a family name with no shade', 'class="bg-rose"'],
		// Only the palette FAMILIES are banned; a keyword and a semantic token that
		// merely start the same way carry no fixed colour of their own.
		['a keyword colour', 'class="border-transparent"'],
		['a semantic error token', 'class="bg-error-strong text-text-inverse"'],
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

	it('reads .css, where an @apply moves the same colour one file away', () => {
		const result = run({
			'apps/web/app/assets/css/paper.css': ['.paper {', '\t@apply bg-white;', '}', ''].join('\n'),
		});

		expect(result.output).toContain('apps/web/app/assets/css/paper.css:2');
		expect(result.status).toBe(1);
	});

	it('reads the design system, where one class paints every call site at once', () => {
		// The leak this second root exists for: `.btn-danger` kept a literal
		// `text-white` through a whole sweep of the app, and every danger button
		// rendered it while the handful swept by hand did not.
		const result = run({
			'packages/ui/components/ui/Button.vue': component('class="bg-error text-white"'),
		});

		expect(result.output).toContain('packages/ui/components/ui/Button.vue:2');
		expect(result.status).toBe(1);
	});

	it('ignores files that are none of .vue, .ts or .css', () => {
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

	it.each(ROOTS)('fails when the %s scan root has moved', (moved) => {
		// A root that is not there must be a build failure, not an empty scan that
		// keeps reporting a clean surface it never read — and EACH root has to say so
		// on its own, or adding a second one quietly makes the first optional.
		const present = ROOTS.filter((scanned) => scanned !== moved);
		const result = run(
			Object.fromEntries(
				present.map((scanned) => [`${scanned}/Card.vue`, component('class="p-4"')])
			),
			{ seedRoot: false }
		);

		expect(result.output).toContain(`Cannot scan ${moved}`);
		expect(result.status).toBe(1);
	});
});
