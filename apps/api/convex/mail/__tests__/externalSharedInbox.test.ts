/**
 * Connecting an external IMAP account AS A SHARED TEAM INBOX (issue #234).
 *
 * Covers the backend path added on top of PR #232: `_connectSharedInternal`
 * provisions a `kind='external', scope='shared'` mailbox with the connecting
 * admin as owner + the initial roster, records a `scope='shared'`
 * `externalMailAccounts` row, and reuses the membership model so teammates read
 * it via `requireMailboxAccess`. Also pins the ownership/credential-model
 * decision: a shared external account is org infrastructure and is invisible to
 * every PERSONAL-external surface (it never masks or blocks the caller's own
 * 1:1 mailbox), and deleting the mailbox stops the sync worker.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api, internal } from '../../_generated/api';
import { modules } from './helpers.testlib';

// One mutable hoisted session drives both the wrapper floors and the in-handler
// mailbox gate — same pattern as mailboxMembers.test.ts.
const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'admin' as 'owner' | 'admin' | 'editor' | null,
	orgId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		getMutationContext: vi.fn(async () => {
			if (sessionMock.role === null) throw new Error('Not authenticated');
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		requireAdminContext: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error('Only owners and admins can perform this action');
			}
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
		requireOrgPermission: vi.fn(async () => {
			if (sessionMock.role !== 'owner' && sessionMock.role !== 'admin') {
				throw new Error("You don't have permission to perform this action");
			}
			return { userId: sessionMock.userId, role: sessionMock.role };
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (sessionMock.role === null) return null;
			return {
				userId: sessionMock.userId,
				role: sessionMock.role,
				activeOrganizationId: sessionMock.orgId,
			};
		}),
	};
});

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null, orgId = 'org-1') {
	sessionMock.userId = userId;
	sessionMock.role = role;
	sessionMock.orgId = orgId;
}

/** Seed `userProfiles` rows so `assertOrgMemberUser` treats the ids as org members. */
async function seedUsers(t: TestConvex<typeof schema>, ...authUserIds: string[]): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		for (const authUserId of authUserIds) {
			await ctx.db.insert('userProfiles', {
				authUserId,
				email: `${authUserId}@owlat.test`,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

/** Turn on the `mail.external` flag the sending/migration surfaces gate on. */
async function enableExternal(t: TestConvex<typeof schema>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'mail.external': true },
			createdAt: Date.now(),
		});
	});
}

/** Seed the instance feature flags a case needs (superset of `enableExternal`). */
async function enableFlags(
	t: TestConvex<typeof schema>,
	flags: Record<string, boolean>
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: flags,
			createdAt: Date.now(),
		});
	});
}

/** Encrypted-envelope + connection fields the connect actions hand the mutation. */
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

/** All membership rows on a mailbox keyed member id → role. */
async function roles(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<Map<string, 'owner' | 'member'>> {
	const rows = await t.run((ctx) =>
		ctx.db
			.query('mailboxMembers')
			.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailboxId))
			.collect()
	);
	return new Map(rows.map((r) => [r.authUserId, r.role]));
}

