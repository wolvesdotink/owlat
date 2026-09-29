import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import {
	CONSUMED_POSTBOX_BODY_TTL_MS,
	clearResolvedPostboxBodies,
	consumeResolvedPostboxMessageBody,
	resolvePostboxMessageBody,
	setResolvedPostboxBodyScope,
	type PostboxBodyClient,
} from '../postboxBodyResolver';

type InlineBody = {
	htmlInline: string | null;
	textInline: string | null;
	hasHtmlBlob: boolean;
	hasTextBlob: boolean;
} | null;
type BlobUrls = { htmlUrl: string | null; textUrl: string | null } | null;

/** A client whose inline body query and blob URL action answer from fixtures. */
function makeClient(inline: InlineBody, urls: BlobUrls = { htmlUrl: null, textUrl: null }) {
	const query = vi.fn(async (ref: unknown, _args: { messageId: string }) => {
		expect(getFunctionName(ref as never)).toBe('mail/mailbox/messages:getMessageInlineBody');
		return inline;
	});
	const action = vi.fn(async (ref: unknown, _args: { messageId: string }) => {
		expect(getFunctionName(ref as never)).toBe('mail/mailbox/messages:getMessageBodyBlobUrls');
		return urls;
	});
	return { client: { query, action } as unknown as PostboxBodyClient, query, action };
}

const inlineHtml = (html: string): InlineBody => ({
	htmlInline: html,
	textInline: null,
	hasHtmlBlob: false,
	hasTextBlob: false,
});

describe('postboxBodyResolver', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reads an inline body from the reactive query and never calls the action', async () => {
		const { client, query, action } = makeClient(inlineHtml('<p>hi</p>'));
		const fetchImpl = vi.fn();

		expect(await resolvePostboxMessageBody(client, 'inline', { fetchImpl })).toEqual({
			html: '<p>hi</p>',
			text: null,
		});
		expect(query).toHaveBeenCalledTimes(1);
		expect(action).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('uses the action only for a blob body, then downloads it', async () => {
		const { client, query, action } = makeClient(
			{ htmlInline: null, textInline: null, hasHtmlBlob: false, hasTextBlob: true },
			{ htmlUrl: null, textUrl: 'https://storage.example/text' }
		);
		const fetchImpl = vi.fn(async () => ({ text: async () => 'long text' }));

		expect(await resolvePostboxMessageBody(client, 'blob', { fetchImpl })).toEqual({
			html: null,
			text: 'long text',
		});
		expect(query).toHaveBeenCalledTimes(1);
		expect(action).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledWith('https://storage.example/text');
	});

	it('skips the inline query when the caller already knows the body is a blob', async () => {
		const { client, query, action } = makeClient(null, {
			htmlUrl: 'https://storage.example/html',
			textUrl: null,
		});
		const fetchImpl = vi.fn(async () => ({ text: async () => '<p>big</p>' }));

		expect(
			await resolvePostboxMessageBody(client, 'known-blob', { fetchImpl, blobOnly: true })
		).toEqual({ html: '<p>big</p>', text: null });
		expect(query).not.toHaveBeenCalled();
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('answers null for an unreadable message and an empty body for one without any', async () => {
		expect(await resolvePostboxMessageBody(makeClient(null).client, 'gone')).toBeNull();
		const empty = makeClient({
			htmlInline: null,
			textInline: null,
			hasHtmlBlob: false,
			hasTextBlob: false,
		});
		expect(await resolvePostboxMessageBody(empty.client, 'empty')).toEqual({
			html: null,
			text: null,
		});
		expect(empty.action).not.toHaveBeenCalled();
	});

	it('fails a download that does not succeed', async () => {
		const { client } = makeClient(null, { htmlUrl: 'https://storage.example/x', textUrl: null });
		const fetchImpl = vi.fn(async () => ({ ok: false, text: async () => '' }));
		await expect(
			resolvePostboxMessageBody(client, 'bad', { fetchImpl, blobOnly: true })
		).rejects.toThrow('Could not load message body');
	});

	it('keeps a consumed body for the TTL, then drops it', async () => {
		const { client, query } = makeClient(inlineHtml('<p>kept</p>'));

		await consumeResolvedPostboxMessageBody(client, 'read-msg');
		expect(query).toHaveBeenCalledTimes(1);

		// Re-opening within the window (back, j/k past and back) is free.
		await vi.advanceTimersByTimeAsync(CONSUMED_POSTBOX_BODY_TTL_MS - 1000);
		expect(await consumeResolvedPostboxMessageBody(client, 'read-msg')).toEqual({
			html: '<p>kept</p>',
			text: null,
		});
		expect(query).toHaveBeenCalledTimes(1);

		// That second read restarted the window.
		await vi.advanceTimersByTimeAsync(CONSUMED_POSTBOX_BODY_TTL_MS - 1000);
		await resolvePostboxMessageBody(client, 'read-msg');
		expect(query).toHaveBeenCalledTimes(1);

		// Past the window the decrypted copy is gone and the next read refetches.
		await vi.advanceTimersByTimeAsync(1000);
		await resolvePostboxMessageBody(client, 'read-msg');
		expect(query).toHaveBeenCalledTimes(2);
	});

	it('drops every cached body when the scope changes, not when it repeats', async () => {
		const { client, query } = makeClient(inlineHtml('<p>a</p>'));
		setResolvedPostboxBodyScope(client, 'user-1||mailbox-a');
		await resolvePostboxMessageBody(client, 'a');

		setResolvedPostboxBodyScope(client, 'user-1||mailbox-a');
		await resolvePostboxMessageBody(client, 'a');
		expect(query).toHaveBeenCalledTimes(1);

		setResolvedPostboxBodyScope(client, 'user-1||mailbox-b');
		await resolvePostboxMessageBody(client, 'a');
		expect(query).toHaveBeenCalledTimes(2);
	});

	it('clearResolvedPostboxBodies drops consumed bodies before their TTL', async () => {
		const { client, query } = makeClient(inlineHtml('<p>a</p>'));
		await consumeResolvedPostboxMessageBody(client, 'a');
		clearResolvedPostboxBodies(client);
		await resolvePostboxMessageBody(client, 'a');
		expect(query).toHaveBeenCalledTimes(2);
	});

	it('does not retain an oversized decrypted body', async () => {
		const { client, query } = makeClient(inlineHtml('x'.repeat(512 * 1024 + 1)));
		await resolvePostboxMessageBody(client, 'oversized');
		await resolvePostboxMessageBody(client, 'oversized');
		expect(query).toHaveBeenCalledTimes(2);
	});

	it('evicts the least-recently-used bodies when the aggregate cache budget is exceeded', async () => {
		const { client, query } = makeClient(inlineHtml('x'.repeat(400 * 1024)));

		for (const messageId of ['a', 'b', 'c', 'd', 'e', 'f']) {
			await resolvePostboxMessageBody(client, messageId);
		}
		await resolvePostboxMessageBody(client, 'a');

		expect(query).toHaveBeenCalledTimes(7);
	});
});
