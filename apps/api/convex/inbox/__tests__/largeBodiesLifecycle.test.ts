/**
 * The storage a large Team Inbox body owns is created once and deleted with
 * its row.
 *
 * Proven here:
 *   · a redelivery stores no second row and leaves no second blob — both when
 *     the action's cheap pre-check catches it and when only the transactional
 *     check inside `receiveMessage` does (the lost race);
 *   · a `receiveMessage` that throws after the body was staged leaves no blob,
 *     and the error still reaches the MTA so it retries — and so does a
 *     storage write that fails after the first part was already stored;
 *   · contact erasure and workspace deletion delete the body blobs with the
 *     row;
 *   · the raw-file retention sweep does NOT: a stored body is the message
 *     itself, kept as long as the row, like an inline one — only the `.eml`
 *     ages out on that horizon.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type * as MessagesModule from '../messages';
import type * as SealedBlobModule from '../../lib/sealedBlob';
import { permanentlyDeleteContactWithRelations } from '../../lib/contactMutations';
import { DAY_MS } from '../../lib/constants';
import {
	MIB,
	SECRET,
	htmlOfSize,
	ingest,
	onlyRow,
	setupTest,
	storedBlobCount,
	type TestConvex,
} from './largeBodies.testlib';

const hooks = vi.hoisted(() => ({
	blindPreCheck: false,
	failReceive: false,
	/** Throw from this `storeSealedBlob` call (1-based), counting from the test's start. */
	failStoreCall: 0,
	storeCalls: 0,
}));

function withHandler<T extends { _handler: (...args: never[]) => unknown }>(
	fn: T,
	handler: (...args: never[]) => unknown
): T {
	return { ...fn, _handler: handler } as T;
}

// The same two seams as inboundIngest.test.ts: the pre-check blinded so only
// the transactional check can catch a redelivery, and a receive that throws
// after the action has staged its blobs.
vi.mock('../messages', async (importOriginal) => {
	const actual = await importOriginal<typeof MessagesModule>();
	const findIdByMessageId = actual.findIdByMessageId as unknown as {
		_handler: (...args: never[]) => unknown;
	};
	const receiveMessage = actual.receiveMessage as unknown as {
		_handler: (...args: never[]) => unknown;
	};
	return {
		...actual,
		findIdByMessageId: withHandler(findIdByMessageId, async (...args: never[]) =>
			hooks.blindPreCheck ? null : await findIdByMessageId._handler(...args)
		),
		receiveMessage: withHandler(receiveMessage, async (...args: never[]) => {
			if (hooks.failReceive) throw new Error('receiveMessage exploded');
			return await receiveMessage._handler(...args);
		}),
	};
});

// A storage write that fails partway: the text part is staged, then the HTML
// store throws.
vi.mock('../../lib/sealedBlob', async (importOriginal) => {
	const actual = await importOriginal<typeof SealedBlobModule>();
	return {
		...actual,
		storeSealedBlob: async (...args: Parameters<typeof actual.storeSealedBlob>) => {
			hooks.storeCalls += 1;
			if (hooks.storeCalls === hooks.failStoreCall) throw new Error('storage store exploded');
			return await actual.storeSealedBlob(...args);
		},
	};
});

beforeEach(() => {
	hooks.blindPreCheck = false;
	hooks.failReceive = false;
	hooks.failStoreCall = 0;
	hooks.storeCalls = 0;
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	vi.stubEnv('MTA_INTERNAL_URL', '');
	vi.stubEnv('MTA_API_URL', '');
	vi.stubEnv('MTA_API_KEY', '');
});

/** A message with BOTH parts too large for the row: two body blobs. */
async function ingestHuge(t: TestConvex, messageId: string) {
	return await ingest(t, {
		messageId,
		textBody: 'Plain '.repeat(60_000),
		htmlBody: htmlOfSize(1.5 * MIB),
	});
}

async function bodyBlobsExist(
	t: TestConvex,
	ids: Array<Id<'_storage'> | undefined>
): Promise<boolean[]> {
	return await t.run(async (ctx) =>
		Promise.all(ids.map(async (id) => (await ctx.storage.get(id!)) !== null))
	);
}

