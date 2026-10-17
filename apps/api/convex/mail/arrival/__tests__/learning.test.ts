/**
 * Learning without asking (SPEC §4.3): unread archives by a person become
 * versioned evidence, sessions gate like triageTally, the learned digest is an
 * undoable operation with a one-time notice, undo leaves a "do not relearn"
 * sentinel, a reply reverses a learned digest, and a `user` status is never
 * touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { settleOwnerReply } from '../../answeredReply';
import { archiveSessionKey, foldUnreadArchives, hasEarnedLearnedDigest } from '../learningSignals';
import {
	OWNER,
	SENDER,
	deliverLive,
	operationOf,
	profileOf,
	seedPersonalMailbox,
	seedProfile,
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

const MINUTE = 60_000;

/** Deliver `count` unread live messages and archive them in one call, then move a minute on. */
async function archiveSession(t: T, count: number): Promise<Id<'mailMessages'>[]> {
	const ids: Id<'mailMessages'>[] = [];
	for (let i = 0; i < count; i++) ids.push((await deliverLive(t)).message._id);
	await t.mutation(api.mail.messageActions.archive, { messageIds: ids });
	vi.setSystemTime(Date.now() + 2 * MINUTE);
	return ids;
}

describe('evidence folding', () => {
	it('counts sessions by key and refuses the sentinel', () => {
		const one = foldUnreadArchives(undefined, 2, 'minute:1')!;
		expect(one).toEqual({ count: 2, sessions: 1, lastSessionKey: 'minute:1', version: 1 });
		const same = foldUnreadArchives(one, 1, 'minute:1')!;
		expect(same).toMatchObject({ count: 3, sessions: 1 });
		const next = foldUnreadArchives(same, 2, 'minute:3')!;
		expect(next).toMatchObject({ count: 5, sessions: 2 });
		expect(hasEarnedLearnedDigest(next)).toBe(false);
		expect(hasEarnedLearnedDigest(foldUnreadArchives(next, 1, 'minute:9')!)).toBe(true);
		expect(foldUnreadArchives({ count: -1, sessions: 0, version: 1 }, 1, 'x')).toBeNull();
		expect(archiveSessionKey(3 * MINUTE + 5)).toBe('minute:3');
		expect(archiveSessionKey(0, 'abc')).toBe('action:abc');
	});
});

describe('unread archive evidence', () => {
	it('counts unread live mail a person archives, not read mail, not imported mail', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		const unread = (await deliverLive(t)).message._id;
		const read = (await deliverLive(t)).message._id;
		const imported = (await deliverLive(t)).message._id;
		await t.run(async (ctx) => {
			await ctx.db.patch(read, { flagSeen: true });
			// What a backfill row looks like: never counted as delivered.
			await ctx.db.patch(imported, { isOpenCounted: undefined });
		});
		await t.mutation(api.mail.messageActions.archive, { messageIds: [unread, read, imported] });
		expect((await profileOf(t, mailboxId))!.unreadArchiveEvidence).toMatchObject({
			count: 1,
			sessions: 1,
			version: 1,
		});
	});

	it('counts a move into Archive, but not an automatic one', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		const first = (await deliverLive(t)).message._id;
		const second = (await deliverLive(t)).message._id;
		await t.mutation(api.mail.messageActions.move, {
			messageIds: [first],
			targetFolderId: folders.archive,
			isAutomatic: true,
		});
		expect((await profileOf(t, mailboxId))!.unreadArchiveEvidence).toBeUndefined();
		await t.mutation(api.mail.messageActions.move, {
			messageIds: [second],
			targetFolderId: folders.archive,
		});
		expect((await profileOf(t, mailboxId))!.unreadArchiveEvidence?.count).toBe(1);
	});

	it('learns a digest after both gates, as an operation with a one-time notice', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		await archiveSession(t, 2);
		await archiveSession(t, 2);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await profileOf(t, mailboxId))!.status).toBe('keep'); // 4 mails, 2 sessions
		await archiveSession(t, 1);
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const profile = (await profileOf(t, mailboxId))!;
		expect(profile).toMatchObject({
			status: 'digest',
			statusSource: 'learned',
			learnedNoticeAt: expect.any(Number),
		});
		const { operation, changes } = await operationOf(t, profile.lastOperationId!);
		expect(operation).toMatchObject({ kind: 'learned_status', actor: 'learning', changeCount: 1 });
		expect(changes[0]!.change).toMatchObject({
			kind: 'senderStatus',
			before: { status: 'keep', statusSource: 'default' },
			after: { status: 'digest', statusSource: 'learned' },
		});

		const notices = await t.query(api.mail.arrival.learning.notices, { mailboxId });
		expect(notices).toEqual([
			expect.objectContaining({ operationId: operation._id, address: SENDER, displayName: 'Shop' }),
		]);
		await t.mutation(api.mail.arrival.learning.acknowledge, { operationId: operation._id });
		expect(await t.query(api.mail.arrival.learning.notices, { mailboxId })).toEqual([]);
	});

	it('never changes a user or suggestion status', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		await seedProfile(t, mailboxId, { status: 'keep', statusSource: 'user' });
		for (let i = 0; i < 3; i++) await archiveSession(t, 2);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const profile = (await profileOf(t, mailboxId))!;
		expect(profile).toMatchObject({ status: 'keep', statusSource: 'user' });
		expect(profile.unreadArchiveEvidence?.count).toBe(6);
		expect(profile.lastOperationId).toBeUndefined();
	});

	it('undo restores the status and leaves the do-not-relearn sentinel', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId } = await seedPersonalMailbox(t);
		for (let i = 0; i < 3; i++) await archiveSession(t, 2);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const learned = (await profileOf(t, mailboxId))!;
		expect(learned.status).toBe('digest');

		const result = await t.mutation(api.mail.arrival.operations.undo, {
			operationId: learned.lastOperationId!,
		});
		expect(result).toMatchObject({ status: 'undone', kind: 'learned_status' });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const after = (await profileOf(t, mailboxId))!;
		expect(after).toMatchObject({
			status: 'keep',
			statusSource: 'default',
			unreadArchiveEvidence: { count: -1, sessions: 0, version: 1 },
		});
		expect(after.learnedNoticeAt).toBeUndefined();

		for (let i = 0; i < 3; i++) await archiveSession(t, 2);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await profileOf(t, mailboxId))!).toMatchObject({
			status: 'keep',
			unreadArchiveEvidence: { count: -1 },
		});
	});
});

