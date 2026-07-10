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
import { modules, seedMailbox } from './helpers';
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
