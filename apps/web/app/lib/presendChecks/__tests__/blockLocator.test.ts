/**
 * "Show me" pins a finding to the Block it came from by content. A short or
 * prefix-shaped URL must not land on a Block that merely contains its
 * characters: no "Show me" is fine, a wrong one is not.
 */
import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { findBlockIdContaining } from '../blockLocator';

function block(id: string, type: string, content: Record<string, unknown>): EditorBlock {
	return { id, type, content } as unknown as EditorBlock;
}

const text = (id: string, html: string) =>
	block(id, 'text', { html, blockType: 'paragraph', textColor: '#374151' });

const menu = (id: string, url: string) =>
	block(id, 'menu', { items: [{ label: 'Home', url }], textColor: '#374151' });

describe('findBlockIdContaining', () => {
	it('pins "#" to the Block linking to it, not one with a hex colour', () => {
		const blocks = [text('t1', '<p>Hello</p>'), menu('m1', '#')];
		expect(findBlockIdContaining(blocks, '#')).toBe('m1');
		expect(findBlockIdContaining([text('t1', '<p>Hello</p>')], '#')).toBeUndefined();
	});

	it('finds a link in a text Block by its quoted href, escaped or not', () => {
		const blocks = [
			text('t1', '<p><a href="https://example.com/page">Read</a></p>'),
			text('t2', '<p><a href="https://example.com/?a=1&amp;b=2">More</a></p>'),
			text('t3', "<p><a href='https://example.com/single'>Single</a></p>"),
		];
		expect(findBlockIdContaining(blocks, 'https://example.com/page')).toBe('t1');
		expect(findBlockIdContaining(blocks, 'https://example.com/?a=1&b=2')).toBe('t2');
		expect(findBlockIdContaining(blocks, 'https://example.com/single')).toBe('t3');
	});

	it('does not take a longer URL for its prefix', () => {
		const blocks = [
			text('t1', '<p><a href="https://example.com/page">Read</a></p>'),
			block('b1', 'button', { text: 'Go', url: 'https://example.com' }),
		];
		expect(findBlockIdContaining(blocks, 'https://example.com')).toBe('b1');
		expect(findBlockIdContaining([blocks[0]!], 'https://example.com')).toBeUndefined();
	});

	it('prefers the deepest Block holding the URL', () => {
		const inner = block('img1', 'image', { src: 'https://cdn.example.com/a.png', alt: '' });
		const container = block('c1', 'container', {
			items: [inner],
			backgroundImage: 'https://cdn.example.com/a.png',
		});
		expect(findBlockIdContaining([container], 'https://cdn.example.com/a.png')).toBe('img1');
	});
});
