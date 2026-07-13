import { describe, it, expect } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import {
	inboundMessageBody,
	mailMessageInlineBody,
	readMailMessageText,
	parseUnifiedMessageContent,
	type BodyBlobStorageReader,
} from '../messageBody';

const storageId = (s: string) => s as Id<'_storage'>;

describe('inboundMessageBody — shape 1 (inboundMessages inline)', () => {
	it('returns text and html verbatim when both present', () => {
		expect(inboundMessageBody({ textBody: 'hi', htmlBody: '<p>hi</p>' })).toEqual({
			text: 'hi',
			html: '<p>hi</p>',
		});
	});

	it('text-only row leaves html undefined', () => {
		expect(inboundMessageBody({ textBody: 'plain' })).toEqual({ text: 'plain', html: undefined });
	});

	it('html-only row leaves text undefined', () => {
		expect(inboundMessageBody({ htmlBody: '<b>x</b>' })).toEqual({
			text: undefined,
			html: '<b>x</b>',
		});
	});

	it('legacy row with neither field yields both undefined', () => {
		expect(inboundMessageBody({})).toEqual({ text: undefined, html: undefined });
	});

	it('never coerces empty strings away (empty is a real value, not absence)', () => {
		expect(inboundMessageBody({ textBody: '', htmlBody: '' })).toEqual({ text: '', html: '' });
	});

	it('collapses null (projection shape) to undefined', () => {
		expect(inboundMessageBody({ textBody: null, htmlBody: null })).toEqual({
			text: undefined,
			html: undefined,
		});
		expect(inboundMessageBody({ textBody: 'x', htmlBody: null })).toEqual({
			text: 'x',
			html: undefined,
		});
	});
});

describe('mailMessageInlineBody — shape 2 (mailMessages inline snippet)', () => {
	it('returns the inline snippet fields verbatim without touching storage', () => {
		expect(mailMessageInlineBody({ textBodyInline: 'snip', htmlBodyInline: '<i>s</i>' })).toEqual({
			text: 'snip',
			html: '<i>s</i>',
		});
	});

	it('blob-only row (no inline) reports both inline fields as undefined', () => {
		expect(mailMessageInlineBody({})).toEqual({ text: undefined, html: undefined });
	});

	it('text-inline-only leaves html undefined', () => {
		expect(mailMessageInlineBody({ textBodyInline: 'only' })).toEqual({
			text: 'only',
			html: undefined,
		});
	});
});

describe('readMailMessageText — shape 2 (mailMessages inline-or-blob)', () => {
	const makeStorage = (map: Record<string, string>): BodyBlobStorageReader => ({
		get: async (id) => {
			const value = map[id as unknown as string];
			return value === undefined ? null : (new Blob([value]) as unknown as Blob);
		},
	});

	it('prefers the inline snippet and never fetches the blob', async () => {
		let fetched = false;
		const storage: BodyBlobStorageReader = {
			get: async () => {
				fetched = true;
				return null;
			},
		};
		const text = await readMailMessageText(storage, {
			textBodyInline: 'inline wins',
			textBodyStorageId: storageId('blob1'),
		});
		expect(text).toBe('inline wins');
		expect(fetched).toBe(false);
	});

	it('falls back to the storage blob contents when there is no inline snippet', async () => {
		const storage = makeStorage({ blob1: 'from the blob' });
		const text = await readMailMessageText(storage, { textBodyStorageId: storageId('blob1') });
		expect(text).toBe('from the blob');
	});

	it('returns empty string when neither inline nor a resolvable blob exists', async () => {
		const storage = makeStorage({});
		expect(await readMailMessageText(storage, {})).toBe('');
		expect(await readMailMessageText(storage, { textBodyStorageId: storageId('missing') })).toBe(
			''
		);
	});
});

describe('parseUnifiedMessageContent — shape 3 (unifiedMessages.content JSON)', () => {
	it('parses a full JSON body blob into its fields', () => {
		const json = JSON.stringify({
			text: 'hello',
			html: '<p>hello</p>',
			subject: 'Subj',
			mediaUrl: 'https://x/y.png',
		});
		expect(parseUnifiedMessageContent(json)).toEqual({
			text: 'hello',
			html: '<p>hello</p>',
			subject: 'Subj',
			mediaUrl: 'https://x/y.png',
		});
	});

	it('parses a partial JSON body blob (only text present)', () => {
		expect(parseUnifiedMessageContent(JSON.stringify({ text: 'just text' }))).toEqual({
			text: 'just text',
		});
	});

	it('treats a legacy plain (non-JSON) string as the text body', () => {
		expect(parseUnifiedMessageContent('legacy plain body')).toEqual({ text: 'legacy plain body' });
	});

	it('treats a JSON non-object (e.g. a quoted string) as the text body', () => {
		// JSON.parse('"hi"') === 'hi' (a string, not an object) → whole input is text.
		expect(parseUnifiedMessageContent('"hi"')).toEqual({ text: '"hi"' });
	});

	it('never throws on malformed input', () => {
		expect(() => parseUnifiedMessageContent('{ not: valid json')).not.toThrow();
		expect(parseUnifiedMessageContent('{ not: valid json')).toEqual({ text: '{ not: valid json' });
	});
});
