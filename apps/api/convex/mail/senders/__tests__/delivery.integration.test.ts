/**
 * Sender status at delivery and the delivered counters (SPEC §5), through
 * both live-ingest paths: hosted MX (`deliverToMailbox`, enforced before the
 * insert) and external forward sync (`ingestExternalMessage`, enforced after
 * the insert through `moveMessagesToFolder`). User filters run first and win;
 * backfills are never enforced or counted.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { internal } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import {
	SENDER_STATUS_REASON_KEY,
	SENDER_STATUS_WINNER_PRIORITY,
	stampSenderStatusOnRecord,
} from '../delivery';
import {
	deliverHosted,
	OWNER,
	profileOf,
	roleOf,
	SENDER,
	seedPersonalMailbox,
	seedProfile,
	type T,
} from './senders.testlib';

async function seedMoveFilter(t: T, mailboxId: Id<'mailboxes'>, folderId: Id<'mailFolders'>) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailFilters', {
			mailboxId,
			name: 'Shop to trash folder',
			isEnabled: true,
			priority: 10,
			conditions: [{ field: 'from', op: 'contains', value: 'shop.example' }],
			actions: [{ type: 'moveToFolder', folderId }],
			stopProcessing: false,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('hosted MX enforcement', () => {
	it('files an auto-archived sender into Archive, read', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		const id = (await deliverHosted(t))!;
		expect(await roleOf(t, id)).toBe('archive');
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.flagSeen).toBe(true);
	});

	it('files an unsubscribed sender into Archive, unread', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'unsubscribed', statusSource: 'user' });
		const id = (await deliverHosted(t))!;
		expect(await roleOf(t, id)).toBe('archive');
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.flagSeen).toBe(false);
	});

	it('leaves digest and keep senders in the Inbox', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'digest', statusSource: 'user' });
		await seedProfile(t, mailboxId, { address: 'friend@example.com' });
		expect(await roleOf(t, (await deliverHosted(t))!)).toBe('inbox');
		const friend = await deliverHosted(t, { from: 'Friend <friend@example.com>' });
		expect(await roleOf(t, friend!)).toBe('inbox');
	});

	it('lets a user filter that moved the mail win over sender status', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		await seedMoveFilter(t, mailboxId, folders.trash);
		const id = (await deliverHosted(t))!;
		expect(await roleOf(t, id)).toBe('trash');
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.flagSeen).toBe(false);
	});

	it('never pulls quarantined mail out of Spam', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'unsubscribed', statusSource: 'user' });
		expect(await roleOf(t, (await deliverHosted(t, { spamVerdict: 'spam' }))!)).toBe('spam');
	});

	it('does nothing for a team inbox', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t, { scope: 'shared' });
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		expect(await roleOf(t, (await deliverHosted(t))!)).toBe('inbox');
	});
});

describe('delivered counters', () => {
	it('counts live mail and marks it as part of the open cohort', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		await deliverHosted(t);
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile.status).toBe('keep');
		expect(profile.statusSource).toBe('default');
		expect(profile.displayName).toBe('Shop');
		expect(profile.deliveredWeeks[0]).toBe(2);
		expect(profile.lastDeliveredAt).toBeDefined();
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.isOpenCounted).toBe(false);
	});

	it('follows the settled category as the sender’s kind', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		const threadId = (await t.run(async (ctx) => await ctx.db.get(id)))!.threadId;
		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'promotion',
			source: 'llm',
		});
		expect((await profileOf(t, mailboxId))!.kind).toBe('promotion');
	});

	it('counts an enforced archive as delivered', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		await deliverHosted(t);
		expect((await profileOf(t, mailboxId))!.deliveredWeeks[0]).toBe(1);
	});

	it('skips the owner’s own mail, Spam, and team inboxes', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		await deliverHosted(t, { from: OWNER });
		await deliverHosted(t, { spamVerdict: 'spam' });
		expect(await profileOf(t, mailboxId, OWNER)).toBeNull();
		expect(await profileOf(t, mailboxId)).toBeNull();

		const team = convexTest(schema, modules);
		rateLimiterTest.register(team);
		const shared = await seedPersonalMailbox(team, { scope: 'shared' });
		const id = (await deliverHosted(team))!;
		expect(await profileOf(team, shared.mailboxId)).toBeNull();
		expect((await team.run(async (ctx) => await ctx.db.get(id)))!.isOpenCounted).toBeUndefined();
	});
});

describe('external forward sync', () => {
	async function seedExternal(t: T) {
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const accountId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert('externalMailAccounts', {
				userId: 'user-A',
				organizationId: 'org-1',
				mailboxId,
				imapHost: 'imap.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password' as const,
				imapUsername: OWNER,
				secretCiphertext: 'x',
				secretIv: 'x',
				secretAuthTag: 'x',
				secretEnvelopeVersion: 1,
				status: 'connected' as const,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.patch(mailboxId, { kind: 'external', externalAccountId: id });
			return id;
		});
		return { mailboxId, folders, accountId };
	}

	async function ingest(
		t: T,
		accountId: Id<'externalMailAccounts'>,
		uid: number,
		origin: 'sync' | 'backfill'
	): Promise<Id<'mailMessages'>> {
		const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
		const result = await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
			accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: uid,
			remoteUidValidity: 7,
			rawStorageId,
			rawSize: 3,
			from: `Shop <${SENDER}>`,
			to: [OWNER],
			cc: [],
			bcc: [],
			subject: `Sale ${uid}`,
			textBodyInline: 'On sale.',
			messageId: `<sync-${uid}@shop.example>`,
			receivedAt: Date.now(),
			attachments: [],
			origin,
		});
		if (!('messageId' in result)) throw new Error('not ingested');
		return result.messageId;
	}

	it('moves synced mail from an auto-archived sender to Archive, read, and writes it back', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, accountId } = await seedExternal(t);
		await seedProfile(t, mailboxId, { status: 'auto_archive', statusSource: 'user' });
		const id = await ingest(t, accountId, 1, 'sync');
		expect(await roleOf(t, id)).toBe('archive');
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.flagSeen).toBe(true);
		const remoteOps = await t.run(
			async (ctx) => await ctx.db.query('externalMailRemoteOps').collect()
		);
		expect(remoteOps.length).toBeGreaterThan(0);
		expect((await profileOf(t, mailboxId))!.deliveredWeeks[0]).toBe(1);
	});

	it('neither enforces nor counts a history backfill', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId, accountId } = await seedExternal(t);
		const seeded = await seedProfile(t, mailboxId, {
			status: 'unsubscribed',
			statusSource: 'user',
		});
		const id = await ingest(t, accountId, 2, 'backfill');
		expect(await roleOf(t, id)).toBe('inbox');
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.isOpenCounted).toBeUndefined();
		expect((await profileOf(t, mailboxId))!.deliveredWeeks).toEqual(seeded.deliveredWeeks);
	});
});

describe('the arrival-record stamp', () => {
	it('records sender status as the folder winner with a reason key, once', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(id))!;
			const now = Date.now();
			await ctx.db.insert('mailArrivalRecords', {
				mailboxId,
				threadId: message.threadId,
				messageId: id,
				sourceKey: `mail:${id}`,
				modelCalls: 0,
				reasonKeys: [],
				createdAt: now,
				updatedAt: now,
				expiresAt: now + 1000,
			});
			const outcome = { status: 'auto_archive' as const, filedTo: 'archive' as const };
			expect(await stampSenderStatusOnRecord(ctx, id, outcome)).toBe(true);
			expect(await stampSenderStatusOnRecord(ctx, id, outcome)).toBe(true);
			expect(await stampSenderStatusOnRecord(ctx, id, { status: 'digest' })).toBe(false);
			const record = (await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', id))
				.first())!;
			expect(record.exclusiveWinners?.folder).toEqual({
				source: 'sender_status',
				priority: SENDER_STATUS_WINNER_PRIORITY,
				folderId: message.folderId,
			});
			expect(record.reasonKeys).toEqual([
				{ key: SENDER_STATUS_REASON_KEY, params: { status: 'auto_archive' } },
			]);
		});
	});
});
