/**
 * The mail-sync worker reads the frozen wire fixtures through its shipped client.
 *
 * Every fixture in `@owlat/worker-protocol/wireFixtures` is a recorded answer
 * of the real handler (apps/api `mail/__tests__/workerWireMailSync.test.ts`
 * pins that). Here each one goes through `checkedConvexClient`, the client
 * `createConvexClient` ships, and must come back unchanged; then the worker's
 * own readers (the credential mapping, the seed sweep, the reconcile decision)
 * run on them. The legacy answers an older backend still gives are read too.
 */

import { MAIL_SYNC_ENDPOINTS } from '@owlat/worker-protocol/mailSync';
import { isWireContractError, type ConvexTransport } from '@owlat/worker-protocol/client';
import {
	MAIL_SYNC_FIXTURE_CREDENTIALS,
	MAIL_SYNC_LEGACY_WIRE_FIXTURES,
	MAIL_SYNC_WIRE_FIXTURES,
	type WireFixtureCase,
} from '@owlat/worker-protocol/wireFixtures';
import type { EndpointReturns } from '@owlat/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { checkedConvexClient, fetchWorkerCredentials, fn } from '../convex.js';
import { decide } from '../remoteState.js';
import { runSeedProbeSweep, type SeedProbeDeps } from '../seedProbes.js';

type Endpoint = keyof typeof MAIL_SYNC_ENDPOINTS;

/** A transport that answers every call with `answer`, as the wire carries it. */
function answering(answer: unknown): ConvexTransport {
	const respond = async () => structuredClone(answer);
	return { query: respond, mutation: respond, action: respond };
}

async function readThroughClient(key: Endpoint, value: unknown): Promise<unknown> {
	const client = checkedConvexClient(answering(value));
	const ref = fn[key] as never;
	const kind = MAIL_SYNC_ENDPOINTS[key].kind;
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
): EndpointReturns<(typeof MAIL_SYNC_ENDPOINTS)[K]> {
	const cases: readonly WireFixtureCase<unknown>[] = MAIL_SYNC_WIRE_FIXTURES[key];
	const found = cases.find((c) => c.name === name);
	if (!found) throw new Error(`no ${key} fixture named ${name}`);
	return found.value as EndpointReturns<(typeof MAIL_SYNC_ENDPOINTS)[K]>;
}

const currentCases = (Object.keys(MAIL_SYNC_ENDPOINTS) as Endpoint[]).flatMap((key) =>
	MAIL_SYNC_WIRE_FIXTURES[key].map(({ name, value }) => ({ title: `${key}: ${name}`, key, value }))
);

const legacyCases = Object.entries(MAIL_SYNC_LEGACY_WIRE_FIXTURES).flatMap(([key, cases]) =>
	cases.map(({ name, value }) => ({
		title: `${key}: ${name} (an older backend)`,
		key: key as Endpoint,
		value,
	}))
);

describe('every mail-sync wire fixture reads back through the shipped client', () => {
	it.each(currentCases)('$title', async ({ key, value }) => {
		await expect(readThroughClient(key, value)).resolves.toEqual(value);
	});

	it.each(legacyCases)('$title', async ({ key, value }) => {
		await expect(readThroughClient(key, value)).resolves.toEqual(value);
	});

	it('refuses an ingest outcome it cannot tell apart', async () => {
		await expect(
			readThroughClient('ingestExternalRaw', { skipped: 'quarantined' })
		).rejects.toSatisfy(isWireContractError);
	});

	it('refuses a cursor row with a wrong nested type', async () => {
		const [inbox] = fixture('getSyncState', 'two folders');
		await expect(
			readThroughClient('getSyncState', [{ ...inbox, forwardIngestFailures: [{ uid: '118' }] }])
		).rejects.toSatisfy(isWireContractError);
	});
});

describe('fetchWorkerCredentials maps every credential answer', () => {
	const fetchFrom = (answer: unknown) =>
		fetchWorkerCredentials(checkedConvexClient(answering(answer)), 'account-1');

	it.each(MAIL_SYNC_WIRE_FIXTURES.getCredentialsForWorker.map((c) => [c.name, c.value] as const))(
		'%s passes through as the backend said it',
		async (_name, value) => {
			await expect(fetchFrom(value)).resolves.toEqual(value);
		}
	);

	it('maps the pre-OAuth bundle onto the current shape, without its absent discriminant', async () => {
		const result = await fetchFrom(MAIL_SYNC_LEGACY_WIRE_FIXTURES.getCredentialsForWorker[0].value);
		expect(result).toEqual({ kind: 'credentials', credentials: MAIL_SYNC_FIXTURE_CREDENTIALS });
		expect(result.kind === 'credentials' && 'kind' in result.credentials).toBe(false);
	});

	it('maps the pre-OAuth miss to missing', async () => {
		await expect(fetchFrom(null)).resolves.toEqual({ kind: 'unavailable', reason: 'missing' });
	});

	it('refuses a bundle whose discriminant it does not know, rather than reading it as legacy', async () => {
		await expect(
			fetchFrom({ ...MAIL_SYNC_FIXTURE_CREDENTIALS, kind: 'credentials-v2' })
		).rejects.toSatisfy(isWireContractError);
	});
});

describe('the worker reads the fixtures', () => {
	it('the seed sweep walks the work page and reports through the recorded answer', async () => {
		const client = checkedConvexClient({
			query: async () => structuredClone(fixture('listSeedProbeWork', 'one seed mailbox')),
			mutation: async () => structuredClone(fixture('recordSeedProbeClassification', 'recorded')),
			action: async () => {
				throw new Error('no action expected');
			},
		});
		const markRead = vi.fn(async () => undefined);
		const recorded: Array<{ probeId: string; folderName: string | null }> = [];
		const deps: SeedProbeDeps = {
			now: () => 1_750_000_000_000,
			random: () => 0.99,
			listWork: (now, cursor) => client.query(fn.listSeedProbeWork, { now, cursor }),
			openMailbox: async () => ({
				findProbes: async () => new Map([['probe-settled', { folderName: 'INBOX', uid: 7 }]]),
				markRead,
				linkTargets: async () => [],
				close: async () => undefined,
			}),
			recordClassification: async (input) => {
				recorded.push({ probeId: input.probeId, folderName: input.folderName });
				return await client.mutation(fn.recordSeedProbeClassification, input);
			},
			click: async () => undefined,
		};
		const outcome = await runSeedProbeSweep(deps);
		expect(outcome).toMatchObject({ accounts: 1, classified: 2, unopened: 0, cursor: null });
		expect(recorded).toEqual([
			{ probeId: 'probe-expired', folderName: null },
			{ probeId: 'probe-settled', folderName: 'INBOX' },
		]);
		// The recorded answer asks for a mark-read, and only a probe that was found can be read.
		expect(markRead).toHaveBeenCalledTimes(1);
	});

	it('the reconcile finds nothing to report when the provider agrees with the local rows', () => {
		const { page } = fixture('listLocalMessages', 'one page');
		const held = new Map(
			page
				.filter((row) => row.remoteName !== null)
				.map((row) => [row.messageId, [{ remoteName: row.remoteName!, flags: row.flags }]])
		);
		const decision = decide(page, {
			index: { get: (messageId) => held.get(messageId) },
			order: ['INBOX', 'Archive'],
			untracked: new Set(),
			untrackedFlags: new Map(),
		});
		expect(decision.observations).toEqual([]);
		expect(decision.unplaced).toEqual([]);
	});
});