describe('_connectSharedInternal — external account as a shared team inbox', () => {
	it('provisions a shared external mailbox, its account, and the initial roster', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedUsers(t, 'user-B', 'user-C');

		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{
				...CREDS,
				emailAddress: 'Support <support@acme.test>',
				displayName: 'Acme Support',
				memberUserIds: ['user-B', 'user-C', 'user-B'], // dup is deduped
			}
		);

		const mailbox = await t.run((ctx) => ctx.db.get(mailboxId));
		expect(mailbox?.kind).toBe('external');
		expect(mailbox?.scope).toBe('shared');
		expect(mailbox?.address).toBe('support@acme.test');
		expect(mailbox?.userId).toBe('admin-user');
		expect(mailbox?.externalAccountId).toBe(externalAccountId);

		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.scope).toBe('shared');
		expect(account?.userId).toBe('admin-user');
		expect(account?.mailboxId).toBe(mailboxId);
		expect(account?.status).toBe('pending');
		// The encrypted envelope is stored verbatim — never returned to readers.
		expect(account?.secretCiphertext).toBe('ct');

		const map = await roles(t, mailboxId);
		expect(map.get('admin-user')).toBe('owner');
		expect(map.get('user-B')).toBe('member');
		expect(map.get('user-C')).toBe('member');
		expect(map.size).toBe(3);
	});

	it('grants added members access via the shared membership model', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedUsers(t, 'user-B');
		const { mailboxId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: ['user-B'] }
		);

		// A member reads the (external) shared inbox; a non-member cannot.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId })).toBe('member');
		expect(await t.query(api.mail.mailbox.identity.get, { mailboxId })).not.toBeNull();

		setSession('user-Z', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId })).toBeNull();
		expect(await t.query(api.mail.mailbox.identity.get, { mailboxId })).toBeNull();
	});

	it('surfaces the connected inbox in the admin listShared overview as kind=external', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedUsers(t, 'user-B');
		const { mailboxId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: ['user-B'] }
		);

		const list = await t.query(api.mail.mailboxMembers.listShared, {});
		const row = list.find((m) => m._id === mailboxId)!;
		expect(row.kind).toBe('external');
		expect(row.memberCount).toBe(2);
	});

	it('rejects a non-admin caller (team inbox is org infrastructure)', async () => {
		const t = convexTest(schema, modules);
		setSession('editor-user', 'editor');
		await expect(
			t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
				...CREDS,
				emailAddress: 'support@acme.test',
				memberUserIds: [],
			})
		).rejects.toThrow(/owners and admins/i);
	});

	it('rejects an initial member who is not an org member', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await expect(
			t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
				...CREDS,
				emailAddress: 'support@acme.test',
				memberUserIds: ['ghost-user'],
			})
		).rejects.toThrow(/not a member/i);
	});

	it('rejects an address already claimed by another active mailbox', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailboxes', {
				userId: 'someone',
				organizationId: 'org-1',
				address: 'support@acme.test',
				domain: 'acme.test',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		});
		await expect(
			t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
				...CREDS,
				emailAddress: 'support@acme.test',
				memberUserIds: [],
			})
		).rejects.toThrow(/already exists/i);
	});
});

describe('personal/shared external-account isolation', () => {
	it('a live SHARED external account does not block the admin connecting a PERSONAL one', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		// Connect a shared team inbox first (leaves a live scope=shared account).
		await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...CREDS,
			emailAddress: 'support@acme.test',
			memberUserIds: [],
		});

		// The same user connecting their OWN personal mailbox must NOT trip the
		// "one live external account per user" guard — that limit is personal-only.
		const { mailboxId } = await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'admin@personal.test',
			imapUsername: 'admin@personal.test',
		});
		const personal = await t.run((ctx) => ctx.db.get(mailboxId));
		expect(personal?.scope).toBeUndefined(); // personal default
		expect(personal?.kind).toBe('external');
	});

	it('still enforces one live PERSONAL external account per user', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await t.mutation(internal.mail.external.accounts._connectInternal, {
			...CREDS,
			emailAddress: 'admin@personal.test',
			imapUsername: 'admin@personal.test',
		});
		await expect(
			t.mutation(internal.mail.external.accounts._connectInternal, {
				...CREDS,
				emailAddress: 'admin2@personal.test',
				imapUsername: 'admin2@personal.test',
			})
		).rejects.toThrow(/already have a connected external/i);
	});
});

describe('removing a shared external inbox stops its sync worker', () => {
	it('marks the linked external account disconnected on mailbox delete', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);

		// Before delete: the account is connectable (pending) — the worker syncs it.
		const before = await t.query(internal.mail.external.accounts.listConnectableAccounts, {});
		expect(before.map((a) => a.accountId)).toContain(externalAccountId);

		await t.mutation(api.mail.mailbox.identity.remove, { mailboxId });

		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.status).toBe('disconnected');
		const after = await t.query(internal.mail.external.accounts.listConnectableAccounts, {});
		expect(after.map((a) => a.accountId)).not.toContain(externalAccountId);
	});
});

