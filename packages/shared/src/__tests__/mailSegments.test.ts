import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../html';
import { mapToSource, segmentMessage } from '../mailSegments';
import { SEGMENT_CASES } from './mailSegmentsFixtures';

const squash = (s: string) => s.replace(/\s+/g, '');

describe('segmentMessage: fixture table', () => {
	it('has a broad table', () => {
		expect(SEGMENT_CASES.length).toBeGreaterThanOrEqual(40);
	});

	for (const fixture of SEGMENT_CASES) {
		it(fixture.name, () => {
			const result = segmentMessage({ text: fixture.text, html: fixture.html });
			const shown = result.segments.map((s) => [
				s.kind,
				result.canonicalText.slice(s.start, s.end),
				s.author,
			]);
			expect(
				result.segments.map((s) => s.kind),
				JSON.stringify(shown, null, 1)
			).toEqual(fixture.expect.map(([kind]) => kind));
			for (const [k, [, contains, author]] of fixture.expect.entries()) {
				const segment = result.segments[k];
				if (!segment) throw new Error(`segment ${k} missing`);
				expect(result.canonicalText.slice(segment.start, segment.end)).toContain(contains);
				if (author) {
					expect([segment.author?.name, segment.author?.email]).toContain(author);
				}
			}
			expect([...result.uncertainReasons].sort()).toEqual([...(fixture.uncertain ?? [])].sort());
			expect(result.uncertain).toBe((fixture.uncertain ?? []).length > 0);
			for (const absent of fixture.absent ?? []) {
				expect(result.canonicalText).not.toContain(absent);
			}
		});
	}
});

describe('segmentMessage: invariants over every fixture', () => {
	it('gives the same segments and ids for the same input', () => {
		for (const fixture of SEGMENT_CASES) {
			const input = { text: fixture.text, html: fixture.html };
			expect(segmentMessage(input)).toEqual(segmentMessage(input));
		}
	});

	it('numbers ids in reading order and keeps ranges ordered, trimmed and disjoint', () => {
		for (const fixture of SEGMENT_CASES) {
			const result = segmentMessage({ text: fixture.text, html: fixture.html });
			let previousEnd = 0;
			for (const [k, segment] of result.segments.entries()) {
				expect(segment.id).toBe(`s${k}`);
				expect(segment.start).toBeGreaterThanOrEqual(previousEnd);
				expect(segment.end).toBeGreaterThan(segment.start);
				const text = result.canonicalText.slice(segment.start, segment.end);
				expect(text).toBe(text.trim());
				previousEnd = segment.end;
			}
		}
	});

	it('maps every segment back to the source it came from', () => {
		for (const fixture of SEGMENT_CASES) {
			const result = segmentMessage({ text: fixture.text, html: fixture.html });
			for (const segment of result.segments) {
				const range = mapToSource(result.sourceMap, segment.start, segment.end);
				expect(range).not.toBeNull();
				if (!range) continue;
				const canonical = result.canonicalText.slice(segment.start, segment.end);
				if (fixture.rawText) continue;
				if (result.sourceMap.source === 'text') {
					const source = (fixture.text ?? '').slice(range.start, range.end);
					expect(squash(source.replace(/^[ \t]*>[ \t>]*/gm, ''))).toBe(squash(canonical));
				} else {
					const source = (fixture.html ?? '').slice(range.start, range.end);
					const visible = htmlToPlainText(source, { preserveBreaks: true });
					expect(squash(visible.replace(/^[ \t]*(?:>[ \t]?)+/gm, ''))).toBe(squash(canonical));
				}
			}
		}
	});

	it('reads the same words as htmlToPlainText for HTML without hidden parts', () => {
		for (const fixture of SEGMENT_CASES) {
			if (!fixture.html || fixture.absent || fixture.rawText || fixture.html.includes('&gt; ')) {
				continue;
			}
			const result = segmentMessage({ html: fixture.html });
			expect(squash(result.canonicalText), fixture.name).toBe(
				squash(htmlToPlainText(fixture.html))
			);
		}
	});
});

