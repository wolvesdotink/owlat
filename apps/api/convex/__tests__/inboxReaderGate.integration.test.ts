/**
 * Modules outside inbox/ that serve Team Inbox rows ask the shared-inbox
 * reader gate (inbox/access.ts): an owner or admin passes, any other member is
 * refused (or, on a soft read, given nothing).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestContact, createTestConversationThread, enableFeatures } from './factories';
import type * as SessionOrganization from '../lib/sessionOrganization';

const sess = vi.hoisted(() => ({ role: 'editor' as 'owner' | 'admin' | 'editor' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = () => ({
		userId: 'user-a',
		role: sess.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		getMutationContext: vi.fn(async () => session()),
		getUserIdFromSession: vi.fn(async () => 'user-a'),
	};
});

const modules = import.meta.glob('../**/*.*s');

type T = ReturnType<typeof convexTest>;

async function seedThread(t: T) {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const threadId = await ctx.db.insert(
			'conversationThreads',
			createTestConversationThread({ contactId, updatedAt: undefined })
		);
		const now = Date.now();
		const roomId = await ctx.db.insert('chatRooms', {
			kind: 'channel',
			name: 'support',
			normalizedName: 'support',
			visibility: 'public',
			createdBy: 'user-a',
			createdAt: now,
			updatedAt: now,
			lastMessageAt: now,
			messageCount: 0,
			linkedInboxThreadId: threadId,
		});
		return { contactId, threadId, roomId };
	});
}

beforeEach(() => {
	sess.role = 'editor';
});

describe('Team Inbox reads outside inbox/ follow the reader gate', () => {
	it('refuses a member the unified timelines and a chat reply on a thread', async () => {
		const t = convexTest(schema, modules);
		const { contactId, threadId } = await seedThread(t);

		await expect(t.query(api.unifiedMessages.getThreadTimeline, { threadId })).rejects.toThrow(
			/Team Inbox/
		);
		await expect(t.query(api.unifiedMessages.getContactTimeline, { contactId })).rejects.toThrow(
			/Team Inbox/
		);
		await expect(t.query(api.unifiedMessages.listRecent, {})).rejects.toThrow(/Team Inbox/);
		await expect(
			t.mutation(api.unifiedMessages.sendChatMessage, { threadId, text: 'hi' })
		).rejects.toThrow(/Team Inbox/);

		sess.role = 'admin';
		await t.mutation(api.unifiedMessages.sendChatMessage, { threadId, text: 'hi' });
		const timeline = await t.query(api.unifiedMessages.getThreadTimeline, { threadId });
		expect(timeline).toHaveLength(1);
	});

	it('refuses a member a manual channel reply before anything is sent', async () => {
		const t = convexTest(schema, modules);
		const { contactId, threadId } = await seedThread(t);

		await expect(
			t.action(api.channels.outbound.sendChannelMessage, {
				contactId,
				channel: 'sms',
				text: 'hi',
				threadId,
			})
		).rejects.toThrow(/Team Inbox/);
		const sent = await t.run((ctx) => ctx.db.query('unifiedMessages').collect());
		expect(sent).toEqual([]);
	});

	it('lists the channels discussing a thread only to a reader', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat']);
		const { threadId } = await seedThread(t);

		expect(
			await t.query(api.chat.emailLink.findChannelsForInboxThread, { inboxThreadId: threadId })
		).toEqual([]);

		sess.role = 'owner';
		const channels = await t.query(api.chat.emailLink.findChannelsForInboxThread, {
			inboxThreadId: threadId,
		});
		expect(channels.map((c) => c.name)).toEqual(['support']);
	});

	it('refuses a member the inbound-derived code task list', async () => {
		const t = convexTest(schema, modules);

		await expect(t.query(api.codeWorkTasks.listRecent, {})).rejects.toThrow(/code tasks/);
		sess.role = 'admin';
		expect(await t.query(api.codeWorkTasks.listRecent, {})).toEqual([]);
	});
});
