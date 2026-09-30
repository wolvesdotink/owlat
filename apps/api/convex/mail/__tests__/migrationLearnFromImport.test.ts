/**
 * Learning from a mailbox import AFTER it finished — `learnFromImportShared`
 * (the team-inbox card) and `learnFromImport` (the personal wizard).
 *
 * A team inbox's knowledge opt-in used to exist only as a checkbox before the
 * import started, and a personal import done while `ai.knowledge` was off never
 * learned at all: an import that completed without knowledge had no way back
 * short of re-importing the whole mailbox. Both entry points re-run the same
 * sweep the operator migration (`reindexMigration`) runs, behind the same
 * authorization as their `start` twins.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules } from './helpers.testlib';

// One mutable hoisted session drives both the wrapper floors and the in-handler
// mailbox gate — same pattern as externalSharedInbox.test.ts.
const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = () => {
		if (sessionMock.role === null) throw new Error('Not authenticated');
		return {
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		};
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return session();
		}),
		requireOrgPermission: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error("You don't have permission to perform this action");
			}
			return session();
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => (sessionMock.role === null ? null : session())),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null) {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

async function setFlags(t: TestConvex<typeof schema>, flags: Record<string, boolean>) {
	await t.run(async (ctx) => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (settings) {
			await ctx.db.patch(settings._id, {
				featureFlags: { ...settings.featureFlags, ...flags },
			});
			return;
		}
		await ctx.db.insert('instanceSettings', { featureFlags: flags, createdAt: Date.now() });
	});
}

const KNOWLEDGE_ON = { 'mail.external': true, ai: true, 'ai.knowledge': true, inbox: true };

const CREDS = {
	imapHost: 'imap.acme.test',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.acme.test',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'support@acme.test',
	authMethod: 'password' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

async function seedMembers(t: TestConvex<typeof schema>, ...authUserIds: string[]) {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const authUserId of authUserIds) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				email: `${authUserId}@acme.test`,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

/** Connect a team inbox as `admin-user`, with `user-B` on its roster. */
async function connectTeamInbox(t: TestConvex<typeof schema>) {
	await seedMembers(t, 'user-B');
	setSession('admin-user', 'admin');
	return await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
		...CREDS,
		emailAddress: 'support@acme.test',
		memberUserIds: ['user-B'],
	});
}

/** Stand in for a finished run: the import walked everything, no knowledge. */
async function finishWithoutKnowledge(
	t: TestConvex<typeof schema>,
	migrationId: Id<'mailboxMigrations'>
) {
	await t.run((ctx) =>
		ctx.db.patch(migrationId, {
			status: 'completed',
			isAiIndexingEnabled: false,
			messagesImported: 12,
			messagesIndexed: 0,
			importCompletedAt: 2,
			completedAt: 3,
		})
	);
}

describe('learnFromImportShared', () => {
	it('starts the knowledge sweep over a completed team-inbox import', async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		const { mailboxId } = await connectTeamInbox(t);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		await finishWithoutKnowledge(t, migrationId);

		const res = await t.mutation(api.mail.migrationShared.learnFromImportShared, { mailboxId });
		expect(res).toEqual({ migrationId });

		// The card's indexing state takes over from here: same row, now sweeping.
		const status = await t.query(api.mail.migrationShared.getStatusShared, { mailboxId });
		expect(status).toMatchObject({
			_id: migrationId,
			status: 'indexing',
			isAiIndexingEnabled: true,
			messagesIndexed: 0,
			messagesImported: 12,
		});
		const audit = await t.run((ctx) => ctx.db.query('mailAuditLog').collect());
		expect(audit.map((r) => r.event)).toContain('migration.reindex_started');
		// No second import row — the mail is not fetched again.
		const rows = await t.run((ctx) => ctx.db.query('mailboxMigrations').collect());
		expect(rows).toHaveLength(1);
	});

	it('refuses a rostered member and an outsider (owner floor)', async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		const { mailboxId } = await connectTeamInbox(t);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		await finishWithoutKnowledge(t, migrationId);

		for (const userId of ['user-B', 'user-Z']) {
			setSession(userId, 'editor');
			await expect(
				t.mutation(api.mail.migrationShared.learnFromImportShared, { mailboxId })
			).rejects.toThrow(/permission/i);
		}
		const row = await t.run((ctx) => ctx.db.get(migrationId));
		expect(row!.status).toBe('completed');
		expect(row!.isAiIndexingEnabled).toBe(false);
	});

	it('refuses an import that is still running', async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		const { mailboxId } = await connectTeamInbox(t);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });

		await expect(
			t.mutation(api.mail.migrationShared.learnFromImportShared, { mailboxId })
		).rejects.toThrow(/wait for the import to finish/i);
		expect((await t.run((ctx) => ctx.db.get(migrationId)))!.status).toBe('importing');
	});

	it('refuses an inbox that was never imported', async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		const { mailboxId } = await connectTeamInbox(t);

		await expect(
			t.mutation(api.mail.migrationShared.learnFromImportShared, { mailboxId })
		).rejects.toThrow(/import this mailbox before/i);
	});

	it('refuses while ai.knowledge is off', async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, { 'mail.external': true });
		const { mailboxId } = await connectTeamInbox(t);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		await finishWithoutKnowledge(t, migrationId);

		await expect(
			t.mutation(api.mail.migrationShared.learnFromImportShared, { mailboxId })
		).rejects.toThrow(/ai\.knowledge.*is disabled/);
		const row = await t.run((ctx) => ctx.db.get(migrationId));
		expect(row!.status).toBe('completed');
		expect(row!.isAiIndexingEnabled).toBe(false);
	});
});

describe('learnFromImport (personal wizard)', () => {
	async function connectPersonal(t: TestConvex<typeof schema>) {
		setSession('admin-user', 'admin');
		return await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'me@acme.test',
			imapUsername: 'me@acme.test',
		});
	}

	it("starts the sweep over the caller's own completed import", async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		await connectPersonal(t);
		const { migrationId } = await t.mutation(api.mail.migration.start, {});
		await finishWithoutKnowledge(t, migrationId);

		expect(await t.mutation(api.mail.migration.learnFromImport, {})).toEqual({ migrationId });
		expect(await t.query(api.mail.migration.getStatus, {})).toMatchObject({
			status: 'indexing',
			isAiIndexingEnabled: true,
		});
	});

	it("never reaches a team inbox's import", async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		const { mailboxId } = await connectTeamInbox(t);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		await finishWithoutKnowledge(t, migrationId);

		await expect(t.mutation(api.mail.migration.learnFromImport, {})).rejects.toThrow(
			/connect a mailbox/i
		);
		expect((await t.run((ctx) => ctx.db.get(migrationId)))!.status).toBe('completed');
	});

	it('refuses while the import is still running', async () => {
		const t = convexTest(schema, modules);
		await setFlags(t, KNOWLEDGE_ON);
		await connectPersonal(t);
		await t.mutation(api.mail.migration.start, {});

		await expect(t.mutation(api.mail.migration.learnFromImport, {})).rejects.toThrow(
			/wait for the import to finish/i
		);
	});
});
