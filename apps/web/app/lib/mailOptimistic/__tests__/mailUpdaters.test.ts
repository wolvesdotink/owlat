import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api } from '@owlat/api';
import { fakeLocalStore } from './fakeLocalStore';
import {
	optimisticArchive,
	optimisticMarkRead,
	optimisticMarkThreadRead,
	optimisticMove,
	optimisticSetFlags,
	optimisticSetLabelOnMessages,
	optimisticSetStar,
	optimisticSnooze,
	optimisticSnoozeMany,
	optimisticSnoozeThread,
	optimisticSnoozeUntilReply,
	optimisticToggleLabelOnMessage,
	optimisticToggleLabelOnThread,
	optimisticTrash,
} from '../mailUpdaters';

/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures cast loose ids into branded types */

const NOW = 1_800_000_000_000;
const MB = 'mb1';
const INBOX = 'f-inbox';
const ARCHIVE = 'f-archive';
const TRASH = 'f-trash';
const WORK = 'f-work';

const q = {
	listMessages: api.mail.mailbox.queries.listMessages,
	listSections: api.mail.sections.listSections,
	listByLabel: api.mail.mailbox.queries.listByLabel,
	listThreadMessages: api.mail.mailbox.messages.listThreadMessages,
	getMessage: api.mail.mailbox.messages.getMessage,
	listFolders: api.mail.mailbox.queries.listFolders,
	accessible: api.mail.mailbox.queries.accessible,
	unreadCounts: api.mail.labels.unreadCounts,
	sidebarThreads: api.today.mailbox.sidebarThreads,
};

function row(id: string, over: Record<string, unknown> = {}) {
	return {
		_id: id,
		_creationTime: 1,
		mailboxId: MB,
		folderId: INBOX,
		threadId: `t-${id}`,
		fromAddress: 'a@example.com',
		subject: `s-${id}`,
		toAddresses: [],
		ccAddresses: [],
		attachments: [],
		hasAttachments: false,
		flagSeen: false,
		flagFlagged: false,
		flagAnswered: false,
		flagDraft: false,
		labelIds: [] as string[],
		receivedAt: 1,
		...over,
	};
}

function folder(id: string, role: string | undefined, unseenCount: number, totalCount: number) {
	return { _id: id, mailboxId: MB, name: id, role, unseenCount, totalCount };
}

const inboxArgs = { mailboxId: MB, folderRole: 'inbox', limit: 50 };
const labelArgs = { mailboxId: MB, labelId: 'l1', limit: 200 };
const mailboxArgs = { mailboxId: MB };
const sidebarArgs = { mailboxId: MB, limit: 5 };

let fake: ReturnType<typeof fakeLocalStore>;
const run = (updater: (store: any, args: any) => void, args: Record<string, unknown>) =>
	updater(fake.store, args);

/** An inbox with rows a (unread, label l1), b (read), c (unread, thread shared with a). */
function seedInbox() {
	const a = row('a', { labelIds: ['l1'], threadId: 't1' });
	const b = row('b', { flagSeen: true });
	const c = row('c', { threadId: 't1' });
	fake.seed(q.listMessages, inboxArgs, { messages: [a, b, c], hasMore: false, nextCursor: null });
	fake.seed(q.listFolders, mailboxArgs, [
		folder(INBOX, 'inbox', 2, 3),
		folder(ARCHIVE, 'archive', 0, 10),
		folder(TRASH, 'trash', 0, 4),
		folder(WORK, undefined, 1, 1),
	]);
	fake.seed(q.accessible, {}, [{ mailboxId: MB, label: 'Me', unread: 2 }]);
	fake.seed(q.unreadCounts, mailboxArgs, { counts: { l1: 1 }, isTruncated: false });
	fake.seed(q.listByLabel, labelArgs, { messages: [a], hasMore: false, nextCursor: null });
	fake.seed(q.sidebarThreads, sidebarArgs, {
		mailboxId: MB,
		unread: 2,
		threads: [
			{ threadId: 't1', latestMessageId: 'c', isUnread: true, status: null },
			{ threadId: 't-b', latestMessageId: 'b', isUnread: false, status: null },
		],
		hiddenStatus: null,
		groupStatus: null,
	});
	fake.seed(
		q.listThreadMessages,
		{ messageId: 'c' },
		{
			thread: {
				_id: 't1',
				messageCount: 2,
				unreadCount: 2,
				hasFlagged: false,
				labelIds: ['l1'],
			},
			labels: [],
			messages: [a, c],
			envelopes: [],
			olderCursor: null,
		}
	);
}

