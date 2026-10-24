/**
 * The checked client: what a worker reads from Convex has passed the contract.
 *
 * Pinned here: a call outside the contract is refused before anything is sent;
 * an answer is checked against `accepts`, missing fields, wrong nested types and
 * bad discriminants failing while a field a newer backend added passes; the
 * failure says the call has run and never repeats a value it was handed.
 */

import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import { defineEndpoint } from '../contract';
import {
	createCheckedClient,
	isWireContractError,
	WireContractError,
	workerReferences,
	type ConvexTransport,
} from '../client';
import { IMAP_ENDPOINTS } from '../imap/index';
import { MAIL_SYNC_ENDPOINTS } from '../mailSync/index';

const REGISTRY = {
	credentials: defineEndpoint({
		path: 'test/secrets:credentials',
		kind: 'action',
		args: { accountId: v.string() },
		returns: v.union(
			v.object({ kind: v.literal('credentials'), password: v.string(), port: v.number() }),
			v.object({ kind: v.literal('unavailable') })
		),
	}),
	counters: defineEndpoint({
		path: 'test/folders:counters',
		kind: 'query',
		args: { folderId: v.id('mailFolders') },
		returns: v.union(
			v.null(),
			v.object({ total: v.number(), rows: v.array(v.object({ uid: v.number() })) })
		),
	}),
	touch: defineEndpoint({
		path: 'test/folders:touch',
		kind: 'mutation',
		args: {},
		returns: v.null(),
	}),
};

const fn = workerReferences(REGISTRY);

function transportAnswering(answer: unknown) {
	const respond = vi.fn(async () => answer);
	const transport: ConvexTransport = { query: respond, mutation: respond, action: respond };
	return { transport, respond };
}

describe('references', () => {
	it('carry each endpoint’s path under the registry’s own name', () => {
		const refs = workerReferences(IMAP_ENDPOINTS);
		expect(Object.keys(refs).sort()).toEqual(Object.keys(IMAP_ENDPOINTS).sort());
	});

	it('the two worker registries name 47 distinct functions', () => {
		const paths = [...Object.values(IMAP_ENDPOINTS), ...Object.values(MAIL_SYNC_ENDPOINTS)].map(
			(endpoint) => endpoint.path
		);
		expect(Object.keys(IMAP_ENDPOINTS)).toHaveLength(20);
		expect(Object.keys(MAIL_SYNC_ENDPOINTS)).toHaveLength(27);
		expect(new Set(paths).size).toBe(47);
	});
});

describe('before sending', () => {
	it('refuses a function the registry does not name, without calling the transport', async () => {
		const { transport, respond } = transportAnswering(null);
		const client = createCheckedClient(transport, REGISTRY);
		const stray = makeFunctionReference<'mutation', Record<string, never>, null>(
			'test/other:stray'
		);
		const call = client.mutation(stray, {});
		await expect(call).rejects.toBeInstanceOf(WireContractError);
		await expect(call).rejects.toMatchObject({ hasRun: false, path: 'test/other:stray' });
		expect(respond).not.toHaveBeenCalled();
	});

	it('refuses a call of the wrong kind, without calling the transport', async () => {
		const { transport, respond } = transportAnswering(null);
		const client = createCheckedClient(transport, REGISTRY);
		const asQuery = makeFunctionReference<'query', Record<string, never>, null>(
			'test/folders:touch'
		);
		await expect(client.query(asQuery, {})).rejects.toMatchObject({
			hasRun: false,
			mismatch: 'declared as a mutation',
		});
		expect(respond).not.toHaveBeenCalled();
	});

	it('refuses a registry that names one function twice', () => {
		const { transport } = transportAnswering(null);
		expect(() => createCheckedClient(transport, { a: REGISTRY.touch, b: REGISTRY.touch })).toThrow(
			/names test\/folders:touch twice/
		);
	});
});

describe('after the answer', () => {
	it('hands back an answer that fits, unchanged', async () => {
		const answer = { total: 2, rows: [{ uid: 1 }, { uid: 2 }] };
		const client = createCheckedClient(transportAnswering(answer).transport, REGISTRY);
		await expect(client.query(fn.counters, { folderId: 'folder-1' })).resolves.toBe(answer);
	});

	it('accepts null where the contract says null', async () => {
		const client = createCheckedClient(transportAnswering(null).transport, REGISTRY);
		await expect(client.query(fn.counters, { folderId: 'folder-1' })).resolves.toBeNull();
		await expect(client.mutation(fn.touch, {})).resolves.toBeNull();
	});

	it('lets through a field a newer backend added, at any depth', async () => {
		const answer = { total: 1, addedLater: 'x', rows: [{ uid: 1, alsoLater: true }] };
		const client = createCheckedClient(transportAnswering(answer).transport, REGISTRY);
		await expect(client.query(fn.counters, { folderId: 'folder-1' })).resolves.toEqual(answer);
	});

	it.each([
		['a missing field', { rows: [] }, '$: matches no member of the union'],
		[
			'a wrong nested type',
			{ total: 1, rows: [{ uid: '1' }] },
			'$: matches no member of the union',
		],
		['an array for an object', [], '$: matches no member of the union'],
		['undefined for null', undefined, '$: matches no member of the union'],
	])('rejects %s', async (_case, answer, mismatch) => {
		const client = createCheckedClient(transportAnswering(answer).transport, REGISTRY);
		await expect(client.query(fn.counters, { folderId: 'folder-1' })).rejects.toMatchObject({
			name: 'WireContractError',
			hasRun: true,
			mismatch,
		});
	});

	it('rejects a discriminant it does not know', async () => {
		const client = createCheckedClient(transportAnswering({ kind: 'revoked' }).transport, REGISTRY);
		await expect(client.action(fn.credentials, { accountId: 'a' })).rejects.toSatisfy(
			isWireContractError
		);
	});

	it('says the call ran, and never repeats a credential it was handed', async () => {
		const secret = 'correct-horse-battery-staple';
		const client = createCheckedClient(
			transportAnswering({ kind: 'credentials', password: secret, port: '993' }).transport,
			REGISTRY
		);
		const error = await client.action(fn.credentials, { accountId: 'a' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WireContractError);
		const message = (error as Error).message;
		expect(message).toMatch(/action test\/secrets:credentials answered outside its wire contract/);
		expect(message).toMatch(/has run and is not retried/);
		expect(message).not.toContain(secret);
		expect(JSON.stringify(error)).not.toContain(secret);
	});
});
