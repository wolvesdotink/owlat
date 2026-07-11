/**
 * Send-as choice for shared (team) inboxes.
 *
 * Covers the identity-resolution + sanctioned-send-as core in `mail/identities.ts`
 * and the `drafts.setIdentity` binding:
 *   - the resolution MATRIX: a teammate composing in a shared inbox is offered
 *     the team identity plus their OWN personal identities (with vs without a
 *     personal mailbox), and a personal inbox is offered only its own identity;
 *   - the dispatch-time re-check BLOCKS every non-sanctioned cross-mailbox From
 *     while allowing the sanctioned personal identity;
 *   - `setIdentity` records `sendAsMailboxId` for a personal pick (so the sent
 *     copy + transport route from that mailbox) and clears it for the team pick.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';
import { internal } from '../../_generated/api';
import { resolveSendAsIdentitiesForCtx, isSanctionedSendAsForUser } from '../identities';

// One mutable hoisted session drives both the authedMutation wrapper floor
// (`getMutationContext`) and the in-handler mailbox gate
// (`getBetterAuthSessionWithRole`). See mailboxAccess.test.ts for the rationale.
const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor' | null,
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

async function addMember(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	authUserId: string,
	role: 'owner' | 'member' = 'member'
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('mailboxMembers', {
			mailboxId,
			authUserId,
			role,
			addedBy: 'admin-user',
			createdAt: Date.now(),
		});
	});
}

async function seedDraft(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	fromAddress: string
): Promise<Id<'mailDrafts'>> {
	let id!: Id<'mailDrafts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailDrafts', {
			mailboxId,
			toAddresses: ['out@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress,
			subject: 'hi',
			bodyHtml: '<p>hi</p>',
			attachments: [],
			state: 'draft',
			lastEditedAt: now,
			createdAt: now,
		});
	});
	return id;
}

async function seedSentFolder(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<Id<'mailFolders'>> {
	let id!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'Sent',
			role: 'sent',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

async function seedThread(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>,
	opts: { needsReplyPendingAt?: number } = {}
): Promise<Id<'mailThreads'>> {
	let id!: Id<'mailThreads'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'hi',
			participants: ['out@example.com'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'prior',
			latestFromAddress: 'out@example.com',
			latestSubject: 'hi',
			folderRoles: ['inbox'],
			labelIds: [],
			...(opts.needsReplyPendingAt !== undefined
				? { needsReplyPendingAt: opts.needsReplyPendingAt }
				: {}),
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

/** Seed a queued (`pending_send`) draft ready to transition to `sent`. */
async function seedPendingDraft(
	t: TestConvex<typeof schema>,
	fields: {
		mailboxId: Id<'mailboxes'>;
		fromAddress: string;
		threadId?: Id<'mailThreads'>;
		sendAsMailboxId?: Id<'mailboxes'>;
		sentByUserId?: string;
	}
): Promise<Id<'mailDrafts'>> {
	let id!: Id<'mailDrafts'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailDrafts', {
			mailboxId: fields.mailboxId,
			threadId: fields.threadId,
			sendAsMailboxId: fields.sendAsMailboxId,
			sentByUserId: fields.sentByUserId,
			toAddresses: ['out@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: fields.fromAddress,
			subject: 'hi',
			bodyHtml: '<p>hi</p>',
			bodyText: 'hi',
			attachments: [],
			state: 'pending_send',
			lastEditedAt: now,
			createdAt: now,
		});
	});
	return id;
}

const RAW_SIZE = 321;

async function transitionToSent(
	t: TestConvex<typeof schema>,
	draftId: Id<'mailDrafts'>
): Promise<void> {
	const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw .eml bytes'])));
	await t.mutation(internal.mail.draftLifecycle.transition, {
		draftId,
		input: {
			to: 'sent' as const,
			at: Date.now(),
			context: {
				rawStorageId,
				rawSize: RAW_SIZE,
				rfc822MessageId: 'msg-1@hinterland.camp',
				references: [],
				bodyHtml: '<p>hi</p>',
				bodyText: 'hi',
				attachmentsMeta: [],
			},
		},
	});
}

