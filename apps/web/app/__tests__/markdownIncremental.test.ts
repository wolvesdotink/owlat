/**
 * The incremental parser must return exactly what a full parse returns for
 * every source, while parsing only the text after the settled blocks when a
 * source extends the previous one. Parser work is observed by counting the
 * characters handed to the parser, never by timing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MarkdownModule from '~/utils/markdown';
import { parseMarkdown, type Block } from '~/utils/markdown';
import { createIncrementalMarkdown } from '~/utils/markdownIncremental';

const parserInputs = vi.hoisted(() => ({ lengths: [] as number[] }));

vi.mock('~/utils/markdown', async (importOriginal) => {
	const actual = await importOriginal<typeof MarkdownModule>();
	return {
		...actual,
		parseMarkdown: (src: string) => {
			parserInputs.lengths.push(src.length);
			return actual.parseMarkdown(src);
		},
		parseMarkdownSettled: (src: string) => {
			parserInputs.lengths.push(src.length);
			return actual.parseMarkdownSettled(src);
		},
	};
});

beforeEach(() => {
	parserInputs.lengths = [];
});

/** The full parse, without counting it as parser work of the code under test. */
function fullParse(src: string): Block[] {
	const counted = parserInputs.lengths.length;
	const blocks = parseMarkdown(src);
	parserInputs.lengths.length = counted;
	return blocks;
}

const DOCUMENTS: Record<string, string> = {
	mixed: [
		'# Open invoices',
		'',
		'There are **three** open invoices, see [the list](https://owlat.example/invoices).',
		'Second line of the same paragraph.',
		'',
		'- First, due `Monday`',
		'- Second, due *Friday*',
		'1. ordered',
		'',
		'> Paid ones',
		'> are hidden.',
		'---',
		'## Next',
		'Closing words with a [partial link](https://owlat.example/a',
	].join('\n'),
	fences: [
		'Before the code.',
		'',
		'```ts',
		'const a = 1;',
		'',
		'',
		'# not a heading',
		'```',
		'After the fence.',
		'',
		'```',
		'unclosed fence',
		'',
		'still code',
	].join('\n'),
	crlf: '# Title\r\n\r\nFirst paragraph\r\nwraps here.\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n\r\nEnd\r',
	loneCarriageReturns: 'one\r two\r\n\r\nthree\r\r\n\rfour',
	blocksWithoutBlankLines: '# H\n---\n> q\n- l\npara\n```\nx\n```\n## H2\ntext',
};

/** Deterministic chunk sizes between 1 and 9. */
function* chunks(text: string, seed: number): Generator<string> {
	let state = seed;
	let at = 0;
	while (at < text.length) {
		state = (state * 1103515245 + 12345) % 2147483648;
		const size = 1 + (state % 9);
		at = Math.min(text.length, at + size);
		yield text.slice(0, at);
	}
}

