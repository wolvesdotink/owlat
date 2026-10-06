import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import type { Id } from '@owlat/api/dataModel';
import { binaryStringToBytes, bytesToBinaryString } from '@owlat/shared/mailMime';
import {
	MBOX_DOWNLOAD_KIND,
	openIncrementalDownload,
	type ByteChunkSink,
} from '../incrementalJsonDownload';
import { mboxExportFilename, writeMailboxMboxExport } from '../mboxExport';

const MAILBOX_ID = 'mailbox_1' as Id<'mailboxes'>;

/** The archive as bytes, read back one char per byte. */
function joined(chunks: Uint8Array[]): string {
	return chunks.map((chunk) => bytesToBinaryString(chunk)).join('');
}

function recordingSink() {
	const chunks: Uint8Array[] = [];
	const state = { closed: false, abortedWith: undefined as unknown };
	const sink: ByteChunkSink = {
		write: async (chunk) => {
			chunks.push(chunk);
		},
		close: async () => {
			state.closed = true;
		},
		abort: async (reason) => {
			state.abortedWith = reason;
		},
	};
	return { chunks, state, sink };
}

/** A paged export server: `pages` is what each successive call returns. */
function clientOverPages(
	pages: Array<{
		messages: Array<{ url: string; fromAddress: string; receivedAt: number }>;
		continueCursor: string;
		isDone: boolean;
	}>
) {
	const action = vi.fn(async (_reference: unknown, untypedArgs: unknown) => {
		const args = untypedArgs as { cursor?: string };
		const index = args.cursor ? Number(args.cursor) : 0;
		return pages[index];
	});
	return { action, client: { action } as unknown as ConvexClient };
}

