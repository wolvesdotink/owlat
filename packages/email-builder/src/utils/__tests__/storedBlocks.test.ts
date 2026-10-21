import { describe, expect, it } from 'vitest';
import { parseStoredBlocks } from '../storedBlocks';

const text = (id: string, html: string) => ({ id, type: 'text', content: { html } });

describe('parseStoredBlocks', () => {
	it('reads a bare block array', () => {
		const blocks = [text('a', 'one'), text('b', 'two')];
		expect(parseStoredBlocks(JSON.stringify(blocks))).toEqual(blocks);
	});

	it('reads the { blocks } envelope the saved-block editor writes', () => {
		const blocks = [text('a', 'one'), text('b', 'two')];
		expect(parseStoredBlocks(JSON.stringify({ blocks }))).toEqual(blocks);
	});

	it('reads a legacy single { type, content } block and gives it an id', () => {
		const [block, ...rest] = parseStoredBlocks(
			JSON.stringify({ type: 'text', content: { html: 'legacy' } })
		);
		expect(rest).toEqual([]);
		expect(block).toMatchObject({ type: 'text', content: { html: 'legacy' } });
		expect(block?.id).toMatch(/^block-/);
	});

	it('returns [] for empty content and invalid JSON', () => {
		expect(parseStoredBlocks('')).toEqual([]);
		expect(parseStoredBlocks(undefined)).toEqual([]);
		expect(parseStoredBlocks(null)).toEqual([]);
		expect(parseStoredBlocks('[')).toEqual([]);
		expect(parseStoredBlocks('not json')).toEqual([]);
	});

	it('returns [] for valid JSON of any other shape', () => {
		expect(parseStoredBlocks('null')).toEqual([]);
		expect(parseStoredBlocks('42')).toEqual([]);
		expect(parseStoredBlocks('"text"')).toEqual([]);
		expect(parseStoredBlocks('{}')).toEqual([]);
		expect(parseStoredBlocks(JSON.stringify({ blocks: 'nope' }))).toEqual([]);
		// A lone type without a content object is not the legacy block shape.
		expect(parseStoredBlocks(JSON.stringify({ type: 'text' }))).toEqual([]);
	});

	it('drops malformed entries and keeps the rest', () => {
		const content = JSON.stringify([
			text('a', 'one'),
			null,
			42,
			'text',
			[text('nested', 'array')],
			{ id: 'no-type', content: {} },
			{ id: 'numeric-type', type: 7, content: {} },
			text('b', 'two'),
		]);
		expect(parseStoredBlocks(content).map((b) => b.id)).toEqual(['a', 'b']);
	});

	it('drops malformed entries inside the envelope too', () => {
		const content = JSON.stringify({ blocks: [null, text('a', 'one'), { id: 'x' }] });
		expect(parseStoredBlocks(content).map((b) => b.id)).toEqual(['a']);
	});

	it('fills a missing or non-string id and keeps existing ids', () => {
		const blocks = parseStoredBlocks(
			JSON.stringify([
				{ type: 'text', content: { html: 'no id' } },
				{ id: 12, type: 'text', content: { html: 'numeric id' } },
				text('kept', 'has id'),
			])
		);
		expect(blocks).toHaveLength(3);
		expect(blocks[0]?.id).toMatch(/^block-/);
		expect(blocks[1]?.id).toMatch(/^block-/);
		expect(blocks[0]?.id).not.toBe(blocks[1]?.id);
		expect(blocks[2]?.id).toBe('kept');
		expect(blocks[0]?.content).toEqual({ html: 'no id' });
	});

	it('fills the same ids on every read, so the editor and the server render agree', () => {
		const content = JSON.stringify([
			{ type: 'text', content: { html: 'no id' } },
			{
				id: 'box',
				type: 'container',
				content: { items: [{ type: 'text', content: { html: 'nested' } }] },
			},
		]);
		const first = parseStoredBlocks(content);
		expect(parseStoredBlocks(content)).toEqual(first);
		expect(first[0]?.id).toBe('block-1');
		const [nested] = (first[1]!.content as { items: Array<{ id?: unknown }> }).items;
		expect(nested?.id).toBe('block-2');
	});

	it('keeps repeated ids for the editor to renew when it loads them', () => {
		const content = JSON.stringify([text('b1', 'one'), text('b1', 'two')]);
		expect(parseStoredBlocks(content).map((b) => b.id)).toEqual(['b1', 'b1']);
	});
});