describe('createIncrementalMarkdown', () => {
	const documents = Object.entries(DOCUMENTS);

	it.each(documents)('matches a full parse at every character of %s', (_name, doc) => {
		const parse = createIncrementalMarkdown();
		for (let k = 0; k <= doc.length; k++) {
			const source = doc.slice(0, k);
			expect(parse(source), JSON.stringify(source)).toEqual(fullParse(source));
		}
	});

	it.each(documents)('matches a full parse when %s arrives in uneven chunks', (_name, doc) => {
		for (const seed of [1, 7, 42]) {
			const parse = createIncrementalMarkdown();
			for (const source of chunks(doc, seed)) {
				expect(parse(source), JSON.stringify(source)).toEqual(fullParse(source));
			}
		}
	});

	it('handles a CRLF whose CR and LF arrive in different flushes', () => {
		const parse = createIncrementalMarkdown();
		const steps = ['Alpha\r', 'Alpha\r\n', 'Alpha\r\n\r', 'Alpha\r\n\r\n', 'Alpha\r\n\r\nBeta\r'];
		for (const source of steps) expect(parse(source)).toEqual(fullParse(source));
		expect(parse('Alpha\r\n\r\nBeta\r\nGamma')).toEqual([
			{ type: 'paragraph', inlines: [{ type: 'text', value: 'Alpha' }] },
			{ type: 'paragraph', inlines: [{ type: 'text', value: 'Beta Gamma' }] },
		]);
	});

	it('parses only the unsettled tail once a large prefix has settled', () => {
		const prefix = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the answer.`).join(
			'\n\n'
		);
		const parse = createIncrementalMarkdown();
		parse(`${prefix}\n\n`);
		parserInputs.lengths = [];

		const tail = 'The last one is overdue';
		const source = `${prefix}\n\n${tail}`;
		expect(parse(source)).toEqual(fullParse(source));
		// The blank line before the tail plus the tail itself; the 6k+ prefix is
		// never handed to the parser again.
		expect(parserInputs.lengths).toEqual([tail.length + 1]);
		expect(prefix.length).toBeGreaterThan(5_000);
	});

	it('keeps parser work linear in the answer length when blocks stay bounded', () => {
		const blocks: string[] = [];
		for (let i = 0; i < 400; i++) {
			blocks.push(
				i % 4 === 0
					? `## Section ${i}`
					: i % 4 === 1
						? `- item ${i}\n- item ${i + 1}`
						: i % 4 === 2
							? `\`\`\`\ncode ${i}\n\`\`\``
							: `Paragraph ${i} with **bold** and a [link](https://owlat.example/${i}).`
			);
		}
		const answer = blocks.join('\n\n');
		const longestBlock = Math.max(...blocks.map((b) => b.length));
		const chunk = 16;

		const parse = createIncrementalMarkdown();
		for (let at = chunk; at < answer.length + chunk; at += chunk) {
			parse(answer.slice(0, Math.min(at, answer.length)));
		}
		expect(parse(answer)).toEqual(fullParse(answer));

		// Every parse covers at most the block being written, the block before it
		// (until the line after it completes) and one chunk.
		const bound = 2 * longestBlock + chunk + 4;
		expect(Math.max(...parserInputs.lengths)).toBeLessThanOrEqual(bound);
		const total = parserInputs.lengths.reduce((sum, n) => sum + n, 0);
		const flushes = parserInputs.lengths.length;
		expect(total).toBeLessThanOrEqual(flushes * bound);
		// A full parse per flush would hand the parser about n²/(2·chunk) characters.
		expect(total * 20).toBeLessThan((answer.length * answer.length) / (2 * chunk));
	});

	it('returns settled blocks as the same objects and the same array for the same source', () => {
		const parse = createIncrementalMarkdown();
		const first = parse('# Title\n\nIntro.\n\nGrowing');
		const second = parse('# Title\n\nIntro.\n\nGrowing more');
		expect(second).not.toBe(first);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
		expect(second[2]).not.toBe(first[2]);
		expect(parse('# Title\n\nIntro.\n\nGrowing more')).toBe(second);
	});

	it('starts over on edits, truncation, replacement and clearing', () => {
		const parse = createIncrementalMarkdown();
		const sources = [
			'# Intro\n\nFirst.\n\nSecond.\n\nThird',
			'# Intro\n\nFirst, edited.\n\nSecond.\n\nThird',
			'# Intro\n\nFirst',
			'Something else entirely.\n\nAnd more',
			'',
			'Back again.\n\n- one',
			'Back again.\n\n- one\n- two',
		];
		for (const source of sources) {
			parserInputs.lengths = [];
			expect(parse(source), JSON.stringify(source)).toEqual(fullParse(source));
		}
		// The last source extends the one before, whose first paragraph settled.
		expect(parserInputs.lengths).toEqual(['\n- one\n- two'.length]);
	});

	it('keeps the caches of separate parsers apart', () => {
		const a = createIncrementalMarkdown();
		const b = createIncrementalMarkdown();
		a('Alpha one.\n\nAlpha two');
		b('Beta one.\n\nBeta two');
		expect(a('Alpha one.\n\nAlpha two, more')).toEqual(fullParse('Alpha one.\n\nAlpha two, more'));
		expect(b('Beta one.\n\nBeta two, more')).toEqual(fullParse('Beta one.\n\nBeta two, more'));
	});

	it('falls back to a full parse while a reference definition is present', () => {
		const prefix = 'Intro with [a link][docs].\n\nMore text.\n\n';
		const parse = createIncrementalMarkdown();
		parse(prefix);

		const withDefinition = `${prefix}[docs]: https://owlat.example/docs\n\nAfter`;
		parserInputs.lengths = [];
		expect(parse(withDefinition)).toEqual(fullParse(withDefinition));
		expect(parserInputs.lengths).toEqual([withDefinition.length]);

		const longer = `${withDefinition} the definition.`;
		parserInputs.lengths = [];
		expect(parse(longer)).toEqual(fullParse(longer));
		expect(parserInputs.lengths).toEqual([longer.length]);

		// A source without the definition goes back to incremental parsing.
		const plain = `${prefix}No definition here.\n\nTail`;
		expect(parse(plain)).toEqual(fullParse(plain));
		parserInputs.lengths = [];
		expect(parse(`${plain} grows`)).toEqual(fullParse(`${plain} grows`));
		expect(parserInputs.lengths).toEqual(['\nTail grows'.length]);
	});
});