describe('a shared external account is invisible to the PERSONAL sending + migration surfaces', () => {
	it('sendingSwitchStatus / migration.getStatus ignore a caller who owns only a shared inbox', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await enableExternal(t);
		// The admin has connected ONLY a shared team inbox (no personal account).
		await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...CREDS,
			emailAddress: 'support@acme.test',
			memberUserIds: [],
		});

		// Neither personal surface may resolve the shared inbox as the caller's own.
		const sending = await t.query(api.mail.sendingSwitch.sendingSwitchStatus, {});
		expect(sending.configured).toBe(false);
		expect(await t.query(api.mail.migration.getStatus, {})).toBeNull();
	});

	it('migration.start refuses when the caller owns only a shared inbox', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await enableExternal(t);
		await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...CREDS,
			emailAddress: 'support@acme.test',
			memberUserIds: [],
		});
		await expect(t.mutation(api.mail.migration.start, {})).rejects.toThrow(/connect a mailbox/i);
	});
});

describe("shared migration — importing a team inbox's existing mail", () => {
	/** Connect a team inbox as `admin-user`, optionally with a roster. */
	async function connectInbox(
		t: TestConvex<typeof schema>,
		memberUserIds: string[] = []
	): Promise<{ mailboxId: Id<'mailboxes'>; externalAccountId: Id<'externalMailAccounts'> }> {
		setSession('admin-user', 'admin');
		return await t.mutation(internal.mail.external.sharedInbox._connectSharedInternal, {
			...CREDS,
			emailAddress: 'support@acme.test',
			memberUserIds,
		});
	}

	/** Every onboarding row in the instance — a shared import must write none. */
	async function onboardingRows(t: TestConvex<typeof schema>) {
		return await t.run((ctx) => ctx.db.query('userOnboarding').collect());
	}

	it('refuses a plain member; allows the mailbox owner and an org admin', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await seedUsers(t, 'user-B');
		const { mailboxId } = await connectInbox(t, ['user-B']);

		// A rostered MEMBER is below the owner floor every team-inbox management
		// surface uses — an import is management, not reading.
		setSession('user-B', 'editor');
		await expect(t.mutation(api.mail.migrationShared.startShared, { mailboxId })).rejects.toThrow(
			/permission/i
		);

		// Promoted to mailbox owner (still a plain org editor) → allowed.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailboxId).eq('authUserId', 'user-B')
				)
				.unique();
			await ctx.db.patch(row!._id, { role: 'owner' });
		});
		const started = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		expect(started.status).toBe('importing');

		// And the org admin reaches the same job (idempotent, not a second row).
		setSession('admin-user', 'admin');
		const again = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		expect(again.migrationId).toBe(started.migrationId);
	});

	it('refuses a personal or hosted mailbox id', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		setSession('admin-user', 'admin');
		const [hostedId, personalId] = await t.run(async (ctx) => {
			const now = Date.now();
			const base = {
				userId: 'admin-user',
				organizationId: 'org-1',
				domain: 'acme.test',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			};
			return [
				await ctx.db.insert('mailboxes', {
					...base,
					address: 'hosted@acme.test',
					kind: 'hosted' as const,
				}),
				// kind='external' but scope personal (undefined) — a BYO mailbox.
				await ctx.db.insert('mailboxes', {
					...base,
					address: 'me@acme.test',
					kind: 'external' as const,
				}),
			];
		});

		for (const mailboxId of [hostedId, personalId]) {
			await expect(t.mutation(api.mail.migrationShared.startShared, { mailboxId })).rejects.toThrow(
				/not an external team inbox/i
			);
		}
	});

	it('is idempotent while a migration is importing or indexing', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const { mailboxId } = await connectInbox(t);

		const first = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		const second = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		expect(second).toEqual({ migrationId: first.migrationId, status: 'importing' });

		await t.run((ctx) => ctx.db.patch(first.migrationId, { status: 'indexing' }));
		const third = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		expect(third).toEqual({ migrationId: first.migrationId, status: 'indexing' });

		const rows = await t.run((ctx) => ctx.db.query('mailboxMigrations').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.scope).toBe('shared');
	});

	it('resets the folder backfill cursors and leaves forward sync alone', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const { mailboxId, externalAccountId } = await connectInbox(t);
		await t.mutation(internal.mail.external.delivery.recordFolderMapping, {
			accountId: externalAccountId,
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUidValidity: 1,
			initialLastSeenUid: 100,
		});
		// A previous run left this folder fully walked.
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', externalAccountId))
				.first();
			await ctx.db.patch(row!._id, { backfillCursor: 0, backfillTotal: 40, backfillDone: 40 });
		});

		await t.mutation(api.mail.migrationShared.startShared, { mailboxId });

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', externalAccountId))
				.first();
			expect(row!.backfillCursor).toBeUndefined();
			expect(row!.backfillTotal).toBeUndefined();
			expect(row!.backfillDone).toBeUndefined();
			expect(row!.lastSeenUid).toBe(100); // forward sync of NEW mail untouched
		});
	});

	it('never stamps an onboarding step — on start, import completion, or indexing', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const { mailboxId } = await connectInbox(t);

		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		expect(await onboardingRows(t)).toHaveLength(0);

		await t.mutation(internal.mail.migration.completeBackfillImport, { migrationId });
		expect(await onboardingRows(t)).toHaveLength(0);

		// And the knowledge sweep's terminal transition stamps nothing either.
		await t.run((ctx) => ctx.db.patch(migrationId, { status: 'indexing' }));
		await t.mutation(internal.mail.migrationIndexing.finalizeMigration, {
			migrationId,
			status: 'completed',
			indexingRanToCompletion: true,
		});
		expect(await onboardingRows(t)).toHaveLength(0);
	});

	it('leaves knowledge indexing OFF unless opted in with the ai.knowledge flag on', async () => {
		// Default: no opt-in, flag on → still off.
		const withFlag = convexTest(schema, modules);
		await enableFlags(withFlag, {
			'mail.external': true,
			ai: true,
			'ai.knowledge': true,
			inbox: true,
		});
		const { mailboxId: flagged } = await connectInbox(withFlag);
		const def = await withFlag.mutation(api.mail.migrationShared.startShared, {
			mailboxId: flagged,
		});
		expect((await withFlag.run((ctx) => ctx.db.get(def.migrationId)))!.isAiIndexingEnabled).toBe(
			false
		);

		// Opted in, flag OFF → still off (the opt-in can't switch the feature on).
		const noFlag = convexTest(schema, modules);
		await enableFlags(noFlag, { 'mail.external': true });
		const { mailboxId: unflagged } = await connectInbox(noFlag);
		const optedIn = await noFlag.mutation(api.mail.migrationShared.startShared, {
			mailboxId: unflagged,
			indexKnowledge: true,
		});
		expect((await noFlag.run((ctx) => ctx.db.get(optedIn.migrationId)))!.isAiIndexingEnabled).toBe(
			false
		);

		// Opted in AND the flag on → on.
		await withFlag.run((ctx) => ctx.db.patch(def.migrationId, { status: 'cancelled' }));
		const both = await withFlag.mutation(api.mail.migrationShared.startShared, {
			mailboxId: flagged,
			indexKnowledge: true,
		});
		expect((await withFlag.run((ctx) => ctx.db.get(both.migrationId)))!.isAiIndexingEnabled).toBe(
			true
		);
	});

	it('getStatusShared returns the job for an owner and null for a non-member', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await seedUsers(t, 'user-B');
		const { mailboxId } = await connectInbox(t, ['user-B']);
		expect(await t.query(api.mail.migrationShared.getStatusShared, { mailboxId })).toBeNull();

		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		const status = await t.query(api.mail.migrationShared.getStatusShared, { mailboxId });
		expect(status).toMatchObject({ _id: migrationId, status: 'importing', importPercent: 0 });

		// A rostered member is below the owner floor, an outsider has no access at
		// all — both get the same null (the read never confirms the inbox exists).
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.migrationShared.getStatusShared, { mailboxId })).toBeNull();
		setSession('user-Z', 'editor');
		expect(await t.query(api.mail.migrationShared.getStatusShared, { mailboxId })).toBeNull();
	});

	it('getStatusShared reports nothing at all when mail.external is off', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const { mailboxId } = await connectInbox(t);
		await t.mutation(api.mail.migrationShared.startShared, { mailboxId });
		expect(await t.query(api.mail.migrationShared.getStatusShared, { mailboxId })).not.toBeNull();

		// Read-side degradation, not a throw: the admin page renders this card
		// alongside others, and an instance without external mail has no team inbox
		// to report on.
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(settings!._id, { featureFlags: { 'mail.external': false } });
		});
		expect(await t.query(api.mail.migrationShared.getStatusShared, { mailboxId })).toBeNull();
	});

	it('cancelShared stops an in-flight import and is a no-op afterwards', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		const { mailboxId, externalAccountId } = await connectInbox(t);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });

		expect(await t.mutation(api.mail.migrationShared.cancelShared, { mailboxId })).toBe(true);
		await t.run(async (ctx) => {
			const m = await ctx.db.get(migrationId);
			expect(m!.status).toBe('cancelled');
			expect(m!.completedAt).toBeDefined();
		});
		// The worker's next poll goes idle.
		const work = await t.query(internal.mail.migration.getBackfillWork, {
			accountId: externalAccountId,
		});
		expect(work.isActive).toBe(false);

		expect(await t.mutation(api.mail.migrationShared.cancelShared, { mailboxId })).toBe(false);
	});

	it('refuses a member cancelling, and an outsider reaching either twin', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		await seedUsers(t, 'user-B');
		const { mailboxId } = await connectInbox(t, ['user-B']);
		await t.mutation(api.mail.migrationShared.startShared, { mailboxId });

		setSession('user-B', 'editor');
		await expect(t.mutation(api.mail.migrationShared.cancelShared, { mailboxId })).rejects.toThrow(
			/permission/i
		);
		setSession('user-Z', 'editor');
		await expect(t.mutation(api.mail.migrationShared.startShared, { mailboxId })).rejects.toThrow(
			/permission/i
		);
	});
});

