import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { diffTemplateVersions } from '../templateDiff';
import { diffSequence } from '../templateDiffFields';
import { renderEmailHtml } from '../renderer';

type Node = { id: string; type: string; content: Record<string, unknown> };

const text = (id: string, html: string, extra: Record<string, unknown> = {}): Node => ({
	id,
	type: 'text',
	content: { html, textColor: '#111111', ...extra },
});
const button = (id: string, label: string, url: string): Node => ({
	id,
	type: 'button',
	content: { text: label, url, backgroundColor: '#000000', textColor: '#ffffff' },
});
const container = (id: string, items: Node[]): Node => ({
	id,
	type: 'container',
	content: { maxWidth: 100, items },
});
const columns = (id: string, cols: Node[][]): Node => ({
	id,
	type: 'columns',
	content: { columnCount: cols.length, ratio: 'equal', columns: cols },
});

const diff = (before: Node[], after: Node[], meta: { before?: object; after?: object } = {}) =>
	diffTemplateVersions({ blocks: before, ...meta.before }, { blocks: after, ...meta.after });

describe('diffTemplateVersions', () => {
	it('reports nothing for identical versions', () => {
		const blocks = [text('t1', '<p>Hello</p>'), button('b1', 'Go', 'https://example.com')];
		const result = diff(blocks, structuredClone(blocks), {
			before: { subject: 'Hi' },
			after: { subject: 'Hi' },
		});
		expect(result.identical).toBe(true);
		expect(result.blocks).toEqual([]);
		expect(result.copy).toEqual([]);
		expect(result.links).toEqual([]);
		expect(result.outlines).toEqual({ before: {}, after: {} });
	});

	it('reports a copy-only edit with the text before and after', () => {
		const result = diff([text('t1', '<p>Hello there</p>')], [text('t1', '<p>Hello world</p>')]);
		expect(result.blocks).toEqual([
			expect.objectContaining({
				id: 't1',
				kind: 'edited',
				moved: false,
				parts: { copy: true, links: false, other: false },
				excerpt: 'Hello world',
			}),
		]);
		expect(result.copy).toEqual([
			{
				kind: 'changed',
				before: 'Hello there',
				after: 'Hello world',
				blockId: 't1',
				blockType: 'text',
				field: 'html',
			},
		]);
		expect(result.links).toEqual([]);
		expect(result.outlines).toEqual({ before: { t1: 'edited' }, after: { t1: 'edited' } });
	});

	it('reports a link-only edit', () => {
		const result = diff(
			[button('b1', 'Shop', 'https://example.com/a')],
			[button('b1', 'Shop', 'https://example.com/b')]
		);
		expect(result.blocks[0]?.parts).toEqual({ copy: false, links: true, other: false });
		expect(result.copy).toEqual([]);
		expect(result.links).toEqual([
			expect.objectContaining({
				kind: 'changed',
				before: 'https://example.com/a',
				after: 'https://example.com/b',
				field: 'url',
			}),
		]);
	});

	it('reports a style-only edit without copy or link changes', () => {
		const result = diff(
			[text('t1', '<p>Same</p>')],
			[text('t1', '<p>Same</p>', { textColor: '#ff0000' })]
		);
		expect(result.blocks[0]).toMatchObject({
			kind: 'edited',
			parts: { copy: false, links: false, other: true },
		});
		expect(result.copy).toEqual([]);
		expect(result.links).toEqual([]);
	});

	it('counts a markup-only html edit as a change', () => {
		const result = diff([text('t1', '<p>Same</p>')], [text('t1', '<p><strong>Same</strong></p>')]);
		expect(result.blocks[0]?.parts).toEqual({ copy: false, links: false, other: true });
	});

	it('reports inserted and removed Blocks with their copy and links', () => {
		const result = diff(
			[text('t1', '<p>Stays</p>'), button('old', 'Old offer', 'https://example.com/old')],
			[
				text('t1', '<p>Stays</p>'),
				text('new', '<p>Fresh <a href="https://example.com/new">news</a></p>'),
			]
		);
		expect(result.blocks.map((b) => [b.id, b.kind])).toEqual([
			['new', 'added'],
			['old', 'removed'],
		]);
		expect(result.outlines).toEqual({ before: { old: 'removed' }, after: { new: 'added' } });
		expect(result.copy.map((c) => [c.kind, c.blockId])).toEqual([
			['added', 'new'],
			['removed', 'old'],
		]);
		expect(result.links).toEqual([
			expect.objectContaining({ kind: 'added', after: 'https://example.com/new', blockId: 'new' }),
			expect.objectContaining({
				kind: 'removed',
				before: 'https://example.com/old',
				blockId: 'old',
			}),
		]);
	});

	it('reports a reorder as a move of the Block that changed place', () => {
		const a = text('a', '<p>A</p>');
		const b = text('b', '<p>B</p>');
		const c = text('c', '<p>C</p>');
		const result = diff(
			[a, b, c],
			[a, c, b].map((n) => structuredClone(n))
		);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]).toMatchObject({ kind: 'moved', moved: true });
		const id = result.blocks[0]!.id;
		expect(result.outlines).toEqual({ before: { [id]: 'moved' }, after: { [id]: 'moved' } });
		expect(result.copy).toEqual([]);
	});

	it('flags an edited Block that also moved', () => {
		const result = diff(
			[text('a', '<p>A</p>'), text('b', '<p>B</p>')],
			[text('b', '<p>B2</p>'), text('a', '<p>A</p>')]
		);
		const edited = result.blocks.find((b) => b.kind === 'edited');
		expect(edited).toMatchObject({ id: 'b' });
		expect(result.blocks.filter((b) => b.moved).length).toBeGreaterThan(0);
	});

	it('reports a nested edit on the child only, and a move between columns', () => {
		const before = [
			container('box', [text('inner', '<p>Inside</p>')]),
			columns('grid', [[text('left', '<p>L</p>')], [text('right', '<p>R</p>')]]),
		];
		const after = [
			container('box', [text('inner', '<p>Inside, edited</p>')]),
			columns('grid', [[], [text('right', '<p>R</p>'), text('left', '<p>L</p>')]]),
		];
		const result = diff(before, after);
		expect(result.blocks.map((b) => [b.id, b.kind])).toEqual([
			['inner', 'edited'],
			['left', 'moved'],
		]);
		expect(result.outlines.after).toEqual({ inner: 'edited', left: 'moved' });
	});

	it('keeps occurrence identity for repeated identical URLs', () => {
		const twice =
			'<p><a href="https://example.com/x">One</a> and <a href="https://example.com/x">two</a></p>';
		const once = '<p><a href="https://example.com/x">One</a> and two</p>';
		const result = diff([text('t1', twice)], [text('t1', once)]);
		expect(result.links).toEqual([
			expect.objectContaining({ kind: 'removed', before: 'https://example.com/x' }),
		]);
	});

	it('keeps occurrence identity for repeated identical copy across list items', () => {
		const list = (items: string[]): Node => ({ id: 'l1', type: 'list', content: { items } });
		const result = diff([list(['Yes', 'Yes', 'No'])], [list(['Yes', 'No'])]);
		expect(result.copy).toEqual([expect.objectContaining({ kind: 'removed', before: 'Yes' })]);
	});

	it('reports an inserted table row as added, not every later row as changed', () => {
		const table = (rows: string[][]): Node => ({
			id: 'tb',
			type: 'table',
			content: { headers: ['Plan', 'Price'], rows },
		});
		const result = diff(
			[
				table([
					['Basic', '$5'],
					['Pro', '$9'],
				]),
			],
			[
				table([
					['Free', '$0'],
					['Basic', '$5'],
					['Pro', '$9'],
				]),
			]
		);
		expect(result.copy.map((c) => c.kind)).toEqual(['added', 'added']);
	});

	it('matches legacy repeated ids the way the editor renews them', () => {
		const legacy = [text('dup', '<p>First</p>'), text('dup', '<p>Second</p>')];
		const result = diff(legacy, structuredClone(legacy));
		expect(result.identical).toBe(true);
		const ids = result.trees.after.map((n) => n.id);
		expect(new Set(ids).size).toBe(2);

		const edited = structuredClone(legacy);
		edited[1]!.content['html'] = '<p>Second, edited</p>';
		const changed = diff(legacy, edited);
		expect(changed.blocks).toHaveLength(1);
		expect(changed.blocks[0]?.id).toBe(ids[1]);
		expect(changed.copy[0]).toMatchObject({ before: 'Second', after: 'Second, edited' });
	});

	it('treats a Block whose type changed under the same id as removed and added', () => {
		const result = diff([text('x', '<p>Go</p>')], [button('x', 'Go', 'https://example.com')]);
		expect(result.blocks.map((b) => b.kind)).toEqual(['added', 'removed']);
		expect(result.outlines).toEqual({ before: { x: 'removed' }, after: { x: 'added' } });
	});

	it('reports subject and preview text changes', () => {
		const blocks = [text('t1', '<p>Same</p>')];
		const result = diff(blocks, blocks, {
			before: { subject: 'Old', previewText: 'Peek' },
			after: { subject: 'New', previewText: 'Peek' },
		});
		expect(result.identical).toBe(false);
		expect(result.meta).toEqual([{ field: 'subject', before: 'Old', after: 'New' }]);
	});

	it('does not mutate its input', () => {
		const before = [text('dup', '<p>A</p>'), text('dup', '<p>B</p>')];
		const snapshot = structuredClone(before);
		diff(before, before);
		expect(before).toEqual(snapshot);
	});
});

