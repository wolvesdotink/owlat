/**
 * The mail-sync worker frees the raw upload of a message it staged but will
 * never ingest (its pipeline stopped mid-poll). Only an unreferenced blob goes.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';

describe('discardStagedRaw', () => {
	it('deletes a staged raw upload no message points at', async () => {
		const t = convexTest(schema, modules);
		const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));

		await t.mutation(internal.mail.external.delivery.discardStagedRaw, { rawStorageId });

		expect(await t.run(async (ctx) => (await ctx.storage.get(rawStorageId)) !== null)).toBe(false);
	});

	it('leaves a blob a stored message already points at', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId);
		const rawStorageId = await t.run(async (ctx) => (await ctx.db.get(messageId))!.rawStorageId);

		await t.mutation(internal.mail.external.delivery.discardStagedRaw, { rawStorageId });

		expect(await t.run(async (ctx) => (await ctx.storage.get(rawStorageId)) !== null)).toBe(true);
	});
});