describe('redelivery', () => {
	it('stores one row and one set of body blobs when the MTA retries', async () => {
		const t = setupTest();
		await ingestHuge(t, 'retry-1@example.com');
		const row = await onlyRow(t);
		expect(row.textBodyStorageId).toBeDefined();
		expect(row.htmlBodyStorageId).toBeDefined();
		const blobs = await storedBlobCount(t);
		expect(blobs).toBe(2);

		expect((await ingestHuge(t, 'retry-1@example.com')).isDuplicate).toBe(true);
		await onlyRow(t);
		expect(await storedBlobCount(t)).toBe(blobs);
	});

	it('drops the blobs it staged when it loses the race to a concurrent delivery', async () => {
		const t = setupTest();
		await ingestHuge(t, 'race-1@example.com');
		const blobs = await storedBlobCount(t);

		// The pre-check ran before the first attempt inserted, so this attempt
		// stages both bodies and only `receiveMessage` finds the duplicate.
		hooks.blindPreCheck = true;
		expect((await ingestHuge(t, 'race-1@example.com')).isDuplicate).toBe(true);

		const row = await onlyRow(t);
		expect(await storedBlobCount(t)).toBe(blobs);
		// The survivors are the first attempt's, which the row still reads.
		expect(await bodyBlobsExist(t, [row.textBodyStorageId, row.htmlBodyStorageId])).toEqual([
			true,
			true,
		]);
	});

	it('drops the text blob it staged when the HTML store then throws', async () => {
		const t = setupTest();
		hooks.failStoreCall = 2;
		await expect(ingestHuge(t, 'half-1@example.com')).rejects.toThrow('storage store exploded');
		expect(hooks.storeCalls).toBe(2);
		expect(await t.run((ctx) => ctx.db.query('inboundMessages').collect())).toHaveLength(0);
		expect(await storedBlobCount(t)).toBe(0);
	});

	it('drops the blobs it staged when the receive mutation throws, and rethrows', async () => {
		const t = setupTest();
		hooks.failReceive = true;
		await expect(ingestHuge(t, 'boom-1@example.com')).rejects.toThrow('receiveMessage exploded');
		expect(await t.run((ctx) => ctx.db.query('inboundMessages').collect())).toHaveLength(0);
		expect(await storedBlobCount(t)).toBe(0);
	});
});

describe('deleting the row deletes its body', () => {
	it('contact erasure removes the stored body parts with the message', async () => {
		const t = setupTest();
		await ingestHuge(t, 'erase-1@example.com');
		const row = await onlyRow(t);

		await t.run((ctx) => permanentlyDeleteContactWithRelations(ctx, row.contactId!));

		expect(await t.run((ctx) => ctx.db.get(row._id))).toBeNull();
		expect(await bodyBlobsExist(t, [row.textBodyStorageId, row.htmlBodyStorageId])).toEqual([
			false,
			false,
		]);
	});

	it('workspace deletion removes the stored body parts with the message', async () => {
		const t = setupTest();
		await ingestHuge(t, 'workspace-1@example.com');
		const row = await onlyRow(t);

		await t.mutation(internal.workspaces.deletion.walker.runStep, { table: 'inboundMessages' });

		expect(await t.run((ctx) => ctx.db.query('inboundMessages').collect())).toHaveLength(0);
		expect(await bodyBlobsExist(t, [row.textBodyStorageId, row.htmlBodyStorageId])).toEqual([
			false,
			false,
		]);
	});

	it('the raw-file retention sweep keeps the body: it is the message, not a file', async () => {
		const t = setupTest();
		await ingestHuge(t, 'retain-1@example.com');
		const row = await onlyRow(t);

		await t.mutation(internal.maintenance.retention.sweepInboundFiles, {
			now: Date.now() + 3650 * DAY_MS,
		});

		expect(await bodyBlobsExist(t, [row.textBodyStorageId, row.htmlBodyStorageId])).toEqual([
			true,
			true,
		]);
	});
});
