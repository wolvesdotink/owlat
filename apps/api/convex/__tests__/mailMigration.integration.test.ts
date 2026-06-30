/**
 * Mailbox migration orchestration — start / getStatus / cancel + the worker
 * backfill surface (getBackfillWork / initFolderBackfill / recordBackfillProgress
 * / completeBackfillImport).
 *
 * Mirrors externalAccounts.integration.test.ts: `getBetterAuthSessionWithRole`
 * is mocked and the `mail.external` / `ai.knowledge` gates read a seeded
 * `instanceSettings` row. A connected account is provisioned via
 * `_connectInternal`, and folder sync rows via `recordFolderMapping`.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		getUserIdFromSession: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return s.userId;
		}),
		getMutationContext: vi.fn().mockImplementation(async () => {
			const s = await sessionMocks.getBetterAuthSessionWithRole();
			if (!s) throw new Error('Not authenticated');
			return { userId: s.userId, role: s.role };
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledge/extraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
);

const CREDS = {
	emailAddress: 'me@example.com',
	imapHost: 'imap.example.com',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.example.com',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'me@example.com',
	authMethod: 'password' as const,
	secretCiphertext: 'ZmFrZS1jaXBoZXI=',
	secretIv: 'ZmFrZS1pdg==',
	secretAuthTag: 'ZmFrZS10YWc=',
	secretEnvelopeVersion: 1,
};

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null, orgId = 'org-1') {
	if (role === null) {
		sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue(null);
		return;
	}
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role,
		activeOrganizationId: orgId,
	});
}

async function enableFlags(
	t: ReturnType<typeof convexTest>,
	flags: Record<string, boolean>,
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: flags,
			createdAt: Date.now(),
		});
	});
}

/** Connect an account for `user-A` and return its id. */
async function connect(
	t: ReturnType<typeof convexTest>,
): Promise<Id<'externalMailAccounts'>> {
	setSession('user-A', 'owner');
	const { externalAccountId } = await t.mutation(
		internal.mail.externalAccounts._connectInternal,
		CREDS,
	);
	return externalAccountId;
}

// =====================================================================
// start
// =====================================================================

describe('mail.migration.start', () => {
	it('creates an importing migration with AI indexing on when ai.knowledge is enabled', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true, ai: true, 'ai.knowledge': true, inbox: true });
		const accountId = await connect(t);

		const res = await t.mutation(api.mail.migration.start, { source: 'google' });
		expect(res.status).toBe('importing');

		await t.run(async (ctx) => {
			const m = await ctx.db.get(res.migrationId);
			expect(m!.accountId).toBe(accountId);
			expect(m!.status).toBe('importing');
			expect(m!.source).toBe('google');
			expect(m!.isAiIndexingEnabled).toBe(true);
			expect(m!.messagesTotal).toBe(0);
		});
	});

	it('disables AI indexing when ai.knowledge is off', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connect(t);

		const res = await t.mutation(api.mail.migration.start, {});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(res.migrationId);
			expect(m!.isAiIndexingEnabled).toBe(false);
			expect(m!.source).toBe('imap');
		});
	});

	it('is idempotent — a second start returns the in-flight migration', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connect(t);

		const first = await t.mutation(api.mail.migration.start, {});
		const second = await t.mutation(api.mail.migration.start, {});
		expect(second.migrationId).toEqual(first.migrationId);

		await t.run(async (ctx) => {
			const all = await ctx.db.query('mailboxMigrations').collect();
			expect(all).toHaveLength(1);
		});
	});

	it('rejects when no mailbox is connected', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		setSession('user-A', 'owner');
		await expect(t.mutation(api.mail.migration.start, {})).rejects.toThrow(/connect a mailbox/i);
	});

	it('refuses an auth_error account the worker would never connect', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const accountId = await connect(t);
		// Stored credentials went stale — the worker self-stops on this account.
		await t.mutation(internal.mail.externalAccounts.setSyncStatus, {
			accountId,
			status: 'auth_error',
			lastError: 'Invalid credentials',
		});
		await expect(t.mutation(api.mail.migration.start, {})).rejects.toThrow(/re-enter your credentials/i);
		await t.run(async (ctx) => {
			const all = await ctx.db.query('mailboxMigrations').collect();
			expect(all).toHaveLength(0); // no wedged 'importing' row created
		});
	});

	it('resets folder backfill cursors so a re-run re-imports', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const accountId = await connect(t);

		// A leftover folder cursor from a previous (completed) run.
		await t.mutation(internal.mail.externalDelivery.recordFolderMapping, {
			accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUidValidity: 1,
			initialLastSeenUid: 100,
		});
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', accountId))
				.first();
			await ctx.db.patch(row!._id, { backfillCursor: 0, backfillTotal: 100, backfillDone: 100 });
		});

		await t.mutation(api.mail.migration.start, {});

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', accountId))
				.first();
			expect(row!.backfillCursor).toBeUndefined();
			expect(row!.backfillTotal).toBeUndefined();
			expect(row!.backfillDone).toBeUndefined();
		});
	});
});

