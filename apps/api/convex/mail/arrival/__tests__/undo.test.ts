/**
 * Undo (SPEC §4.4): pages of ≤100 change rows, each restored only while its
 * value (and, for threads, records and senders, its operation marker) still
 * matches; skipped rows make the operation `undo_partial`. Delayed actions the
 * operation created are cancelled and projections recomputed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { arrivalChangeRow } from '../changeRows';
import {
	deliverLive,
	messageOf,
	operationOf,
	profileOf,
	roleOf,
	seedPersonalMailbox,
	seedProfile,
	seedSenderMessages,
	threadOf,
	type T,
	learnTest,
} from './learn.testlib';

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

afterEach(() => {
	vi.useRealTimers();
});

const undo = (t: T, operationId: Id<'mailArrivalOperations'>) =>
	t.mutation(api.mail.arrival.operations.undo, { operationId });

describe('operations.undo', () => {
	it('restores a thread override, recomputes the projection, and runs once', async () => {
		const t = learnTest();
		await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		const placed = thread.arrival?.placement;
		const fix = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'needs_me',
			scope: 'message',
		});
		expect((await threadOf(t, thread._id)).arrival?.placement).toBe('needs_me');

		const result = await undo(t, fix.operationId!);
		expect(result).toMatchObject({ status: 'undone', restored: 1, skipped: 0, hasMore: false });
		const after = await threadOf(t, thread._id);
		expect(after.placementOverride).toBeUndefined();
		expect(after.arrival?.placement).toBe(placed);
		expect((await operationOf(t, fix.operationId!)).operation).toMatchObject({
			status: 'undone',
			undoneAt: expect.any(Number),
		});
		expect((await undo(t, fix.operationId!)).status).toBe('not_applied');
	});

	it('re-sorts a restored sender in the same mutation, before anything scheduled runs', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		await seedPersonalMailbox(t);
		const first = await deliverLive(t);
		const other = await deliverLive(t, { subject: 'Winter catalogue', id: 'winter' });
		expect(other.thread._id).not.toBe(first.thread._id);
		const before = (await threadOf(t, other.thread._id)).arrival?.placement;
		expect(before).not.toBe('needs_me');
		const fix = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: first.message._id,
			destination: 'needs_me',
			scope: 'sender',
		});
		expect((await threadOf(t, other.thread._id)).arrival?.placement).toBe('needs_me');
		await undo(t, fix.operationId!);
		// No scheduled function has run: the undo itself re-sorted the sender.
		expect((await threadOf(t, other.thread._id)).arrival?.placement).toBe(before);
	});

	it('skips a sender status another operation changed since (ABA) and ends partial', async () => {
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const fix = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'digest',
			scope: 'sender',
		});
		const profile = (await profileOf(t, mailboxId))!;
		// Another operation sets the same value: the value guard alone would pass.
		await t.run(async (ctx) => {
			const other = await ctx.db.insert('mailArrivalOperations', {
				mailboxId,
				kind: 'sender_status',
				actor: 'user',
				changeCount: 0,
				status: 'applied',
				createdAt: Date.now(),
				expiresAt: Date.now() + 1_000_000,
			});
			await ctx.db.patch(profile._id, { lastOperationId: other });
		});
		const result = await undo(t, fix.operationId!);
		expect(result).toMatchObject({ status: 'undo_partial', restored: 0, skipped: 1 });
		expect((await profileOf(t, mailboxId))!.status).toBe('digest');
		expect((await operationOf(t, fix.operationId!)).operation.status).toBe('undo_partial');
	});

	it('restores what still matches and skips a message moved by hand since', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const others = await seedSenderMessages(t, mailboxId, folders.inbox, [10, 20]);
		const fix = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'auto_archive',
			scope: 'sender',
		});
		expect(fix.archived).toBe(3);
		// The person moves one of them on to Trash by hand.
		await t.run(async (ctx) => {
			await ctx.db.patch(others[0]!, { folderId: folders.trash });
		});
		const result = await undo(t, fix.operationId!);
		expect(result).toMatchObject({ status: 'undo_partial', restored: 3, skipped: 1 });
		expect(await roleOf(t, message._id)).toBe('inbox');
		expect(await roleOf(t, others[1]!)).toBe('inbox');
		expect(await roleOf(t, others[0]!)).toBe('trash');
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await profileOf(t, mailboxId))!).toMatchObject({
			status: 'keep',
			statusSource: 'default',
		});
	});

	it('pages through more than 100 rows and reports the outcome of every page', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const ids = await seedSenderMessages(
			t,
			mailboxId,
			folders.inbox,
			Array.from({ length: 149 }, (_, i) => 1_000 + i)
		);
		// The oldest message is a conversation of its own that waits for a reply:
		// archived last, its row (the one marked) sits on a later undo page.
		await t.run(async (ctx) => {
			const oldest = (await ctx.db.get(ids[0]!))!;
			const { _id, _creationTime, ...thread } = (await ctx.db.get(oldest.threadId))!;
			const own = await ctx.db.insert('mailThreads', {
				...thread,
				messageCount: 1,
				needsReply: {
					messageId: oldest._id,
					source: 'llm',
					urgency: 'normal',
					detectedAt: Date.now(),
				},
			});
			await ctx.db.patch(oldest._id, { threadId: own });
		});
		const fix = await t.mutation(api.mail.arrival.fix.apply, {
			messageId: message._id,
			destination: 'auto_archive',
			scope: 'sender',
		});
		expect(fix.archived).toBe(150);
		const { changes } = await operationOf(t, fix.operationId!);
		const marked = changes.findIndex((row) => row.isNeedsReplyCleared === true);
		expect(marked).toBeGreaterThanOrEqual(100);
		// Moved on by hand since: its row, on a later page, is skipped.
		await t.run(async (ctx) => {
			await ctx.db.patch(ids[1]!, { folderId: folders.trash });
		});
		const first = await undo(t, fix.operationId!);
		expect(first).toMatchObject({ status: 'undone', restored: 100, hasMore: true });
		expect(first.isNeedsReplyCleared).toBe(false);
		expect(
			await t.query(api.mail.arrival.operations.undoStatus, { operationId: fix.operationId! })
		).toMatchObject({ isDone: false, restored: 100 });

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await t.query(api.mail.arrival.operations.undoStatus, { operationId: fix.operationId! })
		).toEqual({
			status: 'undo_partial',
			kind: 'fix',
			restored: 150,
			skipped: 1,
			isNeedsReplyCleared: true,
			isDone: true,
		});
		for (const id of [message._id, ...ids.filter((id) => id !== ids[1])]) {
			expect(await roleOf(t, id)).toBe('inbox');
		}
		expect((await operationOf(t, fix.operationId!)).operation.status).toBe('undo_partial');
		// The cleared reminder stays cleared.
		const oldest = await messageOf(t, ids[0]!);
		expect((await threadOf(t, oldest.threadId)).needsReply).toBeUndefined();
	});

	it('restores message flags, labels and sections, skipping a label deleted since', async () => {
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		const { message } = await deliverLive(t);
		const { operationId, gone } = await t.run(async (ctx) => {
			const kept = await ctx.db.insert('mailLabels', {
				mailboxId,
				name: 'Kept',
				createdAt: 0,
			});
			const gone = await ctx.db.insert('mailLabels', {
				mailboxId,
				name: 'Gone',
				createdAt: 0,
			});
			await ctx.db.patch(message._id, {
				flagSeen: true,
				flagFlagged: true,
				labelIds: [kept, gone],
				pinnedSection: 'Travel',
			});
			const operationId = await ctx.db.insert('mailArrivalOperations', {
				mailboxId,
				kind: 'rule_apply',
				actor: 'rule',
				messageId: message._id,
				changeCount: 5,
				status: 'applied',
				createdAt: Date.now(),
				expiresAt: Date.now() + 1_000_000,
			});
			const now = Date.now();
			const rows = [
				{ kind: 'messageRead' as const, messageId: message._id, before: false, after: true },
				{ kind: 'messageFlag' as const, messageId: message._id, before: false, after: true },
				{
					kind: 'messageLabel' as const,
					messageId: message._id,
					labelId: kept,
					before: false,
					after: true,
				},
				{
					kind: 'messageLabel' as const,
					messageId: message._id,
					labelId: gone,
					before: false,
					after: true,
				},
				{
					kind: 'messageSection' as const,
					messageId: message._id,
					before: null,
					after: 'Travel',
				},
			];
			for (const change of rows) {
				await ctx.db.insert(
					'mailArrivalOperationChanges',
					arrivalChangeRow({ operationId, mailboxId, change, now })
				);
			}
			// A label deleted before the undo.
			await ctx.db.delete(gone);
			return { operationId, gone };
		});
		const result = await undo(t, operationId);
		expect(result).toMatchObject({ status: 'undo_partial', restored: 4, skipped: 1 });
		const after = await messageOf(t, message._id);
		expect(after.flagSeen).toBe(false);
		expect(after.flagFlagged).toBe(false);
		expect(after.labelIds).toEqual([gone]);
		expect(after.pinnedSection).toBeUndefined();
	});

	it('cancels the pending delayed actions the operation created, and restores a rule placement', async () => {
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const { message, thread } = await deliverLive(t);
		const { operationId, actionId, othersId } = await t.run(async (ctx) => {
			const operationId = await ctx.db.insert('mailArrivalOperations', {
				mailboxId,
				kind: 'rule_apply',
				actor: 'rule',
				messageId: message._id,
				changeCount: 1,
				status: 'applied',
				createdAt: Date.now(),
				expiresAt: Date.now() + 1_000_000,
			});
			const record = (await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', message._id))
				.first())!;
			await ctx.db.patch(record._id, { rulePlacement: 'digest', lastOperationId: operationId });
			await ctx.db.insert(
				'mailArrivalOperationChanges',
				arrivalChangeRow({
					operationId,
					mailboxId,
					change: {
						kind: 'recordRulePlacement',
						messageId: message._id,
						before: null,
						after: 'digest',
					},
					now: Date.now(),
				})
			);
			const base = {
				mailboxId,
				threadId: thread._id,
				messageId: message._id,
				action: 'archive' as const,
				runAt: Date.now() + 60_000,
				anchor: { messageReceivedAt: message.receivedAt, folderId: folders.inbox },
				state: 'pending' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			const actionId = await ctx.db.insert('mailDelayedActions', {
				...base,
				actionKey: `${message._id}:archive:rule`,
				source: 'rule',
				createdByOperationId: operationId,
			});
			const othersId = await ctx.db.insert('mailDelayedActions', {
				...base,
				actionKey: `${message._id}:archive:code_detector`,
				source: 'code_detector',
			});
			return { operationId, actionId, othersId };
		});
		const result = await undo(t, operationId);
		expect(result).toMatchObject({ status: 'undone', restored: 1 });
		await t.run(async (ctx) => {
			expect(await ctx.db.get(actionId)).toMatchObject({ state: 'cancelled', cancelledBy: 'undo' });
			expect((await ctx.db.get(othersId))!.state).toBe('pending');
			const record = (await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', message._id))
				.first())!;
			expect(record.rulePlacement).toBeUndefined();
		});
	});

	it('restores a resumed draft pause', async () => {
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		const profile = await seedProfile(t, mailboxId, { autoDraftPausedAt: 5, unusedDraftStreak: 5 });
		const resumed = await t.mutation(api.mail.senders.status.resumeDrafts, {
			target: { mailboxId, senderDigest: profile.senderDigest },
		});
		const result = await undo(t, resumed.operationId!);
		expect(result).toMatchObject({ status: 'undone', restored: 1, kind: 'draft_resume' });
		expect((await profileOf(t, mailboxId))!).toMatchObject({
			autoDraftPausedAt: 5,
			unusedDraftStreak: 5,
		});
	});

	it('refuses an operation of a mailbox the caller cannot reach', async () => {
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		const operationId = await t.run(async (ctx) => {
			await ctx.db.patch(mailboxId, { organizationId: 'org-2' });
			return await ctx.db.insert('mailArrivalOperations', {
				mailboxId,
				kind: 'fix',
				actor: 'user',
				changeCount: 0,
				status: 'applied',
				createdAt: Date.now(),
				expiresAt: Date.now() + 1_000_000,
			});
		});
		await expect(undo(t, operationId)).rejects.toThrow();
	});
});