describe('shared external inbox credential rotation / repair', () => {
	it('rotates the linked account credentials and resets it to pending', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);
		// Simulate the worker flagging a rotated password.
		await t.run((ctx) =>
			ctx.db.patch(externalAccountId, { status: 'auth_error', lastError: 'AUTHENTICATIONFAILED' })
		);

		await t.mutation(internal.mail.external.sharedInbox._updateCredentialsSharedInternal, {
			...CREDS,
			emailAddress: 'support@acme.test',
			imapHost: 'imap2.acme.test',
			secretCiphertext: 'ct2',
			mailboxId,
		});

		const account = await t.run((ctx) => ctx.db.get(externalAccountId));
		expect(account?.status).toBe('pending'); // worker re-validates
		expect(account?.lastError).toBeUndefined();
		expect(account?.imapHost).toBe('imap2.acme.test');
		expect(account?.secretCiphertext).toBe('ct2');
		// Back on the worker's connectable set after the repair.
		const connectable = await t.query(internal.mail.external.accounts.listConnectableAccounts, {});
		expect(connectable.map((a) => a.accountId)).toContain(externalAccountId);
	});

	it('surfaces the account status (never the secret) to admins via getSharedExternalAccount', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);
		await t.run((ctx) => ctx.db.patch(externalAccountId, { status: 'auth_error' }));

		const view = await t.query(api.mail.external.sharedInbox.getSharedExternalAccount, {
			mailboxId,
		});
		expect(view.configured).toBe(true);
		if (!view.configured) return;
		expect(view.status).toBe('auth_error');
		expect(view.imapHost).toBe(CREDS.imapHost);
		expect(view).not.toHaveProperty('secretCiphertext');
	});

	it('hides connection metadata from a plain member (owner floor, soft-fail)', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedUsers(t, 'user-B');
		// user-B is on the roster as a plain `member`, not an owner.
		const { mailboxId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: ['user-B'] }
		);
		// The member can read the inbox, but getSharedExternalAccount is gated at the
		// `owner` floor — so its connection metadata stays invisible (soft-fail),
		// pinning the owner-only floor against a silent regression to member-readable.
		setSession('user-B', 'editor');
		expect(await t.query(api.mail.mailboxMembers.myRole, { mailboxId })).toBe('member');
		const view = await t.query(api.mail.external.sharedInbox.getSharedExternalAccount, {
			mailboxId,
		});
		expect(view.configured).toBe(false);
	});

	it('listShared surfaces the linked external account status for the admin overview', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);
		await t.run((ctx) =>
			ctx.db.patch(externalAccountId, { status: 'auth_error', lastError: 'bad password' })
		);
		const list = await t.query(api.mail.mailboxMembers.listShared, {});
		const row = list.find((m) => m._id === mailboxId)!;
		expect(row.externalStatus).toBe('auth_error');
		expect(row.externalLastError).toBe('bad password');
	});

	it('refuses a non-admin repairing the team inbox', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const { mailboxId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);
		// A non-member editor has no owner access to the team inbox.
		setSession('editor-user', 'editor');
		await expect(
			t.mutation(internal.mail.external.sharedInbox._updateCredentialsSharedInternal, {
				...CREDS,
				emailAddress: 'support@acme.test',
				mailboxId,
			})
		).rejects.toThrow(/permission/i);
	});
});