describe('runSentEffects — sent-copy placement', () => {
	it('classic path: sent copy lands in the thread mailbox’s Sent folder on the existing thread', async () => {
		const t = convexTest(schema, modules);
		const team = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		const sentFolder = await seedSentFolder(t, team);
		const teamThread = await seedThread(t, team);
		const draftId = await seedPendingDraft(t, {
			mailboxId: team,
			fromAddress: 'team@hinterland.camp',
			threadId: teamThread,
			sentByUserId: 'owner-user',
		});

		await transitionToSent(t, draftId);

		const messages = await t.run((ctx) => ctx.db.query('mailMessages').collect());
		expect(messages).toHaveLength(1);
		const sent = messages[0]!;
		expect(sent.mailboxId).toBe(team);
		expect(sent.folderId).toBe(sentFolder);
		// Reuses the existing team thread — no fresh thread is opened.
		expect(sent.threadId).toBe(teamThread);
		const threads = await t.run((ctx) => ctx.db.query('mailThreads').collect());
		expect(threads).toHaveLength(1);
		// Byte usage is charged to the team mailbox.
		const teamMb = await t.run((ctx) => ctx.db.get(team));
		expect(teamMb?.usedBytes).toBe(RAW_SIZE);
	});

	it('personal send-as: sent copy lands in the personal mailbox on a fresh thread; team thread gets the marker', async () => {
		const t = convexTest(schema, modules);
		const team = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });
		await addMember(t, team, 'user-B');
		const teamSent = await seedSentFolder(t, team);
		const personalSent = await seedSentFolder(t, personal);
		// The team thread is in the Reply Queue; sending must clear it.
		const teamThread = await seedThread(t, team, { needsReplyPendingAt: Date.now() });

		const draftId = await seedPendingDraft(t, {
			mailboxId: team, // the THREAD mailbox
			fromAddress: 'b@hinterland.camp',
			threadId: teamThread,
			sendAsMailboxId: personal, // routed through the personal mailbox
			sentByUserId: 'user-B',
		});

		await transitionToSent(t, draftId);

		const messages = await t.run((ctx) => ctx.db.query('mailMessages').collect());
		expect(messages).toHaveLength(1);
		const sent = messages[0]!;
		// Sent copy lives in the PERSONAL mailbox's Sent folder…
		expect(sent.mailboxId).toBe(personal);
		expect(sent.folderId).toBe(personalSent);
		expect(sent.folderId).not.toBe(teamSent);
		// …on a FRESH thread owned by the personal mailbox (not the team thread).
		expect(sent.threadId).not.toBe(teamThread);
		const freshThread = await t.run((ctx) => ctx.db.get(sent.threadId!));
		expect(freshThread?.mailboxId).toBe(personal);

		// usedBytes is charged to the PERSONAL mailbox, not the team mailbox.
		const personalMb = await t.run((ctx) => ctx.db.get(personal));
		const teamMb = await t.run((ctx) => ctx.db.get(team));
		expect(personalMb?.usedBytes).toBe(RAW_SIZE);
		expect(teamMb?.usedBytes).toBe(0);

		// The ORIGINAL team thread is stamped with the personal-address marker and
		// drops out of the Reply Queue — context never silently forks.
		const stampedTeamThread = await t.run((ctx) => ctx.db.get(teamThread));
		expect(stampedTeamThread?.latestReply?.isFromPersonalAddress).toBe(true);
		expect(stampedTeamThread?.latestReply?.byUserId).toBe('user-B');
		expect(stampedTeamThread?.needsReplyPendingAt).toBeUndefined();
	});
});

