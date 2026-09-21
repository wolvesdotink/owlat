/**
 * L17 — `mail/contacts.senderState` reads the sender-screener toggle for the
 * CALLER (`owned.userId`), not the mailbox OWNER (`owned.mailbox.userId`). On a
 * shared mailbox a delegate must see their OWN screener state; keying it on the
 * mailbox owner leaked the owner's preference to every delegate.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'owner-user',
	role: 'owner' as 'owner' | 'admin' | 'editor' | null,
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

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null) {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

async function seedScreener(
	t: ReturnType<typeof convexTest>,
	userId: string,
	on: boolean
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailUserSettings', {
			userId,
			autoAdvance: 'next',
			isSenderScreenerOn: on,
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('mail/contacts.senderState — keyed on the caller', () => {
	it("returns the delegate's screener state, not the mailbox owner's", async () => {
		const t = convexTest(schema, modules);

		// Shared mailbox owned by owner-user; owner has the screener ON.
		setSession('owner-user', 'owner');
		const mailboxId: Id<'mailboxes'> = await seedMailbox(t, {
			userId: 'owner-user',
			organizationId: 'org-1',
			scope: 'shared',
		});
		await seedScreener(t, 'owner-user', true);
		// The delegate (an org admin acting on the shared mailbox) has it OFF.
		await seedScreener(t, 'delegate-user', false);

		// Delegate calls senderState — they get access as an org admin, so
		// owned.userId === 'delegate-user'.
		setSession('delegate-user', 'admin');
		const state = await t.query(api.mail.contacts.senderState, {
			mailboxId,
			email: 'someone@example.com',
		});
		// The caller's OFF state, not the owner's ON state.
		expect(state.isScreenerEnabled).toBe(false);
	});

	it("reflects the caller's own ON toggle", async () => {
		const t = convexTest(schema, modules);
		setSession('owner-user', 'owner');
		const mailboxId = await seedMailbox(t, {
			userId: 'owner-user',
			organizationId: 'org-1',
			scope: 'shared',
		});
		await seedScreener(t, 'owner-user', false);
		await seedScreener(t, 'delegate-user', true);

		setSession('delegate-user', 'admin');
		const state = await t.query(api.mail.contacts.senderState, {
			mailboxId,
			email: 'someone@example.com',
		});
		expect(state.isScreenerEnabled).toBe(true);
	});
});
