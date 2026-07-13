/**
 * messageBody — the sealed-at-rest decrypt shim (Sealed Mail E8b).
 *
 * NAMED TEST GATE (a): the `open*` accessors round-trip a body across ALL FIVE
 * storage shapes, for both a SEALED row and a LEGACY-PLAINTEXT row:
 *   1. inboundMessages inline    -> openInboundMessageBody
 *   2. mailMessages inline       -> openMailMessageInlineBody
 *   3. mailMessages storage blob -> readMailMessageText
 *   4. unifiedMessages.content   -> openUnifiedMessageContent
 *   5. conversationThreads preview -> openConversationThreadPreview
 * The sync accessors E8a introduced still describe the raw row; these async
 * siblings are the ONE place that unseals.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	openInboundMessageBody,
	openConversationThreadPreview,
	openMailMessageInlineBody,
	openUnifiedMessageContent,
	readMailMessageText,
	sealMessageBody,
	sealUnifiedMessageContentAtWrite,
	UNIFIED_MESSAGE_STORAGE_VERSION_SEALED,
	type BodyBlobStorageReader,
} from '../messageBody';
import { sealBytesAtRest } from '../atRestBodies';
import type { Id } from '../../_generated/dataModel';

const SECRET = 'unit-test-instance-secret-value';

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
});

/** A storage stub that returns a single blob (from a string or raw bytes) for a
 * known id. Storage blobs are sealed with the BYTE cipher, so a sealed blob is
 * stored as its raw sealed bytes here. */
function storageWith(id: string, content: string | Uint8Array): BodyBlobStorageReader {
	return {
		get(storageId: Id<'_storage'>): Promise<Blob | null> {
			if (String(storageId) !== id) return Promise.resolve(null);
			return Promise.resolve(
				new Blob([typeof content === 'string' ? content : (content as unknown as BlobPart)])
			);
		},
	};
}

describe('messageBody open* accessors — sealed rows round-trip', () => {
	it('shape 1: inboundMessages inline text/html', async () => {
		const text = 'inbound text body';
		const html = '<p>inbound html body</p>';
		const row = {
			textBody: await sealMessageBody(text),
			htmlBody: await sealMessageBody(html),
		};
		const body = await openInboundMessageBody(row);
		expect(body.text).toBe(text);
		expect(body.html).toBe(html);
	});

	it('shape 2: mailMessages inline snippet', async () => {
		const text = 'mail inline text';
		const row = {
			textBodyInline: await sealMessageBody(text),
			htmlBodyInline: await sealMessageBody('<b>x</b>'),
		};
		const body = await openMailMessageInlineBody(row);
		expect(body.text).toBe(text);
		expect(body.html).toBe('<b>x</b>');
	});

	it('shape 3: mailMessages storage blob (byte cipher)', async () => {
		const text = 'the full sealed body from the blob';
		const sealedBytes = await sealBytesAtRest(SECRET, new TextEncoder().encode(text));
		const storageId = 'blob-1' as unknown as Id<'_storage'>;
		const resolved = await readMailMessageText(storageWith('blob-1', sealedBytes), {
			textBodyStorageId: storageId,
		});
		expect(resolved).toBe(text);
	});

	it('shape 4: unifiedMessages.content JSON', async () => {
		const content = JSON.stringify({ text: 'unified text', subject: 'Hi' });
		const sealed = await sealMessageBody(content);
		const parsed = await openUnifiedMessageContent(sealed);
		expect(parsed.text).toBe('unified text');
		expect(parsed.subject).toBe('Hi');
	});

	it('versions unified content schema separately from its sealed storage encoding', async () => {
		const versioned = await sealUnifiedMessageContentAtWrite(JSON.stringify({ text: 'private' }));
		expect(versioned.contentVersion).toBe(1);
		expect(versioned.contentStorageVersion).toBe(UNIFIED_MESSAGE_STORAGE_VERSION_SEALED);
		expect(versioned.content).not.toContain('private');
	});

	it('shape 5: conversationThreads.lastPreview', async () => {
		const row = {
			_id: 'thread-1',
			lastPreview: await sealMessageBody('private preview'),
		};
		const opened = await openConversationThreadPreview(row);
		expect(opened.lastPreview).toBe('private preview');
	});
});

describe('messageBody open* accessors — legacy plaintext rows pass through', () => {
	it('shape 1: unsealed inbound row', async () => {
		const body = await openInboundMessageBody({ textBody: 'plain', htmlBody: '<p>plain</p>' });
		expect(body.text).toBe('plain');
		expect(body.html).toBe('<p>plain</p>');
	});

	it('shape 2: unsealed mail inline row', async () => {
		const body = await openMailMessageInlineBody({ textBodyInline: 'plain inline' });
		expect(body.text).toBe('plain inline');
		expect(body.html).toBeUndefined();
	});

	it('shape 3: unsealed mail blob', async () => {
		const storageId = 'blob-2' as unknown as Id<'_storage'>;
		const resolved = await readMailMessageText(storageWith('blob-2', 'plain blob body'), {
			textBodyStorageId: storageId,
		});
		expect(resolved).toBe('plain blob body');
	});

	it('shape 4: unsealed unified content', async () => {
		const parsed = await openUnifiedMessageContent(JSON.stringify({ text: 'plain unified' }));
		expect(parsed.text).toBe('plain unified');
	});

	it('shape 5: unsealed conversation preview', async () => {
		const opened = await openConversationThreadPreview({ lastPreview: 'plain preview' });
		expect(opened.lastPreview).toBe('plain preview');
	});

	it('absent fields collapse to undefined', async () => {
		const body = await openInboundMessageBody({});
		expect(body.text).toBeUndefined();
		expect(body.html).toBeUndefined();
	});
});