const ids = (list: Array<{ _id: string }>) => list.map((m) => m._id);
const folders = () =>
	Object.fromEntries(
		(fake.get(q.listFolders, mailboxArgs) as any[]).map((f) => [
			f._id,
			[f.unseenCount, f.totalCount],
		])
	);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	fake = fakeLocalStore();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('flag updaters', () => {
	it('markRead patches every copy of the row and moves every unread count', () => {
		seedInbox();
		run(optimisticMarkRead, { messageId: 'a', seen: true });

		expect(fake.get(q.listMessages, inboxArgs).messages[0].flagSeen).toBe(true);
		expect(fake.get(q.listByLabel, labelArgs).messages[0].flagSeen).toBe(true);
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).messages[0].flagSeen).toBe(true);
		expect(folders()[INBOX]).toEqual([1, 3]);
		expect(fake.get(q.accessible, {})[0].unread).toBe(1);
		// Sparse: the label's last unread message is read, so the key goes.
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({});
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).thread.unreadCount).toBe(1);
		const sidebar = fake.get(q.sidebarThreads, sidebarArgs);
		expect(sidebar.unread).toBe(1);
		// c is still unread, so the thread stays bold.
		expect(sidebar.threads[0].isUnread).toBe(true);
	});

	it('markRead of an already-read row writes nothing', () => {
		seedInbox();
		const before = fake.get(q.listFolders, mailboxArgs);
		run(optimisticMarkRead, { messageId: 'b', seen: true });
		expect(fake.get(q.listFolders, mailboxArgs)).toBe(before);
		expect(fake.get(q.listMessages, inboxArgs).messages[1].flagSeen).toBe(true);
	});

	it('mark unread counts the row back in', () => {
		seedInbox();
		run(optimisticMarkRead, { messageId: 'b', seen: false });
		expect(folders()[INBOX]).toEqual([3, 3]);
		const sidebar = fake.get(q.sidebarThreads, sidebarArgs);
		expect(sidebar.threads[1].isUnread).toBe(true);
	});

	it('setStar flags the row and the thread doc', () => {
		seedInbox();
		run(optimisticSetStar, { messageId: 'a', starred: true });
		expect(fake.get(q.listMessages, inboxArgs).messages[0].flagFlagged).toBe(true);
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).thread.hasFlagged).toBe(true);
		// Starring moves no unread count.
		expect(folders()[INBOX]).toEqual([2, 3]);
	});

	it('setFlags applies every given flag to every selected row', () => {
		seedInbox();
		run(optimisticSetFlags, { messageIds: ['a', 'c'], seen: true, flagged: true });
		const rows = fake.get(q.listMessages, inboxArgs).messages;
		expect(rows.map((m: any) => [m.flagSeen, m.flagFlagged])).toEqual([
			[true, true],
			[true, false],
			[true, true],
		]);
		expect(folders()[INBOX]).toEqual([0, 3]);
		expect(fake.get(q.sidebarThreads, sidebarArgs).threads[0].isUnread).toBe(false);
	});

	it('setFlags without a flag is a no-op', () => {
		seedInbox();
		const before = fake.get(q.listMessages, inboxArgs);
		run(optimisticSetFlags, { messageIds: ['a'] });
		expect(fake.get(q.listMessages, inboxArgs)).toBe(before);
	});

	it('markThreadRead clears the whole thread, the thread doc and its sidebar row', () => {
		seedInbox();
		run(optimisticMarkThreadRead, { threadId: 't1', seen: true });
		const rows = fake.get(q.listMessages, inboxArgs).messages;
		expect(rows.map((m: any) => m.flagSeen)).toEqual([true, true, true]);
		expect(folders()[INBOX]).toEqual([0, 3]);
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).thread.unreadCount).toBe(0);
		expect(fake.get(q.sidebarThreads, sidebarArgs).threads[0].isUnread).toBe(false);
	});

	it('patches the reader getMessage copy', () => {
		fake.seed(q.getMessage, { messageId: 'x' }, row('x'));
		run(optimisticMarkRead, { messageId: 'x', seen: true });
		expect(fake.get(q.getMessage, { messageId: 'x' }).flagSeen).toBe(true);
	});

	it('moves split-inbox section counts, leaving capped ones alone', () => {
		const a = row('a', { pinnedSection: 'News' });
		const b = row('b');
		fake.seed(
			q.listSections,
			{ mailboxId: MB, folderId: INBOX },
			{
				sections: [
					{ name: 'News', messages: [a], hasMore: false, unreadCount: 4, isUnreadCapped: false },
					{ name: null, messages: [b], hasMore: false, unreadCount: 9, isUnreadCapped: true },
				],
			}
		);
		run(optimisticSetFlags, { messageIds: ['a', 'b'], seen: true });
		const sections = fake.get(q.listSections, { mailboxId: MB, folderId: INBOX }).sections;
		expect(sections.map((s: any) => s.unreadCount)).toEqual([3, 9]);
		expect(sections.map((s: any) => s.messages[0].flagSeen)).toEqual([true, true]);
	});
});

