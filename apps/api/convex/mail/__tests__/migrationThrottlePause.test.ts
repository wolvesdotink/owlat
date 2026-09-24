/**
 * `pauseImportForThrottle` — an import that ran out of its provider's daily
 * bandwidth budget waits for the window to reset instead of failing.
 *
 * Before this, the worker's throttled retry ladder (a few hours) ended in
 * `markImportFailed`, so a mailbox bigger than one day's budget landed on a red
 * "import stopped" card once per day and needed a manual "Try again" each time.
 * The migration now stays `importing` with `resumesAt` set; the walk's next
 * recorded batch clears it, and only a provider that lets nothing through for
 * several windows in a row still fails the import.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { MAX_THROTTLE_PAUSES } from '../migrationBackfill';
import { latestMigrationForAccount } from '../migration';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';

const DAY = 24 * 60 * 60_000;

async function setup() {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t);
	const folderId = await seedFolder(t, mailboxId, 'sent');
	let accountId!: Id<'externalMailAccounts'>;
	let migrationId!: Id<'mailboxMigrations'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		accountId = await ctx.db.insert('externalMailAccounts', {
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
			imapUsername: 'team@owlat.test',
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('externalMailFolderSync', {
			accountId,
			mailboxId,
			folderId,
			remoteName: '[Gmail]/Sent Mail',
			remoteUidValidity: 1,
			lastSeenUid: 1000,
			lastSyncedAt: now,
			backfillCursor: 600,
			backfillTotal: 1000,
			backfillDone: 400,
		});
		migrationId = await ctx.db.insert('mailboxMigrations', {
			userId: 'user-A',
			organizationId: 'org-1',
			accountId,
			mailboxId,
			source: 'google',
			status: 'importing',
			isAiIndexingEnabled: false,
			messagesTotal: 1000,
			messagesImported: 400,
			messagesIndexed: 0,
			startedAt: now,
			updatedAt: now,
		});
	});
	return { t, accountId, migrationId };
}

async function pause(
	t: ReturnType<typeof convexTest>,
	migrationId: Id<'mailboxMigrations'>,
	resumeAt = Date.now() + DAY
) {
	return await t.mutation(internal.mail.migrationBackfill.pauseImportForThrottle, {
		migrationId,
		resumeAt,
		reason: 'Connection not available: Account exceeded command or bandwidth limits.',
	});
}

describe('pauseImportForThrottle', () => {
	it('holds the import instead of failing it', async () => {
		const { t, migrationId } = await setup();
		const resumeAt = Date.now() + DAY;

		expect(await pause(t, migrationId, resumeAt)).toEqual({ outcome: 'paused' });

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('importing');
			expect(m!.resumesAt).toBe(resumeAt);
			expect(m!.lastError).toBeUndefined();
			const audit = await ctx.db
				.query('mailAuditLog')
				.filter((q) => q.eq(q.field('event'), 'migration.import_paused'))
				.first();
			expect(audit!.details).toContain('exceeded command or bandwidth limits');
		});
	});

	it('tells the worker about the pause, so a restarted worker waits it out too', async () => {
		const { t, accountId, migrationId } = await setup();
		const resumeAt = Date.now() + DAY;
		await pause(t, migrationId, resumeAt);

		const work = await t.query(internal.mail.migrationBackfill.getBackfillWork, { accountId });
		expect(work).toEqual({ isActive: true, migrationId, resumesAt: resumeAt });
	});

	it('surfaces the resume time to the wizard while importing', async () => {
		const { t, accountId, migrationId } = await setup();
		const resumeAt = Date.now() + DAY;
		await pause(t, migrationId, resumeAt);

		const status = await t.run(async (ctx) => await latestMigrationForAccount(ctx, accountId));
		expect(status!.status).toBe('importing');
		expect(status!.resumesAt).toBe(resumeAt);
	});

	it('clears the pause as soon as the resumed walk records a batch', async () => {
		const { t, accountId, migrationId } = await setup();
		await pause(t, migrationId);
		await pause(t, migrationId);

		await t.mutation(internal.mail.migrationBackfill.recordBackfillProgress, {
			accountId,
			migrationId,
			remoteName: '[Gmail]/Sent Mail',
			newCursor: 500,
			importedDelta: 100,
			failedDelta: 0,
		});

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.resumesAt).toBeUndefined();
			expect(m!.throttlePauses).toBeUndefined();
		});
		const work = await t.query(internal.mail.migrationBackfill.getBackfillWork, { accountId });
		expect(work).toEqual({ isActive: true, migrationId });
	});

	it('a large import that inches forward every day is never failed', async () => {
		const { t, accountId, migrationId } = await setup();
		let cursor = 600;
		for (let day = 0; day < MAX_THROTTLE_PAUSES * 3; day++) {
			expect(await pause(t, migrationId)).toEqual({ outcome: 'paused' });
			cursor -= 10;
			await t.mutation(internal.mail.migrationBackfill.recordBackfillProgress, {
				accountId,
				migrationId,
				remoteName: '[Gmail]/Sent Mail',
				newCursor: cursor,
				importedDelta: 10,
				failedDelta: 0,
			});
		}
		await t.run(async (ctx) => {
			expect((await ctx.db.get(migrationId))!.status).toBe('importing');
		});
	});

	it('fails the import once the provider lets nothing through for window after window', async () => {
		const { t, accountId, migrationId } = await setup();
		for (let i = 0; i < MAX_THROTTLE_PAUSES; i++) {
			expect(await pause(t, migrationId)).toEqual({ outcome: 'paused' });
		}

		expect(await pause(t, migrationId)).toEqual({ outcome: 'failed' });

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('failed');
			expect(m!.resumesAt).toBeUndefined();
			// A code the web phrases in the user's language; lastError keeps only
			// the provider's own words.
			expect(m!.failureCode).toBe('throttle_exhausted');
			expect(m!.lastError).toBe(
				'Connection not available: Account exceeded command or bandwidth limits.'
			);
			expect(m!.throttlePauses).toBe(MAX_THROTTLE_PAUSES);
		});

		const status = await t.run(async (ctx) => await latestMigrationForAccount(ctx, accountId));
		expect(status!.failureCode).toBe('throttle_exhausted');
		expect(status!.failedAfterDays).toBe(MAX_THROTTLE_PAUSES);
	});

	it('caps a resume time too far out, and never sets one in the past', async () => {
		const { t, migrationId } = await setup();
		const before = Date.now();
		await pause(t, migrationId, before + 30 * DAY);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.resumesAt!).toBeLessThanOrEqual(Date.now() + 2 * DAY);
		});

		await pause(t, migrationId, before - DAY);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.resumesAt!).toBeGreaterThanOrEqual(before);
		});
	});

	it('leaves a migration that already left the importing phase alone', async () => {
		const { t, migrationId } = await setup();
		await t.run(async (ctx) => {
			await ctx.db.patch(migrationId, { status: 'cancelled' });
		});

		expect(await pause(t, migrationId)).toEqual({ outcome: 'ignored' });

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('cancelled');
			expect(m!.resumesAt).toBeUndefined();
		});
	});
});
