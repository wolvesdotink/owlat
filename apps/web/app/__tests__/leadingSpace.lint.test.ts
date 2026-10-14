/**
 * A LEADING SPACE INSIDE AN INLINE ELEMENT NEVER REACHES THE PAGE (#1340).
 *
 * Vue compiles templates with `whitespace: 'condense'`, which drops a
 * whitespace-only text node when it is an element's first child. So in
 *
 *     {{ host }}<span v-if="priority"> {{ priorityLabel }}</span>
 *
 * the space before `{{ priorityLabel }}` is gone and the page reads
 * "bounce.example.compriority 10". The separator has to be explicit: start the
 * element with `{{ ' ' }}`.
 *
 * The rule flags an inline element (or `<template>`) that is glued to the text
 * or interpolation before it and opens with whitespace before an interpolation
 * or element. It deliberately does not flag an element that follows another
 * element: there the gap usually comes from a flex `gap-*`, and the template
 * alone cannot tell the two apart.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'vue/compiler-sfc';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// HTML phrasing elements that hold text, plus `<template>`, which renders none.
const INLINE = new Set([
	'a',
	'abbr',
	'b',
	'bdi',
	'bdo',
	'cite',
	'code',
	'data',
	'del',
	'dfn',
	'em',
	'i',
	'ins',
	'kbd',
	'label',
	'mark',
	'q',
	's',
	'samp',
	'small',
	'span',
	'strong',
	'sub',
	'sup',
	'template',
	'time',
	'u',
	'var',
]);

// compiler-core NodeTypes, structurally: ELEMENT, TEXT, COMMENT, INTERPOLATION.
const ELEMENT = 1;
const TEXT = 2;
const COMMENT = 3;
const INTERPOLATION = 5;

interface TemplateNode {
	type: number;
	tag?: string;
	content?: unknown;
	props?: { loc: { end: { offset: number } } }[];
	children?: TemplateNode[];
	loc: { source: string; start: { offset: number; line: number } };
}

/**
 * Children as they render: comments are dropped from the page, and the
 * whitespace beside one is dropped with it, so neither can separate text.
 */
function rendered(children: TemplateNode[] | undefined): TemplateNode[] {
	return (children ?? []).filter((child) => child.type !== COMMENT);
}

/** The raw source, comments removed, between an element's start tag and its first rendered child. */
function leadingGap(element: TemplateNode): string {
	const first = rendered(element.children)[0];
	if (!first) return '';
	const base = element.loc.start.offset;
	const props = element.props ?? [];
	const afterProps = props.length
		? props[props.length - 1]!.loc.end.offset - base
		: 1 + (element.tag?.length ?? 0);
	const tagEnd = element.loc.source.indexOf('>', afterProps);
	return element.loc.source
		.slice(tagEnd + 1, first.loc.start.offset - base)
		.replace(/<!--[\s\S]*?-->/g, '');
}

function gluedToText(previous: TemplateNode | undefined): boolean {
	if (!previous) return false;
	if (previous.type === INTERPOLATION) return true;
	return previous.type === TEXT && /\S$/.test(String(previous.content));
}

/** `line <tag>` for each inline element whose leading space Vue drops. */
function droppedSpaces(source: string): string[] {
	const ast = parse(source).descriptor.template?.ast as TemplateNode | undefined;
	const found: string[] = [];
	const visit = (node: TemplateNode) => {
		const siblings = rendered(node.children);
		for (const [index, child] of siblings.entries()) {
			const first = rendered(child.children)[0];
			if (
				child.type === ELEMENT &&
				INLINE.has(child.tag ?? '') &&
				first &&
				(first.type === INTERPOLATION || first.type === ELEMENT) &&
				/^\s+$/.test(leadingGap(child)) &&
				gluedToText(siblings[index - 1])
			) {
				found.push(`${child.loc.start.line} <${child.tag}>`);
			}
			visit(child);
		}
	};
	if (ast) visit(ast);
	return found;
}

function vueFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === '__tests__' || entry === 'node_modules') continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) vueFiles(path, out);
		else if (entry.endsWith('.vue')) out.push(path);
	}
	return out;
}

describe('the leading-space check itself', () => {
	const check = (markup: string) => droppedSpaces(`<template><p>${markup}</p></template>`);

	it('flags a span or template glued to an interpolation and opening with a space', () => {
		expect(check('{{ host }}<span v-if="p"> {{ label }}</span>')).toEqual(['1 <span>']);
		expect(check('{{ count }}<template v-if="more">\n\t{{ rest }}</template>')).toEqual([
			'1 <template>',
		]);
	});

	it('flags one glued to plain text', () => {
		expect(check('Total<span> {{ n }}</span>')).toEqual(['1 <span>']);
	});

	it('covers every phrasing element, not just span', () => {
		expect(check('{{ host }}<del> {{ label }}</del>')).toEqual(['1 <del>']);
		expect(check('x{{ n }}<sup> {{ footnote }}</sup>')).toEqual(['1 <sup>']);
		expect(check('{{ said }}<q> {{ quote }}</q>')).toEqual(['1 <q>']);
	});

	it('sees through comments, which render nothing and take their whitespace along', () => {
		expect(check('{{ host }}<!-- note --><span> {{ label }}</span>')).toEqual(['1 <span>']);
		expect(check('{{ host }}<span> <!-- note -->{{ label }}</span>')).toEqual(['1 <span>']);
		expect(check('{{ host }}<span><!-- note -->{{ label }}</span>')).toEqual([]);
		expect(check('{{ host }} <!-- note --><span>{{ label }}</span>')).toEqual([]);
	});

	it('accepts an explicit {{ " " }} and a space outside the element', () => {
		expect(check(`{{ host }}<span v-if="p">{{ ' ' }}{{ label }}</span>`)).toEqual([]);
		expect(check('{{ host }} <span v-if="p">{{ label }}</span>')).toEqual([]);
		expect(check('{{ host }}\n<template v-if="p"> {{ label }}</template>')).toEqual([]);
	});

	it('leaves element-after-element alone, where a flex gap may space it', () => {
		expect(check('<code>{{ name }}</code>\n<span> {{ label }}</span>')).toEqual([]);
	});

	it('leaves block elements and text that keeps its own space alone', () => {
		expect(check('{{ a }}<div> {{ b }}</div>')).toEqual([]);
		expect(check('{{ a }}<span> · {{ b }}</span>')).toEqual([]);
	});
});

describe('no inline element relies on a leading space Vue drops (#1340)', () => {
	it('every glued inline element spells its separator out', () => {
		const offenders = vueFiles(appRoot).flatMap((file) =>
			droppedSpaces(readFileSync(file, 'utf8')).map((hit) => `${relative(appRoot, file)}:${hit}`)
		);
		expect(offenders).toEqual([]);
	});
});
