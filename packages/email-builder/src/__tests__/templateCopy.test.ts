import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'vue/compiler-sfc';

/**
 * No builder template may carry English copy of its own.
 *
 * Every word the designer and the previewer show comes from the `builder.*`
 * catalogs (src/i18n), so a German user never meets an English button, empty
 * state or screen-reader name. The way that regresses is a new literal in a
 * template — `title="Delete"`, `:aria-label="open ? 'Close' : 'Open'"`, a bare
 * text node — which reads fine in English and slips past every other test.
 * This walks every `.vue` file under `src/` with Vue's own template parser and
 * fails on:
 *
 *  - static copy attributes (`title`, `aria-label`, `placeholder`, `alt`, ...);
 *  - string literals inside bound copy attributes and `{{ }}` interpolations;
 *  - text nodes.
 *
 * "Copy" is anything with two letters in a row. Not copy: catalog keys
 * (`builder.…`, the UI layer's `ui.…`), a bare lower-case identifier (`'mode'`,
 * `blockType === 'accordion'` — an argument or a value, never a sentence), units,
 * and the technical examples below (a URL, a CSS snippet).
 */

const SRC = join(__dirname, '..');

/** Attributes whose value a user reads or a screen reader announces. */
const COPY_ATTRIBUTES = new Set([
	'title',
	'aria-label',
	'aria-roledescription',
	'aria-valuetext',
	'placeholder',
	'alt',
	'label',
	'description',
	'confirm-text',
	'cancel-text',
]);

/**
 * Literal values that are not language: technical examples a user types over,
 * key names on keyboard chips, CSS units. Keyed `file → values` so an allowance
 * never leaks to another component.
 */
const NOT_COPY: Record<string, readonly string[]> = {
	'components/FocusModeOverlay.vue': ['Esc'],
	'components/canvas/SubjectFields.vue': ['{{'],
	'components/dialogs/LinkDialog.vue': ['https://example.com'],
	'components/dialogs/VariableCreateDialog.vue': ['order_id', 'variable'],
	'components/panel/PropertyField.vue': ['https://'],
	'components/panel/fields/ColorField.vue': ['#000000'],
	'preview/components/EmailPreviewer.vue': [
		'HTML',
		'AMP',
		'.html',
		'.txt',
		'.amp.html',
		'email.html',
		'email.txt',
		'email.amp.html',
	],
	'preview/components/RenderOptionsPanel.vue': [
		'en',
		'LTR',
		'RTL',
		'.custom-class { color: red; }',
		'https://fonts.googleapis.com/css2?family=...',
	],
};

/** Units, the same in every language. */
const UNITS = new Set(['px', 'KB', '/ 102 KB']);

const COPY = /[A-Za-z]{2}/;

function vueFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === '__tests__' ? [] : vueFiles(path);
		return entry.name.endsWith('.vue') ? [path] : [];
	});
}

/** Remove `${ … }` from a template literal body, nested braces included. */
function stripSubstitutions(body: string): string {
	let out = '';
	let depth = 0;
	for (let i = 0; i < body.length; i++) {
		if (depth === 0 && body[i] === '$' && body[i + 1] === '{') {
			depth = 1;
			i++;
			continue;
		}
		if (depth > 0) {
			if (body[i] === '{') depth++;
			else if (body[i] === '}') depth--;
			continue;
		}
		out += body[i];
	}
	return out;
}