describe('purging a removed shared external inbox', () => {
	it('cascade-deletes the account, mailbox, and roster', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedUsers(t, 'user-B');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: ['user-B'] }
		);
		// Remove (soft-delete) first, mirroring the admin flow.
		await t.mutation(api.mail.mailbox.identity.remove, { mailboxId });

		vi.useFakeTimers();
		try {
			await t.mutation(api.mail.external.sharedInbox.purgeShared, { mailboxId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			expect(await ctx.db.get(externalAccountId)).toBeNull();
			expect(await ctx.db.get(mailboxId)).toBeNull();
			const roster = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailboxId))
				.collect();
			expect(roster).toHaveLength(0);
		});
	});

	it('cancels an in-flight import before the first purge chunk runs', async () => {
		const t = convexTest(schema, modules);
		await enableFlags(t, { 'mail.external': true });
		setSession('admin-user', 'admin');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);
		const { migrationId } = await t.mutation(api.mail.migrationShared.startShared, { mailboxId });

		vi.useFakeTimers();
		try {
			// No `finishAllScheduledFunctions`: the point is the state the purge
			// leaves BEFORE its cascade runs. A mid-walk worker polls in that window,
			// and an `importing` row would keep it fetching into a draining mailbox.
			await t.mutation(api.mail.external.sharedInbox.purgeShared, { mailboxId });

			const cancelled = await t.run((ctx) => ctx.db.get(migrationId));
			expect(cancelled!.status).toBe('cancelled');
			expect(cancelled!.completedAt).toBeDefined();
			const work = await t.query(internal.mail.migration.getBackfillWork, {
				accountId: externalAccountId,
			});
			expect(work.isActive).toBe(false);

			// The cascade still runs to completion afterwards.
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		await t.run(async (ctx) => {
			expect(await ctx.db.get(externalAccountId)).toBeNull();
			expect(await ctx.db.get(migrationId)).toBeNull();
		});
	});

	it('rejects a non-admin caller', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		const { mailboxId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);
		setSession('editor-user', 'editor');
		await expect(
			t.mutation(api.mail.external.sharedInbox.purgeShared, { mailboxId })
		).rejects.toThrow(/owners and admins/i);
	});
});

