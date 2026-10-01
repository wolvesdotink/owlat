/**
 * Counter scopes (plan 3.1) end with the mailbox they count.
 *
 * A hard-deleted mailbox takes its `mailLabelUnread:<mailboxId>` scope and its
 * inbox's `mailSectionUnread` / `mailFolderArrivals` scopes with it, and the
 * 0048 backfill does not start a scope for a mailbox purged after it listed it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { modules } from './helpers.testlib';
import { startEmptyMailboxCounters } from '../messageCounters';

type T = TestConvex<typeof schema>;

async function seedExternalMailbox(t: T) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: 'me@gmail.example',
			domain: 'gmail.example',
			kind: 'external',
			status: 'deleted',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const inboxId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: 'me@gmail.example',
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'disconnected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await startEmptyMailboxCounters(ctx, mailboxId, inboxId);
		// A leftover bucket, as a scope that never quite drained would hold.
		await ctx.db.insert('counterBuckets', {
			scope: `mailFolderArrivals:${inboxId}`,
			bucket: '0000000001',
			count: 1,
			updatedAt: now,
		});
		return { mailboxId, inboxId, accountId };
	});
}

async function counterRows(t: T) {
	return await t.run(async (ctx) => ({
		scopes: (await ctx.db.query('counterScopes').collect()).map((row) => row.scope),
		buckets: (await ctx.db.query('counterBuckets').collect()).map((row) => row.scope),
	}));
}

describe('counter scopes on mailbox hard delete', () => {
	it('purging a disconnected account deletes the mailbox and inbox scopes', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, accountId } = await seedExternalMailbox(t);
		expect((await counterRows(t)).scopes).toHaveLength(3);

		await t.mutation(internal.mail.external.accountTeardown._purgeChunk, {
			accountId,
			mailboxId,
		});

		expect(await t.run(async (ctx) => await ctx.db.get(mailboxId))).toBeNull();
		expect(await counterRows(t)).toEqual({ scopes: [], buckets: [] });
	});

	it('0048 starts no scope for a mailbox or folder that is gone', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxId, accountId } = await seedExternalMailbox(t);
		await t.mutation(internal.mail.external.accountTeardown._purgeChunk, {
			accountId,
			mailboxId,
		});

		const outcome = await t.mutation(internal.migrations['0048_backfill_counters'].startScopes, {
			scopes: [
				{ kind: 'mailLabelUnread', ownerId: mailboxId },
				{ kind: 'mailSectionUnread', ownerId: inboxId },
				{ kind: 'mailFolderArrivals', ownerId: inboxId },
			],
		});

		expect(outcome).toEqual({ started: 0, running: 0, ready: 0 });
		expect((await counterRows(t)).scopes).toEqual([]);
	});
});
