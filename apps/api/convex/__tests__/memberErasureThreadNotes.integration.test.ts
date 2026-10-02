import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
} from './memberErasureFixtures';

/**
 * Internal notes on Team Inbox threads under member erasure: the notes the
 * member wrote stay on their threads with the authorship anonymized (like team
 * chat), a note that mentioned them names '[deleted account]' instead, and
 * their Mentions rows go. Another member's notes and mentions are untouched.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('member erasure of internal notes', () => {
	it('anonymizes authorship, forgets mentions of the member, keeps the team’s', async () => {
		const t = erasureHarness();
		const { authUserId, requestId } = await seedEditor(t);
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'Invoice 4471',
				normalizedSubject: 'invoice 4471',
				contactIdentifier: 'customer@example.com',
				status: 'open',
				messageCount: 1,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			const ownNoteId = await ctx.db.insert('threadNotes', {
				threadId,
				authorId: authUserId,
				body: 'I called them, refund is on its way. @colleague',
				mentionedUserIds: ['colleague-1'],
				createdAt: now,
			});
			await ctx.db.insert('threadNoteMentions', {
				noteId: ownNoteId,
				threadId,
				userId: 'colleague-1',
				createdAt: now,
			});
			const colleagueNoteId = await ctx.db.insert('threadNotes', {
				threadId,
				authorId: 'colleague-1',
				body: '@editor can you confirm?',
				mentionedUserIds: [authUserId, 'colleague-2'],
				createdAt: now + 1,
			});
			for (const userId of [authUserId, 'colleague-2']) {
				await ctx.db.insert('threadNoteMentions', {
					noteId: colleagueNoteId,
					threadId,
					userId,
					createdAt: now + 1,
				});
			}
			return { ownNoteId, colleagueNoteId };
		});

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			const own = await ctx.db.get(seeded.ownNoteId);
			expect(own?.authorId).toBe('[deleted account]');
			expect(own?.body).toContain('refund is on its way');
			const colleague = await ctx.db.get(seeded.colleagueNoteId);
			expect(colleague?.authorId).toBe('colleague-1');
			expect(colleague?.mentionedUserIds).toEqual(['[deleted account]', 'colleague-2']);
			const mentions = await ctx.db.query('threadNoteMentions').collect();
			expect(mentions.map((m) => m.userId).sort()).toEqual(['colleague-1', 'colleague-2']);
		});
	});
});