describe('move updaters', () => {
	it('move drops the rows from their folder view and moves both folder counts', () => {
		seedInbox();
		run(optimisticMove, { messageIds: ['a', 'b'], targetFolderId: WORK });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['c']);
		expect(folders()[INBOX]).toEqual([1, 1]);
		expect(folders()[WORK]).toEqual([2, 3]);
		// The label view spans the mailbox: the row stays, in its new folder.
		expect(fake.get(q.listByLabel, labelArgs).messages[0].folderId).toBe(WORK);
		// Moving mail moves no label count.
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({ l1: 1 });
	});

	it('move leaves a row already in the target alone', () => {
		seedInbox();
		const before = fake.get(q.listMessages, inboxArgs);
		run(optimisticMove, { messageIds: ['a'], targetFolderId: INBOX });
		expect(fake.get(q.listMessages, inboxArgs)).toBe(before);
	});

	it('archive resolves the Archive folder and takes the thread out of the sidebar', () => {
		seedInbox();
		run(optimisticArchive, { messageIds: ['a', 'c'] });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['b']);
		expect(folders()[ARCHIVE]).toEqual([2, 12]);
		expect(folders()[INBOX]).toEqual([0, 1]);
		const sidebar = fake.get(q.sidebarThreads, sidebarArgs);
		expect(sidebar.threads.map((t: any) => t.threadId)).toEqual(['t-b']);
		expect(sidebar.unread).toBe(0);
		expect(fake.get(q.accessible, {})[0].unread).toBe(0);
	});

	it('archive keeps a sidebar thread that still has inbox mail', () => {
		seedInbox();
		run(optimisticArchive, { messageIds: ['c'] });
		const sidebar = fake.get(q.sidebarThreads, sidebarArgs);
		expect(sidebar.threads.map((t: any) => t.threadId)).toEqual(['t1', 't-b']);
	});

	it('trash resolves the Trash folder', () => {
		seedInbox();
		run(optimisticTrash, { messageIds: ['b'] });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['a', 'c']);
		expect(folders()[TRASH]).toEqual([0, 5]);
	});

	it('archive without a cached folder list still takes the row out of its folder', () => {
		fake.seed(q.listMessages, inboxArgs, {
			messages: [row('a'), row('b')],
			hasMore: false,
			nextCursor: null,
		});
		fake.seed(
			q.listMessages,
			{ mailboxId: MB },
			{
				messages: [row('a')],
				hasMore: false,
				nextCursor: null,
			}
		);
		run(optimisticArchive, { messageIds: ['a'] });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['b']);
		// The unknown destination is never written onto a row that stays.
		expect(fake.get(q.listMessages, { mailboxId: MB }).messages[0].folderId).toBe(INBOX);
	});
});

