/**
 * `inboundMessages.attachmentMeta` is an unvalidated JSON STRING written from
 * data that came off the wire, and this parser is the boundary where it becomes
 * props. Everything here is an input a sender can produce.
 *
 * What is pinned:
 *   - malformed JSON, a non-array and non-object entries yield no attachments
 *     rather than throwing inside a render
 *   - an entry with no `contentType` is dropped (there is no honest default)
 *   - a missing filename falls back to a NAME, never `undefined` — an
 *     `<a download>` bound to undefined saves a file literally called
 *     "undefined"
 *   - a missing `size` renders as 0, not NaN
 *   - `partIndex` is passed through when present and OMITTED when absent, so
 *     the reader's `?? '0'` fallback is the one that decides
 *   - the STORED VERSION decides the shape, not the presence of a field: a
 *     version-0 row (the column absent, written before the raw `.eml` existed)
 *     yields no `partIndex` even if the string carries one, because there are
 *     no bytes for it to address
 *   - two files sharing a name keep their distinct part indexes
 *   - a path-shaped filename survives verbatim: it is rendered as text and used
 *     as a download hint, and rewriting it would silently rename the file
 */
import { describe, it, expect } from 'vitest';
import { parseInboundAttachmentMeta } from '../inboundAttachmentMeta';

describe('parseInboundAttachmentMeta', () => {
	it('returns no attachments for absent, empty or malformed input', () => {
		expect(parseInboundAttachmentMeta(undefined)).toEqual([]);
		expect(parseInboundAttachmentMeta('')).toEqual([]);
		expect(parseInboundAttachmentMeta('{not json')).toEqual([]);
		expect(parseInboundAttachmentMeta('"a string"')).toEqual([]);
		expect(parseInboundAttachmentMeta('{"filename":"a.txt"}')).toEqual([]);
	});

	it('drops entries that are not objects or carry no contentType', () => {
		const raw = JSON.stringify([
			null,
			'nope',
			42,
			{ filename: 'no-type.txt', size: 10 },
			{ filename: 'ok.txt', contentType: 'text/plain', size: 10, partIndex: '1' },
		]);

		expect(parseInboundAttachmentMeta(raw, 1)).toEqual([
			{ filename: 'ok.txt', contentType: 'text/plain', size: 10, partIndex: '1' },
		]);
	});

	it('names an unnamed part instead of leaving the download hint undefined', () => {
		const [att] = parseInboundAttachmentMeta(
			JSON.stringify([{ contentType: 'application/pdf', partIndex: '2' }]),
			1
		);

		expect(att?.filename).toBe('attachment');
		expect(att?.size).toBe(0);
	});

	it('omits partIndex when the wire did not carry one, rather than inventing one', () => {
		const [att] = parseInboundAttachmentMeta(
			JSON.stringify([{ filename: 'legacy.txt', contentType: 'text/plain', size: 1 }]),
			1
		);

		expect(att).not.toHaveProperty('partIndex');
	});

	it('ignores non-string partIndex and non-number size', () => {
		const [att] = parseInboundAttachmentMeta(
			JSON.stringify([{ filename: 'x', contentType: 'text/plain', size: '10', partIndex: 3 }]),
			1
		);

		expect(att).toEqual({ filename: 'x', contentType: 'text/plain', size: 0 });
	});

	it('keeps two same-named files apart by their part index', () => {
		const parsed = parseInboundAttachmentMeta(
			JSON.stringify([
				{ filename: 'scan.pdf', contentType: 'application/pdf', size: 1, partIndex: '1' },
				{ filename: 'scan.pdf', contentType: 'application/pdf', size: 2, partIndex: '2' },
			]),
			1
		);

		expect(parsed.map((a) => a.partIndex)).toEqual(['1', '2']);
	});

	it('reads no partIndex out of a version-0 row, whatever the string says', () => {
		// Version 0 is every row written before the raw `.eml` was stored: there
		// are no bytes for a part index to point into, so a `partIndex` in the
		// string is not an address, and a download built on it would 404. The
		// VERSION is what says so — guessing from the field's presence is what
		// the stored version exists to replace.
		const raw = JSON.stringify([
			{ filename: 'old.pdf', contentType: 'application/pdf', size: 3, partIndex: '1' },
		]);

		expect(parseInboundAttachmentMeta(raw, 0)).toEqual([
			{ filename: 'old.pdf', contentType: 'application/pdf', size: 3 },
		]);
		// The column absent IS version 0.
		expect(parseInboundAttachmentMeta(raw)).toEqual([
			{ filename: 'old.pdf', contentType: 'application/pdf', size: 3 },
		]);
	});

	it('passes a path-shaped filename through unchanged', () => {
		const [att] = parseInboundAttachmentMeta(
			JSON.stringify([
				{ filename: '../../etc/passwd', contentType: 'text/plain', size: 1, partIndex: '1' },
			]),
			1
		);

		expect(att?.filename).toBe('../../etc/passwd');
	});
});
