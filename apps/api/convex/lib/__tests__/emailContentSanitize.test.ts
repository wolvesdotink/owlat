import { describe, it, expect } from 'vitest';
import {
	sanitizeOverlayBlocksJson,
	sanitizeStoredBlocksJson,
	sanitizeTranslationsJson,
} from '../emailContentSanitize';

const UNSAFE = '<p>Hi</p><img src="x" onerror="window.__x=1"><a href="javascript:alert(1)">x</a>';

const LEGITIMATE =
	'<p><strong>Bold</strong> <em>italic</em> <u>u</u> <s>s</s> ' +
	'<a href="https://example.com" target="_blank" rel="noopener">link</a> ' +
	'<span style="color:#ff0000">red</span> ' +
	'<span class="variable-tag" contenteditable="false" data-variable="firstName">{{firstName}}</span></p>' +
	'<ul><li>one</li><li>two</li></ul>';

const text = (id: string, html: string) => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph', fontSize: 16 },
});

function expectClean(html: unknown) {
	expect(typeof html).toBe('string');
	expect(html).not.toContain('onerror');
	expect(html).not.toContain('javascript:');
	expect(html).toContain('Hi');
}

describe('sanitizeStoredBlocksJson', () => {
	it('cleans top-level text blocks', () => {
		const out = JSON.parse(sanitizeStoredBlocksJson(JSON.stringify([text('b1', UNSAFE)])));
		expectClean(out[0].content.html);
	});

	it('cleans text nested in columns and containers', () => {
		const content = [
			{
				id: 'c1',
				type: 'columns',
				content: { columns: [[text('t1', UNSAFE)], [text('t2', 'ok')]] },
			},
			{
				id: 'k1',
				type: 'container',
				content: {
					items: [{ id: 'k2', type: 'container', content: { items: [text('t3', UNSAFE)] } }],
				},
			},
		];
		const out = JSON.parse(sanitizeStoredBlocksJson(JSON.stringify(content)));
		expectClean(out[0].content.columns[0][0].content.html);
		expectClean(out[1].content.items[0].content.items[0].content.html);
	});

	it('cleans the saved-block envelope and the legacy single block', () => {
		const envelope = JSON.parse(
			sanitizeStoredBlocksJson(JSON.stringify({ blocks: [text('b1', UNSAFE)] }))
		);
		expectClean(envelope.blocks[0].content.html);
		const single = JSON.parse(sanitizeStoredBlocksJson(JSON.stringify(text('b1', UNSAFE))));
		expectClean(single.content.html);
	});

	it('returns legitimate content byte-for-byte', () => {
		const json = JSON.stringify([
			text('b1', LEGITIMATE),
			{ id: 'b2', type: 'button', content: { text: 'Go', url: 'https://x.test' } },
		]);
		expect(sanitizeStoredBlocksJson(json)).toBe(json);
	});

	it('leaves non-text blocks and invalid JSON alone', () => {
		const raw = JSON.stringify([{ id: 'r', type: 'rawHtml', content: { html: '<b>x</b>' } }]);
		expect(sanitizeStoredBlocksJson(raw)).toBe(raw);
		expect(sanitizeStoredBlocksJson('not json')).toBe('not json');
		expect(sanitizeStoredBlocksJson(undefined)).toBeUndefined();
	});
});

