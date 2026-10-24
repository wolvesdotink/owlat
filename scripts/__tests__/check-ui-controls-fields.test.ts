/**
 * The field rules of the form-control gate (scripts/check-ui-controls.ts):
 * every native text control carries the `.input` recipe or `.input-bare`, and
 * nothing that carries one adds chrome or a size of its own (docs/web-ui.md).
 *
 * Each rule is proved by a pair: the markup that must fail and the near-miss
 * beside it that must pass. The near-misses matter as much as the failures:
 * checkboxes, layout classes and one-sided icon room are legitimate, and a gate
 * that flagged them would be routed around rather than obeyed.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-ui-controls.ts');
const FILE = 'apps/web/app/components/Field.vue';
const UNSTYLED = 'Give native text controls the field recipe';
const RESTYLED = 'Do not restyle a field';

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

type Result = { status: number; output: string };

/** A miniature repository: the real script, and the sources the case seeds. */
function run(files: Record<string, string>): Result {
	const root = mkdtempSync(join(tmpdir(), 'owlat-ui-fields-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'scripts'), { recursive: true });
	copyFileSync(SCRIPT, join(root, 'scripts/check-ui-controls.ts'));
	mkdirSync(join(root, 'apps/web/app'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const absolute = join(root, path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, contents);
	}
	const result = spawnSync('bun', ['scripts/check-ui-controls.ts'], {
		cwd: root,
		encoding: 'utf8',
	});
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** A component whose template is the given markup, on line 2. */
function template(markup: string): string {
	return ['<template>', `\t${markup}`, '</template>', ''].join('\n');
}

const check = (markup: string) => run({ [FILE]: template(markup) });

describe('native text controls carry the recipe', () => {
	it.each([
		['an input with no type', '<input v-model="name" />'],
		['a text input with no class', '<input type="text" />'],
		['an email input', '<input type="email" class="w-full" />'],
		['a number input', '<input type="number" class="w-20" />'],
		['a search input', '<input type="search" class="flex-1" />'],
		['a date input', '<input type="date" />'],
		['an uppercase type', '<input type="TEXT" />'],
		['a select', '<select v-model="x"><option>a</option></select>'],
		['a textarea', '<textarea v-model="x" />'],
		[
			'a hand-rolled field',
			'<input class="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2" />',
		],
		['a password toggle', `<input :type="shown ? 'text' : 'password'" />`],
		['a bound type that names no literal', '<input :type="kind" />'],
		['a recipe hidden behind an identifier', '<input :class="inputClass" />'],
		['a modifier without the base class', '<input class="input-sm input-error" />'],
		['a class that merely contains input', '<input class="inputs ui-input-control" />'],
	])('fails on %s', (_label, markup) => {
		const result = check(markup);

		expect(result.output).toContain(UNSTYLED);
		expect(result.output).toContain(`${FILE}:2`);
		expect(result.status).toBe(1);
	});

	it.each([
		['the recipe', '<input type="text" class="input" />'],
		['the recipe among layout classes', '<input class="mt-2 input w-64" />'],
		['the bare variant', '<input class="input-bare flex-1" />'],
		['the recipe in a bound array', `<select :class="['input', size]" />`],
		['the recipe in a bound ternary', `<textarea :class="small ? 'input input-sm' : 'input'" />`],
		['the recipe as an object key', '<input :class="{ input: true }" />'],
		['the recipe in a template literal', '<input :class="`input ${extra}`" />'],
		[
			'the recipe static, modifiers bound',
			`<input class="input" :class="{ 'input-error': bad }" />`,
		],
		['a checkbox', '<input type="checkbox" class="size-4" />'],
		['a radio', '<input type="radio" />'],
		['a file input', '<input type="file" class="hidden" />'],
		['a range input', '<input type="range" />'],
		['a colour input', '<input type="color" />'],
		['a hidden input', '<input type="hidden" name="token" />'],
		[
			'a bound type that only names non-text types',
			`<input :type="many ? 'checkbox' : 'radio'" />`,
		],
		['a component named like a control', '<SelectMenu />'],
	])('passes %s', (_label, markup) => {
		const result = check(markup);

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('reports a wrapped tag on the line it opens', () => {
		const result = run({
			[FILE]: [
				'<template>',
				'\t<div>',
				'\t\t<textarea',
				'\t\t\tv-model="note"',
				'\t\t\tclass="w-full resize-none"',
				'\t\t/>',
				'\t</div>',
				'</template>',
				'',
			].join('\n'),
		});

		expect(result.output).toContain(`${FILE}:3 <textarea>`);
		expect(result.status).toBe(1);
	});

	it('reads a tag whose attribute values contain >', () => {
		const result = check(`<input :disabled="count > 0" class="input" @keydown="a => b" />`);

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('ignores controls in comments, interpolations, scripts and styles', () => {
		const result = run({
			[FILE]: [
				'<script setup lang="ts">',
				'const markup = \'<input type="text">\';',
				'</script>',
				'<template>',
				'\t<!-- <input type="text"> was replaced by the field below -->',
				'\t<p>{{ count <input ? 1 : 2 }}</p>',
				'\t<input class="input" />',
				'</template>',
				'<style scoped>',
				'select { color: red; }',
				'</style>',
				'',
			].join('\n'),
		});

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('walks nested directories and reports every file', () => {
		const result = run({
			'apps/web/app/pages/settings/deep/index.vue': template('<select />'),
			'apps/web/app/components/A.vue': template('<textarea />'),
		});

		expect(result.output).toContain('apps/web/app/components/A.vue:2 <textarea>');
		expect(result.output).toContain('apps/web/app/pages/settings/deep/index.vue:2 <select>');
		expect(result.status).toBe(1);
	});
});

describe('a field adds layout, not chrome', () => {
	it.each([
		['a radius', 'class="input rounded-xl"', 'rounded-xl'],
		['a background', 'class="input bg-bg-base"', 'bg-bg-base'],
		['a border', 'class="input border border-brand"', 'border border-brand'],
		['a shadow', 'class="input shadow-none"', 'shadow-none'],
		['a surface pair', 'class="input surface-2"', 'surface-2'],
		['a focus ring under a variant', 'class="input focus:ring-2"', 'focus:ring-2'],
		['an outline', 'class="input outline-none"', 'outline-none'],
		['a hover background', 'class="input hover:bg-bg-surface"', 'hover:bg-bg-surface'],
		['an important radius', 'class="input !rounded-none"', '!rounded-none'],
		[
			'an arbitrary-variant background',
			'class="input [&:invalid]:bg-error/5"',
			'[&:invalid]:bg-error/5',
		],
		['a font size', 'class="input text-xs"', 'text-xs'],
		['a responsive font size', 'class="input md:text-lg"', 'md:text-lg'],
		['all-round padding', 'class="input p-2"', 'p-2'],
		['horizontal padding', 'class="input px-4"', 'px-4'],
		['vertical padding', 'class="input py-1.5"', 'py-1.5'],
		[
			'chrome in a bound class beside the recipe',
			`class="input" :class="{ 'bg-warning/5': note }"`,
			'bg-warning/5',
		],
		['chrome in a bound array', `:class="['input', 'rounded-full']"`, 'rounded-full'],
	])('fails on %s', (_label, attributes, offending) => {
		const result = check(`<input ${attributes} />`);

		expect(result.output).toContain(RESTYLED);
		expect(result.output).toContain(`${FILE}:2 <input> ${offending}`);
		expect(result.status).toBe(1);
	});

	it('holds a wrapper that wears the recipe to the same rule', () => {
		const result = check('<div class="input flex items-center rounded-full py-1.5" />');

		expect(result.output).toContain(`${FILE}:2 <div> rounded-full py-1.5`);
		expect(result.status).toBe(1);
	});

	it.each([
		['width and spacing', 'class="input w-64 mt-2 mb-4 shrink-0 max-w-[14rem]"'],
		['flex placement', 'class="input flex-1 min-w-0 self-end"'],
		['one-sided room for an icon or action', 'class="input pl-10 pr-8 pb-8"'],
		['the recipe modifiers', 'class="input input-sm input-error input-note"'],
		['typeface and weight', 'class="input font-mono font-semibold"'],
		['textarea height and resize', 'class="input h-28 min-h-[80px] resize-y"'],
		['a native select arrow swap', 'class="input appearance-none pr-8"'],
		['disabled-state layout', 'class="input disabled:cursor-not-allowed disabled:opacity-50"'],
		['a text colour', `class="input" :class="{ 'text-error': bad }"`],
	])('passes %s', (_label, attributes) => {
		const result = check(`<input ${attributes} />`);

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});

	it('lets a bare control size itself but not draw chrome', () => {
		expect(check('<input class="input-bare px-1 text-xs leading-relaxed" />').status).toBe(0);

		const result = check('<input class="input-bare bg-bg-surface rounded-lg" />');
		expect(result.output).toContain(`${FILE}:2 <input> bg-bg-surface rounded-lg`);
		expect(result.status).toBe(1);
	});

	it('leaves chrome on an element without the recipe alone', () => {
		// A wrapper that draws the field around a bare control owns its chrome.
		const result = check(
			'<label class="flex rounded-lg bg-bg-surface focus-within:ring-2"><input class="input-bare" /></label>'
		);

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});
});

describe('class on a field component places its container', () => {
	it.each([
		['UiInput', '<UiInput v-model="x" class="rounded-xl" />'],
		['UiSelect', '<UiSelect v-model="x" :options="o" class="bg-bg-base" />'],
		['UiTextarea', '<UiTextarea v-model="x" :class="[\'shadow-none\']" />'],
		['the kebab-case spelling', '<ui-input v-model="x" class="border" />'],
	])('fails on chrome on %s', (_label, markup) => {
		const result = check(markup);

		expect(result.output).toContain(RESTYLED);
		expect(result.status).toBe(1);
	});

	it('passes layout and size classes on a field component', () => {
		const result = check('<UiInput v-model="x" class="mt-2 w-64 sm:flex-1 text-sm" />');

		expect(result.output).toBe('');
		expect(result.status).toBe(0);
	});
});