/** The string literals an expression spells out (quotes and template literals). */
function stringLiterals(expression: string): string[] {
	const literals: string[] = [];
	const pattern =
		/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.|\$\{(?:[^{}]|\{[^{}]*\})*\})*)`/g;
	for (const match of expression.matchAll(pattern)) {
		const [, single, double, template] = match;
		if (template !== undefined) literals.push(stripSubstitutions(template));
		else literals.push(single ?? double ?? '');
	}
	return literals;
}

function isCopy(file: string, value: string): boolean {
	const trimmed = value.trim();
	if (!COPY.test(trimmed)) return false;
	// A catalog key or key prefix (`builder.align.` once `${opt}` is stripped).
	if (/^(builder|ui)\.[\w.]*$/.test(trimmed)) return false;
	if (/^[a-z][a-zA-Z0-9]*$/.test(trimmed)) return false;
	if (UNITS.has(trimmed)) return false;
	return !(NOT_COPY[file] ?? []).includes(trimmed);
}

interface TemplateNode {
	type: number;
	content?: unknown;
	props?: TemplateProp[];
	children?: TemplateNode[];
	loc: { start: { line: number } };
}

interface TemplateProp {
	type: number;
	name: string;
	value?: { content: string };
	arg?: { content?: string };
	exp?: { content?: string };
	loc: { start: { line: number } };
}

// @vue/compiler-core NodeTypes.
const ELEMENT = 1;
const TEXT = 2;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

function findCopy(file: string, source: string): string[] {
	const { descriptor } = parse(source, { filename: file });
	const ast = descriptor.template?.ast as TemplateNode | undefined;
	if (!ast) return [];
	const found: string[] = [];
	const report = (line: number, value: string) => found.push(`${file}:${line} ${value.trim()}`);

	const visit = (node: TemplateNode) => {
		if (node.type === TEXT && typeof node.content === 'string' && isCopy(file, node.content)) {
			report(node.loc.start.line, node.content);
		}
		if (node.type === INTERPOLATION) {
			const expression = (node.content as { content?: string } | undefined)?.content ?? '';
			for (const literal of stringLiterals(expression)) {
				if (isCopy(file, literal)) report(node.loc.start.line, literal);
			}
		}
		if (node.type === ELEMENT) {
			for (const prop of node.props ?? []) {
				if (prop.type === ATTRIBUTE && COPY_ATTRIBUTES.has(prop.name)) {
					const value = prop.value?.content ?? '';
					if (isCopy(file, value)) report(prop.loc.start.line, `${prop.name}="${value}"`);
				}
				if (
					prop.type === DIRECTIVE &&
					prop.name === 'bind' &&
					COPY_ATTRIBUTES.has(prop.arg?.content ?? '')
				) {
					for (const literal of stringLiterals(prop.exp?.content ?? '')) {
						if (isCopy(file, literal)) {
							report(prop.loc.start.line, `:${prop.arg?.content} '${literal}'`);
						}
					}
				}
			}
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(ast);
	return found;
}

describe('builder templates', () => {
	const files = vueFiles(SRC);

	it('finds the components it audits', () => {
		expect(files.length).toBeGreaterThan(60);
	});

	it('carry no English copy of their own', () => {
		const offenders = files.flatMap((path) =>
			findCopy(relative(SRC, path), readFileSync(path, 'utf8'))
		);
		expect(offenders).toEqual([]);
	});

	it('catches each shape of literal copy', () => {
		const source = `<template>
	<button title="Delete" :aria-label="open ? 'Close menu' : t('builder.x')" />
	<input :placeholder="\`Search \${count} items\`" />
	<p>No items yet</p>
	<span>{{ saving ? 'Saving...' : t('builder.y') }}</span>
	<b :title="t(\`builder.align.\${opt}\`)">{{ count }} px</b>
	<i :title="kind === 'accordion' ? t('builder.z') : 'Add Block'">Empty</i>
</template>`;
		expect(findCopy('fixture.vue', source)).toEqual([
			'fixture.vue:2 title="Delete"',
			"fixture.vue:2 :aria-label 'Close menu'",
			"fixture.vue:3 :placeholder 'Search  items'",
			'fixture.vue:4 No items yet',
			'fixture.vue:5 Saving...',
			"fixture.vue:7 :title 'Add Block'",
			'fixture.vue:7 Empty',
		]);
	});
});
