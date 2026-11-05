/**
 * Done and Reopen: the stamp that marks a conversation done until newer mail,
 * and Reopen bringing the Archive copies back to the Inbox. The move of the
 * Inbox mail to Archive is `archiveThreads`, tested in its own module.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../../schema';
import { api } from '../../../_generated/api';
import { modules, seedFolder, seedMailbox, seedMessage } from '../../__tests__/helpers.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type T = TestConvex<typeof schema>;
let t: T;
beforeEach(() => {
	t = convexTest({ schema, modules });
});

async function seedBox(userId = 'user-A', address = 'me@owlat.test', organizationId = 'org-1') {
	const mailboxId = await seedMailbox(t, { userId, address, organizationId });
	for (const role of ['inbox', 'archive', 'sent'] as const) await seedFolder(t, mailboxId, role);
	return mailboxId;
}

async function messageAndThread(messageId: Awaited<ReturnType<typeof seedMessage>>) {
	return await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const folder = (await ctx.db.get(message.folderId))!;
		const thread = (await ctx.db.get(message.threadId!))!;
		return { role: folder.role, thread };
	});
}

describe('markDone and reopen', () => {
	it('marks a conversation done at or after its latest message', async () => {
		const mailboxId = await seedBox();
		const later = Date.now() + 60_000;
		const messageId = await seedMessage(t, mailboxId, { role: 'sent', receivedAt: later });
		const { thread } = await messageAndThread(messageId);

		await t.mutation(api.mail.people.done.markDone, { threadId: thread._id });

		const after = (await messageAndThread(messageId)).thread;
		expect(after.doneAt).toBeGreaterThanOrEqual(later);
		expect(after.doneBy).toBe('user-A');
	});

	it('moves the archived mail back to the Inbox and clears the mark', async () => {
		const mailboxId = await seedBox();
		const messageId = await seedMessage(t, mailboxId, { role: 'archive' });
		const { thread } = await messageAndThread(messageId);
		await t.mutation(api.mail.people.done.markDone, { threadId: thread._id });

		const result = await t.mutation(api.mail.people.done.reopen, { threadId: thread._id });

		const after = await messageAndThread(messageId);
		expect(result).toEqual({ hasMore: false });
		expect(after.role).toBe('inbox');
		expect(after.thread.doneAt).toBeUndefined();
		expect(after.thread.doneBy).toBeUndefined();
	});

	it('unmutes a muted conversation it reopens, so it is open again', async () => {
		const mailboxId = await seedBox();
		const messageId = await seedMessage(t, mailboxId, { role: 'archive' });
		const { thread } = await messageAndThread(messageId);
		await t.run(async (ctx) => ctx.db.patch(thread._id, { mutedAt: Date.now() }));

		await t.mutation(api.mail.people.done.reopen, { threadId: thread._id });

		expect((await messageAndThread(messageId)).thread.mutedAt).toBeUndefined();
	});

	it('refuses a conversation in a mailbox the caller cannot reach', async () => {
		const mailboxId = await seedBox('user-B', 'other@owlat.test', 'org-2');
		const messageId = await seedMessage(t, mailboxId, { role: 'inbox' });
		const { thread } = await messageAndThread(messageId);

		await expect(
			t.mutation(api.mail.people.done.markDone, { threadId: thread._id })
		).rejects.toThrow();
		expect((await messageAndThread(messageId)).thread.doneAt).toBeUndefined();
	});
});
