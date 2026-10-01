/**
 * `FETCH … BODY[]` batches its round trips (plan 3.6): one \Seen write and one
 * URL mint per chunk of messages, downloads in parallel, responses still in
 * sequence order. A desktop client's first sync asks for thousands of bodies,
 * and it used to pay four serial round trips for each.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { fetchModule, type FetchArgs } from '../index.js';
import type { FetchEnvelope } from '../format.js';
import type { CommandDeps, ConnectionState, StartArgs } from '../../types.js';
import { forEachOrdered, RAW_DOWNLOAD_CONCURRENCY, RAW_URL_BATCH } from '../rawBodies.js';

// convex/server declares AnyFunctionReference without exporting it.
type AnyFunctionReference = Parameters<typeof getFunctionName>[0];

function envelope(uid: number, overrides: Partial<FetchEnvelope> = {}): FetchEnvelope {
	return {
		_id: `m-${uid}`,
		uid,
		modseq: 1,
		rawSize: 10,
		rfc822MessageId: `mid-${uid}@owlat.test`,
		fromAddress: 'jane@owlat.test',
		toAddresses: ['bob@owlat.test'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Hi',
		internalDate: Date.UTC(2026, 5, 9, 10, 30, 5),
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		flagDeleted: false,
		customFlags: [],
		...overrides,
	};
}

const raw = (uid: number) => Buffer.from(`Subject: ${uid}\r\n\r\nbody ${uid}`, 'utf8');

function harness(envelopes: FetchEnvelope[], opts: { mintFails?: boolean } = {}) {
	const lines: string[] = [];
	let inFlight = 0;
	let peak = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			const uid = Number(new URL(url).searchParams.get('uid'));
			inFlight++;
			peak = Math.max(peak, inFlight);
			// Later messages finish first, so ordering has to be enforced.
			await new Promise((resolve) => setTimeout(resolve, (100 - (uid % 100)) / 20));
			inFlight--;
			const bytes = raw(uid);
			return {
				ok: true,
				arrayBuffer: async () =>
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			};
		})
	);
	const convex = {
		query: vi.fn(async (fnRef: AnyFunctionReference) => {
			const ref = getFunctionName(fnRef);
			if (ref.endsWith(':folderMembershipPage')) return null;
			if (ref.endsWith(':listFolderUidsPage')) {
				return { uids: envelopes.map((m) => m.uid), nextUid: null };
			}
			if (ref.endsWith(':fetchEnvelopes')) return { rows: envelopes, nextUid: null };
			return null;
		}),
		action: vi.fn(async (fnRef: AnyFunctionReference, params: { messageIds: string[] }) => {
			if (!getFunctionName(fnRef).endsWith(':getRawStorageUrls')) return null;
			if (opts.mintFails) throw new Error('backend unavailable');
			return params.messageIds.map((messageId) => ({
				messageId,
				url: `https://storage.test/raw?uid=${messageId.slice(2)}`,
			}));
		}),
		mutation: vi.fn(async (_fnRef: AnyFunctionReference, params: { messageIds: string[] }) => ({
			updated: params.messageIds.map((messageId) => ({
				messageId,
				uid: Number(messageId.slice(2)),
				modseq: 2,
				flags: ['\\Seen'],
			})),
			unchanged: [],
		})),
	};
	const state: ConnectionState = {
		auth: { mailboxId: 'mb1', appPasswordId: 'ap1', address: 'a@test', userId: 'u1' },
		selected: {
			folderId: 'f1',
			folderName: 'INBOX',
			uidValidity: 1,
			uidNext: 1000,
			highestModseq: 1,
			totalCount: envelopes.length,
			readOnly: false,
		},
		clientId: null,
	};
	const run = async (set: string, itemsToken: string) => {
		const startArgs: StartArgs<FetchArgs> = {
			deps: { convex } as unknown as CommandDeps,
			state,
			args: { set, itemsToken, byUid: false },
			tag: 'a001',
			verb: 'FETCH',
			send: (line: string | Buffer) =>
				lines.push(typeof line === 'string' ? line : line.toString('latin1')),
		};
		await fetchModule.start(startArgs).completion;
	};
	return { lines, convex, run, peak: () => peak };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('FETCH BODY[] batching', () => {
	const COUNT = RAW_URL_BATCH + 10;
	const envelopes = Array.from({ length: COUNT }, (_, i) =>
		// Every third message is already seen, so it needs no \Seen write.
		envelope(i + 1, { flagSeen: i % 3 === 0 })
	);

	it('mints URLs and writes \\Seen once per chunk, not per message', async () => {
		const h = harness(envelopes);
		await h.run(`1:${COUNT}`, '(UID FLAGS BODY[])');

		expect(h.convex.action).toHaveBeenCalledTimes(2);
		expect(h.convex.mutation).toHaveBeenCalledTimes(2);
		const [first, second] = h.convex.mutation.mock.calls.map(
			(call) => (call[1] as { messageIds: string[] }).messageIds
		);
		expect(first).toEqual(
			envelopes
				.slice(0, RAW_URL_BATCH)
				.filter((m) => !m.flagSeen)
				.map((m) => m._id)
		);
		expect(second).toEqual(
			envelopes
				.slice(RAW_URL_BATCH)
				.filter((m) => !m.flagSeen)
				.map((m) => m._id)
		);
		// No per-message storage-id lookups any more.
		expect(h.convex.query.mock.calls.map((c) => getFunctionName(c[0]))).not.toContainEqual(
			expect.stringContaining('fetchRawStorageId')
		);
	});

	it('downloads in parallel but answers in sequence order with each body', async () => {
		const h = harness(envelopes);
		await h.run(`1:${COUNT}`, '(UID FLAGS BODY[])');

		const fetchLines = h.lines.filter((l) => l.startsWith('* '));
		expect(fetchLines).toHaveLength(COUNT);
		for (const [i, line] of fetchLines.entries()) {
			const uid = i + 1;
			expect(line.startsWith(`* ${uid} FETCH (UID ${uid} FLAGS (\\Seen) BODY[] {`)).toBe(true);
			expect(line).toContain(raw(uid).toString('latin1'));
		}
		expect(h.lines.at(-1)).toBe('a001 OK FETCH completed');
		expect(h.peak()).toBeGreaterThan(1);
		expect(h.peak()).toBeLessThanOrEqual(RAW_DOWNLOAD_CONCURRENCY);
	});

	it('drops the body fields, not the command, when the URL mint fails', async () => {
		const h = harness(envelopes.slice(0, 3), { mintFails: true });
		await h.run('1:3', '(UID BODY.PEEK[])');

		expect(h.lines).toEqual([
			'* 1 FETCH (UID 1)',
			'* 2 FETCH (UID 2)',
			'* 3 FETCH (UID 3)',
			'a001 OK FETCH completed',
		]);
		expect(h.convex.mutation).not.toHaveBeenCalled();
	});

	it('makes no body round trips for a FETCH without body sections', async () => {
		const h = harness(envelopes);
		await h.run(`1:${COUNT}`, '(UID FLAGS)');
		expect(h.convex.action).not.toHaveBeenCalled();
		expect(h.convex.mutation).not.toHaveBeenCalled();
	});
});

describe('forEachOrdered', () => {
	it('keeps at most `concurrency` results pending and emits in input order', async () => {
		let running = 0;
		let peak = 0;
		const emitted: number[] = [];
		await forEachOrdered(
			[5, 1, 4, 2, 3],
			2,
			async (n) => {
				running++;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, n));
				running--;
				return n * 10;
			},
			(n, result) => {
				emitted.push(result + n);
			}
		);
		expect(emitted).toEqual([55, 11, 44, 22, 33]);
		expect(peak).toBe(2);
	});
});