describe('reply reversal', () => {
	async function replyToSender(t: T, mailboxId: Id<'mailboxes'>, sentFolder: Id<'mailFolders'>) {
		await t.run(async (ctx) => {
			const thread = (await ctx.db.query('mailThreads').first())!;
			const id = await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId: sentFolder,
				uid: 99,
				modseq: 1,
				rfc822MessageId: '<reply@owlat.test>',
				threadId: thread._id,
				fromAddress: OWNER,
				toAddresses: [`Shop <${SENDER}>`],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Re: Autumn sale',
				normalizedSubject: 'autumn sale',
				snippet: 'Thanks',
				rawStorageId: await ctx.storage.store(new Blob(['raw'])),
				rawSize: 3,
				attachments: [],
				hasAttachments: false,
				flagSeen: true,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt: Date.now(),
				internalDate: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await settleOwnerReply(ctx, id);
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	}

	it('puts a learned digest back to the default and resets the evidence', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		await deliverLive(t);
		const profile = (await profileOf(t, mailboxId))!;
		await t.run(async (ctx) => {
			await ctx.db.patch(profile._id, {
				status: 'digest',
				statusSource: 'learned',
				unreadArchiveEvidence: { count: 6, sessions: 3, version: 1 },
			});
		});
		await replyToSender(t, mailboxId, folders.sent);
		const after = (await profileOf(t, mailboxId))!;
		expect(after).toMatchObject({
			status: 'keep',
			statusSource: 'default',
			unreadArchiveEvidence: { count: 0, sessions: 0, version: 1 },
		});
		expect((await operationOf(t, after.lastOperationId!)).operation).toMatchObject({
			kind: 'learned_status',
			actor: 'learning',
		});
	});

	it('a reply before a queued learned digest runs cancels it', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		// Both gates crossed: the learned digest is queued, not run yet.
		for (let i = 0; i < 3; i++) await archiveSession(t, 2);
		expect((await profileOf(t, mailboxId))!.unreadArchiveEvidence?.count).toBe(6);
		await replyToSender(t, mailboxId, folders.sent);
		const after = (await profileOf(t, mailboxId))!;
		expect(after).toMatchObject({
			status: 'keep',
			statusSource: 'default',
			unreadArchiveEvidence: { count: 0, sessions: 0, version: 1 },
		});
		expect(after.lastOperationId).toBeUndefined();
	});

	it('leaves a user digest alone', async () => {
		vi.useFakeTimers();
		const t = learnTest();
		const { mailboxId, folders } = await seedPersonalMailbox(t);
		await deliverLive(t);
		const profile = (await profileOf(t, mailboxId))!;
		await t.run(async (ctx) => {
			await ctx.db.patch(profile._id, { status: 'digest', statusSource: 'user' });
		});
		await replyToSender(t, mailboxId, folders.sent);
		expect((await profileOf(t, mailboxId))!).toMatchObject({
			status: 'digest',
			statusSource: 'user',
		});
	});
});
