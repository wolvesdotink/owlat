/**
 * Starting an import after one FAILED resumes the walk instead of restarting it.
 *
 * The wizard's 'Try again' went through `startMigrationForAccount`, which wiped
 * every per-folder backfill cursor unconditionally — written for the case where
 * the previous run FINISHED and left them at 0. After a failure those cursors
 * hold real progress, and wiping them made each retry re-fetch the entire
 * history from the provider.
 *
 * On the instance that surfaced this, a 17,000-message Gmail team inbox failed
 * three times over three days: 10,400 / 10,381 / 10,397 messages imported, every
 * run dying at the same point because the retry spent the same daily IMAP
 * bandwidth on the same already-imported mail and hit the same wall. The import
 * could not finish, however many times it was started.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { modules } from './helpers.testlib';
import { startMigrationForAccount } from '../migration';

const USER_ID = 'user-A';
const ORG_ID = 'org-1';

interface Seeded {
	accountId: Id<'externalMailAccounts'>;
	mailboxId: Id<'mailboxes'>;
	sentSyncId: Id<'externalMailFolderSync'>;
	inboxSyncId: Id<'externalMailFolderSync'>;
}

/**
 * One external account with two mapped folders: a fully-walked INBOX and a Sent
 * folder the run died 60% of the way down — the shape the failing instance was
 * left in.
 */
async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: USER_ID,
			organizationId: ORG_ID,
			address: 'team@acme.test',
			domain: 'acme.test',
			kind: 'external',
			scope: 'shared',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folderId = async (role: 'inbox' | 'sent') =>
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name: role.toUpperCase(),
				role,
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
			userId: USER_ID,
			organizationId: ORG_ID,
			mailboxId,
			scope: 'shared',
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: 'team@acme.test',
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		const sync = async (
			remoteName: string,
			role: 'inbox' | 'sent',
			backfill: { cursor: number; total: number; done: number }
		) =>
			await ctx.db.insert('externalMailFolderSync', {
				accountId,
				mailboxId,
				folderId: await folderId(role),
				remoteName,
				remoteUidValidity: 1,
				lastSeenUid: 100,
				lastSyncedAt: now,
				backfillCursor: backfill.cursor,
				backfillTotal: backfill.total,
				backfillDone: backfill.done,
			});
		return {
			accountId,
			mailboxId,
			inboxSyncId: await sync('INBOX', 'inbox', { cursor: 0, total: 10, done: 10 }),
			sentSyncId: await sync('[Gmail]/Sent Mail', 'sent', {
				cursor: 6986,
				total: 17_369,
				done: 10_395,
			}),
		};
	});
}

async function start(t: ReturnType<typeof convexTest>, seeded: Seeded) {
	return await t.run(async (ctx) => {
		const account = (await ctx.db.get(seeded.accountId))!;
		return await startMigrationForAccount(ctx, {
			account,
			mailboxId: seeded.mailboxId,
			userId: USER_ID,
			organizationId: ORG_ID,
			source: 'google',
			scope: 'shared',
			isAiIndexingEnabled: false,
		});
	});
}

async function insertPreviousRun(
	t: ReturnType<typeof convexTest>,
	seeded: Seeded,
	row: {
		status: 'failed' | 'completed' | 'cancelled';
		messagesImported: number;
		messagesFailed?: number;
	}
) {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailboxMigrations', {
			userId: USER_ID,
			organizationId: ORG_ID,
			accountId: seeded.accountId,
			mailboxId: seeded.mailboxId,
			scope: 'shared',
			source: 'google',
			status: row.status,
			isAiIndexingEnabled: false,
			messagesTotal: 17_379,
			messagesImported: row.messagesImported,
			...(row.messagesFailed === undefined ? {} : { messagesFailed: row.messagesFailed }),
			messagesIndexed: 0,
			startedAt: now - 1,
			completedAt: now,
			updatedAt: now,
		});
	});
}

