/**
 * `inbox/bodyStorage` — which parts of a Team Inbox body stay on the row, and
 * the bounded projections derived from it.
 *
 * The budget is spent on STORED bytes, so these cases sit on the three ways a
 * character count under-reports a body: the two parts share one budget, a
 * non-ASCII character is several UTF-8 bytes, and sealing base64-encodes an
 * AES-GCM box. The estimate is held against the real sealer, so a change to
 * the envelope cannot make it quietly too small.
 */

import { describe, it, expect } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { sealAtRest } from '../../lib/atRestBodies';
import {
	INBOUND_BODY_EXCERPT_CODE_POINTS,
	INBOUND_INLINE_BODY_BUDGET_BYTES,
	buildInboundBodyExcerpt,
	inboundMirrorContent,
	planInboundBodyStorage,
	storedBodyBytesUpperBound,
} from '../bodyStorage';

const SECRET = 'body-storage-test-instance-secret-value';
const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;
const messageId = 'inbound-1' as Id<'inboundMessages'>;
const blobId = 'blob-1' as Id<'_storage'>;

/** The longest ASCII body whose sealed form still fits the whole budget:
 * 64 + 4 * ceil((n + 16) / 3) <= 262,144. */
const LARGEST_INLINE_ASCII = 196_544;

describe('storedBodyBytesUpperBound', () => {
	it('is never below what the at-rest sealer actually writes', async () => {
		const samples = [
			'a',
			'ab',
			'abc',
			'x'.repeat(1000),
			'ü'.repeat(4097),
			'日本語'.repeat(3000),
			'🙂'.repeat(2500),
			'y'.repeat(LARGEST_INLINE_ASCII),
		];
		for (const body of samples) {
			const sealed = await sealAtRest(SECRET, body);
			const bound = storedBodyBytesUpperBound(utf8Length(body));
			expect(bound).toBeGreaterThanOrEqual(sealed.length);
			// Tight enough to matter: the envelope header is all it rounds up.
			expect(bound - sealed.length).toBeLessThan(64);
		}
	});

	it('costs nothing for an empty part, which the sealer stores as empty', async () => {
		expect(await sealAtRest(SECRET, '')).toBe('');
		expect(storedBodyBytesUpperBound(0)).toBe(0);
	});
});

describe('planInboundBodyStorage', () => {
	it('keeps an ordinary message wholly inline', () => {
		expect(
			planInboundBodyStorage({ textBody: 'Hello there', htmlBody: '<p>Hello there</p>' })
		).toEqual({ isTextStored: false, isHtmlStored: false });
	});

	it('keeps a body that fits the budget exactly, and moves one byte more', () => {
		expect(planInboundBodyStorage({ htmlBody: 'h'.repeat(LARGEST_INLINE_ASCII) })).toEqual({
			isTextStored: false,
			isHtmlStored: false,
		});
		expect(planInboundBodyStorage({ htmlBody: 'h'.repeat(LARGEST_INLINE_ASCII + 1) })).toEqual({
			isTextStored: false,
			isHtmlStored: true,
		});
	});

	it('counts the sealing overhead: 200 KiB of plaintext does not fit 256 KiB once sealed', () => {
		const body = 'z'.repeat(200 * 1024);
		expect(utf8Length(body)).toBeLessThan(INBOUND_INLINE_BODY_BUDGET_BYTES);
		expect(planInboundBodyStorage({ textBody: body }).isTextStored).toBe(true);
	});

	it('counts UTF-8 bytes, not code units', () => {
		// 100k code units either way; as `ü` that is 200k bytes, over the budget
		// once sealed, while the ASCII body of the same `.length` fits.
		const ascii = 'u'.repeat(100_000);
		const umlaut = 'ü'.repeat(100_000);
		expect(ascii.length).toBe(umlaut.length);
		expect(planInboundBodyStorage({ textBody: ascii }).isTextStored).toBe(false);
		expect(planInboundBodyStorage({ textBody: umlaut }).isTextStored).toBe(true);
	});

	it('charges text and HTML against ONE budget and moves the larger part first', () => {
		// Each part fits alone; together they do not.
		const text = 't'.repeat(90 * 1024);
		const html = 'h'.repeat(110 * 1024);
		expect(planInboundBodyStorage({ textBody: text }).isTextStored).toBe(false);
		expect(planInboundBodyStorage({ htmlBody: html }).isHtmlStored).toBe(false);
		expect(planInboundBodyStorage({ textBody: text, htmlBody: html })).toEqual({
			isTextStored: false,
			isHtmlStored: true,
		});
	});

	it('moves both parts when the smaller one alone still crowds the row', () => {
		const plan = planInboundBodyStorage({
			textBody: 't'.repeat(180 * 1024),
			htmlBody: 'h'.repeat(1536 * 1024),
		});
		expect(plan).toEqual({ isTextStored: true, isHtmlStored: true });
	});

	it('keeps a short text part inline beside a 1.5 MiB HTML part', () => {
		expect(
			planInboundBodyStorage({ textBody: 'Plain part', htmlBody: 'h'.repeat(1536 * 1024) })
		).toEqual({ isTextStored: false, isHtmlStored: true });
	});
});

