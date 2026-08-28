import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import type { Id } from '@owlat/api/dataModel';
import type { TextChunkSink } from '../incrementalJsonSerializer';
import { mboxExportFilename, writeMailboxMboxExport } from '../mboxExport';

const MAILBOX_ID = 'mailbox_1' as Id<'mailboxes'>;

function recordingSink() {
	const chunks: string[] = [];
	const state = { closed: false, abortedWith: undefined as unknown };
	const sink: TextChunkSink = {
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

function stubFetch(bodies: Record<string, string>) {
	const fetchMock = vi.fn(async (url: string) => {
		const body = bodies[url];
		if (body === undefined) return { ok: false } as unknown as Response;
		const bytes = Uint8Array.from(body, (char) => char.charCodeAt(0) & 0xff);
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

		const archive = chunks.join('');
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

		expect(chunks.join('')).toContain('\n>From Monday we ship.\n');
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

	it('preserves the message bytes rather than re-encoding them as UTF-8', async () => {
		const { client } = clientOverPages([
			{
				messages: [{ url: 'https://x/1', fromAddress: 'a@example.com', receivedAt: 0 }],
				continueCursor: '',
				isDone: true,
			},
		]);
		// A latin1 byte that is not valid UTF-8 on its own: a lossy decode would
		// replace it and the archive would no longer be the original message.
		const raw = 'Subject: Café\n\nbody\n';
		stubFetch({ 'https://x/1': raw });
		const { chunks, sink } = recordingSink();

		await writeMailboxMboxExport(client, MAILBOX_ID, sink);

		expect(chunks.join('')).toContain(raw);
	});
});
