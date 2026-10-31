import { describe, it, expect } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { renderEmailHtml } from '../renderer';
import { escapeJsonValue } from '../sanitize';

/**
 * Regression tests for JSON-in-HTML embedding hardening.
 *
 * (1) Gmail JSON-LD annotations are serialized inside a
 *     `<script type="application/ld+json">` element. A user-controlled value
 *     containing `</script>` must not close the element early (stored XSS in
 *     the public archive).
 * (2) The repeat-block placeholder substitution re-parses JSON after merging
 *     per-recipient values. A raw control char in a value must not throw out
 *     of renderEmailHtml and fail that recipient.
 */

const extractLdJson = (html: string): string | undefined => {
	const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
	return m?.[1];
};

describe('JSON-LD annotation script embedding', () => {
	it('does not allow a </script> breakout from an annotation value', () => {
		const payload = '</script><img src=x onerror=alert(1)>';
		const html = renderEmailHtml([], {
			gmailAnnotations: { description: payload },
		});

		// The injected close-tag + <img> must never appear literally.
		expect(html).not.toContain('</script><img');
		expect(html).not.toContain('<img src=x onerror=alert(1)>');
		// `<` is neutralized to its JSON unicode escape.
		expect(html).toContain('\\u003c/script>');

		// The embedded JSON is still valid and round-trips to the original value.
		const jsonText = extractLdJson(html);
		expect(jsonText).toBeDefined();
		const parsed = JSON.parse(jsonText as string) as { description?: string };
		expect(parsed.description).toBe(payload);
	});

	it('keeps benign annotation values intact and parseable', () => {
		const html = renderEmailHtml([], {
			gmailAnnotations: {
				description: 'Summer sale, up to 50% off',
				discountCode: 'SAVE50',
			},
		});
		const parsed = JSON.parse(extractLdJson(html) as string) as {
			description?: string;
			offers?: { discountCode?: string };
		};
		expect(parsed.description).toBe('Summer sale, up to 50% off');
		expect(parsed.offers?.discountCode).toBe('SAVE50');
	});
});

describe('escapeJsonValue hardening', () => {
	it('escapes < and control chars so the result parses inside a JSON string', () => {
		const raw = 'a</script>b\u0001c\u2028d';
		const escaped = escapeJsonValue(raw);
		expect(escaped).not.toContain('<');
		// Round-trips through JSON.parse as part of a JSON string literal.
		expect(JSON.parse(`"${escaped}"`)).toBe(raw);
	});

	it('escapes every C0 control code unit with its short or \\u form', () => {
		const short: Record<number, string> = {
			0x08: '\\b',
			0x09: '\\t',
			0x0a: '\\n',
			0x0c: '\\f',
			0x0d: '\\r',
		};
		for (let code = 0; code < 0x20; code++) {
			const ch = String.fromCharCode(code);
			const expected = short[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
			expect(escapeJsonValue(`a${ch}b`), `U+${code.toString(16)}`).toBe(`a${expected}b`);
			expect(JSON.parse(`"${escapeJsonValue(ch)}"`)).toBe(ch);
		}
	});

	it('escapes the JSON delimiters, <, U+2028 and U+2029 and nothing else', () => {
		expect(escapeJsonValue('"\\<>\u2028\u2029')).toBe('\\"\\\\\\u003c>\\u2028\\u2029');
		expect(escapeJsonValue("plain 'text' & > é")).toBe("plain 'text' & > é");
	});

	it('keeps surrogate pairs and lone surrogates untouched', () => {
		const value = 'mail \u{1F4E7}\uD800 end';
		expect(escapeJsonValue(value)).toBe(value);
		expect(JSON.parse(`"${escapeJsonValue(`${value}\n<`)}"`)).toBe(`${value}\n<`);
	});
});

describe('repeat-block re-parse resilience', () => {
	const makeBlocks = (): EditorBlock[] => [
		{
			id: 'item',
			type: 'text',
			content: {
				html: '<p>{{product.name}}</p>',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#333',
				repeat: {
					variable: 'products',
					itemAlias: 'product',
				},
			},
		} as unknown as EditorBlock,
	];

	it('does not throw when a per-item value contains a raw control char', () => {
		const products = JSON.stringify([
			{ name: 'Widget A' },
			{ name: 'Bad\u0001Value' },
			{ name: 'Widget C' },
		]);

		let html = '';
		expect(() => {
			html = renderEmailHtml(makeBlocks(), { variableValues: { products } });
		}).not.toThrow();

		// Benign items still render.
		expect(html).toContain('Widget A');
		expect(html).toContain('Widget C');
	});
});
