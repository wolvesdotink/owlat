/**
 * Per-sender remote-image allowlist (mail/imageAllowlist).
 *
 * Covers the grant/revoke round trip, the canonicalization that makes a grant
 * match the lowercased `mailMessages.fromAddress` the reader looks it up by,
 * idempotency, and the mailbox ownership gate: a non-owner editor must not be
 * able to read another mailbox's trusted senders or add one to it.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { modules, seedMailbox } from './helpers.testlib';

const sessionMock = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'editor' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: sessionMock.userId, role: sessionMock.role })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
			activeOrganizationId: 'org-1',
		})),
	};
});

beforeEach(() => {
	sessionMock.userId = 'user-A';
	sessionMock.role = 'editor';
});

describe('mail.imageAllowlist', () => {
	it('grants, lists and revokes a sender', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });

		await t.mutation(api.mail.imageAllowlist.allow, {
			mailboxId,
			senderEmail: 'news@stratechery.com',
		});
		let list = await t.query(api.mail.imageAllowlist.list, { mailboxId });
		expect(list.map((row) => row.senderEmail)).toEqual(['news@stratechery.com']);

		const revoked = await t.mutation(api.mail.imageAllowlist.revoke, {
			mailboxId,
			senderEmail: 'news@stratechery.com',
		});
		expect(revoked.revoked).toBe(true);
		list = await t.query(api.mail.imageAllowlist.list, { mailboxId });
		expect(list).toEqual([]);
	});

	it('canonicalizes the address so it matches the stored fromAddress', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });

		await t.mutation(api.mail.imageAllowlist.allow, {
			mailboxId,
			senderEmail: '  News@Stratechery.COM ',
		});
		const list = await t.query(api.mail.imageAllowlist.list, { mailboxId });
		expect(list[0]?.senderEmail).toBe('news@stratechery.com');
	});

	it('is idempotent — a second grant keeps one row', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });

		const first = await t.mutation(api.mail.imageAllowlist.allow, {
			mailboxId,
			senderEmail: 'news@stratechery.com',
		});
		const second = await t.mutation(api.mail.imageAllowlist.allow, {
			mailboxId,
			senderEmail: 'NEWS@stratechery.com',
		});
		expect(second).toBe(first);
		expect(await t.query(api.mail.imageAllowlist.list, { mailboxId })).toHaveLength(1);
	});

	it('revoking a sender that was never granted is a no-op', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		const result = await t.mutation(api.mail.imageAllowlist.revoke, {
			mailboxId,
			senderEmail: 'nobody@example.com',
		});
		expect(result.revoked).toBe(false);
	});

	it('rejects an address with no @', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		await expect(
			t.mutation(api.mail.imageAllowlist.allow, { mailboxId, senderEmail: 'stratechery.com' })
		).rejects.toThrow();
	});

	it("a non-owner editor cannot read or extend another user's allowlist", async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { userId: 'user-A' });
		await t.mutation(api.mail.imageAllowlist.allow, {
			mailboxId,
			senderEmail: 'news@stratechery.com',
		});

		sessionMock.userId = 'user-B';
		expect(await t.query(api.mail.imageAllowlist.list, { mailboxId })).toEqual([]);
		await expect(
			t.mutation(api.mail.imageAllowlist.allow, { mailboxId, senderEmail: 'spam@evil.example' })
		).rejects.toThrow();
		await expect(
			t.mutation(api.mail.imageAllowlist.revoke, { mailboxId, senderEmail: 'news@stratechery.com' })
		).rejects.toThrow();
	});
});
