/**
 * Coverage for mail.mailbox.inboxUnreadCount — the value behind the desktop
 * dock/taskbar badge. Sums the caller's own inbox `unseenCount` and is scoped
 * to the caller's mailboxes.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('llmProvider')
	)
);

describe('mail.mailbox.inboxUnreadCount', () => {
	it("sums the caller's own inbox unseenCount and ignores other users' mail", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = Date.now();
			const mine = await ctx.db.insert('mailboxes', {
				userId: 'test-user',
				organizationId: 'test-org',
				address: 'me@example.com',
				domain: 'example.com',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('mailFolders', {
				mailboxId: mine,
				name: 'INBOX',
				role: 'inbox',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 5,
				unseenCount: 3,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
			// Another user's mailbox unread must NOT leak into the badge.
			const theirs = await ctx.db.insert('mailboxes', {
				userId: 'other-user',
				organizationId: 'test-org',
				address: 'other@example.com',
				domain: 'example.com',
				status: 'active',
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('mailFolders', {
				mailboxId: theirs,
				name: 'INBOX',
				role: 'inbox',
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 9,
				unseenCount: 9,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		});

		const unread = await t.query(api.mail.mailbox.inboxUnreadCount, {});
		expect(unread).toBe(3);
	});
});