describe('diffSequence', () => {
	it('pairs a removal and an insertion at the same spot as a change', () => {
		expect(diffSequence(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
			{ kind: 'changed', before: 'b', after: 'x' },
		]);
	});

	it('reports leftovers as plain insertions and removals', () => {
		expect(diffSequence(['a'], ['a', 'b', 'c'])).toEqual([
			{ kind: 'added', after: 'b' },
			{ kind: 'added', after: 'c' },
		]);
		expect(diffSequence(['a', 'b'], [])).toEqual([
			{ kind: 'removed', before: 'a' },
			{ kind: 'removed', before: 'b' },
		]);
	});
});

describe('renderEmailHtml diffOutlines', () => {
	const blocks = [
		{ id: 't1', type: 'text', content: { html: '<p>Root</p>' } },
		{
			id: 'box',
			type: 'container',
			content: {
				maxWidth: 100,
				items: [{ id: 'inner', type: 'text', content: { html: '<p>In</p>' } }],
			},
		},
	] as unknown as EditorBlock[];

	it('outlines marked Blocks at the root and nested', () => {
		const html = renderEmailHtml(blocks, { diffOutlines: { t1: 'edited', inner: 'added' } });
		expect(html).toContain('data-owlat-diff="edited"');
		expect(html).toContain('data-owlat-diff="added"');
		expect(html.match(/data-owlat-diff=/g)).toHaveLength(2);
	});

	it('leaves ordinary output untouched', () => {
		expect(renderEmailHtml(blocks)).not.toContain('data-owlat-diff');
		expect(renderEmailHtml(blocks, { diffOutlines: {} })).toBe(renderEmailHtml(blocks));
	});

	it('ignores ids that are only inherited object members', () => {
		const odd = [
			{ id: 'constructor', type: 'text', content: { html: '<p>Odd</p>' } },
		] as unknown as EditorBlock[];
		expect(renderEmailHtml(odd, { diffOutlines: {} })).not.toContain('data-owlat-diff');
	});
});