describe('resolveSendAsIdentitiesForCtx — resolution matrix', () => {
	it('personal inbox offers only its own identity (no send-as extras)', async () => {
		const t = convexTest(schema, modules);
		const personal = await seedMailbox(t, { userId: 'user-A', address: 'a@hinterland.camp' });
		const result = await t.run(async (ctx) => {
			const mb = await ctx.db.get(personal);
			return resolveSendAsIdentitiesForCtx(ctx, mb!, 'user-A');
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ address: 'a@hinterland.camp', kind: 'own' });
	});

	it('shared inbox — member WITH a personal mailbox is offered team + personal', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });
		await addMember(t, shared, 'user-B');

		const result = await t.run(async (ctx) => {
			const mb = await ctx.db.get(shared);
			return resolveSendAsIdentitiesForCtx(ctx, mb!, 'user-B');
		});
		const team = result.find((r) => r.mailboxId === shared);
		const own = result.find((r) => r.mailboxId === personal);
		expect(team).toMatchObject({ address: 'team@hinterland.camp', kind: 'team' });
		expect(own).toMatchObject({ address: 'b@hinterland.camp', kind: 'personal' });
	});

	it('shared inbox — member WITHOUT a personal mailbox gets only the team identity', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		await addMember(t, shared, 'user-C');

		const result = await t.run(async (ctx) => {
			const mb = await ctx.db.get(shared);
			return resolveSendAsIdentitiesForCtx(ctx, mb!, 'user-C');
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ mailboxId: shared, kind: 'team' });
	});

	it('shared inbox — an org admin WITHOUT a membership row is offered only the team identity', async () => {
		// Regression: the offer path reaches the shared mailbox via
		// requireMailboxAccess, whose org owner/admin role-bypass grants access with
		// no mailboxMembers row. Offering that admin their personal identity would
		// let setIdentity accept a pick the dispatch re-check then revokes
		// (from_revoked after Send). The offered set must match the sanctioned set:
		// no membership ⇒ no personal send-as, only the team identity.
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		// admin-user owns a personal mailbox but is NOT a member of the shared inbox.
		await seedMailbox(t, { userId: 'admin-user', address: 'admin@hinterland.camp' });

		const result = await t.run(async (ctx) => {
			const mb = await ctx.db.get(shared);
			return resolveSendAsIdentitiesForCtx(ctx, mb!, 'admin-user');
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ mailboxId: shared, kind: 'team' });
		expect(result.some((r) => r.mailboxId !== shared)).toBe(false);
	});

	it('shared inbox does NOT offer another org member’s shared mailbox as personal', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		// user-B owns another SHARED mailbox — not a personal identity, so excluded.
		await seedMailbox(t, { userId: 'user-B', address: 'other@hinterland.camp', scope: 'shared' });
		await addMember(t, shared, 'user-B');

		const result = await t.run(async (ctx) => {
			const mb = await ctx.db.get(shared);
			return resolveSendAsIdentitiesForCtx(ctx, mb!, 'user-B');
		});
		expect(result.every((r) => r.mailboxId === shared)).toBe(true);
	});
});