describe('startMigrationForAccount after a failed run', () => {
	it('keeps the folder cursors so the walk resumes where it stopped', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await insertPreviousRun(t, seeded, {
			status: 'failed',
			messagesImported: 10_397,
			messagesFailed: 8,
		});

		await start(t, seeded);

		const sent = await t.run(async (ctx) => await ctx.db.get(seeded.sentSyncId));
		// Re-walking these 10,395 messages is what spent the provider's daily
		// budget and made every retry die at the same point.
		expect(sent?.backfillCursor).toBe(6986);
		expect(sent?.backfillTotal).toBe(17_369);
		expect(sent?.backfillDone).toBe(10_395);
	});

	it('carries the counters forward so the bar continues rather than restarting', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await insertPreviousRun(t, seeded, {
			status: 'failed',
			messagesImported: 10_397,
			messagesFailed: 8,
		});

		const { migrationId } = await start(t, seeded);

		const row = await t.run(async (ctx) => await ctx.db.get(migrationId));
		// `initFolderBackfill` returns an already-initialised folder's cursor
		// WITHOUT re-adding its total, so a resumed run that started these at zero
		// would render a full bar over a denominator of 0.
		expect(row?.messagesTotal).toBe(10 + 17_369);
		expect(row?.messagesImported).toBe(10_397);
		expect(row?.messagesFailed).toBe(8);
	});

	it('records the resume in the audit trail', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await insertPreviousRun(t, seeded, { status: 'failed', messagesImported: 10_397 });

		await start(t, seeded);

		const audit = await t.run(
			async (ctx) =>
				await ctx.db
					.query('mailAuditLog')
					.filter((q) => q.eq(q.field('event'), 'migration.started'))
					.first()
		);
		expect(audit?.details).toContain('resumed=true');
	});
});

describe('startMigrationForAccount otherwise', () => {
	it('re-walks from the top after a run that COMPLETED', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		// A completed run leaves every cursor at 0; the user asking again wants
		// the whole history re-walked.
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.sentSyncId, { backfillCursor: 0, backfillDone: 17_369 });
		});
		await insertPreviousRun(t, seeded, { status: 'completed', messagesImported: 17_379 });

		const { migrationId } = await start(t, seeded);

		const [sent, row] = await t.run(
			async (ctx) => [await ctx.db.get(seeded.sentSyncId), await ctx.db.get(migrationId)] as const
		);
		expect(sent?.backfillCursor).toBeUndefined();
		expect(sent?.backfillTotal).toBeUndefined();
		expect(row?.messagesTotal).toBe(0);
		expect(row?.messagesImported).toBe(0);
	});

	it('re-walks after a failure that left nothing to resume', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		// `completeBackfillImport` fails a walk that reached the end of every
		// folder without storing anything — every cursor is at 0, so resuming it
		// would re-fail instantly without fetching a single message.
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.sentSyncId, { backfillCursor: 0 });
		});
		await insertPreviousRun(t, seeded, {
			status: 'failed',
			messagesImported: 0,
			messagesFailed: 17_379,
		});

		const { migrationId } = await start(t, seeded);

		const [sent, row] = await t.run(
			async (ctx) => [await ctx.db.get(seeded.sentSyncId), await ctx.db.get(migrationId)] as const
		);
		expect(sent?.backfillCursor).toBeUndefined();
		expect(row?.messagesImported).toBe(0);
		expect(row?.messagesFailed).toBe(0);
	});

	it('still reuses an in-flight migration rather than spawning a second', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailboxMigrations', {
				userId: USER_ID,
				organizationId: ORG_ID,
				accountId: seeded.accountId,
				mailboxId: seeded.mailboxId,
				scope: 'shared',
				source: 'google',
				status: 'importing',
				isAiIndexingEnabled: false,
				messagesTotal: 17_379,
				messagesImported: 1,
				messagesIndexed: 0,
				startedAt: now,
				updatedAt: now,
			});
		});

		const { status } = await start(t, seeded);

		expect(status).toBe('importing');
		const count = await t.run(
			async (ctx) => (await ctx.db.query('mailboxMigrations').collect()).length
		);
		expect(count).toBe(1);
	});
});