describe('snooze updaters', () => {
	it('snooze hides the row everywhere but the reader and moves the unseen counts', () => {
		seedInbox();
		fake.seed(
			q.listSections,
			{ mailboxId: MB, folderId: INBOX },
			{
				sections: [
					{
						name: null,
						messages: [row('a')],
						hasMore: false,
						unreadCount: 2,
						isUnreadCapped: false,
					},
				],
			}
		);
		run(optimisticSnooze, { messageId: 'a', until: NOW + 60_000 });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['b', 'c']);
		expect(fake.get(q.listByLabel, labelArgs).messages).toEqual([]);
		expect(fake.get(q.listSections, { mailboxId: MB, folderId: INBOX }).sections[0]).toMatchObject({
			messages: [],
			unreadCount: 1,
		});
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).messages[0].snoozedUntil).toBe(
			NOW + 60_000
		);
		expect(folders()[INBOX]).toEqual([1, 3]);
		// Label counts include snoozed mail.
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({ l1: 1 });
	});

	it('keeps the row in the Snoozed view', () => {
		fake.seed(
			q.listMessages,
			{ mailboxId: MB, folderRole: 'snoozed' },
			{
				messages: [row('a', { snoozedUntil: NOW + 1000 })],
				hasMore: false,
				nextCursor: null,
			}
		);
		run(optimisticSnooze, { messageId: 'a', until: NOW + 60_000 });
		const view = fake.get(q.listMessages, { mailboxId: MB, folderRole: 'snoozed' });
		expect(view.messages[0].snoozedUntil).toBe(NOW + 60_000);
	});

	it('snoozeUntilReply marks the row as waiting for a reply', () => {
		seedInbox();
		run(optimisticSnoozeUntilReply, { messageId: 'b', capUntil: NOW + 60_000 });
		const reader = fake.get(q.listThreadMessages, { messageId: 'c' });
		expect(reader.messages).toHaveLength(2);
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['a', 'c']);
	});

	it('snoozeMany defers every selected row and drops a thread whose newest mail sleeps', () => {
		seedInbox();
		run(optimisticSnoozeMany, { messageIds: ['b', 'c'], until: NOW + 60_000 });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['a']);
		const sidebar = fake.get(q.sidebarThreads, sidebarArgs);
		expect(sidebar.threads).toEqual([]);
		expect(sidebar.unread).toBe(1);
	});

	it('snoozeThread defers only the thread inbox mail', () => {
		seedInbox();
		fake.seed(
			q.listMessages,
			{ mailboxId: MB, folderId: ARCHIVE },
			{
				messages: [row('z', { threadId: 't1', folderId: ARCHIVE })],
				hasMore: false,
				nextCursor: null,
			}
		);
		run(optimisticSnoozeThread, { threadId: 't1', until: NOW + 60_000 });
		expect(ids(fake.get(q.listMessages, inboxArgs).messages)).toEqual(['b']);
		expect(ids(fake.get(q.listMessages, { mailboxId: MB, folderId: ARCHIVE }).messages)).toEqual([
			'z',
		]);
		expect(folders()[INBOX]).toEqual([0, 3]);
	});

	it('snoozeThread falls back to the inbox views when no folder list is cached', () => {
		fake.seed(q.listMessages, inboxArgs, {
			messages: [row('a', { threadId: 't1' })],
			hasMore: false,
			nextCursor: null,
		});
		run(optimisticSnoozeThread, { threadId: 't1', until: NOW + 60_000 });
		expect(fake.get(q.listMessages, inboxArgs).messages).toEqual([]);
	});
});

describe('label updaters', () => {
	it('toggleOnMessage adds the label to the row, its thread and the unread count', () => {
		seedInbox();
		run(optimisticToggleLabelOnMessage, { messageId: 'b', labelId: 'l2', add: true });
		expect(fake.get(q.listMessages, inboxArgs).messages[1].labelIds).toEqual(['l2']);
		// b is read, so the label gains no unread.
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({ l1: 1 });
		run(optimisticToggleLabelOnMessage, { messageId: 'c', labelId: 'l2', add: true });
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({ l1: 1, l2: 1 });
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).thread.labelIds).toEqual([
			'l1',
			'l2',
		]);
	});

	it('removing a label drops the row from that label view and the badge', () => {
		seedInbox();
		run(optimisticToggleLabelOnMessage, { messageId: 'a', labelId: 'l1', add: false });
		expect(fake.get(q.listByLabel, labelArgs).messages).toEqual([]);
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({});
		// No known message of t1 keeps l1, so the thread loses it too.
		expect(fake.get(q.listThreadMessages, { messageId: 'c' }).thread.labelIds).toEqual([]);
	});

	it('setOnMessages labels the whole selection', () => {
		seedInbox();
		run(optimisticSetLabelOnMessages, { messageIds: ['a', 'b', 'c'], labelId: 'l1', add: true });
		const rows = fake.get(q.listMessages, inboxArgs).messages;
		expect(rows.map((m: any) => m.labelIds)).toEqual([['l1'], ['l1'], ['l1']]);
		expect(fake.get(q.unreadCounts, mailboxArgs).counts).toEqual({ l1: 2 });
	});

	it('toggleOnThread unlabels the thread doc even with no row loaded', () => {
		fake.seed(
			q.listThreadMessages,
			{ messageId: 'x' },
			{
				thread: { _id: 't9', messageCount: 1, unreadCount: 0, hasFlagged: false, labelIds: ['l1'] },
				labels: [],
				messages: [],
				envelopes: [],
				olderCursor: null,
			}
		);
		run(optimisticToggleLabelOnThread, { threadId: 't9', labelId: 'l1', add: false });
		expect(fake.get(q.listThreadMessages, { messageId: 'x' }).thread.labelIds).toEqual([]);
	});
});
