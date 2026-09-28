/**
 * `mail/contacts.senderState` answers the reader's "Accept sender" question
 * with the Reply Queue gate's own rule (`resolveScreenerEnabled` +
 * `isScreenedOut`), so the button only appears for mail the gate held back:
 *
 * - a SHARED mailbox never screens, whoever calls and whatever their toggles
 *   (the gate turns the screener off there, so there is nothing to accept);
 * - a personal mailbox follows its owner's preference, shown to the owner;
 * - any other caller on a personal mailbox reads the screener as off, so the
 *   owner's preference never leaks to a delegate (L17).
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

type T = ReturnType<typeof convexTest>;

function setSession(userId: string, role: 'owner' | 'admin' | 'editor' | null) {
	sessionMock.userId = userId;
	sessionMock.role = role;
}

async function seedScreener(t: T, userId: string, on: boolean): Promise<void> {
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

async function seedContact(
	t: T,
	mailboxId: Id<'mailboxes'>,
	email: string,
	flags: { isVip?: boolean; isScreenerAccepted?: boolean; useCount?: number } = {}
): Promise<void> {
	await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert('mailContacts', {
			mailboxId,
			email,
			useCount: flags.useCount ?? 0,
			lastUsedAt: now,
			...(flags.isVip !== undefined ? { isVip: flags.isVip } : {}),
			...(flags.isScreenerAccepted !== undefined
				? { isScreenerAccepted: flags.isScreenerAccepted }
				: {}),
			createdAt: now,
		});
	});
}

async function senderState(t: T, mailboxId: Id<'mailboxes'>, email = 'stranger@example.com') {
	return t.query(api.mail.contacts.senderState, { mailboxId, email });
}

describe('mail/contacts.senderState — shared mailbox', () => {
	it.each([
		{ ownerOn: true, delegateOn: true },
		{ ownerOn: true, delegateOn: false },
		{ ownerOn: false, delegateOn: true },
	])(
		'never offers Accept (owner on: $ownerOn, delegate on: $delegateOn)',
		async ({ ownerOn, delegateOn }) => {
			const t = convexTest(schema, modules);
			const mailboxId = await seedMailbox(t, {
				userId: 'owner-user',
				organizationId: 'org-1',
				scope: 'shared',
			});
			await seedScreener(t, 'owner-user', ownerOn);
			await seedScreener(t, 'delegate-user', delegateOn);

			for (const [userId, role] of [
				['owner-user', 'owner'],
				['delegate-user', 'admin'],
			] as const) {
				setSession(userId, role);
				const state = await senderState(t, mailboxId);
				expect(state.isScreenerEnabled, userId).toBe(false);
				expect(state.canAccept, userId).toBe(false);
			}
		}
	);
});

describe('mail/contacts.senderState — personal mailbox', () => {
	async function personalMailbox(t: T, ownerOn: boolean): Promise<Id<'mailboxes'>> {
		const mailboxId = await seedMailbox(t, { userId: 'owner-user', organizationId: 'org-1' });
		await seedScreener(t, 'owner-user', ownerOn);
		return mailboxId;
	}

	it('offers Accept to the owner for an unknown sender while the screener is on', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await personalMailbox(t, true);
		setSession('owner-user', 'owner');
		const state = await senderState(t, mailboxId);
		expect(state).toEqual({
			isVip: false,
			isKnown: false,
			isScreenerAccepted: false,
			isScreenerEnabled: true,
			canAccept: true,
		});
	});

	it('offers nothing while the owner has the screener off', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await personalMailbox(t, false);
		setSession('owner-user', 'owner');
		const state = await senderState(t, mailboxId);
		expect(state.isScreenerEnabled).toBe(false);
		expect(state.canAccept).toBe(false);
	});

	it.each([
		{ name: 'known', flags: { useCount: 3 } },
		{ name: 'VIP', flags: { isVip: true } },
		{ name: 'accepted', flags: { isScreenerAccepted: true } },
	])('does not offer Accept for a $name sender', async ({ flags }) => {
		const t = convexTest(schema, modules);
		const mailboxId = await personalMailbox(t, true);
		await seedContact(t, mailboxId, 'friend@example.com', flags);
		setSession('owner-user', 'owner');
		const state = await senderState(t, mailboxId, 'Friend@Example.com');
		expect(state.isScreenerEnabled).toBe(true);
		expect(state.isKnown).toBe(true);
		expect(state.canAccept).toBe(false);
	});

	it("never shows another caller the owner's screener preference", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await personalMailbox(t, true);
		// The caller's own toggle does not apply to someone else's mailbox either.
		await seedScreener(t, 'admin-user', true);
		setSession('admin-user', 'admin');
		const state = await senderState(t, mailboxId);
		expect(state.isScreenerEnabled).toBe(false);
		expect(state.canAccept).toBe(false);
	});

	it('returns the empty state without a session', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await personalMailbox(t, true);
		setSession('owner-user', null);
		const state = await senderState(t, mailboxId);
		expect(state.canAccept).toBe(false);
		expect(state.isScreenerEnabled).toBe(false);
	});
});