// =====================================================================
// worker backfill surface
// =====================================================================

describe('mail.migration — worker backfill surface', () => {
	async function setup() {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const accountId = await connect(t);
		await t.mutation(internal.mail.externalDelivery.recordFolderMapping, {
			accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUidValidity: 1,
			initialLastSeenUid: 100,
		});
		const { migrationId } = await t.mutation(api.mail.migration.start, {});
		return { t, accountId, migrationId };
	}

	it('getBackfillWork reports active while a migration is importing', async () => {
		const { t, accountId } = await setup();
		const work = await t.query(internal.mail.migration.getBackfillWork, { accountId });
		expect(work.isActive).toBe(true);
	});

	it('getBackfillWork reports inactive when no migration is importing', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const accountId = await connect(t);
		const work = await t.query(internal.mail.migration.getBackfillWork, { accountId });
		expect(work.isActive).toBe(false);
	});

	it('initFolderBackfill snapshots the ceiling + count and bumps messagesTotal once', async () => {
		const { t, accountId, migrationId } = await setup();
		// Sparse UIDs: 80 actual messages spread across a UID space topping at 100.
		const r1 = await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		expect(r1).toEqual({ startCursor: 100 });

		// Idempotent resume — same cursor, no double-count.
		const r2 = await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		expect(r2).toEqual({ startCursor: 100 });

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesTotal).toBe(80); // count, not the UID ceiling
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', accountId))
				.first();
			expect(row!.backfillTotal).toBe(80);
			expect(row!.backfillCursor).toBe(100);
		});
	});

	it('re-initialises a folder when a restart cleared its backfillTotal', async () => {
		const { t, accountId, migrationId } = await setup();
		// Cancel+restart race: start() reset the row, but a still-in-flight batch
		// from the previous run re-wrote backfillCursor alone (total still cleared).
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', accountId))
				.first();
			await ctx.db.patch(row!._id, {
				backfillCursor: 42,
				backfillTotal: undefined,
				backfillDone: undefined,
			});
		});

		const res = await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		// Re-initialised from the ceiling, not resumed at the stale cursor 42.
		expect(res).toEqual({ startCursor: 100 });
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesTotal).toBe(80); // denominator recovered, not stuck at 0
		});
	});

	it('recordBackfillProgress drops the cursor and advances counters', async () => {
		const { t, accountId, migrationId } = await setup();
		await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		const res = await t.mutation(internal.mail.migration.recordBackfillProgress, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			newCursor: 50,
			importedDelta: 50,
		});
		expect(res).toEqual({ stillImporting: true });

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesImported).toBe(50);
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', accountId))
				.first();
			expect(row!.backfillCursor).toBe(50);
			expect(row!.backfillDone).toBe(50);
		});
	});

	it('recordBackfillProgress reports stillImporting=false once cancelled (stops the worker)', async () => {
		const { t, accountId, migrationId } = await setup();
		await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		// User cancels mid-import.
		await t.mutation(api.mail.migration.cancel, {});

		const res = await t.mutation(internal.mail.migration.recordBackfillProgress, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			newCursor: 50,
			importedDelta: 50,
		});
		expect(res).toEqual({ stillImporting: false });

		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			// Counter is NOT advanced for a cancelled migration.
			expect(m!.messagesImported).toBe(0);
			expect(m!.status).toBe('cancelled');
		});
	});

	it("a superseded migration's in-flight batch doesn't corrupt the restarted one", async () => {
		const { t, accountId, migrationId: first } = await setup();
		await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId: first,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});

		// User cancels #1 and immediately restarts → #2 (start() resets the row).
		await t.mutation(api.mail.migration.cancel, {});
		const { migrationId: second } = await t.mutation(api.mail.migration.start, {});

		// A batch still in flight from #1's run lands now, keyed to #1.
		const res = await t.mutation(internal.mail.migration.recordBackfillProgress, {
			accountId,
			migrationId: first,
			remoteName: 'INBOX',
			newCursor: 50,
			importedDelta: 50,
		});
		expect(res).toEqual({ stillImporting: false }); // worker stops #1's walk

		await t.run(async (ctx) => {
			// #2 is untouched: counter zero and the folder row stays reset.
			const m2 = await ctx.db.get(second);
			expect(m2!.messagesImported).toBe(0);
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', accountId))
				.first();
			expect(row!.backfillCursor).toBeUndefined(); // not clobbered by #1's batch
		});

		// #2 then initialises cleanly from the ceiling.
		const init2 = await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId: second,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		expect(init2).toEqual({ startCursor: 100 });
		await t.run(async (ctx) => {
			const m2 = await ctx.db.get(second);
			expect(m2!.messagesTotal).toBe(80); // denominator correct, not stuck at 0
		});
	});

	it('accumulates messagesTotal across multiple folders without double-counting', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const accountId = await connect(t);
		await t.mutation(internal.mail.externalDelivery.recordFolderMapping, {
			accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUidValidity: 1,
			initialLastSeenUid: 0,
		});
		await t.mutation(internal.mail.externalDelivery.recordFolderMapping, {
			accountId,
			folderRole: 'sent',
			remoteName: '[Gmail]/Sent Mail',
			remoteUidValidity: 1,
			initialLastSeenUid: 0,
		});
		const { migrationId } = await t.mutation(api.mail.migration.start, {});

		await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: '[Gmail]/Sent Mail',
			ceilingUid: 50,
			messageCount: 30,
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesTotal).toBe(110); // Σ per-folder count
		});

		// Re-initialising one folder (resume) must not re-add its count.
		await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 100,
			messageCount: 80,
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesTotal).toBe(110);
		});
	});

	it('initFolderBackfill handles an empty folder (count 0) without wedging', async () => {
		const { t, accountId, migrationId } = await setup();
		const res = await t.mutation(internal.mail.migration.initFolderBackfill, {
			accountId,
			migrationId,
			remoteName: 'INBOX',
			ceilingUid: 0,
			messageCount: 0,
		});
		expect(res).toEqual({ startCursor: 0 }); // nextBackfillRange(0) is immediately done
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesTotal).toBe(0);
		});
	});

	it('recordBackfillProgress reports stillImporting:false for an unmapped folder', async () => {
		const { t, accountId, migrationId } = await setup();
		const res = await t.mutation(internal.mail.migration.recordBackfillProgress, {
			accountId,
			migrationId,
			remoteName: 'No Such Folder',
			newCursor: 10,
			importedDelta: 5,
		});
		expect(res).toEqual({ stillImporting: false });
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.messagesImported).toBe(0); // counter untouched
		});
	});

	it('markImportFailed flips an importing migration to failed with the error', async () => {
		const { t, migrationId } = await setup();
		await t.mutation(internal.mail.migration.markImportFailed, {
			migrationId,
			errorMessage: 'IMAP server dropped the connection',
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('failed');
			expect(m!.lastError).toBe('IMAP server dropped the connection');
			expect(m!.completedAt).toBeDefined();
			const audit = await ctx.db
				.query('mailAuditLog')
				.filter((q) => q.eq(q.field('event'), 'migration.import_failed'))
				.first();
			expect(audit).not.toBeNull();
		});
	});

	it('markImportFailed truncates an oversized error message', async () => {
		const { t, migrationId } = await setup();
		await t.mutation(internal.mail.migration.markImportFailed, {
			migrationId,
			errorMessage: 'x'.repeat(1000),
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.lastError).toHaveLength(500);
		});
	});

	it('markImportFailed leaves a cancelled migration untouched (guard)', async () => {
		const { t, migrationId } = await setup();
		await t.mutation(api.mail.migration.cancel, {});
		await t.mutation(internal.mail.migration.markImportFailed, {
			migrationId,
			errorMessage: 'late error from a stale worker batch',
		});
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('cancelled'); // not overwritten to 'failed'
			expect(m!.lastError).toBeUndefined();
		});
	});

	it('completeBackfillImport finalizes completed when AI indexing is off', async () => {
		const { t, accountId, migrationId } = await setup(); // ai.knowledge not enabled
		await t.mutation(internal.mail.migration.completeBackfillImport, { migrationId });
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('completed');
			expect(m!.importCompletedAt).toBeDefined();
			expect(m!.completedAt).toBeDefined();
		});
	});

	it('completeBackfillImport hands off to indexing when AI is on', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true, ai: true, 'ai.knowledge': true, inbox: true });
		const accountId = await connect(t);
		await t.mutation(internal.mail.externalDelivery.recordFolderMapping, {
			accountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUidValidity: 1,
			initialLastSeenUid: 10,
		});
		const { migrationId } = await t.mutation(api.mail.migration.start, {});

		await t.mutation(internal.mail.migration.completeBackfillImport, { migrationId });
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('indexing');
			expect(m!.importCompletedAt).toBeDefined();
			expect(m!.completedAt).toBeUndefined();
		});
	});
});