/** Serve each URL's body; a string body is a binary string (one char per byte). */
function stubFetch(bodies: Record<string, string | Uint8Array>) {
	const fetchMock = vi.fn(async (url: string) => {
		const body = bodies[url];
		if (body === undefined) return { ok: false } as unknown as Response;
		const bytes = typeof body === 'string' ? binaryStringToBytes(body) : body.slice();
		return {
			ok: true,
			arrayBuffer: async () => bytes.buffer,
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('mboxExportFilename', () => {
	it('dates the archive so repeated exports do not collide', () => {
		expect(mboxExportFilename(new Date('2026-08-28T10:00:00Z'))).toBe('owlat-mail-2026-08-28.mbox');
	});
});

describe('writeMailboxMboxExport', () => {
	it('writes every message of every page as one mbox archive', async () => {
		const { client, action } = clientOverPages([
			{
				messages: [
					{ url: 'https://x/1', fromAddress: 'a@example.com', receivedAt: Date.UTC(2021, 0, 1) },
					{ url: 'https://x/2', fromAddress: 'b@example.com', receivedAt: Date.UTC(2021, 0, 2) },
				],
				continueCursor: '1',
				isDone: false,
			},
			{
				messages: [
					{ url: 'https://x/3', fromAddress: 'c@example.com', receivedAt: Date.UTC(2021, 0, 3) },
				],
				continueCursor: '',
				isDone: true,
			},
		]);
		stubFetch({
			'https://x/1': 'Subject: One\n\nbody one\n',
			'https://x/2': 'Subject: Two\n\nbody two\n',
			'https://x/3': 'Subject: Three\n\nbody three\n',
		});
		const { chunks, state, sink } = recordingSink();

		expect(await writeMailboxMboxExport(client, MAILBOX_ID, sink)).toBe(3);

		const archive = joined(chunks);
		expect(archive.startsWith('From a@example.com Fri Jan  1 00:00:00 2021\n')).toBe(true);
		expect(archive).toContain('From b@example.com Sat Jan  2 00:00:00 2021\n');
		expect(archive).toContain('Subject: Three\n');
		expect(state.closed).toBe(true);
		expect(action).toHaveBeenCalledTimes(2);
	});

	it('reports progress per message rather than per page', async () => {
		const { client } = clientOverPages([
			{
				messages: [
					{ url: 'https://x/1', fromAddress: 'a@example.com', receivedAt: 0 },
					{ url: 'https://x/2', fromAddress: 'b@example.com', receivedAt: 0 },
				],
				continueCursor: '',
				isDone: true,
			},
		]);
		stubFetch({ 'https://x/1': 'Subject: One\n\n', 'https://x/2': 'Subject: Two\n\n' });
		const { sink } = recordingSink();
		const seen: number[] = [];

		await writeMailboxMboxExport(client, MAILBOX_ID, sink, ({ messages }) => seen.push(messages));

		expect(seen).toEqual([1, 2]);
	});

	it('quotes a body line that would otherwise read as a separator', async () => {
		const { client } = clientOverPages([
			{
				messages: [{ url: 'https://x/1', fromAddress: 'a@example.com', receivedAt: 0 }],
				continueCursor: '',
				isDone: true,
			},
		]);
		stubFetch({ 'https://x/1': 'Subject: Trap\n\nFrom Monday we ship.\n' });
		const { chunks, sink } = recordingSink();

		await writeMailboxMboxExport(client, MAILBOX_ID, sink);

		expect(joined(chunks)).toContain('\n>From Monday we ship.\n');
	});

	it('aborts the destination when a message cannot be downloaded', async () => {
		const { client } = clientOverPages([
			{
				messages: [{ url: 'https://x/missing', fromAddress: 'a@example.com', receivedAt: 0 }],
				continueCursor: '',
				isDone: true,
			},
		]);
		stubFetch({});
		const { state, sink } = recordingSink();

		await expect(writeMailboxMboxExport(client, MAILBOX_ID, sink)).rejects.toThrow(
			'Could not download a message'
		);
		expect(state.closed).toBe(false);
		expect(state.abortedWith).toBeInstanceOf(Error);
	});

	it('refuses to loop on a cursor that does not advance', async () => {
		const action = vi.fn(async () => ({
			messages: [],
			continueCursor: 'same',
			isDone: false,
		}));
		const client = { action } as unknown as ConvexClient;
		const { sink } = recordingSink();

		await expect(writeMailboxMboxExport(client, MAILBOX_ID, sink)).rejects.toThrow(
			'pagination did not advance'
		);
	});

	it('writes 8-bit message bytes to the file unchanged, not as UTF-8 text (#1280)', async () => {
		const { client } = clientOverPages([
			{
				messages: [{ url: 'https://x/1', fromAddress: 'a@example.com', receivedAt: 0 }],
				continueCursor: '',
				isDone: true,
			},
		]);
		// An 8-bit UTF-8 body (é, an em dash, curly quotes, €) and a binary part
		// with bytes 0x80-0x9F: written as a string, the file stream would encode
		// every byte at or above 0x80 as two or three.
		const encoder = new TextEncoder();
		const message = Uint8Array.from([
			...encoder.encode('Subject: Café\nContent-Transfer-Encoding: 8bit\n\n'),
			...encoder.encode('Price — “quoted” 5€\n'),
			0x00,
			0x41,
			0x80,
			0x99,
			0x9f,
			0xa0,
			0xff,
			0x0a,
		]);
		stubFetch({ 'https://x/1': message });
		// The real destination: the save picker's file stream, which writes a
		// string chunk as UTF-8 and a byte chunk as it is.
		const file: number[] = [];
		vi.stubGlobal('window', {
			showSaveFilePicker: vi.fn(async () => ({
				createWritable: vi.fn(async () => ({
					write: vi.fn(async (chunk: string | Uint8Array) => {
						file.push(...(typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
					}),
					close: vi.fn(async () => undefined),
					abort: vi.fn(async () => undefined),
				})),
			})),
		});
		const sink = await openIncrementalDownload('mail.mbox', MBOX_DOWNLOAD_KIND);

		await writeMailboxMboxExport(client, MAILBOX_ID, sink);

		const fromLine = encoder.encode('From a@example.com Thu Jan  1 00:00:00 1970\n');
		expect(file).toEqual([...fromLine, ...message, 0x0a]);
	});
});
