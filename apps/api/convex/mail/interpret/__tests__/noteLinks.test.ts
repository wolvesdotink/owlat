/**
 * Internal notes and the thread brief (mail/interpret/noteReactions.ts):
 * the `#` item link on Team Inbox notes (inbox/notes.ts) and on Postbox
 * discussion messages (chat/mailDiscussion.ts) must name an item of the same
 * thread; emoji reactions toggle per person, stay bounded and go with a
 * deleted note.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import {
	acceptReactionEmoji,
	MAX_NOTE_REACTIONS_PER_PERSON,
	summarizeNoteReactions,
} from '../noteReactions';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

const session = vi.hoisted(() => ({
	current: { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' },
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session.current),
		isActiveOrgMember: vi.fn(async () => true),
		getMutationContext: vi.fn(async () => session.current),
		getBetterAuthSessionWithRole: vi.fn(async () => session.current),
		requireAdminContext: vi.fn(async () => session.current),
	};
});

beforeEach(() => {
	session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
});

const SENT = Date.UTC(2026, 9, 7, 9, 0);

async function teamItem(t: Test) {
	const { threadId, inboundId } = await seedTeamThread(t);
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'inbound', id: inboundId },
		threadRef: { kind: 'team', id: threadId },
		mode: 'actions',
		contentRevision: `rev-${inboundId}`,
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({ items: [reduceItem()], latest: undefined, facts: undefined }),
	});
	const itemId = await t.run(async (ctx) => {
		const item = await ctx.db
			.query('threadItems')
			.withIndex('by_conversation_thread_and_status', (q) =>
				q.eq('conversationThreadId', threadId).eq('status', 'open')
			)
			.first();
		return item!._id;
	});
	return { threadId, itemId };
}

async function mailItem(t: Test, address: string) {
	const { messageId, threadId } = await seedMailThread(t, { address, scope: 'shared' });
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'actions',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({ items: [reduceItem()], latest: undefined, facts: undefined }),
	});
	const itemId = await t.run(async (ctx) => {
		const item = await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) =>
				q.eq('mailThreadId', threadId).eq('status', 'open')
			)
			.first();
		return item!._id;
	});
	return { threadId, itemId };
}

describe('Team Inbox notes', () => {
	it('link to an item of the same thread and refuse one of another thread', async () => {
		const t = convexTest(schema, modules);
		const a = await teamItem(t);
		const b = await teamItem(t);
		const mail = await mailItem(t, 'support@owlat.test');

		const noteId = await t.mutation(api.inbox.notes.create, {
			threadId: a.threadId,
			body: 'I will handle the refund',
			threadItemId: a.itemId,
		});
		expect((await t.run(async (ctx) => ctx.db.get(noteId)))?.threadItemId).toBe(a.itemId);
		const [view] = await t.query(api.inbox.notes.listForThread, { threadId: a.threadId });
		expect(view).toMatchObject({ threadItemId: a.itemId, reactions: [] });

		for (const foreign of [b.itemId, mail.itemId]) {
			await expect(
				t.mutation(api.inbox.notes.create, {
					threadId: a.threadId,
					body: 'Wrong thread',
					threadItemId: foreign,
				})
			).rejects.toThrow(/not part of this thread/);
			await expect(
				t.mutation(api.inbox.notes.update, { noteId, body: 'Edited', threadItemId: foreign })
			).rejects.toThrow(/not part of this thread/);
		}

		// An edit can drop the link, or keep it by leaving it out.
		await t.mutation(api.inbox.notes.update, { noteId, body: 'Edited' });
		expect((await t.run(async (ctx) => ctx.db.get(noteId)))?.threadItemId).toBe(a.itemId);
		await t.mutation(api.inbox.notes.update, { noteId, body: 'Edited', threadItemId: null });
		expect((await t.run(async (ctx) => ctx.db.get(noteId)))?.threadItemId).toBeUndefined();
	});

	it('toggle reactions per person, and a deleted note loses them', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await teamItem(t);
		const noteId = await t.mutation(api.inbox.notes.create, { threadId, body: 'On it' });

		expect(await t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji: '👍' })).toEqual({
			isOn: true,
		});
		session.current = { userId: 'user-B', role: 'admin', activeOrganizationId: 'org-1' };
		await t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji: '👍' });
		await t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji: '🎉' });
		let [view] = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(view?.reactions).toEqual([
			{ emoji: '👍', count: 2, isMine: true },
			{ emoji: '🎉', count: 1, isMine: true },
		]);
		const row = await t.run(async (ctx) => ctx.db.query('noteReactions').first());
		expect(row).toMatchObject({
			threadKind: 'team',
			conversationThreadId: threadId,
			noteSource: 'threadNote',
		});

		expect(await t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji: '🎉' })).toEqual({
			isOn: false,
		});
		session.current = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
		[view] = await t.query(api.inbox.notes.listForThread, { threadId });
		expect(view?.reactions).toEqual([{ emoji: '👍', count: 2, isMine: true }]);

		await expect(
			t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji: 'lol' })
		).rejects.toThrow(/emoji/);

		await t.mutation(api.inbox.notes.remove, { noteId });
		expect(await t.run(async (ctx) => ctx.db.query('noteReactions').collect())).toEqual([]);
		await expect(
			t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji: '👍' })
		).rejects.toThrow(/deleted/);
	});

	it('bound how many emojis one person puts on a note', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await teamItem(t);
		const noteId = await t.mutation(api.inbox.notes.create, { threadId, body: 'On it' });
		const emojis = ['👍', '🎉', '❤️', '😀', '🚀', '👀', '✅', '🙏', '🔥', '💯', '🤔'];
		for (const emoji of emojis.slice(0, MAX_NOTE_REACTIONS_PER_PERSON)) {
			await t.mutation(api.inbox.notes.toggleReaction, { noteId, emoji });
		}
		await expect(
			t.mutation(api.inbox.notes.toggleReaction, {
				noteId,
				emoji: emojis[MAX_NOTE_REACTIONS_PER_PERSON]!,
			})
		).rejects.toThrow();
	});
});

describe('Postbox thread discussion', () => {
	it('links a message to an item of the same thread and reacts to it', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat', 'mail.external']);
		const a = await mailItem(t, 'support@owlat.test');
		const b = await mailItem(t, 'sales@owlat.test');

		const { messageId } = await t.mutation(api.chat.mailDiscussion.post, {
			threadId: a.threadId,
			body: 'Who sends the contract?',
			threadItemId: a.itemId,
		});
		await expect(
			t.mutation(api.chat.mailDiscussion.post, {
				threadId: a.threadId,
				body: 'Wrong thread',
				threadItemId: b.itemId,
			})
		).rejects.toThrow(/not part of this thread/);

		await t.mutation(api.chat.mailDiscussion.toggleReaction, { messageId, emoji: '👍' });
		const discussion = await t.query(api.chat.mailDiscussion.getForThread, {
			threadId: a.threadId,
		});
		expect(discussion?.messages).toHaveLength(1);
		expect(discussion?.messages[0]).toMatchObject({
			threadItemId: a.itemId,
			reactions: [{ emoji: '👍', count: 1, isMine: true }],
		});
		const row = await t.run(async (ctx) => ctx.db.query('noteReactions').first());
		expect(row).toMatchObject({
			threadKind: 'mail',
			mailThreadId: a.threadId,
			noteSource: 'chatMessage',
			chatMessageId: messageId,
		});
	});

	it('refuses reactions from someone who cannot read the mailbox', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['chat', 'mail.external']);
		const a = await mailItem(t, 'support@owlat.test');
		const { messageId } = await t.mutation(api.chat.mailDiscussion.post, {
			threadId: a.threadId,
			body: 'Hello',
		});
		session.current = { userId: 'user-Z', role: 'editor', activeOrganizationId: 'org-1' };
		await expect(
			t.mutation(api.chat.mailDiscussion.toggleReaction, {
				messageId: messageId as Id<'chatMessages'>,
				emoji: '👍',
			})
		).rejects.toThrow();
	});
});

describe('reaction rules', () => {
	it('accepts emoji sequences and refuses text', () => {
		expect(acceptReactionEmoji(' 👍🏽 ')).toBe('👍🏽');
		expect(acceptReactionEmoji('👨‍👩‍👧')).toBe('👨‍👩‍👧');
		expect(acceptReactionEmoji('🇩🇪')).toBe('🇩🇪');
		for (const bad of ['', 'ok', '👍 ok', '1', '<b>']) {
			expect(() => acceptReactionEmoji(bad)).toThrow();
		}
	});

	it('groups by emoji in first-reaction order and marks the viewer’s own', () => {
		expect(
			summarizeNoteReactions(
				[
					{ emoji: '🎉', userId: 'b', createdAt: 2 },
					{ emoji: '👍', userId: 'a', createdAt: 1 },
					{ emoji: '🎉', userId: 'a', createdAt: 3 },
				],
				'b'
			)
		).toEqual([
			{ emoji: '👍', count: 1, isMine: false },
			{ emoji: '🎉', count: 2, isMine: true },
		]);
	});
});