describe('buildInboundBodyExcerpt', () => {
	it('is the opening of the text part, cut on a code point', () => {
		const excerpt = buildInboundBodyExcerpt({ textBody: '🙂'.repeat(20_000) });
		expect(Array.from(excerpt ?? '')).toHaveLength(INBOUND_BODY_EXCERPT_CODE_POINTS);
		// No half of a surrogate pair at the cut.
		expect(excerpt?.endsWith('🙂')).toBe(true);
	});

	it('converts the HTML when there is no text part', () => {
		const excerpt = buildInboundBodyExcerpt({
			htmlBody: `<style>p{color:red}</style><p>Invoice &amp; receipt</p>${'<p>x</p>'.repeat(100_000)}`,
		});
		expect(excerpt?.startsWith('Invoice & receipt')).toBe(true);
		expect(excerpt).not.toContain('<p>');
		expect(excerpt).not.toContain('color:red');
		expect(Array.from(excerpt ?? '').length).toBeLessThanOrEqual(INBOUND_BODY_EXCERPT_CODE_POINTS);
	});
});

describe('inboundMirrorContent', () => {
	it('mirrors a small message whole, as before', () => {
		const content = JSON.parse(
			inboundMirrorContent({ textBody: 'hi', htmlBody: '<p>hi</p>', subject: 'Hello' }, messageId)
		);
		expect(content).toEqual({ text: 'hi', html: '<p>hi</p>', subject: 'Hello' });
	});

	it('mirrors a message with a stored part as a bounded projection plus its row id', () => {
		const content = inboundMirrorContent(
			{
				textBody: 'Short text',
				htmlBody: 'h'.repeat(1536 * 1024),
				subject: 'Newsletter',
				htmlBodyStorageId: blobId,
			},
			messageId
		);
		expect(utf8Length(content)).toBeLessThan(128 * 1024);
		expect(JSON.parse(content)).toEqual({
			text: 'Short text',
			subject: 'Newsletter',
			isBodyTruncated: true,
			inboundMessageId: messageId,
		});
	});

	it('projects an inline body whose JSON escaping would overrun the mirror', () => {
		// Inline-sized, but every control character escapes to six bytes.
		const content = inboundMirrorContent(
			{ textBody: '\u0001'.repeat(60_000), subject: 's' },
			messageId
		);
		expect(utf8Length(content)).toBeLessThan(256 * 1024);
		expect(JSON.parse(content).isBodyTruncated).toBe(true);
	});

	it('keeps the sealed-mail flags on either shape', () => {
		const content = JSON.parse(
			inboundMirrorContent(
				{
					textBody: 'x',
					subject: 's',
					isSealed: true,
					isSignatureValid: true,
					textBodyStorageId: blobId,
				},
				messageId
			)
		);
		expect(content.isSealed).toBe(true);
		expect(content.isSignatureValid).toBe(true);
	});
});
