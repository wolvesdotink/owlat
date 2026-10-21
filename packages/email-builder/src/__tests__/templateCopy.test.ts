import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { babelParse, parse } from 'vue/compiler-sfc';

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
 * "Copy" is anything with two letters in a row, lower-case words included
 * (`title="delete"` is shown as much as `title="Delete"`). Not copy: catalog
 * keys (`builder.…`, the UI layer's `ui.…`), units, the technical examples
 * below (a URL, a CSS snippet), and a bare lower-case identifier the code only
 * tests or passes (`blockType === 'accordion'`, `fn('mode')`), which an
 * expression never displays. Literals are read off the expression's syntax
 * tree, so `kind === 'accordion' ? … : 'delete'` still flags `'delete'`.
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

/** Comparisons: their operands are values the code tests, never shown. */
const COMPARISONS = new Set(['===', '!==', '==', '!=', 'in', 'instanceof']);

interface ExpressionNode {
	type: string;
	[field: string]: unknown;
}

function isNode(value: unknown): value is ExpressionNode {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as ExpressionNode).type === 'string'
	);
}

function childNodes(node: ExpressionNode, field: string): ExpressionNode[] {
	const value = node[field];
	if (Array.isArray(value)) return value.filter(isNode);
	return isNode(value) ? [value] : [];
}

/**
 * The string literals an expression spells out, each marked `shown` when the
 * expression's value can be that very string (`open ? 'Close' : 'Open'`,
 * `a || 'Untitled'`, a template literal) and not `shown` when the code only
 * tests or passes it (`kind === 'accordion'`, `fn('mode')`, the test of a
 * ternary, the left side of `&&`, an object key). `label(source)` displays
 * its argument, so that argument stays `shown`.
 */
function stringLiterals(expression: string): { value: string; shown: boolean }[] {
	const literals: { value: string; shown: boolean }[] = [];
	const program = babelParse(`(${expression})`, { plugins: ['typescript'] }).program;
	const statement = program.body[0] as unknown as ExpressionNode;

	const visit = (node: ExpressionNode, shown: boolean): void => {
		const each = (field: string, childShown: boolean) => {
			for (const child of childNodes(node, field)) visit(child, childShown);
		};
		switch (node.type) {
			case 'StringLiteral':
				literals.push({ value: node['value'] as string, shown });
				return;
			case 'TemplateLiteral': {
				// The text around `${ }` is one string (`builder.align.${opt}` → `builder.align.`).
				const quasis = node['quasis'] as { value: { cooked: string | null } }[];
				literals.push({ value: quasis.map((quasi) => quasi.value.cooked ?? '').join(''), shown });
				each('expressions', shown);
				return;
			}
			case 'ConditionalExpression':
				each('test', false);
				each('consequent', shown);
				each('alternate', shown);
				return;
			case 'LogicalExpression':
				each('left', node['operator'] === '&&' ? false : shown);
				each('right', shown);
				return;
			case 'BinaryExpression': {
				const operandsShown = COMPARISONS.has(node['operator'] as string) ? false : shown;
				each('left', operandsShown);
				each('right', operandsShown);
				return;
			}
			case 'CallExpression':
			case 'OptionalCallExpression':
			case 'NewExpression': {
				// `label(source)` shows its argument, translated; other calls only use theirs.
				const callee = node['callee'] as ExpressionNode;
				each('callee', false);
				each('arguments', shown && callee.type === 'Identifier' && callee['name'] === 'label');
				return;
			}
			case 'MemberExpression':
			case 'OptionalMemberExpression':
				each('object', false);
				each('property', false);
				return;
			case 'ObjectProperty':
				each('key', false);
				each('value', shown);
				return;
			default:
				for (const field of Object.keys(node)) {
					if (field === 'loc' || field.endsWith('Comments')) continue;
					each(field, shown);
				}
		}
	};
	visit(statement, true);
	return literals;
}

/**
 * Whether `value` is English copy. A `shown` value (a text node, a static
 * attribute, a literal the expression can evaluate to) is copy whatever its
 * case; a value the code only tests or passes may be a bare lower-case
 * identifier (`'mode'`, `kind === 'accordion'`).
 */
function isCopy(file: string, value: string, shown = true): boolean {
	const trimmed = value.trim();
	if (!COPY.test(trimmed)) return false;
	// A catalog key or key prefix (`builder.align.` once `${opt}` is stripped).
	if (/^(builder|ui)\.[\w.]*$/.test(trimmed)) return false;
	if (!shown && /^[a-z][a-zA-Z0-9]*$/.test(trimmed)) return false;
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
			for (const { value, shown } of stringLiterals(expression)) {
				if (isCopy(file, value, shown)) report(node.loc.start.line, value);
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
					for (const { value, shown } of stringLiterals(prop.exp?.content ?? '')) {
						if (isCopy(file, value, shown)) {
							report(prop.loc.start.line, `:${prop.arg?.content} '${value}'`);
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

	it('catches lower-case copy wherever it is shown', () => {
		const source = `<template>
	<button title="delete" aria-label="search" />
	<p>loading</p>
	<i :title="mode === 'edit' ? 'close' : t('builder.x')" />
	<b :aria-label="name || 'untitled'">{{ busy && 'saving' }}</b>
	<s :title="\`remove \${name}\`" />
</template>`;
		expect(findCopy('fixture.vue', source)).toEqual([
			'fixture.vue:2 title="delete"',
			'fixture.vue:2 aria-label="search"',
			'fixture.vue:3 loading',
			"fixture.vue:4 :title 'close'",
			"fixture.vue:5 :aria-label 'untitled'",
			'fixture.vue:5 saving',
			"fixture.vue:6 :title 'remove '",
		]);
	});

	it('lets a lower-case identifier through only where the code tests or passes it', () => {
		const source = `<template>
	<i :title="kind === 'accordion' ? t('builder.a') : t('builder.b')" />
	<b :aria-label="label(getBlock('mode')?.label ?? 'text')">{{ items['count'] }}</b>
	<u :title="state !== 'idle' && t('builder.c')" />
</template>`;
		expect(findCopy('fixture.vue', source)).toEqual(["fixture.vue:3 :aria-label 'text'"]);
	});
});
