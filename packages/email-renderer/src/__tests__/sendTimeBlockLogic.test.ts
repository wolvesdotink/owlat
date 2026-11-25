import { describe, it, expect } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { renderEmailHtml } from '../renderer';
import { renderPlainText } from '../plaintext';

const text = (id: string, html: string, logic: Record<string, unknown> = {}): EditorBlock =>
	({
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#333', ...logic },
	}) as unknown as EditorBlock;

const withCode = text('a', '<p>Code {{bookingCode}}</p>', {
	condition: { variable: 'bookingCode', operator: 'exists' },
});
const withoutCode = text('b', '<p>No code yet</p>', {
	condition: { variable: 'bookingCode', operator: 'notExists' },
});
const line = text('c', '<p>{{line.name}} x {{line.qty}}</p>', {
	repeat: { variable: 'lines', itemAlias: 'line' },
});
const plain = text('d', '<p>Thanks</p>');

describe('sendTimeBlockLogic', () => {
	it('renders a body without conditions or repeats byte for byte as without the option', () => {
		const blocks = [plain, text('e', '<p>Hello {{firstName}}</p>')];
		const options = { variableType: 'data' as const };
		expect(renderEmailHtml(blocks, { ...options, sendTimeBlockLogic: true })).toBe(
			renderEmailHtml(blocks, options)
		);
		expect(renderPlainText(blocks, { sendTimeBlockLogic: true })).toBe(renderPlainText(blocks));
	});

	it('keeps both branches of a condition, each between its markers', () => {
		const html = renderEmailHtml([withCode, withoutCode, plain], { sendTimeBlockLogic: true });
		expect(html).toContain('Code {{bookingCode}}');
		expect(html).toContain('No code yet');
		expect(html.match(/<!--owlat:if /g)).toHaveLength(2);
		expect(html.match(/<!--owlat:endif-->/g)).toHaveLength(2);
	});

	it('renders a repeated Block once, with its item tokens, between repeat markers', () => {
		const html = renderEmailHtml([line], {
			sendTimeBlockLogic: true,
			variableValues: { lines: JSON.stringify([{ name: 'A' }, { name: 'B' }]) },
		});
		expect(html.match(/\{\{line\.name\}\}/g)).toHaveLength(1);
		expect(html).toContain('<!--owlat:each ');
		expect(html).toContain('<!--owlat:endeach-->');
		expect(html).not.toContain('>A x');
	});

	it('puts the condition outside the repeat of a Block that has both', () => {
		const both = text('f', '<p>{{line.name}}</p>', {
			condition: { variable: 'showLines', operator: 'exists' },
			repeat: { variable: 'lines', itemAlias: 'line' },
		});
		const html = renderEmailHtml([both], { sendTimeBlockLogic: true });
		expect(html.indexOf('<!--owlat:if ')).toBeLessThan(html.indexOf('<!--owlat:each '));
		expect(html.indexOf('<!--owlat:endeach-->')).toBeLessThan(html.indexOf('<!--owlat:endif-->'));
	});

	it('drops a marker an author wrote into a Block', () => {
		const forged = {
			id: 'g',
			type: 'rawHtml',
			content: { html: '<div>x<!--owlat:endif-->y</div>' },
		} as unknown as EditorBlock;
		const html = renderEmailHtml([withCode, forged], { sendTimeBlockLogic: true });
		expect(html.match(/<!--owlat:endif-->/g)).toHaveLength(1);
	});

	it('keeps the markers through minification', () => {
		const html = renderEmailHtml([withCode], { sendTimeBlockLogic: true, minify: true });
		expect(html).toContain('<!--owlat:if ');
		expect(html).toContain('<!--owlat:endif-->');
	});

	it('marks the same regions in the plain text, the separator inside the markers', () => {
		const body = renderPlainText([plain, withCode, line], { sendTimeBlockLogic: true });
		expect(body.startsWith('Thanks<!--owlat:if ')).toBe(true);
		expect(body).toMatch(/<!--owlat:if [^>]*-->\n\nCode \{\{bookingCode\}\}<!--owlat:endif-->/);
		expect(body).toMatch(
			/<!--owlat:each [^>]*-->\n\n\{\{line\.name\}\} x \{\{line\.qty\}\}<!--owlat:endeach-->/
		);
	});

	it('decides conditions and repeats in the render without the option, as the preview does', () => {
		const html = renderEmailHtml([withCode, withoutCode], {
			variableValues: { bookingCode: 'X' },
		});
		expect(html).toContain('Code {{bookingCode}}');
		expect(html).not.toContain('No code yet');
		expect(html).not.toContain('owlat:');
	});
});
