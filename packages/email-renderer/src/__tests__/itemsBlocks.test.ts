/**
 * Container and hero both hold an `items` list and share one plaintext walker
 * and one padded AMP wrapper (blocks/_items.ts). Container's AMP used to read
 * the raw padding fields, so a container without them rendered
 * `padding:undefinedpx`, and it kept empty children that hero dropped.
 */
import { describe, it, expect } from 'vitest';
import type { ContainerItem, EditorBlock } from '@owlat/shared';
import { renderAmpEmail } from '../amp';
import { renderPlainText } from '../plaintext';

const text = (id: string, body: string): ContainerItem =>
	({
		id,
		type: 'text',
		content: { html: `<p>${body}</p>`, blockType: 'paragraph', fontSize: 16, textColor: '#333' },
	}) as unknown as ContainerItem;

// A list without items renders nothing in AMP and in plaintext.
const emptyList: ContainerItem = {
	id: 'empty',
	type: 'list',
	content: { items: [], listType: 'bullet', fontSize: 16, textColor: '#333' },
} as unknown as ContainerItem;

const container = (content: Record<string, unknown>): EditorBlock =>
	({
		id: 'c',
		type: 'container',
		content: { items: [], maxWidth: 100, ...content },
	}) as unknown as EditorBlock;

const hero = (content: Record<string, unknown>): EditorBlock =>
	({
		id: 'h',
		type: 'hero',
		content: {
			backgroundImage: '',
			backgroundPosition: 'center',
			backgroundSize: 'cover',
			height: 400,
			mode: 'fixed-height',
			verticalAlign: 'middle',
			items: [],
			...content,
		},
	}) as unknown as EditorBlock;

/** The wrapper `<div>` an items block emits in the AMP body. */
const wrapperOf = (html: string, marker: string): string => {
	const at = html.indexOf(marker);
	const start = html.lastIndexOf('<div style="', at);
	return html.slice(start, html.indexOf('</div>', at) + '</div>'.length);
};

describe('container AMP', () => {
	it('falls back to the HTML-path padding when no padding fields are set', () => {
		const html = renderAmpEmail([container({ items: [text('a', 'Alpha')] })]);
		expect(html).toContain('padding:16px 24px 16px 24px');
		expect(html).not.toContain('undefined');
	});

	it('uses the stored padding and escapes the background colour', () => {
		const html = renderAmpEmail([
			container({
				items: [text('a', 'Alpha')],
				backgroundColor: '#fff"><x',
				paddingTop: 1,
				paddingRight: 2,
				paddingBottom: 3,
				paddingLeft: 4,
			}),
		]);
		const wrapper = wrapperOf(html, 'Alpha');
		expect(wrapper).toContain('padding:1px 2px 3px 4px');
		expect(wrapper).toContain('background-color:#fff&quot;&gt;&lt;x;');
		expect(wrapper).not.toContain('"><x');
	});

	it('skips children that render nothing', () => {
		const html = renderAmpEmail([
			container({ items: [text('a', 'Alpha'), emptyList, text('b', 'Beta')] }),
		]);
		const wrapper = wrapperOf(html, 'Alpha');
		const inner = wrapper.slice(wrapper.indexOf('>') + 1, -'</div>'.length);
		expect(inner.split('\n')).toHaveLength(2);
		expect(inner).not.toMatch(/\n\n/);
	});
});

describe('hero AMP', () => {
	it('keeps its 40/24/40/24 padding defaults and the overlay-first background', () => {
		const html = renderAmpEmail([
			hero({ items: [text('a', 'Welcome')], overlayColor: '#101010', backgroundColor: '#ffffff' }),
		]);
		const wrapper = wrapperOf(html, 'Welcome');
		expect(wrapper).toContain('background-color:#101010;padding:40px 24px 40px 24px');
	});

	it('skips children that render nothing', () => {
		const html = renderAmpEmail([hero({ items: [emptyList, text('a', 'Welcome'), emptyList] })]);
		const wrapper = wrapperOf(html, 'Welcome');
		const inner = wrapper.slice(wrapper.indexOf('>') + 1, -'</div>'.length);
		expect(inner.split('\n')).toHaveLength(1);
	});
});

describe('items-block plaintext', () => {
	it('puts each non-empty container child on its own line', () => {
		expect(
			renderPlainText([container({ items: [text('a', 'Alpha'), emptyList, text('b', 'Beta')] })])
		).toBe('Alpha\nBeta');
	});

	it('walks hero children the same way', () => {
		expect(
			renderPlainText([hero({ items: [text('a', 'Welcome'), emptyList, text('b', 'Friend')] })])
		).toBe('Welcome\nFriend');
	});
});