describe('isSanctionedSendAsForUser — dispatch-time re-check', () => {
	it('allows the team identity (sending === thread) with an allowed From', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: shared,
				sendingMailboxId: shared,
				fromAddress: 'team@hinterland.camp',
				userId: 'anyone',
			})
		);
		expect(ok).toBe(true);
	});

	it('blocks a From that is not in the sending mailbox allow-set', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, { address: 'team@hinterland.camp', scope: 'shared' });
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: shared,
				sendingMailboxId: shared,
				fromAddress: 'spoof@gmail.com',
				userId: 'anyone',
			})
		);
		expect(ok).toBe(false);
	});

	it('allows a member’s own personal identity used inside a shared thread', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, { address: 'team@hinterland.camp', scope: 'shared' });
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });
		await addMember(t, shared, 'user-B');
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: shared,
				sendingMailboxId: personal,
				fromAddress: 'b@hinterland.camp',
				userId: 'user-B',
			})
		);
		expect(ok).toBe(true);
	});

	it('blocks a cross-mailbox From the sender does NOT own', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, { address: 'team@hinterland.camp', scope: 'shared' });
		const someoneElse = await seedMailbox(t, { userId: 'user-D', address: 'd@hinterland.camp' });
		await addMember(t, shared, 'user-B');
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: shared,
				sendingMailboxId: someoneElse,
				fromAddress: 'd@hinterland.camp',
				userId: 'user-B',
			})
		);
		expect(ok).toBe(false);
	});

	it('blocks send-as when the sender is not a member of the shared thread', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, { address: 'team@hinterland.camp', scope: 'shared' });
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });
		// No membership row for user-B on the shared mailbox.
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: shared,
				sendingMailboxId: personal,
				fromAddress: 'b@hinterland.camp',
				userId: 'user-B',
			})
		);
		expect(ok).toBe(false);
	});

	it('blocks personal send-as for an org admin who is not a member of the shared thread', async () => {
		// The dispatch check knows nothing about org roles — it requires the
		// mailbox's own user or an explicit membership row. This pins the admin case
		// so the offer restriction above and the dispatch refusal stay in lockstep.
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		const adminPersonal = await seedMailbox(t, {
			userId: 'admin-user',
			address: 'admin@hinterland.camp',
		});
		// admin-user has NO membership row on the shared mailbox.
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: shared,
				sendingMailboxId: adminPersonal,
				fromAddress: 'admin@hinterland.camp',
				userId: 'admin-user',
			})
		);
		expect(ok).toBe(false);
	});

	it('blocks send-as when the thread mailbox is personal (no team context)', async () => {
		const t = convexTest(schema, modules);
		const threadPersonal = await seedMailbox(t, { userId: 'user-A', address: 'a@hinterland.camp' });
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });
		const ok = await t.run((ctx) =>
			isSanctionedSendAsForUser(ctx, {
				threadMailboxId: threadPersonal,
				sendingMailboxId: personal,
				fromAddress: 'b@hinterland.camp',
				userId: 'user-B',
			})
		);
		expect(ok).toBe(false);
	});
});

describe('drafts.setIdentity — records the sending mailbox', () => {
	it('records sendAsMailboxId for a personal pick and clears it for the team pick', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		const personal = await seedMailbox(t, { userId: 'user-B', address: 'b@hinterland.camp' });
		await addMember(t, shared, 'user-B');
		const draftId = await seedDraft(t, shared, 'team@hinterland.camp');

		setSession('user-B', 'editor');
		// Personal identity → sendAsMailboxId points at the personal mailbox.
		await t.mutation(api.mail.drafts.setIdentity, {
			draftId,
			fromAddress: 'b@hinterland.camp',
		});
		let draft = await t.run((ctx) => ctx.db.get(draftId));
		expect(draft?.fromAddress).toBe('b@hinterland.camp');
		expect(draft?.sendAsMailboxId).toBe(personal);

		// Switching back to the team identity clears the send-as binding.
		await t.mutation(api.mail.drafts.setIdentity, {
			draftId,
			fromAddress: 'team@hinterland.camp',
		});
		draft = await t.run((ctx) => ctx.db.get(draftId));
		expect(draft?.fromAddress).toBe('team@hinterland.camp');
		expect(draft?.sendAsMailboxId).toBeUndefined();
	});

	it('rejects a From that is neither the team nor one of the sender’s own identities', async () => {
		const t = convexTest(schema, modules);
		const shared = await seedMailbox(t, {
			userId: 'owner-user',
			address: 'team@hinterland.camp',
			scope: 'shared',
		});
		// A mailbox owned by someone else — never a sanctioned From for user-B.
		await seedMailbox(t, { userId: 'user-D', address: 'd@hinterland.camp' });
		await addMember(t, shared, 'user-B');
		const draftId = await seedDraft(t, shared, 'team@hinterland.camp');

		setSession('user-B', 'editor');
		await expect(
			t.mutation(api.mail.drafts.setIdentity, {
				draftId,
				fromAddress: 'd@hinterland.camp',
			})
		).rejects.toThrow();
	});
});
