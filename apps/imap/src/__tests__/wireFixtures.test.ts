/**
 * The IMAP server reads the frozen wire fixtures through its shipped client.
 *
 * Every fixture in `@owlat/worker-protocol/wireFixtures` is a recorded answer
 * of the real handler (apps/api `mail/__tests__/workerWireImap.test.ts` pins
 * that). Here each one goes through `checkedConvexClient`, the client
 * `createConvexClient` ships, and must come back unchanged; then the commands'
 * own readers (FETCH formatting, the folder tree, the membership walk, the
 * wire handshake) are run on them. A contract change that the backend makes and
 * this server cannot read fails here.
 */

import { IMAP_WIRE_MIN_SUPPORTED, IMAP_WIRE_VERSION } from '@owlat/shared/imapWire';
import { IMAP_ENDPOINTS } from '@owlat/worker-protocol/imap';
import { isWireContractError, type ConvexTransport } from '@owlat/worker-protocol/client';
import {
	IMAP_FIXTURE_ENVELOPE_1,
	IMAP_FIXTURE_ENVELOPE_2,
	IMAP_WIRE_FIXTURES,
	type WireFixtureCase,
} from '@owlat/worker-protocol/wireFixtures';
import type { EndpointReturns } from '@owlat/worker-protocol';
import { getFunctionName } from 'convex/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkedConvexClient, fn, type ConvexClient } from '../convex.js';
import { formatEnvelope, formatFlags } from '../commands/fetch/format.js';
import { buildFolderTree } from '../commands/helpers/folderTree.js';
import { forgetCachedMemberships, loadCurrentUids } from '../commands/helpers/membership.js';
import { classifyWireReport } from '../wireHandshake.js';

type Endpoint = keyof typeof IMAP_ENDPOINTS;

/** A transport that answers every call with `answer`, as the wire carries it. */
function answering(answer: unknown): ConvexTransport {
	const respond = async () => (answer === undefined ? undefined : structuredClone(answer));
	return { query: respond, mutation: respond, action: respond };
}

async function readThroughClient(key: Endpoint, value: unknown): Promise<unknown> {
	const client = checkedConvexClient(answering(value));
	const ref = fn[key] as never;
	const kind = IMAP_ENDPOINTS[key].kind;
	return kind === 'query'
		? await client.query(ref, {} as never)
		: kind === 'mutation'
			? await client.mutation(ref, {} as never)
			: await client.action(ref, {} as never);
}

/** The value of one named fixture case, typed as what the endpoint returns. */
function fixture<K extends Endpoint>(
	key: K,
	name: string
): EndpointReturns<(typeof IMAP_ENDPOINTS)[K]> {
	const cases: readonly WireFixtureCase<unknown>[] = IMAP_WIRE_FIXTURES[key];
	const found = cases.find((c) => c.name === name);
	if (!found) throw new Error(`no ${key} fixture named ${name}`);
	return found.value as EndpointReturns<(typeof IMAP_ENDPOINTS)[K]>;
}

describe('every IMAP wire fixture reads back through the shipped client', () => {
	for (const key of Object.keys(IMAP_ENDPOINTS) as Endpoint[]) {
		for (const { name, value } of IMAP_WIRE_FIXTURES[key]) {
			it(`${key}: ${name}`, async () => {
				await expect(readThroughClient(key, value)).resolves.toEqual(value);
			});
		}
	}

	it('refuses an envelope page missing a field the formatter reads', async () => {
		const { uid: _dropped, ...withoutUid } = IMAP_FIXTURE_ENVELOPE_1;
		await expect(
			readThroughClient('fetchEnvelopes', { rows: [withoutUid], nextUid: null })
		).rejects.toSatisfy(isWireContractError);
	});

	it('refuses a membership page whose arm does not hold together', async () => {
		await expect(
			readThroughClient('folderMembershipPage', { version: 'v', isReady: true, blocks: [[1]] })
		).rejects.toSatisfy(isWireContractError);
	});

	it('reads an answer carrying a field a newer backend added', async () => {
		const value = { ...fixture('peekFolderModseq', 'counters'), recentCount: 3 };
		await expect(readThroughClient('peekFolderModseq', value)).resolves.toEqual(value);
	});
});

describe('the commands read the fixtures', () => {
	it('FETCH formats both envelopes', () => {
		expect(formatFlags(IMAP_FIXTURE_ENVELOPE_1)).toBe('\\Seen \\Flagged $Label1');
		expect(formatFlags(IMAP_FIXTURE_ENVELOPE_2)).toBe('\\Deleted');
		const envelope = formatEnvelope(IMAP_FIXTURE_ENVELOPE_1);
		expect(envelope).toContain('"Quarterly numbers"');
		expect(envelope).toContain('"ada" "example.com"');
		expect(envelope).toContain('<quarterly-1@example.com>');
		expect(formatEnvelope(IMAP_FIXTURE_ENVELOPE_2)).toContain('"Invoice reminder"');
	});

	it('LIST builds the folder tree from the folder rows', () => {
		const tree = buildFolderTree(fixture('listFolders', 'system and user folders'));
		expect(tree.map((folder) => folder.path)).toEqual(['INBOX', 'Sent', 'INBOX/Receipts']);
		expect(tree.find((folder) => folder.path === 'INBOX')?.hasChildren).toBe(true);
	});

	it('the wire handshake classifies each report it was recorded for', () => {
		expect(
			classifyWireReport({ result: fixture('reportServer', 'current') }, IMAP_WIRE_VERSION)
		).toEqual({ kind: 'compatible', backendWireVersion: IMAP_WIRE_VERSION });
		expect(
			classifyWireReport(
				{ result: fixture('reportServer', 'server too old') },
				IMAP_WIRE_MIN_SUPPORTED - 1
			)
		).toMatchObject({ kind: 'tooOld', reason: 'server_too_old' });
		expect(
			classifyWireReport(
				{ result: fixture('reportServer', 'backend older') },
				IMAP_WIRE_VERSION + 1
			)
		).toEqual({ kind: 'backendOlder', backendWireVersion: IMAP_WIRE_VERSION });
	});

	describe('the membership walk', () => {
		beforeEach(() => forgetCachedMemberships());

		/** The checked client answering `folderMembershipPage` with the fixture for its arguments. */
		function membershipClient(): { client: ConvexClient; calls: Array<Record<string, unknown>> } {
			const calls: Array<Record<string, unknown>> = [];
			const query = vi.fn(
				async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
					expect(getFunctionName(ref)).toBe(IMAP_ENDPOINTS.folderMembershipPage.path);
					calls.push(args);
					return structuredClone(
						args['knownVersion'] === undefined
							? fixture('folderMembershipPage', 'blocks')
							: fixture('folderMembershipPage', 'unchanged')
					);
				}
			);
			const transport = { query, mutation: query, action: query } as unknown as ConvexTransport;
			return { client: checkedConvexClient(transport), calls };
		}

		it('reads the blocks, then serves the unchanged answer from its cache', async () => {
			const { client, calls } = membershipClient();
			await expect(loadCurrentUids(client, 'folder-inbox')).resolves.toEqual([1, 2]);
			await expect(loadCurrentUids(client, 'folder-inbox')).resolves.toEqual([1, 2]);
			expect(calls).toEqual([
				{ folderId: 'folder-inbox' },
				{
					folderId: 'folder-inbox',
					knownVersion: fixture('folderMembershipPage', 'blocks')!.version,
				},
			]);
		});
	});
});