// =====================================================================
// getStatus + cancel
// =====================================================================

describe('mail.migration.getStatus', () => {
	it('returns null when there is no migration', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connect(t);
		const status = await t.query(api.mail.migration.getStatus, {});
		expect(status).toBeNull();
	});

	it('derives import/index percentages', async () => {
		const { t } = await (async () => {
			const t = convexTest(schema, modules);
			await enableFlags(t, { 'mail.external': true });
			const accountId = await connect(t);
			await t.mutation(internal.mail.externalDelivery.recordFolderMapping, {
				accountId,
				folderRole: 'inbox',
				remoteName: 'INBOX',
				remoteUidValidity: 1,
				initialLastSeenUid: 100,
			});
			const { migrationId } = await t.mutation(api.mail.migration.start, {});
			await t.mutation(internal.mail.migration.initFolderBackfill, {
				accountId,
				migrationId,
				remoteName: 'INBOX',
				ceilingUid: 100,
				messageCount: 100,
			});
			await t.mutation(internal.mail.migration.recordBackfillProgress, {
				accountId,
				migrationId,
				remoteName: 'INBOX',
				newCursor: 25,
				importedDelta: 75,
			});
			return { t };
		})();

		const status = await t.query(api.mail.migration.getStatus, {});
		expect(status!.status).toBe('importing');
		expect(status!.messagesTotal).toBe(100);
		expect(status!.messagesImported).toBe(75);
		expect(status!.importPercent).toBe(75);
	});

	it('returns null for anonymous callers', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connect(t);
		setSession('user-A', null);
		const status = await t.query(api.mail.migration.getStatus, {});
		expect(status).toBeNull();
	});
});

describe('mail.migration.cancel', () => {
	it('flips an in-flight migration to cancelled', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connect(t);
		const { migrationId } = await t.mutation(api.mail.migration.start, {});

		const ok = await t.mutation(api.mail.migration.cancel, {});
		expect(ok).toBe(true);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('cancelled');
			expect(m!.completedAt).toBeDefined();
		});
	});

	it('returns false when there is nothing to cancel', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await connect(t);
		const ok = await t.mutation(api.mail.migration.cancel, {});
		expect(ok).toBe(false);
	});
});