describe('segmentMessage: details', () => {
	it('returns nothing to read for an empty body, with full confidence', () => {
		expect(segmentMessage({})).toEqual({
			canonicalText: '',
			segments: [],
			sourceMap: { source: 'text', runs: [] },
			confidence: 1,
			uncertain: false,
			uncertainReasons: [],
		});
		expect(segmentMessage({ text: null, html: null }).segments).toEqual([]);
	});

	it('prefers the HTML body, as the reader does', () => {
		const result = segmentMessage({ text: 'text body', html: '<p>html body</p>' });
		expect(result.sourceMap.source).toBe('html');
		expect(result.canonicalText).toBe('html body');
	});

	it('strips > markers from canonical text and maps a quote back into them', () => {
		const text = 'Yes.\n\n> Can you send\n> the deck?\n';
		const result = segmentMessage({ text });
		expect(result.canonicalText).toBe('Yes.\n\nCan you send\nthe deck?');
		const at = result.canonicalText.indexOf('the deck');
		const range = mapToSource(result.sourceMap, at, at + 'the deck'.length);
		expect(range && text.slice(range.start, range.end)).toBe('the deck');
	});

	it('maps through CRLF line ends', () => {
		const text = 'First line\r\nSecond line\r\n';
		const result = segmentMessage({ text });
		const at = result.canonicalText.indexOf('Second');
		const range = mapToSource(result.sourceMap, at, at + 6);
		expect(range && text.slice(range.start, range.end)).toBe('Second');
	});

	it('maps a decoded entity back to the whole entity', () => {
		const html = '<p>Fees &amp; costs: &euro;5 &#8364;7</p>';
		const result = segmentMessage({ html });
		expect(result.canonicalText).toBe('Fees & costs: &euro;5 €7');
		const amp = result.canonicalText.indexOf('&');
		expect(mapToSource(result.sourceMap, amp, amp + 1)).toEqual({
			start: html.indexOf('&amp;'),
			end: html.indexOf('&amp;') + 5,
		});
		const euro = result.canonicalText.indexOf('€');
		const range = mapToSource(result.sourceMap, euro, euro + 2);
		expect(range && html.slice(range.start, range.end)).toBe('&#8364;7');
	});

	it('collapses HTML whitespace as a browser shows it', () => {
		const result = segmentMessage({ html: '<div>\n  Please   send\n  the file.\n</div>' });
		expect(result.canonicalText).toBe('Please send the file.');
	});

	it('takes a stricter hidden-style test from the caller', () => {
		const html = '<p>Visible.</p><p style="font-size:0">tiny injected text</p>';
		expect(segmentMessage({ html }).canonicalText).toContain('tiny injected');
		const strict = segmentMessage({ html }, { styleHides: (s) => /font-size\s*:\s*0/.test(s) });
		expect(strict.canonicalText).toBe('Visible.');
	});

	it('returns null for an empty or out-of-range mapping', () => {
		const result = segmentMessage({ text: 'abc' });
		expect(mapToSource(result.sourceMap, 1, 1)).toBeNull();
		expect(mapToSource(result.sourceMap, 5, 9)).toBeNull();
	});

	it('lowers confidence for heuristic boundaries and doubt', () => {
		const marked = segmentMessage({ text: 'Yes.\n\n> Can you?\n' });
		expect(marked.confidence).toBe(1);
		const unmarked = segmentMessage({
			text: 'Yes.\n\nOn Mon, 5 Oct 2026 at 10:00, Jonas Weber <jonas@example.com> wrote:\nCan you?\n',
		});
		expect(unmarked.confidence).toBeLessThan(1);
		expect(unmarked.segments.map((s) => s.kind)).toEqual(['fresh', 'quoted']);
		const doubtful = segmentMessage({ text: '> line that\nwraps here\n> more\n' });
		expect(doubtful.confidence).toBeLessThanOrEqual(0.7);
	});

	it('stays linear on hostile markup', () => {
		const hostile = '<'.repeat(50_000) + '<script'.repeat(5_000) + '&amp'.repeat(20_000);
		const started = Date.now();
		segmentMessage({ html: hostile });
		segmentMessage({ text: '>'.repeat(100_000) });
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

describe('segmentMessage: Outlook forwards', () => {
	const body =
		'Kannst du das übernehmen?\n\n________________________________\nVon: Tomás Ruiz <tomas@example.net>\nGesendet: Montag, 5. Oktober 2026 11:00\nAn: Lena Hofmann <lena@example.org>\nBetreff: Zugang\n\nBitte richtet mir einen Zugang ein.\n';

	it('reads the header block as forwarded when the message subject is a forward', () => {
		const kinds = (subject?: string) =>
			segmentMessage({ text: body, subject }).segments.map((s) => s.kind);
		expect(kinds('WG: Zugang')).toEqual(['fresh', 'forwarded']);
		expect(kinds('FW: Zugang')).toEqual(['fresh', 'forwarded']);
		expect(kinds('TR: Zugang')).toEqual(['fresh', 'forwarded']);
		expect(kinds('AW: Zugang')).toEqual(['fresh', 'quoted']);
		expect(kinds('RE: FW: Zugang')).toEqual(['fresh', 'quoted']);
		expect(kinds()).toEqual(['fresh', 'quoted']);
	});

	it('lets an explicit reply subject win over an embedded FW subject', () => {
		const history =
			'Paid, thanks.\n\nFrom: Billing <billing@example.com>\nSent: Monday, October 5, 2026 10:00 AM\nTo: Mara Lind\nSubject: FW: Invoice\n\nPlease pay invoice 2231.\n';
		const kinds = (subject?: string) =>
			segmentMessage({ text: history, subject }).segments.map((s) => s.kind);
		expect(kinds('RE: FW: Invoice')).toEqual(['fresh', 'quoted']);
		expect(kinds('AW: WG: Rechnung')).toEqual(['fresh', 'quoted']);
		expect(kinds('FW: Invoice')).toEqual(['fresh', 'forwarded']);
		// Without a reply or forward prefix the embedded subject still decides.
		expect(kinds('Invoice')).toEqual(['fresh', 'forwarded']);
		expect(kinds()).toEqual(['fresh', 'forwarded']);
	});

	it('keeps the original sender of the forwarded block', () => {
		const result = segmentMessage({ text: body, subject: 'WG: Zugang' });
		expect(result.segments[1]?.author).toEqual({ name: 'Tomás Ruiz', email: 'tomas@example.net' });
	});
});