describe('member erasure preserves a shared team inbox (org infrastructure)', () => {
	it('keeps the shared mailbox, its credentials, and the custodian owner row', async () => {
		const t = convexTest(schema, modules);
		setSession('admin-user', 'admin');
		await seedUsers(t, 'admin-user');
		const { mailboxId, externalAccountId } = await t.mutation(
			internal.mail.external.sharedInbox._connectSharedInternal,
			{ ...CREDS, emailAddress: 'support@acme.test', memberUserIds: [] }
		);

		const requestId = await t.run(async (ctx) => {
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'admin-user'))
				.first();
			const now = Date.now();
			return await ctx.db.insert('accountDeletionRequests', {
				userProfileId: profile!._id,
				email: 'admin-user@owlat.test',
				requestedAt: now,
				scheduledForDeletion: now,
				cancellationToken: 'tok',
				status: 'pending',
				createdAt: now,
			});
		});

		vi.useFakeTimers();
		try {
			await t.mutation(internal.auth.memberErasure.eraseMemberData, {
				authUserId: 'admin-user',
				requestId,
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}

		await t.run(async (ctx) => {
			// The team inbox, its credential row, and the custodian's owner membership
			// all survive the erasure — they are org infrastructure, not personal data.
			expect(await ctx.db.get(mailboxId)).not.toBeNull();
			const account = await ctx.db.get(externalAccountId);
			expect(account).not.toBeNull();
			expect(account?.scope).toBe('shared');
			const owner = await ctx.db
				.query('mailboxMembers')
				.withIndex('by_mailbox_user', (q) =>
					q.eq('mailboxId', mailboxId).eq('authUserId', 'admin-user')
				)
				.unique();
			expect(owner?.role).toBe('owner');
		});
	});
});
