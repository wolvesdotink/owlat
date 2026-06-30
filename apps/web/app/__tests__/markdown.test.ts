import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInlines, isSafeHref } from '~/utils/markdown';

describe('parseInlines', () => {
	it('parses bold, italic, and inline code', () => {
		expect(parseInlines('a **b** c')).toEqual([
			{ type: 'text', value: 'a ' },
			{ type: 'strong', value: 'b' },
			{ type: 'text', value: ' c' },
		]);
		expect(parseInlines('use `npm run` now')).toEqual([
			{ type: 'text', value: 'use ' },
			{ type: 'code', value: 'npm run' },
			{ type: 'text', value: ' now' },
		]);
		expect(parseInlines('*em*')).toEqual([{ type: 'em', value: 'em' }]);
	});

	it('renders safe links as anchors and never emits an unsafe link node', () => {
		expect(parseInlines('[docs](https://x.com)')).toEqual([
			{ type: 'link', value: 'docs', href: 'https://x.com' },
		]);
		const unsafe = parseInlines('[x](javascript:alert(1))');
		expect(unsafe.every((p) => p.type === 'text')).toBe(true);
		expect(unsafe.map((p) => p.value).join('')).toBe('[x](javascript:alert(1))');
	});

	it('does not format inside inline code', () => {
		const parts = parseInlines('`a *b* c`');
		expect(parts).toEqual([{ type: 'code', value: 'a *b* c' }]);
	});
});

describe('isSafeHref', () => {
	it('allows http/https/mailto only', () => {
		expect(isSafeHref('https://x.com')).toBe(true);
		expect(isSafeHref('http://x.com')).toBe(true);
		expect(isSafeHref('mailto:a@b.com')).toBe(true);
		expect(isSafeHref('javascript:alert(1)')).toBe(false);
		expect(isSafeHref('data:text/html,x')).toBe(false);
	});
});

describe('parseMarkdown', () => {
	it('parses headings and paragraphs', () => {
		const blocks = parseMarkdown('# Title\n\nHello world.');
		expect(blocks[0]).toEqual({ type: 'heading', level: 1, inlines: [{ type: 'text', value: 'Title' }] });
		expect(blocks[1]).toEqual({ type: 'paragraph', inlines: [{ type: 'text', value: 'Hello world.' }] });
	});

	it('parses fenced code blocks with a language and preserves contents verbatim', () => {
		const blocks = parseMarkdown('```ts\nconst a = **1**;\n```');
		expect(blocks[0]).toEqual({ type: 'code', lang: 'ts', value: 'const a = **1**;' });
	});

	it('parses unordered and ordered lists', () => {
		const ul = parseMarkdown('- one\n- two');
		expect(ul[0]).toMatchObject({ type: 'list', ordered: false });
		expect((ul[0] as { items: unknown[] }).items).toHaveLength(2);

		const ol = parseMarkdown('1. first\n2. second');
		expect(ol[0]).toMatchObject({ type: 'list', ordered: true });
	});

	it('parses blockquotes and horizontal rules', () => {
		const bq = parseMarkdown('> quoted line');
		expect(bq[0]).toEqual({ type: 'blockquote', inlines: [{ type: 'text', value: 'quoted line' }] });
		expect(parseMarkdown('---')[0]).toEqual({ type: 'hr' });
	});

	it('joins soft-wrapped paragraph lines and separates on blank lines', () => {
		const blocks = parseMarkdown('line one\nline two\n\nsecond para');
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({ type: 'paragraph', inlines: [{ type: 'text', value: 'line one line two' }] });
		expect(blocks[1]).toEqual({ type: 'paragraph', inlines: [{ type: 'text', value: 'second para' }] });
	});
});