describe('sanitizeStoredBlocksJson numeric style fields', () => {
	const BAD = '0" data-probe="1';

	it('drops non-numeric values and keeps numbers', () => {
		const json = JSON.stringify([
			{
				id: 'b1',
				type: 'text',
				content: { html: 'x', fontSize: 16, paddingTop: BAD, marginLeft: ['1'], borderWidth: 2 },
			},
		]);
		const out = JSON.parse(sanitizeStoredBlocksJson(json));
		expect(out[0].content).toEqual({ html: 'x', fontSize: 16, borderWidth: 2 });
	});

	it('converts numeric strings to numbers', () => {
		const json = JSON.stringify([
			{ id: 's', type: 'spacer', content: { height: '24', paddingLeft: ' 8 ' } },
		]);
		const out = JSON.parse(sanitizeStoredBlocksJson(json));
		expect(out[0].content).toEqual({ height: 24, paddingLeft: 8 });
	});

	it('reaches nested column styles, container items and table cells', () => {
		const json = JSON.stringify([
			{
				id: 'c',
				type: 'columns',
				content: {
					columns: [[{ id: 'i', type: 'spacer', content: { height: BAD } }]],
					columnStyles: [{ paddingTop: BAD, borderRadius: 4 }],
				},
			},
			{
				id: 'k',
				type: 'container',
				content: { items: [{ id: 'n', type: 'divider', content: { thickness: BAD } }] },
			},
			{
				id: 't',
				type: 'table',
				content: { cells: [[{ content: 'a', colSpan: BAD, rowSpan: 2 }]] },
			},
		]);
		const out = JSON.parse(sanitizeStoredBlocksJson(json));
		expect(out[0].content.columns[0][0].content).toEqual({});
		expect(out[0].content.columnStyles[0]).toEqual({ borderRadius: 4 });
		expect(out[1].content.items[0].content).toEqual({});
		expect(out[2].content.cells[0][0]).toEqual({ content: 'a', rowSpan: 2 });
		expect(JSON.stringify(out)).not.toContain('data-probe');
	});

	it('normalizes width and value on the block types that store them as numbers', () => {
		const json = JSON.stringify([
			{ id: 'i', type: 'image', content: { src: 'x', width: BAD } },
			{ id: 'v', type: 'video', content: { videoUrl: 'x', width: '80' } },
			{
				id: 'k',
				type: 'container',
				content: { items: [{ id: 'd', type: 'divider', content: { width: BAD, thickness: 1 } }] },
			},
			{
				id: 'p',
				type: 'progressBar',
				content: {
					value: BAD,
					maxValue: 100,
					condition: { variable: 'plan', operator: 'equals', value: 'pro' },
				},
			},
		]);
		const out = JSON.parse(sanitizeStoredBlocksJson(json));
		expect(out[0].content).toEqual({ src: 'x' });
		expect(out[1].content).toEqual({ videoUrl: 'x', width: 80 });
		expect(out[2].content.items[0].content).toEqual({ thickness: 1 });
		expect(out[3].content).toEqual({
			maxValue: 100,
			condition: { variable: 'plan', operator: 'equals', value: 'pro' },
		});
	});

	it('leaves string-typed width and condition values alone', () => {
		const json = JSON.stringify([
			{
				id: 't',
				type: 'table',
				content: {
					columns: [{ width: '25%' }],
					condition: { variable: 'plan', operator: 'equals', value: 'pro' },
				},
			},
		]);
		expect(sanitizeStoredBlocksJson(json)).toBe(json);
	});
});

describe('translation overlays', () => {
	it('cleans overlay html in a translations blob and keeps the rest', () => {
		const blob = JSON.stringify({
			de: {
				subject: 'Hallo',
				blocks: { b1: { html: UNSAFE }, b2: { buttonText: 'Los' } },
			},
		});
		const out = JSON.parse(sanitizeTranslationsJson(blob));
		expectClean(out.de.blocks.b1.html);
		expect(out.de.blocks.b2).toEqual({ buttonText: 'Los' });
		expect(out.de.subject).toBe('Hallo');
	});

	it('cleans an overlay block map', () => {
		const out = JSON.parse(sanitizeOverlayBlocksJson(JSON.stringify({ b1: { html: UNSAFE } })));
		expectClean(out.b1.html);
	});

	it('returns legitimate overlays byte-for-byte', () => {
		const blob = JSON.stringify({ de: { subject: 's', blocks: { b1: { html: LEGITIMATE } } } });
		expect(sanitizeTranslationsJson(blob)).toBe(blob);
	});
});
