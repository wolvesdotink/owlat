import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Tasks, member groups and the company index under member erasure: the
 * member's private tasks go, shared tasks stay with the member's id
 * anonymized, a task taken from their personal mail loses its link into it,
 * they leave every group, and the company index rows of their personal
 * mailbox go with it. A colleague's rows are untouched.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const GONE = '[deleted account]';

describe('member erasure of tasks and the company index', () => {
	it('deletes private tasks, anonymizes shared ones and unlinks the personal mailbox', async () => {
		const t = erasureHarness();
		const { authUserId: uid, requestId } = await seedEditor(t);
		const { mailboxId, threadId } = await seedPersonalMailbox(t, uid);
		const teamBox = await seedPersonalMailbox(t, 'colleague-1', {
			scope: 'shared',
			address: 'team@example.com',
		});
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const base = { status: 'open' as const, createdAt: now, updatedAt: now };
			const groupId = await ctx.db.insert('memberGroups', {
				name: 'Management',
				createdBy: uid,
				createdAt: now,
				updatedAt: now,
			});
			const ownMembership = await ctx.db.insert('memberGroupMembers', {
				groupId,
				userId: uid,
				addedBy: 'colleague-1',
				addedAt: now,
			});
			const colleagueMembership = await ctx.db.insert('memberGroupMembers', {
				groupId,
				userId: 'colleague-1',
				addedBy: uid,
				addedAt: now,
			});
			const privateTask = await ctx.db.insert('tasks', {
				...base,
				title: 'My salary talk',
				visibility: 'private',
				createdBy: uid,
				assigneeUserId: uid,
				sourceMailboxId: mailboxId,
				sourceMailThreadId: threadId,
			});
			const handedOver = await ctx.db.insert('tasks', {
				...base,
				status: 'done',
				title: 'Update the onboarding checklist',
				visibility: 'everyone',
				createdBy: uid,
				assigneeUserId: 'colleague-1',
				completedBy: uid,
				completedAt: now,
			});
			const fromPersonalMail = await ctx.db.insert('tasks', {
				...base,
				title: 'Answer Northwind',
				visibility: 'group',
				groupId,
				createdBy: 'colleague-1',
				assigneeUserId: uid,
				companyKey: 'northwind.example',
				sourceMailboxId: mailboxId,
				sourceMailThreadId: threadId,
			});
			const colleaguePrivate = await ctx.db.insert('tasks', {
				...base,
				title: 'Colleague’s own',
				visibility: 'private',
				createdBy: 'colleague-1',
				assigneeUserId: 'colleague-1',
				sourceMailboxId: teamBox.mailboxId,
				sourceMailThreadId: teamBox.threadId,
			});
			const index = { addresses: ['mia@northwind.example'], lastMessageAt: now };
			const personalRow = await ctx.db.insert('companyThreads', {
				...index,
				companyKey: 'northwind.example',
				kind: 'mail',
				mailboxId,
				mailThreadId: threadId,
				ownerUserId: uid,
			});
			const teamRow = await ctx.db.insert('companyThreads', {
				...index,
				companyKey: 'northwind.example',
				kind: 'mail',
				mailboxId: teamBox.mailboxId,
				mailThreadId: teamBox.threadId,
			});
			const personalCursor = await ctx.db.insert('companyIndexCursors', {
				mailboxId,
				position: now,
				updatedAt: now,
			});
			const teamCursor = await ctx.db.insert('companyIndexCursors', {
				mailboxId: teamBox.mailboxId,
				position: now,
				updatedAt: now,
			});
			return {
				groupId,
				ownMembership,
				colleagueMembership,
				privateTask,
				handedOver,
				fromPersonalMail,
				colleaguePrivate,
				personalRow,
				teamRow,
				personalCursor,
				teamCursor,
			};
		});

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.privateTask)).toBeNull();
			const handedOver = await ctx.db.get(seeded.handedOver);
			expect(handedOver).toMatchObject({
				createdBy: GONE,
				assigneeUserId: 'colleague-1',
				completedBy: GONE,
				status: 'done',
			});
			const fromPersonalMail = await ctx.db.get(seeded.fromPersonalMail);
			expect(fromPersonalMail).toMatchObject({
				title: 'Answer Northwind',
				createdBy: 'colleague-1',
				assigneeUserId: GONE,
				companyKey: 'northwind.example',
			});
			expect(fromPersonalMail?.sourceMailboxId).toBeUndefined();
			expect(fromPersonalMail?.sourceMailThreadId).toBeUndefined();
			const colleaguePrivate = await ctx.db.get(seeded.colleaguePrivate);
			expect(colleaguePrivate?.sourceMailThreadId).toBe(teamBox.threadId);

			expect((await ctx.db.get(seeded.groupId))?.createdBy).toBe(GONE);
			expect(await ctx.db.get(seeded.ownMembership)).toBeNull();
			expect((await ctx.db.get(seeded.colleagueMembership))?.addedBy).toBe(GONE);

			expect(await ctx.db.get(seeded.personalRow)).toBeNull();
			expect(await ctx.db.get(seeded.personalCursor)).toBeNull();
			expect(await ctx.db.get(seeded.teamRow)).not.toBeNull();
			expect(await ctx.db.get(seeded.teamCursor)).not.toBeNull();
		});
	});
});
